//! Hojas protegidas en el .xlsx.
//!
//! - <sheetProtection> en la hoja, con la contraseña como la guarda Excel
//!   (SHA-512 con sal y 100 000 vueltas; también se leen las del método viejo).
//! - Las celdas que se pueden editar con la hoja protegida llevan un estilo con
//!   <protection locked="0"/>, como al quitar «Bloqueada» en Formato de celdas.
//!   Además van como <protectedRanges> (rangos que se pueden editar), para
//!   rangos tan grandes que no conviene marcar celda por celda.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;

use base64::Engine;
use quick_xml::events::Event;
use quick_xml::Reader;
use sha2::{Digest, Sha512};

use crate::xlsx_extras::{attributes, entry, read_zip, set_entry, sheet_paths, write_zip};

/// Cómo se guarda la contraseña.
#[derive(Clone, Debug, PartialEq)]
pub enum PasswordHash {
    /// El método viejo de Excel: 4 cifras hexadecimales.
    Legacy(String),
    /// SHA-512 (base64), con su sal (base64) y número de vueltas.
    Sha512 { hash: String, salt: String, spins: u32 },
}

#[derive(Clone, Debug, PartialEq, Default)]
pub struct RawProtection {
    pub sheet: String,
    pub protected: bool,
    pub password: Option<PasswordHash>,
    /// Celdas que se pueden editar con la hoja protegida: (fila1, col1, fila2, col2), desde 1.
    pub unlocked: Vec<(i32, i32, i32, i32)>,
}

const SPINS: u32 = 100_000;
/// Más de esto ya no se marca celda por celda (queda como rango editable).
const MAX_MARKED_CELLS: usize = 40_000;

/// Contraseña con el método viejo de Excel (el que también entiende cualquier programa).
fn legacy_hash(password: &str) -> String {
    let bytes: Vec<u16> = password.chars().map(|c| (c as u32 & 0xFF) as u16).collect();
    let mut hash: u16 = 0;
    for &b in bytes.iter().rev() {
        hash = ((hash >> 14) & 1) | ((hash << 1) & 0x7FFF);
        hash ^= b;
    }
    hash = ((hash >> 14) & 1) | ((hash << 1) & 0x7FFF);
    hash ^= bytes.len() as u16;
    hash ^= 0xCE4B;
    format!("{hash:04X}")
}

fn sha512_spin(password: &str, salt: &[u8], spins: u32) -> Vec<u8> {
    let utf16: Vec<u8> = password.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let mut h = Sha512::new();
    h.update(salt);
    h.update(&utf16);
    let mut hash = h.finalize().to_vec();
    for i in 0..spins {
        let mut h = Sha512::new();
        h.update(&hash);
        h.update(i.to_le_bytes());
        hash = h.finalize().to_vec();
    }
    hash
}

/// Sal nueva (16 bytes): no tiene que ser secreta, solo distinta cada vez.
fn new_salt() -> Vec<u8> {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let mut h = Sha512::new();
    h.update(nanos.to_le_bytes());
    h.update(std::process::id().to_le_bytes());
    h.update((&nanos as *const u128 as usize).to_le_bytes());
    h.finalize()[..16].to_vec()
}

pub fn hash_password(password: &str) -> PasswordHash {
    let salt = new_salt();
    let b64 = base64::engine::general_purpose::STANDARD;
    PasswordHash::Sha512 { hash: b64.encode(sha512_spin(password, &salt, SPINS)), salt: b64.encode(&salt), spins: SPINS }
}

pub fn check_password(hash: &PasswordHash, password: &str) -> bool {
    match hash {
        PasswordHash::Legacy(h) => h.eq_ignore_ascii_case(&legacy_hash(password)),
        PasswordHash::Sha512 { hash, salt, spins } => {
            let b64 = base64::engine::general_purpose::STANDARD;
            let Ok(salt) = b64.decode(salt) else { return false };
            b64.encode(sha512_spin(password, &salt, *spins)) == *hash
        }
    }
}

// ───────────── estilos (cellXfs) ─────────────

/// Los <xf> de <cellXfs>: (inicio, fin) de cada uno dentro del XML de estilos.
fn xf_spans(styles: &str) -> Option<(usize, usize, Vec<(usize, usize)>)> {
    let start = styles.find("<cellXfs")?;
    let end = styles[start..].find("</cellXfs>")? + start;
    let mut spans = Vec::new();
    let mut pos = start + 8;
    while let Some(i) = styles[pos..end].find("<xf").map(|i| pos + i) {
        let tag_end = styles[i..].find('>').map(|e| i + e + 1)?;
        let close = if styles[..tag_end].ends_with("/>") { tag_end } else { styles[tag_end..].find("</xf>").map(|e| tag_end + e + 5)? };
        spans.push((i, close));
        pos = close;
    }
    Some((start, end, spans))
}

