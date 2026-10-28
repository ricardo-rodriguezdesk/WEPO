//! Grupos de filas y columnas (esquema) en el .xlsx: el atributo `outlineLevel`
//! de cada <row> y <col>, `collapsed` en la fila (o columna) de resumen, y los
//! niveles más altos en <sheetFormatPr>. IronCalc no los lee ni los escribe.

use std::fs;

use quick_xml::events::Event;
use quick_xml::Reader;

use crate::xlsx_extras::{attributes, entry, read_zip, set_entry, sheet_paths, write_zip};

#[derive(Clone, Debug, Default, PartialEq)]
pub struct RawOutline {
    pub sheet: String,
    /// (fila desde 1, nivel)
    pub rows: Vec<(i32, u8)>,
    /// (columna desde 1, nivel)
    pub cols: Vec<(i32, u8)>,
    /// Filas y columnas de resumen marcadas como contraídas.
    pub collapsed_rows: Vec<i32>,
    pub collapsed_cols: Vec<i32>,
}

fn flag(a: &std::collections::HashMap<String, String>, key: &str) -> bool {
    a.get(key).is_some_and(|v| v == "1" || v == "true")
}

pub fn read_outline(path: &str) -> Result<Vec<RawOutline>, String> {
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    let entries = read_zip(&bytes)?;
    let mut result = Vec::new();
    for (sheet, sheet_path) in sheet_paths(&entries)? {
        let Some(xml) = entry(&entries, &sheet_path) else { continue };
        let mut raw = RawOutline { sheet, ..Default::default() };
        let mut reader = Reader::from_reader(xml);
        let mut buf = Vec::new();
        loop {
            match reader.read_event_into(&mut buf).map_err(|e| e.to_string())? {
                Event::Start(e) | Event::Empty(e) => {
                    let name = e.local_name();
                    match name.as_ref() {
                        "row" => {
                            let a = attributes(&e);
                            let Some(r) = a.get("r").and_then(|r| r.parse::<i32>().ok()) else { continue };
                            let level: u8 = a.get("outlineLevel").and_then(|l| l.parse().ok()).unwrap_or(0);
                            if level > 0 {
                                raw.rows.push((r, level));
                            }
                            if flag(&a, "collapsed") {
                                raw.collapsed_rows.push(r);
                            }
                        }
                        "col" => {
                            let a = attributes(&e);
                            let min: i32 = a.get("min").and_then(|v| v.parse().ok()).unwrap_or(0);
                            let max: i32 = a.get("max").and_then(|v| v.parse().ok()).unwrap_or(min).min(min + 16_384);
                            let level: u8 = a.get("outlineLevel").and_then(|l| l.parse().ok()).unwrap_or(0);
                            for c in min..=max {
                                if level > 0 {
                                    raw.cols.push((c, level));
                                }
                                if flag(&a, "collapsed") {
                                    raw.collapsed_cols.push(c);
                                }
                            }
                        }
                        // Lo que va después de las filas ya no interesa.
                        "mergeCells" | "conditionalFormatting" | "pageMargins" => break,
                        _ => {}
                    }
                }
                Event::Eof => break,
                _ => {}
            }
            buf.clear();
        }
        if !raw.rows.is_empty() || !raw.cols.is_empty() {
            result.push(raw);
        }
    }
    Ok(result)
}

/// Pone (o cambia) un atributo en la etiqueta que empieza en `tag` (el texto de «<row …» o «<col …»).
fn set_attr(tag: &str, key: &str, value: &str) -> String {
    let pattern = format!(" {key}=\"");
    if let Some(start) = tag.find(&pattern) {
        let rest = &tag[start + pattern.len()..];
        let end = rest.find('"').map_or(tag.len(), |e| start + pattern.len() + e);
        return format!("{}{value}{}", &tag[..start + pattern.len()], &tag[end..]);
    }
    let close = if tag.ends_with("/>") { tag.len() - 2 } else { tag.len() - 1 };
    format!("{} {key}=\"{value}\"{}", &tag[..close], &tag[close..])
}

