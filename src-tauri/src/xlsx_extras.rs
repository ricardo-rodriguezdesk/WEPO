//! Partes del .xlsx que IronCalc no lee ni escribe y que WEPO maneja por su cuenta.
//!
//! Un .xlsx es un ZIP con archivos XML. Al abrir, leemos de ahí lo que nos
//! interesa; al guardar, IronCalc escribe el libro y después nosotros abrimos
//! ese ZIP, agregamos nuestras partes en el lugar correcto y lo volvemos a escribir.
//!
//! Por ahora: listas desplegables (validación de datos).

use std::collections::HashMap;
use std::fs;
use std::io::{Cursor, Read, Write};

use quick_xml::events::Event;
use quick_xml::Reader;

/// Una validación tal como está en el XML: rango(s) y fórmula de la lista.
#[derive(Clone, Debug, PartialEq)]
pub struct RawValidation {
    /// Rangos separados por espacios, p. ej. "B2:B20 D2".
    pub sqref: String,
    /// `"Sí,No"` (lista escrita) o `$H$1:$H$5` / `Hoja2!$A$1:$A$9` (rango).
    pub formula1: String,
}

/// Lo que agregamos a cada hoja al guardar.
#[derive(Default, Debug)]
pub struct SheetExtras {
    pub validations: Vec<RawValidation>,
}

// ───────────── ZIP ─────────────

type Entries = Vec<(String, Vec<u8>)>;

fn read_zip(bytes: &[u8]) -> Result<Entries, String> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|e| e.to_string())?;
    let mut entries = Vec::with_capacity(archive.len());
    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| e.to_string())?;
        let mut data = Vec::new();
        file.read_to_end(&mut data).map_err(|e| e.to_string())?;
        let name = file.name().map_err(|e| e.to_string())?.into_owned();
        entries.push((name, data));
    }
    Ok(entries)
}

fn write_zip(path: &str, entries: &Entries) -> Result<(), String> {
    let file = fs::File::create(path).map_err(|e| e.to_string())?;
    let mut writer = zip::ZipWriter::new(file);
    let options =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    for (name, data) in entries {
        writer.start_file(name.as_str(), options).map_err(|e| e.to_string())?;
        writer.write_all(data).map_err(|e| e.to_string())?;
    }
    writer.finish().map_err(|e| e.to_string())?;
    Ok(())
}

fn entry<'a>(entries: &'a Entries, name: &str) -> Option<&'a [u8]> {
    entries.iter().find(|(n, _)| n == name).map(|(_, d)| d.as_slice())
}

// ───────────── XML ─────────────

/// Atributos de una etiqueta como mapa nombre → valor (sin prefijo de espacio de nombres).
fn attributes(e: &quick_xml::events::BytesStart) -> HashMap<String, String> {
    e.attributes()
        .flatten()
        .filter_map(|a| {
            let key = a.key.local_name().as_ref().to_string();
            let full = a.key.as_ref().to_string();
            let raw = a.value.as_ref();
            let value = quick_xml::escape::unescape(raw).ok()?.into_owned();
            // Guardamos con y sin prefijo: "r:id" y "id".
            Some([(key, value.clone()), (full, value)])
        })
        .flatten()
        .collect()
}

/// Traduce una entidad como `quot` o `#34` a su carácter.
fn entity(name: &str) -> String {
    match name {
        "quot" => "\"".into(),
        "amp" => "&".into(),
        "lt" => "<".into(),
        "gt" => ">".into(),
        "apos" => "'".into(),
        n if n.starts_with("#x") => u32::from_str_radix(&n[2..], 16).ok().and_then(char::from_u32).map(String::from).unwrap_or_default(),
        n if n.starts_with('#') => n[1..].parse().ok().and_then(char::from_u32).map(String::from).unwrap_or_default(),
        _ => String::new(),
    }
}