fn unlocked_styles(styles: &str) -> HashSet<usize> {
    let Some((_, _, spans)) = xf_spans(styles) else { return HashSet::new() };
    spans
        .iter()
        .enumerate()
        .filter(|(_, (a, b))| {
            let xf = &styles[*a..*b];
            xf.contains("<protection") && (xf.contains(r#"locked="0""#) || xf.contains(r#"locked="false""#))
        })
        .map(|(i, _)| i)
        .collect()
}

/// Agrega a <cellXfs> una copia «desbloqueada» de cada estilo pedido. Devuelve estilo viejo → nuevo.
fn add_unlocked_styles(styles: &mut String, needed: &[usize]) -> HashMap<usize, usize> {
    let mut map = HashMap::new();
    let Some((_, end, spans)) = xf_spans(styles) else { return map };
    let mut extra = String::new();
    for (k, &old) in needed.iter().enumerate() {
        let Some(&(a, b)) = spans.get(old).or(spans.first()) else { continue };
        let xf = &styles[a..b];
        let open_end = xf.find('>').unwrap_or(xf.len() - 1);
        let mut open = xf[..open_end + 1].trim_end_matches("/>").trim_end_matches('>').to_string();
        if !open.contains("applyProtection") {
            open.push_str(r#" applyProtection="1""#);
        }
        let inner = if xf.ends_with("/>") { "" } else { &xf[open_end + 1..xf.len() - 5] };
        // <protection> va después de <alignment> y antes de <extLst>.
        let inner = match inner.find("<extLst") {
            Some(i) => format!(r#"{}<protection locked="0"/>{}"#, &inner[..i], &inner[i..]),
            None => format!(r#"{inner}<protection locked="0"/>"#),
        };
        extra.push_str(&format!("{open}>{inner}</xf>"));
        map.insert(old, spans.len() + k);
    }
    styles.insert_str(end, &extra);
    // El conteo de <cellXfs count="…">.
    if let Some(start) = styles.find("<cellXfs") {
        let tag_end = styles[start..].find('>').map_or(styles.len(), |e| start + e);
        let tag = &styles[start..tag_end];
        if let Some(c) = tag.find("count=\"") {
            let from = start + c + 7;
            let to = styles[from..].find('"').map_or(from, |e| from + e);
            let total = spans.len() + needed.len();
            styles.replace_range(from..to, &total.to_string());
        }
    }
    map
}

// ───────────── celdas de la hoja ─────────────

struct Row {
    r: i32,
    /// "<row r=\"3\" …>" (sin cerrar) y si venía vacía (<row …/>).
    open: String,
    cells: Vec<(i32, String)>,
}

fn attr(tag: &str, key: &str) -> Option<String> {
    let pattern = format!(" {key}=\"");
    let start = tag.find(&pattern)? + pattern.len();
    let end = tag[start..].find('"')? + start;
    Some(tag[start..end].to_string())
}

fn col_of(cell_ref: &str) -> i32 {
    cell_ref.chars().take_while(char::is_ascii_alphabetic).fold(0, |n, c| n * 26 + (c.to_ascii_uppercase() as i32 - 'A' as i32 + 1))
}

/// Parte <sheetData> en filas y celdas (lo demás se queda tal cual).
fn parse_rows(inner: &str) -> Vec<Row> {
    let mut rows = Vec::new();
    let mut pos = 0;
    while let Some(i) = inner[pos..].find("<row").map(|i| pos + i) {
        let tag_end = inner[i..].find('>').map_or(inner.len(), |e| i + e + 1);
        let tag = &inner[i..tag_end];
        let r: i32 = attr(tag, "r").and_then(|v| v.parse().ok()).unwrap_or(0);
        if tag.ends_with("/>") {
            rows.push(Row { r, open: format!("{}>", tag.trim_end_matches("/>")), cells: Vec::new() });
            pos = tag_end;
            continue;
        }
        let close = inner[tag_end..].find("</row>").map_or(inner.len(), |e| tag_end + e);
        let body = &inner[tag_end..close];
        let mut cells = Vec::new();
        let mut p = 0;
        while let Some(c) = body[p..].find("<c ").map(|c| p + c) {
            let ctag_end = body[c..].find('>').map_or(body.len(), |e| c + e + 1);
            let end = if body[..ctag_end].ends_with("/>") { ctag_end } else { body[ctag_end..].find("</c>").map_or(body.len(), |e| ctag_end + e + 4) };
            let cell = &body[c..end];
            cells.push((attr(cell, "r").map_or(0, |v| col_of(&v)), cell.to_string()));
            p = end;
        }
        rows.push(Row { r, open: tag.to_string(), cells });
        pos = close + 6;
    }
    rows
}

fn rows_text(rows: &[Row]) -> String {
    rows.iter()
        .map(|row| {
            if row.cells.is_empty() {
                format!("{}/>", row.open.trim_end_matches('>'))
            } else {
                format!("{}{}</row>", row.open, row.cells.iter().map(|(_, c)| c.as_str()).collect::<String>())
            }
        })
        .collect()
}

fn set_style_attr(cell: &str, style: usize) -> String {
    let tag_end = cell.find('>').unwrap_or(cell.len());
    let tag = &cell[..tag_end];
    let rest = &cell[tag_end..];
    let tag = match tag.find(" s=\"") {
        Some(i) => {
            let from = i + 4;
            let to = tag[from..].find('"').map_or(from, |e| from + e);
            format!("{}{style}{}", &tag[..from], &tag[to..])
        }
        None => {
            let base = tag.trim_end_matches('/');
            let slash = if tag.ends_with('/') { "/" } else { "" };
            format!(r#"{base} s="{style}"{slash}"#)
        }
    };
    format!("{tag}{rest}")
}

fn column_letters(mut col: i32) -> String {
    let mut name = String::new();
    while col > 0 {
        let rem = (col - 1) % 26;
        name.insert(0, (b'A' + rem as u8) as char);
        col = (col - 1) / 26;
    }
    name
}

/// Junta celdas sueltas en rectángulos (por filas seguidas con las mismas columnas).
fn to_rects(cells: &BTreeMap<i32, Vec<i32>>) -> Vec<(i32, i32, i32, i32)> {
    // Primero, rachas por fila.
    let mut runs: Vec<(i32, i32, i32)> = Vec::new(); // (fila, col1, col2)
    for (&r, cols) in cells {
        let mut cols = cols.clone();
        cols.sort_unstable();
        cols.dedup();
        let mut i = 0;
        while i < cols.len() {
            let mut j = i;
            while j + 1 < cols.len() && cols[j + 1] == cols[j] + 1 {
                j += 1;
            }
            runs.push((r, cols[i], cols[j]));
            i = j + 1;
        }
    }
    let mut rects: Vec<(i32, i32, i32, i32)> = Vec::new();
    for (r, a, b) in runs {
        if let Some(rect) = rects.iter_mut().find(|x| x.2 == r - 1 && x.1 == a && x.3 == b) {
            rect.2 = r;
        } else {
            rects.push((r, a, r, b));
        }
    }
    rects
}

pub fn read_protection(path: &str) -> Result<Vec<RawProtection>, String> {
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    let entries = read_zip(&bytes)?;
    let styles = entry(&entries, "xl/styles.xml").map(|s| String::from_utf8_lossy(s).into_owned()).unwrap_or_default();
    let unlocked_ids = unlocked_styles(&styles);
    let mut result = Vec::new();
    for (sheet, sheet_path) in sheet_paths(&entries)? {
        let Some(xml) = entry(&entries, &sheet_path) else { continue };
        let mut raw = RawProtection { sheet, ..Default::default() };
        let mut cells: BTreeMap<i32, Vec<i32>> = BTreeMap::new();
        let mut reader = Reader::from_reader(xml);
        let mut buf = Vec::new();
        loop {
            match reader.read_event_into(&mut buf).map_err(|e| e.to_string())? {
                Event::Start(e) | Event::Empty(e) => {
                    let name = e.local_name();
                    match name.as_ref() {
                        "c" if !unlocked_ids.is_empty() => {
                            let a = attributes(&e);
                            let s: usize = a.get("s").and_then(|s| s.parse().ok()).unwrap_or(0);
                            if unlocked_ids.contains(&s) {
                                if let Some((r, c)) = a.get("r").and_then(|r| crate::xlsx_extras::cell_ref(r)) {
                                    cells.entry(r).or_default().push(c);
                                }
                            }
                        }
                        "sheetProtection" => {
                            let a = attributes(&e);
                            raw.protected = a.get("sheet").is_some_and(|v| v == "1" || v == "true");
                            raw.password = if let (Some(hash), Some(salt)) = (a.get("hashValue"), a.get("saltValue")) {
                                if a.get("algorithmName").is_some_and(|n| n == "SHA-512") {
                                    Some(PasswordHash::Sha512 { hash: hash.clone(), salt: salt.clone(), spins: a.get("spinCount").and_then(|s| s.parse().ok()).unwrap_or(SPINS) })
                                } else {
                                    // Otro algoritmo que WEPO no sabe revisar: se guarda como venía.
                                    Some(PasswordHash::Sha512 { hash: hash.clone(), salt: salt.clone(), spins: u32::MAX })
                                }
                            } else {
                                a.get("password").map(|p| PasswordHash::Legacy(p.clone()))
                            };
                        }
                        "protectedRange" => {
                            let a = attributes(&e);
                            // Los que tienen su propia contraseña no se pueden editar libremente.
                            if a.contains_key("password") || a.contains_key("hashValue") {
                                continue;
                            }
                            for part in a.get("sqref").map(String::as_str).unwrap_or("").split_whitespace() {
                                let mut ends = part.split(':').filter_map(crate::xlsx_extras::cell_ref);
                                if let Some((r1, c1)) = ends.next() {
                                    let (r2, c2) = ends.next().unwrap_or((r1, c1));
                                    raw.unlocked.push((r1.min(r2), c1.min(c2), r1.max(r2), c1.max(c2)));
                                }
                            }
                        }
                        _ => {}
                    }
                }
                Event::Eof => break,
                _ => {}
            }
            buf.clear();
        }
        for rect in to_rects(&cells) {
            if !raw.unlocked.iter().any(|u| u.0 <= rect.0 && u.1 <= rect.1 && u.2 >= rect.2 && u.3 >= rect.3) {
                raw.unlocked.push(rect);
            }
        }
        if raw.protected || !raw.unlocked.is_empty() {
            result.push(raw);
        }
    }
    Ok(result)
}

/// Después de <sheetData> (y <sheetCalcPr> si hay).
fn insert_after_data(xml: &str, fragment: &str) -> String {
    let at = match xml.find("<sheetCalcPr") {
        Some(i) => xml[i..].find("/>").map_or(xml.len(), |e| i + e + 2),
        None => xml.find("</sheetData>").map(|i| i + 12).or_else(|| xml.find("<sheetData/>").map(|i| i + 12)).unwrap_or(xml.len()),
    };
    format!("{}{fragment}{}", &xml[..at], &xml[at..])
}

pub fn write_protection(path: &str, list: &[RawProtection]) -> Result<(), String> {
    if list.is_empty() {
        return Ok(());
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    let mut entries = read_zip(&bytes)?;
    let paths = sheet_paths(&entries)?;
    let mut styles = entry(&entries, "xl/styles.xml").map(|s| String::from_utf8_lossy(s).into_owned()).unwrap_or_default();
    let mut style_map: HashMap<usize, usize> = HashMap::new();
    for raw in list {
        let Some((_, sheet_path)) = paths.iter().find(|(n, _)| *n == raw.sheet) else { continue };
        let Some(xml) = entry(&entries, sheet_path) else { continue };
        let mut xml = String::from_utf8_lossy(xml).into_owned();

        // Las celdas que se pueden editar llevan un estilo desbloqueado.
        let total: usize = raw.unlocked.iter().map(|u| ((u.2 - u.0 + 1) as usize) * ((u.3 - u.1 + 1) as usize)).sum();
        if total > 0 && total <= MAX_MARKED_CELLS && !styles.is_empty() {
            if xml.contains("<sheetData/>") {
                xml = xml.replace("<sheetData/>", "<sheetData></sheetData>");
            }
            if let (Some(a), Some(b)) = (xml.find("<sheetData>"), xml.find("</sheetData>")) {
                let mut rows = parse_rows(&xml[a + 11..b]);
                for &(r1, c1, r2, c2) in &raw.unlocked {
                    for r in r1..=r2 {
                        let index = match rows.iter().position(|x| x.r == r) {
                            Some(i) => i,
                            None => {
                                let at = rows.iter().position(|x| x.r > r).unwrap_or(rows.len());
                                rows.insert(at, Row { r, open: format!(r#"<row r="{r}">"#), cells: Vec::new() });
                                at
                            }
                        };
                        for c in c1..=c2 {
                            let row = &mut rows[index];
                            let k = match row.cells.iter().position(|(x, _)| *x == c) {
                                Some(k) => k,
                                None => {
                                    let at = row.cells.iter().position(|(x, _)| *x > c).unwrap_or(row.cells.len());
                                    row.cells.insert(at, (c, format!(r#"<c r="{}{r}"/>"#, column_letters(c))));
                                    at
                                }
                            };
                            let old: usize = attr(&row.cells[k].1, "s").and_then(|s| s.parse().ok()).unwrap_or(0);
                            let new = match style_map.get(&old) {
                                Some(&n) => n,
                                None => {
                                    let added = add_unlocked_styles(&mut styles, &[old]);
                                    let n = added.get(&old).copied().unwrap_or(old);
                                    style_map.insert(old, n);
                                    n
                                }
                            };
                            row.cells[k].1 = set_style_attr(&row.cells[k].1, new);
                        }
                    }
                }
                xml = format!("{}<sheetData>{}</sheetData>{}", &xml[..a], rows_text(&rows), &xml[b + 12..]);
            }
        }

        if raw.protected {
            let mut tag = String::from("<sheetProtection");
            match &raw.password {
                Some(PasswordHash::Legacy(h)) => tag.push_str(&format!(r#" password="{h}""#)),
                Some(PasswordHash::Sha512 { hash, salt, spins }) if *spins != u32::MAX => {
                    tag.push_str(&format!(r#" algorithmName="SHA-512" hashValue="{hash}" saltValue="{salt}" spinCount="{spins}""#))
                }
                Some(PasswordHash::Sha512 { hash, salt, .. }) => tag.push_str(&format!(r#" algorithmName="SHA-512" hashValue="{hash}" saltValue="{salt}" spinCount="{SPINS}""#)),
                None => {}
            }
            tag.push_str(r#" sheet="1" objects="1" scenarios="1"/>"#);
            if !raw.unlocked.is_empty() {
                let ranges: String = raw
                    .unlocked
                    .iter()
                    .enumerate()
                    .map(|(i, u)| {
                        let a = format!("{}{}", column_letters(u.1), u.0);
                        let b = format!("{}{}", column_letters(u.3), u.2);
                        let sqref = if a == b { a } else { format!("{a}:{b}") };
                        format!(r#"<protectedRange name="Editable{}" sqref="{sqref}"/>"#, i + 1)
                    })
                    .collect();
                tag.push_str(&format!("<protectedRanges>{ranges}</protectedRanges>"));
            }
            xml = insert_after_data(&xml, &tag);
        }
        set_entry(&mut entries, sheet_path, xml.into_bytes());
    }
    if !style_map.is_empty() {
        set_entry(&mut entries, "xl/styles.xml", styles.into_bytes());
    }
    write_zip(path, &entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn contrasenas_como_excel() {
        // Valor conocido del método viejo: «test» → CBEB.
        assert_eq!(legacy_hash("test"), "CBEB");
        assert_eq!(legacy_hash("wepo"), "CA45");
        assert_eq!(legacy_hash("Secreta123"), "F36A");
        let h = hash_password("secreta");
        assert!(check_password(&h, "secreta"));
        assert!(!check_password(&h, "otra"));
        assert!(check_password(&PasswordHash::Legacy("CBEB".into()), "test"));
    }

    #[test]
    fn estilos_desbloqueados_y_celdas_nuevas() {
        let mut styles = r#"<styleSheet><cellXfs count="2"><xf xfId="0" fontId="0"/><xf xfId="0" fontId="1" applyAlignment="1"><alignment horizontal="center"/></xf></cellXfs></styleSheet>"#.to_string();
        let map = add_unlocked_styles(&mut styles, &[0, 1]);
        assert_eq!(map, HashMap::from([(0, 2), (1, 3)]));
        assert!(styles.contains(r#"<cellXfs count="4">"#));
        assert!(styles.contains(r#"<xf xfId="0" fontId="1" applyAlignment="1" applyProtection="1"><alignment horizontal="center"/><protection locked="0"/></xf>"#), "{styles}");
        assert_eq!(unlocked_styles(&styles), HashSet::from([2, 3]));

        let rows = parse_rows(r#"<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1"/></row><row r="3"/>"#);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].cells.iter().map(|c| c.0).collect::<Vec<_>>(), [1, 3]);
        assert_eq!(set_style_attr(r#"<c r="A1" t="s"><v>0</v></c>"#, 5), r#"<c r="A1" t="s" s="5"><v>0</v></c>"#);
        assert_eq!(set_style_attr(r#"<c r="B1" s="1"/>"#, 7), r#"<c r="B1" s="7"/>"#);
        assert_eq!(to_rects(&BTreeMap::from([(2, vec![2, 3]), (3, vec![2, 3]), (5, vec![4])])), vec![(2, 2, 3, 3), (5, 4, 5, 4)]);
    }
}