/// Le pone nivel (y contraído) a cada fila: a las que ya están en el XML, en su etiqueta; a las que no, una etiqueta nueva.
fn rows_xml(xml: &str, levels: &[(i32, u8)], collapsed: &[i32]) -> String {
    let Some(data_start) = xml.find("<sheetData") else { return xml.to_string() };
    let Some(open_end) = xml[data_start..].find('>').map(|i| data_start + i + 1) else { return xml.to_string() };
    // <sheetData/> vacío: se abre para poder poner filas.
    let (mut xml, open_end) = if xml[data_start..open_end].ends_with("/>") {
        (format!("{}<sheetData></sheetData>{}", &xml[..data_start], &xml[open_end..]), data_start + "<sheetData>".len())
    } else {
        (xml.to_string(), open_end)
    };
    let mut wanted: Vec<(i32, u8, bool)> = levels.iter().map(|&(r, l)| (r, l, collapsed.contains(&r))).collect();
    for &r in collapsed {
        if !levels.iter().any(|&(x, _)| x == r) {
            wanted.push((r, 0, true));
        }
    }
    wanted.sort_by_key(|w| w.0);
    let mut pos = open_end;
    for (r, level, is_collapsed) in wanted {
        // Busca la etiqueta <row r="N"…> o la primera fila después de N.
        loop {
            let Some(next) = xml[pos..].find("<row ").map(|i| pos + i) else {
                let end = xml[pos..].find("</sheetData>").map_or(xml.len(), |i| pos + i);
                let tag = new_row(r, level, is_collapsed);
                xml.insert_str(end, &tag);
                pos = end + tag.len();
                break;
            };
            let tag_end = xml[next..].find('>').map_or(xml.len(), |i| next + i + 1);
            let tag = xml[next..tag_end].to_string();
            let number: i32 = tag.split("r=\"").nth(1).and_then(|s| s.split('"').next()).and_then(|s| s.parse().ok()).unwrap_or(0);
            if number < r {
                pos = tag_end;
                continue;
            }
            if number == r {
                let mut changed = tag.clone();
                if level > 0 {
                    changed = set_attr(&changed, "outlineLevel", &level.to_string());
                }
                if is_collapsed {
                    changed = set_attr(&changed, "collapsed", "1");
                }
                xml.replace_range(next..tag_end, &changed);
                pos = next + changed.len();
            } else {
                let tag = new_row(r, level, is_collapsed);
                xml.insert_str(next, &tag);
                pos = next + tag.len();
            }
            break;
        }
    }
    xml
}