pub fn escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// Hojas del libro en orden: (nombre, ruta del XML dentro del ZIP).
fn sheet_paths(entries: &Entries) -> Result<Vec<(String, String)>, String> {
    let workbook = entry(entries, "xl/workbook.xml").ok_or("El archivo no tiene xl/workbook.xml")?;
    let rels = entry(entries, "xl/_rels/workbook.xml.rels").ok_or("El archivo no tiene relaciones del libro")?;

    let mut targets = HashMap::new();
    let mut reader = Reader::from_reader(rels);
    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf).map_err(|e| e.to_string())? {
            Event::Start(e) | Event::Empty(e) if e.local_name().as_ref() == "Relationship" => {
                let a = attributes(&e);
                if let (Some(id), Some(target)) = (a.get("Id"), a.get("Target")) {
                    let target = target.trim_start_matches('/');
                    let path = if target.starts_with("xl/") { target.to_string() } else { format!("xl/{target}") };
                    targets.insert(id.clone(), path);
                }
            }
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }

    let mut sheets = Vec::new();
    let mut reader = Reader::from_reader(workbook);
    loop {
        match reader.read_event_into(&mut buf).map_err(|e| e.to_string())? {
            Event::Start(e) | Event::Empty(e) if e.local_name().as_ref() == "sheet" => {
                let a = attributes(&e);
                if let (Some(name), Some(id)) = (a.get("name"), a.get("r:id").or(a.get("id"))) {
                    if let Some(path) = targets.get(id) {
                        sheets.push((name.clone(), path.clone()));
                    }
                }
            }
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }
    Ok(sheets)
}

// ───────────── leer ─────────────

/// Listas desplegables de cada hoja de un .xlsx: (nombre de la hoja, validaciones).
pub fn read_validations(path: &str) -> Result<Vec<(String, Vec<RawValidation>)>, String> {
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    let entries = read_zip(&bytes)?;
    let mut result = Vec::new();
    for (name, sheet_path) in sheet_paths(&entries)? {
        let Some(xml) = entry(&entries, &sheet_path) else { continue };
        let validations = parse_validations(xml)?;
        if !validations.is_empty() {
            result.push((name, validations));
        }
    }
    Ok(result)
}

