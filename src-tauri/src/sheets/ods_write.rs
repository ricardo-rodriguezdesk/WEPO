//! Guardar en .ods (OpenDocument, el formato de LibreOffice Calc): valores,
//! fórmulas (traducidas a la forma de OpenDocument), formato de las celdas
//! (letra, colores, alineación, bordes, formato de número), celdas combinadas
//! y anchos y altos.

use std::collections::HashMap;
use std::fs;
use std::io::Write;

use ironcalc::base::cell::CellValue;
use ironcalc::base::expressions::parser::stringify::to_english_string;
use ironcalc::base::expressions::types::CellReferenceRC;

use super::{SheetDocument, StyleView};

fn esc(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// Letras de columna → número (A = 1).
fn col_number(letters: &str) -> i32 {
    letters.bytes().fold(0, |n, b| n * 26 + (b.to_ascii_uppercase() - b'A' + 1) as i32)
}

/// Lee una celda como «$A$1» al principio de `s`: devuelve cuántos bytes ocupa.
fn cell_at(s: &str) -> Option<usize> {
    let b = s.as_bytes();
    let mut i = 0;
    if b.get(i) == Some(&b'$') {
        i += 1;
    }
    let letters = i;
    while i < b.len() && b[i].is_ascii_alphabetic() {
        i += 1;
    }
    let n = i - letters;
    if n == 0 || n > 3 || col_number(&s[letters..i]) > 16384 {
        return None;
    }
    if b.get(i) == Some(&b'$') {
        i += 1;
    }
    let digits = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    if i == digits {
        return None;
    }
    Some(i)
}

/// Traduce una fórmula de Excel (en inglés, con comas) a la de OpenDocument.
///
/// `=SUM(A1:A3,Hoja2!B1)` → `of:=SUM([.A1:.A3];[$Hoja2.B1])`
pub fn excel_formula_to_ods(formula: &str) -> String {
    let body = formula.strip_prefix('=').unwrap_or(formula);
    let mut out = String::from("of:=");
    let mut i = 0;
    let b = body.as_bytes();
    let mut prev: Option<char> = None;
    while i < body.len() {
        let rest = &body[i..];
        let ch = rest.chars().next().unwrap();
        if ch == '"' {
            // Texto: se copia tal cual (con sus comillas dobles "").
            let mut j = 1;
            while j < rest.len() {
                if rest.as_bytes()[j] == b'"' {
                    if rest.as_bytes().get(j + 1) == Some(&b'"') {
                        j += 2;
                        continue;
                    }
                    j += 1;
                    break;
                }
                j += rest[j..].chars().next().map_or(1, char::len_utf8);
            }
            out.push_str(&rest[..j]);
            i += j;
            prev = Some('"');
            continue;
        }
        let boundary = !prev.is_some_and(|p| p.is_alphanumeric() || p == '_' || p == '.' || p == '$');
        if boundary && (ch == '\'' || ch == '$' || ch.is_alphabetic()) {
            if let Some((len, text)) = reference_at(rest) {
                out.push_str(&text);
                i += len;
                prev = Some(']');
                continue;
            }
        }
        match ch {
            ',' => out.push(';'),
            _ => out.push(ch),
        }
        i += ch.len_utf8();
        prev = Some(ch);
        let _ = b;
    }
    out
}

/// Una referencia (con su hoja, si tiene) al principio de `s`, ya escrita como en OpenDocument.
fn reference_at(s: &str) -> Option<(usize, String)> {
    let mut sheet: Option<String> = None;
    let mut start = 0;
    // 'Mi hoja'!A1 o Hoja2!A1
    if let Some(stripped) = s.strip_prefix('\'') {
        let mut j = 0;
        let bytes = stripped.as_bytes();
        while j < bytes.len() {
            if bytes[j] == b'\'' {
                if bytes.get(j + 1) == Some(&b'\'') {
                    j += 2;
                    continue;
                }
                break;
            }
            j += 1;
        }
        if stripped.as_bytes().get(j + 1) != Some(&b'!') {
            return None;
        }
        sheet = Some(format!("'{}'", &stripped[..j]));
        start = j + 3;
    } else if let Some(bang) = s.find('!') {
        let name = &s[..bang];
        if !name.is_empty() && name.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '.') {
            sheet = Some(name.to_string());
            start = bang + 1;
        }
    }
    let rest = &s[start..];
    let a = cell_at(rest)?;
    let mut len = a;
    let mut second = None;
    if rest.as_bytes().get(a) == Some(&b':') {
        if let Some(bl) = cell_at(&rest[a + 1..]) {
            second = Some(&rest[a + 1..a + 1 + bl]);
            len = a + 1 + bl;
        }
    }
    // Nombres de función como LOG10( no son celdas; tampoco algo que siga con letras.
    let next = rest[len..].chars().next();
    if next.is_some_and(|c| c == '(' || c.is_alphanumeric() || c == '_') {
        return None;
    }
    let first = &rest[..a];
    let text = match (&sheet, second) {
        (Some(sh), Some(b2)) => format!("[${sh}.{first}:.{b2}]"),
        (Some(sh), None) => format!("[${sh}.{first}]"),
        (None, Some(b2)) => format!("[.{first}:.{b2}]"),
        (None, None) => format!("[.{first}]"),
    };
    Some((start + len, text))
}