fn new_row(r: i32, level: u8, collapsed: bool) -> String {
    let mut tag = format!(r#"<row r="{r}""#);
    if level > 0 {
        tag.push_str(&format!(r#" outlineLevel="{level}""#));
    }
    if collapsed {
        tag.push_str(r#" collapsed="1""#);
    }
    tag.push_str("/>");
    tag
}

/// Nivel de las columnas: las etiquetas <col min max> se parten donde hace falta.
fn cols_xml(xml: &str, levels: &[(i32, u8)], collapsed: &[i32]) -> String {
    if levels.is_empty() && collapsed.is_empty() {
        return xml.to_string();
    }
    // Lo que ya había: (min, max, etiqueta sin min ni max).
    let mut spans: Vec<(i32, i32, String)> = Vec::new();
    let (before, after) = match (xml.find("<cols>"), xml.find("</cols>")) {
        (Some(a), Some(b)) => {
            let inner = &xml[a + 6..b];
            for piece in inner.split("<col ").skip(1) {
                let tag = format!("<col {}", piece.trim_end());
                let get = |k: &str| tag.split(&format!(" {k}=\"")).nth(1).and_then(|s| s.split('"').next()).and_then(|s| s.parse::<i32>().ok());
                if let (Some(min), Some(max)) = (get("min"), get("max")) {
                    spans.push((min, max, tag));
                }
            }
            (xml[..a].to_string(), xml[b + 7..].to_string())
        }
        _ => {
            // Sin <cols>: va justo antes de <sheetData>.
            let at = xml.find("<sheetData").unwrap_or(xml.len());
            (xml[..at].to_string(), xml[at..].to_string())
        }
    };
    let mut special: Vec<i32> = levels.iter().map(|&(c, _)| c).chain(collapsed.iter().copied()).collect();
    special.sort_unstable();
    special.dedup();
    // Cada columna especial queda sola en su etiqueta.
    for &c in &special {
        if let Some(k) = spans.iter().position(|(a, b, _)| *a <= c && c <= *b) {
            let (a, b, tag) = spans.remove(k);
            if a < c {
                spans.push((a, c - 1, tag.clone()));
            }
            spans.push((c, c, tag.clone()));
            if c < b {
                spans.push((c + 1, b, tag));
            }
        } else {
            spans.push((c, c, r#"<col min="0" max="0" width="9.140625"/>"#.into()));
        }
    }
    spans.sort_by_key(|s| s.0);
    let mut body = String::from("<cols>");
    for (a, b, tag) in spans {
        let mut tag = set_attr(&set_attr(&tag, "min", &a.to_string()), "max", &b.to_string());
        if a == b {
            if let Some(&(_, level)) = levels.iter().find(|(c, _)| *c == a) {
                tag = set_attr(&tag, "outlineLevel", &level.to_string());
            }
            if collapsed.contains(&a) {
                tag = set_attr(&tag, "collapsed", "1");
            }
        }
        body.push_str(&tag);
    }
    body.push_str("</cols>");
    format!("{before}{body}{after}")
}

/// Niveles más altos en <sheetFormatPr> (Excel los usa para dibujar los botones 1, 2…).
fn format_xml(xml: &str, row_level: u8, col_level: u8) -> String {
    let Some(start) = xml.find("<sheetFormatPr") else {
        let at = ["<cols>", "<sheetData"].iter().filter_map(|t| xml.find(t)).min().unwrap_or(xml.len());
        let mut tag = String::from(r#"<sheetFormatPr defaultRowHeight="15""#);
        if row_level > 0 {
            tag.push_str(&format!(r#" outlineLevelRow="{row_level}""#));
        }
        if col_level > 0 {
            tag.push_str(&format!(r#" outlineLevelCol="{col_level}""#));
        }
        tag.push_str("/>");
        return format!("{}{tag}{}", &xml[..at], &xml[at..]);
    };
    let end = xml[start..].find('>').map_or(xml.len(), |i| start + i + 1);
    let mut tag = xml[start..end].to_string();
    if row_level > 0 {
        tag = set_attr(&tag, "outlineLevelRow", &row_level.to_string());
    }
    if col_level > 0 {
        tag = set_attr(&tag, "outlineLevelCol", &col_level.to_string());
    }
    format!("{}{tag}{}", &xml[..start], &xml[end..])
}

pub fn write_outline(path: &str, outlines: &[RawOutline]) -> Result<(), String> {
    if outlines.is_empty() {
        return Ok(());
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    let mut entries = read_zip(&bytes)?;
    let paths = sheet_paths(&entries)?;
    for raw in outlines {
        let Some((_, sheet_path)) = paths.iter().find(|(n, _)| *n == raw.sheet) else { continue };
        let Some(xml) = entry(&entries, sheet_path) else { continue };
        let mut xml = String::from_utf8_lossy(xml).into_owned();
        xml = rows_xml(&xml, &raw.rows, &raw.collapsed_rows);
        xml = cols_xml(&xml, &raw.cols, &raw.collapsed_cols);
        let row_level = raw.rows.iter().map(|r| r.1).max().unwrap_or(0);
        let col_level = raw.cols.iter().map(|c| c.1).max().unwrap_or(0);
        xml = format_xml(&xml, row_level, col_level);
        set_entry(&mut entries, sheet_path, xml.into_bytes());
    }
    write_zip(path, &entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filas_nuevas_y_existentes() {
        let xml = r#"<worksheet><sheetFormatPr defaultRowHeight="15"/><sheetData><row r="2" spans="1:1"><c r="A2"/></row><row r="5"><c r="A5"/></row></sheetData></worksheet>"#;
        let out = rows_xml(xml, &[(2, 1), (3, 1), (4, 2)], &[5]);
        assert_eq!(
            out,
            r#"<worksheet><sheetFormatPr defaultRowHeight="15"/><sheetData><row r="2" spans="1:1" outlineLevel="1"><c r="A2"/></row><row r="3" outlineLevel="1"/><row r="4" outlineLevel="2"/><row r="5" collapsed="1"><c r="A5"/></row></sheetData></worksheet>"#
        );
        let cols = cols_xml(r#"<worksheet><cols><col min="1" max="4" width="20" customWidth="1"/></cols><sheetData/></worksheet>"#, &[(2, 1), (3, 1)], &[]);
        assert_eq!(
            cols,
            r#"<worksheet><cols><col min="1" max="1" width="20" customWidth="1"/><col min="2" max="2" width="20" customWidth="1" outlineLevel="1"/><col min="3" max="3" width="20" customWidth="1" outlineLevel="1"/><col min="4" max="4" width="20" customWidth="1"/></cols><sheetData/></worksheet>"#
        );
        assert!(format_xml(&cols, 2, 1).contains(r#"<sheetFormatPr defaultRowHeight="15" outlineLevelRow="2" outlineLevelCol="1"/>"#));
    }
}