/// Solo las validaciones de tipo lista, que son las que WEPO entiende.
fn parse_validations(xml: &[u8]) -> Result<Vec<RawValidation>, String> {
    let mut reader = Reader::from_reader(xml);
    let mut buf = Vec::new();
    let mut found = Vec::new();
    let mut current: Option<(String, bool)> = None; // (sqref, es de tipo lista)
    let mut in_formula = false;
    let mut formula = String::new();
    loop {
        match reader.read_event_into(&mut buf).map_err(|e| e.to_string())? {
            Event::Start(e) if e.local_name().as_ref() == "dataValidation" => {
                let a = attributes(&e);
                let is_list = a.get("type").map(|t| t == "list").unwrap_or(false);
                current = Some((a.get("sqref").cloned().unwrap_or_default(), is_list));
                formula.clear();
            }
            Event::Start(e) if e.local_name().as_ref() == "formula1" => in_formula = true,
            Event::End(e) if e.local_name().as_ref() == "formula1" => in_formula = false,
            Event::Text(t) if in_formula => formula.push_str(&t.xml10_content()),
            Event::GeneralRef(r) if in_formula => formula.push_str(&entity(&r)),
            Event::End(e) if e.local_name().as_ref() == "dataValidation" => {
                if let Some((sqref, true)) = current.take() {
                    if !sqref.is_empty() && !formula.is_empty() {
                        found.push(RawValidation { sqref, formula1: formula.clone() });
                    }
                }
            }
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }
    Ok(found)
}

// ───────────── escribir ─────────────

/// Etiquetas que, según el estándar, van después de <dataValidations> en una hoja.
const AFTER_VALIDATIONS: &[&str] = &[
    "<hyperlinks", "<printOptions", "<pageMargins", "<pageSetup", "<headerFooter", "<rowBreaks",
    "<colBreaks", "<customProperties", "<cellWatches", "<ignoredErrors", "<smartTags", "<drawing",
    "<legacyDrawing", "<legacyDrawingHF", "<picture", "<oleObjects", "<controls", "<webPublishItems",
    "<tableParts", "<extLst", "</worksheet>",
];

/// Inserta `fragment` justo antes de la primera de `tags` que aparezca en `xml`.
fn insert_before_first(xml: &str, fragment: &str, tags: &[&str]) -> String {
    let position = tags
        .iter()
        .filter_map(|tag| {
            // Que sea la etiqueta exacta y no otra que empieza igual (<drawing vs <drawingX).
            xml.match_indices(tag).map(|(i, _)| i).find(|&i| {
                let next = xml[i + tag.len()..].chars().next();
                tag.starts_with("</") || matches!(next, Some(' ' | '>' | '/'))
            })
        })
        .min()
        .unwrap_or(xml.len());
    format!("{}{}{}", &xml[..position], fragment, &xml[position..])
}

fn validations_xml(validations: &[RawValidation]) -> String {
    let items: String = validations
        .iter()
        .map(|v| {
            format!(
                r#"<dataValidation type="list" allowBlank="1" showErrorMessage="1" sqref="{}"><formula1>{}</formula1></dataValidation>"#,
                escape(&v.sqref),
                escape(&v.formula1)
            )
        })
        .collect();
    format!(r#"<dataValidations count="{}">{items}</dataValidations>"#, validations.len())
}

/// Agrega nuestras partes al .xlsx que acaba de escribir IronCalc.
pub fn write_extras(path: &str, sheets: &[(String, SheetExtras)]) -> Result<(), String> {
    if sheets.iter().all(|(_, extras)| extras.validations.is_empty()) {
        return Ok(());
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    let mut entries = read_zip(&bytes)?;
    let paths = sheet_paths(&entries)?;

    for (name, extras) in sheets {
        let Some((_, sheet_path)) = paths.iter().find(|(n, _)| n == name) else { continue };
        let Some(index) = entries.iter().position(|(n, _)| n == sheet_path) else { continue };
        let mut xml = String::from_utf8(entries[index].1.clone()).map_err(|e| e.to_string())?;
        if !extras.validations.is_empty() && !xml.contains("<dataValidations") {
            xml = insert_before_first(&xml, &validations_xml(&extras.validations), AFTER_VALIDATIONS);
        }
        entries[index].1 = xml.into_bytes();
    }
    write_zip(path, &entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inserta_en_el_orden_correcto() {
        let xml = r#"<worksheet><sheetData/><mergeCells/><pageMargins left="1"/><drawing r:id="x"/></worksheet>"#;
        let out = insert_before_first(xml, "<dataValidations/>", AFTER_VALIDATIONS);
        assert_eq!(out, r#"<worksheet><sheetData/><mergeCells/><dataValidations/><pageMargins left="1"/><drawing r:id="x"/></worksheet>"#);
        let out = insert_before_first("<worksheet><sheetData/></worksheet>", "<x/>", AFTER_VALIDATIONS);
        assert_eq!(out, "<worksheet><sheetData/><x/></worksheet>");
    }

    #[test]
    fn lee_listas_con_comillas_y_rangos() {
        let xml = br#"<worksheet><dataValidations count="2">
            <dataValidation type="list" allowBlank="1" sqref="B2:B9 D2"><formula1>&quot;S&#237;,No,Tal vez&quot;</formula1></dataValidation>
            <dataValidation type="whole" sqref="C2"><formula1>1</formula1></dataValidation>
            <dataValidation type="list" sqref="E2:E5"><formula1>Opciones!$A$1:$A$3</formula1></dataValidation>
        </dataValidations></worksheet>"#;
        let found = parse_validations(xml).unwrap();
        assert_eq!(found.len(), 2, "solo las de tipo lista");
        assert_eq!(found[0].sqref, "B2:B9 D2");
        assert_eq!(found[0].formula1, "\"Sí,No,Tal vez\"");
        assert_eq!(found[1].formula1, "Opciones!$A$1:$A$3");
    }
}