/// Estilo de celda de OpenDocument (las propiedades que WEPO maneja).
fn cell_style_xml(name: &str, s: &StyleView, data_style: Option<&str>) -> String {
    let mut text = String::new();
    if s.b {
        text.push_str(r#" fo:font-weight="bold" style:font-weight-asian="bold" style:font-weight-complex="bold""#);
    }
    if s.i {
        text.push_str(r#" fo:font-style="italic""#);
    }
    if s.u {
        text.push_str(r#" style:text-underline-style="solid" style:text-underline-width="auto" style:text-underline-color="font-color""#);
    }
    if s.strike {
        text.push_str(r#" style:text-line-through-style="solid""#);
    }
    if let Some(c) = &s.color {
        text.push_str(&format!(r#" fo:color="{}""#, esc(c)));
    }
    if s.size > 0 && s.size != 11 {
        text.push_str(&format!(r#" fo:font-size="{}pt""#, s.size));
    }
    if !s.font.is_empty() {
        text.push_str(&format!(r#" style:font-name="{}""#, esc(&s.font)));
    }
    let mut cell = String::new();
    if let Some(f) = &s.fill {
        cell.push_str(&format!(r#" fo:background-color="{}""#, esc(f)));
    }
    if s.wrap {
        cell.push_str(r#" fo:wrap-option="wrap""#);
    }
    if let Some(v) = &s.v {
        cell.push_str(&format!(r#" style:vertical-align="{}""#, if v == "center" { "middle" } else { v.as_str() }));
    }
    let sides = ["top", "right", "bottom", "left"];
    for (k, side) in sides.iter().enumerate() {
        if let Some(b) = &s.borders[k] {
            let width = match b.style.as_str() {
                "medium" => "1.5pt solid",
                "thick" => "2.5pt solid",
                "double" => "2.5pt double",
                "dotted" => "0.75pt dotted",
                "dashed" => "0.75pt dashed",
                _ => "0.75pt solid",
            };
            cell.push_str(&format!(r#" fo:border-{side}="{width} {}""#, esc(&b.color)));
        }
    }
    let para = match s.h.as_deref() {
        Some("center") => r#"<style:paragraph-properties fo:text-align="center"/>"#,
        Some("right") => r#"<style:paragraph-properties fo:text-align="end"/>"#,
        Some("justify") => r#"<style:paragraph-properties fo:text-align="justify"/>"#,
        Some("left") => r#"<style:paragraph-properties fo:text-align="start"/>"#,
        _ => "",
    };
    let data = data_style.map(|d| format!(r#" style:data-style-name="{d}""#)).unwrap_or_default();
    format!(
        r#"<style:style style:name="{name}" style:family="table-cell" style:parent-style-name="Default"{data}><style:table-cell-properties{cell}/>{para}<style:text-properties{text}/></style:style>"#
    )
}

/// Formato de número de OpenDocument para uno de Excel (los más comunes).
fn data_style_xml(name: &str, fmt: &str) -> Option<String> {
    let f = fmt.trim();
    if f.is_empty() || f.eq_ignore_ascii_case("general") || f == "@" {
        return None;
    }
    let lower = f.to_lowercase();
    let decimals = |s: &str| s.split('.').nth(1).map_or(0, |d| d.chars().take_while(|c| *c == '0').count());
    if lower.contains('y') || (lower.contains('d') && lower.contains('m')) {
        // Fechas: día, mes y año en el orden del formato.
        let mut parts = String::new();
        let mut seen = String::new();
        for token in lower.split(|c: char| !c.is_alphanumeric()).filter(|t| !t.is_empty()) {
            let piece = match token.chars().next() {
                Some('d') => r#"<number:day number:style="long"/>"#,
                Some('m') => r#"<number:month number:style="long"/>"#,
                Some('y') => r#"<number:year number:style="long"/>"#,
                Some('h') => r#"<number:hours number:style="long"/>"#,
                Some('s') => r#"<number:seconds number:style="long"/>"#,
                _ => continue,
            };
            if !parts.is_empty() {
                let sep = if seen.ends_with('h') { ":" } else { "/" };
                parts.push_str(&format!("<number:text>{sep}</number:text>"));
            }
            parts.push_str(piece);
            seen.push(token.chars().next().unwrap());
        }
        return Some(format!(r#"<number:date-style style:name="{name}">{parts}</number:date-style>"#));
    }
    if f.contains('%') {
        return Some(format!(r#"<number:percentage-style style:name="{name}"><number:number number:decimal-places="{}" number:min-decimal-places="{}" number:min-integer-digits="1"/><number:text>%</number:text></number:percentage-style>"#, decimals(f), decimals(f)));
    }
    let grouping = if f.contains(",") { r#" number:grouping="true""# } else { "" };
    let first = f.split(';').next().unwrap_or(f);
    let d = decimals(first);
    let number = format!(r#"<number:number number:decimal-places="{d}" number:min-decimal-places="{d}" number:min-integer-digits="1"{grouping}/>"#);
    if first.contains('$') || first.contains('€') {
        let symbol = if first.contains('€') { "€" } else { "$" };
        return Some(format!(r#"<number:currency-style style:name="{name}"><number:currency-symbol>{symbol}</number:currency-symbol>{number}</number:currency-style>"#));
    }
    Some(format!(r#"<number:number-style style:name="{name}">{number}</number:number-style>"#))
}

/// Número de serie de Excel → fecha ISO (para office:date-value).
fn serial_to_iso(serial: f64) -> String {
    let days = serial.floor() as i64;
    // 1899-12-30 es el día 0 (contando el 29 de febrero de 1900 que Excel inventó).
    let (mut y, mut m, mut d) = (1899i64, 12i64, 30i64);
    let mut left = days;
    let dim = |y: i64, m: i64| match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ => {
            if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 {
                29
            } else {
                28
            }
        }
    };
    while left > 0 {
        let step = (dim(y, m) - d + 1).min(left);
        d += step;
        left -= step;
        if d > dim(y, m) {
            d = 1;
            m += 1;
            if m > 12 {
                m = 1;
                y += 1;
            }
        }
    }
    let secs = ((serial - serial.floor()) * 86400.0).round() as i64;
    if secs > 0 {
        format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}", secs / 3600, secs / 60 % 60, secs % 60)
    } else {
        format!("{y:04}-{m:02}-{d:02}")
    }
}

impl SheetDocument {
    pub(super) fn write_ods(&self, path: &str) -> Result<(), String> {
        let model = self.model.get_model();
        let names = self.sheet_names();
        let mut styles_xml = String::new();
        let mut data_styles = String::new();
        let mut style_names: HashMap<String, String> = HashMap::new();
        let mut col_styles: HashMap<String, String> = HashMap::new();
        let mut row_styles: HashMap<String, String> = HashMap::new();
        let mut auto = String::new();
        let mut tables = String::new();

        for (index, name) in names.iter().enumerate() {
            let sheet = index as u32;
            let view = self.view(sheet)?;
            let height = view.rows.len() as i32;
            let width = view.rows.iter().map(|r| r.len()).max().unwrap_or(0) as i32;
            let mut covered: HashMap<(i32, i32), bool> = HashMap::new();
            let mut spans: HashMap<(i32, i32), (i32, i32)> = HashMap::new();
            for &(r1, c1, r2, c2) in &view.merged {
                spans.insert((r1, c1), (r2 - r1 + 1, c2 - c1 + 1));
                for r in r1..=r2 {
                    for c in c1..=c2 {
                        if (r, c) != (r1, c1) {
                            covered.insert((r, c), true);
                        }
                    }
                }
            }
            let mut xml = format!(r#"<table:table table:name="{}">"#, esc(name));
            // Columnas: con su ancho (las que no lo cambiaron, con el normal).
            let widths: HashMap<i32, f64> = view.col_widths.iter().copied().collect();
            let hidden_cols: Vec<i32> = view.hidden_cols.clone();
            let cols = width.max(1);
            for c in 1..=cols {
                let w = widths.get(&c).copied().unwrap_or(90.0);
                let key = format!("{:.3}", w / 96.0);
                let n = col_styles.len() + 1;
                let style = col_styles.entry(key.clone()).or_insert_with(|| {
                    auto.push_str(&format!(r#"<style:style style:name="co{n}" style:family="table-column"><style:table-column-properties fo:break-before="auto" style:column-width="{key}in"/></style:style>"#));
                    format!("co{n}")
                });
                let vis = if hidden_cols.contains(&c) { r#" table:visibility="collapse""# } else { "" };
                xml.push_str(&format!(r#"<table:table-column table:style-name="{style}"{vis} table:default-cell-style-name="Default"/>"#));
            }
            let heights: HashMap<i32, f64> = view.row_heights.iter().copied().collect();
            for r in 1..=height.max(1) {
                let row_style = heights.get(&r).map(|h| {
                    let key = format!("{:.3}", h / 96.0);
                    let n = row_styles.len() + 1;
                    row_styles
                        .entry(key.clone())
                        .or_insert_with(|| {
                            auto.push_str(&format!(r#"<style:style style:name="ro{n}" style:family="table-row"><style:table-row-properties style:row-height="{key}in" style:use-optimal-row-height="false"/></style:style>"#));
                            format!("ro{n}")
                        })
                        .clone()
                });
                let vis = if view.hidden_rows.contains(&r) { r#" table:visibility="collapse""# } else { "" };
                xml.push_str(&format!("<table:table-row{}{vis}>", row_style.map(|s| format!(r#" table:style-name="{s}""#)).unwrap_or_default()));
                let cells = view.rows.get((r - 1) as usize).map(|x| x.len() as i32).unwrap_or(0);
                let mut empty = 0;
                for c in 1..=cells {
                    let cell = &view.rows[(r - 1) as usize][(c - 1) as usize];
                    let is_covered = covered.contains_key(&(r, c));
                    let formula = model.workbook.worksheet(sheet)?.cell(r, c).and_then(|cl| cl.get_formula()).and_then(|fi| {
                        let (node, _) = model.parsed_formulas.get(index)?.get(fi as usize)?;
                        Some(to_english_string(node, &CellReferenceRC { sheet: name.clone(), row: r, column: c }))
                    });
                    let style_id = cell.2 as usize;
                    let has_style = style_id != 0;
                    if cell.0.is_empty() && formula.is_none() && !has_style && !is_covered && !spans.contains_key(&(r, c)) {
                        empty += 1;
                        continue;
                    }
                    if empty > 0 {
                        xml.push_str(&if empty > 1 { format!(r#"<table:table-cell table:number-columns-repeated="{empty}"/>"#) } else { "<table:table-cell/>".to_string() });
                        empty = 0;
                    }
                    if is_covered {
                        xml.push_str("<table:covered-table-cell/>");
                        continue;
                    }
                    let style = view.styles.get(style_id);
                    let fmt = style.map(|s| s.num_fmt.clone()).unwrap_or_default();
                    let mut attrs = String::new();
                    if let Some(s) = style.filter(|_| has_style) {
                        let key = format!("{style_id}");
                        let n = style_names.len() + 1;
                        let sname = style_names
                            .entry(key)
                            .or_insert_with(|| {
                                let ds = data_style_xml(&format!("N{n}"), &s.num_fmt).map(|x| {
                                    data_styles.push_str(&x);
                                    format!("N{n}")
                                });
                                styles_xml.push_str(&cell_style_xml(&format!("ce{n}"), s, ds.as_deref()));
                                format!("ce{n}")
                            })
                            .clone();
                        attrs.push_str(&format!(r#" table:style-name="{sname}""#));
                    }
                    if let Some(&(rows, cols)) = spans.get(&(r, c)) {
                        attrs.push_str(&format!(r#" table:number-rows-spanned="{rows}" table:number-columns-spanned="{cols}""#));
                    }
                    if let Some(f) = &formula {
                        attrs.push_str(&format!(r#" table:formula="{}""#, esc(&excel_formula_to_ods(f))));
                    }
                    let value = model.get_cell_value_by_index(sheet, r, c).unwrap_or(CellValue::None);
                    let fl = fmt.to_lowercase();
                    let is_date = fl.contains('y') || (fl.contains('d') && fl.contains('m'));
                    let body = match value {
                        CellValue::Number(n) if is_date => format!(r#"<table:table-cell office:value-type="date" office:date-value="{}"{attrs}><text:p>{}</text:p></table:table-cell>"#, serial_to_iso(n), esc(&cell.0)),
                        CellValue::Number(n) if fmt.contains('%') => format!(r#"<table:table-cell office:value-type="percentage" office:value="{n}"{attrs}><text:p>{}</text:p></table:table-cell>"#, esc(&cell.0)),
                        CellValue::Number(n) => format!(r#"<table:table-cell office:value-type="float" office:value="{n}"{attrs}><text:p>{}</text:p></table:table-cell>"#, esc(&cell.0)),
                        CellValue::Boolean(b) => format!(r#"<table:table-cell office:value-type="boolean" office:boolean-value="{b}"{attrs}><text:p>{}</text:p></table:table-cell>"#, if b { "VERDADERO" } else { "FALSO" }),
                        CellValue::String(s) => {
                            let paras: String = s.split('\n').map(|l| format!("<text:p>{}</text:p>", esc(l))).collect();
                            format!(r#"<table:table-cell office:value-type="string"{attrs}>{paras}</table:table-cell>"#)
                        }
                        CellValue::None => format!("<table:table-cell{attrs}/>"),
                    };
                    xml.push_str(&body);
                }
                if cells == 0 {
                    xml.push_str("<table:table-cell/>");
                }
                xml.push_str("</table:table-row>");
            }
            xml.push_str("</table:table>");
            tables.push_str(&xml);
        }

        const NS: &str = r#"xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:number="urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0" xmlns:of="urn:oasis:names:tc:opendocument:xmlns:of:1.2" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/""#;
        let content = format!(
            r#"<?xml version="1.0" encoding="UTF-8"?><office:document-content {NS} office:version="1.3"><office:automatic-styles>{data_styles}{auto}{styles_xml}</office:automatic-styles><office:body><office:spreadsheet>{tables}</office:spreadsheet></office:body></office:document-content>"#
        );
        let styles = format!(
            r#"<?xml version="1.0" encoding="UTF-8"?><office:document-styles {NS} office:version="1.3"><office:styles><style:default-style style:family="table-cell"><style:text-properties style:font-name="Calibri" fo:font-size="11pt"/></style:default-style><style:style style:name="Default" style:family="table-cell"/></office:styles></office:document-styles>"#
        );
        let meta = format!(r#"<?xml version="1.0" encoding="UTF-8"?><office:document-meta {NS} office:version="1.3"><office:meta><meta:generator>WEPO</meta:generator></office:meta></office:document-meta>"#);
        let manifest = r#"<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3"><manifest:file-entry manifest:full-path="/" manifest:version="1.3" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/></manifest:manifest>"#;

        let file = fs::File::create(path).map_err(|e| e.to_string())?;
        let mut zip = zip::ZipWriter::new(file);
        // «mimetype» va primero y sin comprimir: así reconocen el archivo los programas.
        let stored = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        let deflated = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        zip.start_file("mimetype", stored).map_err(|e| e.to_string())?;
        zip.write_all(b"application/vnd.oasis.opendocument.spreadsheet").map_err(|e| e.to_string())?;
        for (name, data) in [("content.xml", content.as_str()), ("styles.xml", styles.as_str()), ("meta.xml", meta.as_str()), ("META-INF/manifest.xml", manifest)] {
            zip.start_file(name, deflated).map_err(|e| e.to_string())?;
            zip.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
        }
        zip.finish().map_err(|e| e.to_string())?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn traduce_formulas_a_ods() {
        assert_eq!(excel_formula_to_ods("=SUM(A1:A3,Hoja2!B1)"), "of:=SUM([.A1:.A3];[$Hoja2.B1])");
        assert_eq!(excel_formula_to_ods("=$B$1-$B$1/10*A6"), "of:=[.$B$1]-[.$B$1]/10*[.A6]");
        assert_eq!(excel_formula_to_ods("=IF(A1>1,\"a,b\",'Mi hoja'!B2)"), "of:=IF([.A1]>1;\"a,b\";[$'Mi hoja'.B2])");
        assert_eq!(excel_formula_to_ods("=LOG10(A2)"), "of:=LOG10([.A2])");
        // Ida y vuelta con el lector.
        assert_eq!(crate::sheets::ods_formula_to_excel(&excel_formula_to_ods("=SUM(A1:A3,Hoja2!B1)*2")), "SUM(A1:A3,Hoja2!B1)*2");
    }

    #[test]
    fn fechas_de_excel() {
        assert_eq!(serial_to_iso(46327.0), "2026-11-01");
        assert_eq!(serial_to_iso(45658.5), "2025-01-01T12:00:00");
    }

    #[test]
    fn guarda_y_vuelve_a_abrir_un_ods() {
        let mut doc = SheetDocument::new_empty().unwrap();
        doc.set_cell(0, 1, 1, "Producto").unwrap();
        doc.set_cell(0, 2, 1, "Café").unwrap();
        doc.set_cell(0, 2, 2, "12.5").unwrap();
        doc.set_cell(0, 3, 2, "7.5").unwrap();
        doc.set_cell(0, 4, 2, "=SUM(B2:B3)").unwrap();
        let path = std::env::temp_dir().join("wepo-prueba.ods").to_string_lossy().to_string();
        doc.save(&path, 0).unwrap();
        let again = SheetDocument::open(&path).unwrap();
        assert_eq!(again.model.get_cell_content(0, 2, 1).unwrap(), "Café");
        assert_eq!(again.model.get_cell_content(0, 4, 2).unwrap(), "=SUM(B2:B3)");
        assert_eq!(again.model.get_formatted_cell_value(0, 4, 2).unwrap(), "20");
    }
}
