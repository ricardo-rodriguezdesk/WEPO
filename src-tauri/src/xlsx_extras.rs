//! Partes del .xlsx que IronCalc no lee ni escribe y que WEPO maneja por su cuenta.
//!
//! Un .xlsx es un ZIP con archivos XML. Al abrir, leemos de ahí lo que nos
//! interesa; al guardar, IronCalc escribe el libro y después nosotros abrimos
//! ese ZIP, agregamos nuestras partes en el lugar correcto y lo volvemos a escribir.
//!
//! Por ahora: listas desplegables (validación de datos), gráficas e imágenes.

use std::collections::HashMap;
use std::fs;
use std::io::{Cursor, Read, Write};

use quick_xml::events::Event;
use quick_xml::Reader;

/// Una validación tal como está en el XML.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct RawValidation {
    /// Rangos separados por espacios, p. ej. "B2:B20 D2".
    pub sqref: String,
    /// "list", "whole" (número entero), "decimal" o "date".
    pub kind: String,
    /// "between", "greaterThan"… (no aplica a las listas).
    pub operator: String,
    /// Lista: `"Sí,No"` (escrita) o `$H$1:$H$5` / `Hoja2!$A$1:$A$9` (rango).
    /// Números y fechas: el primer límite (las fechas como número de serie).
    pub formula1: String,
    pub formula2: Option<String>,
    /// Mensaje propio cuando el valor no es válido.
    pub error: Option<String>,
}

/// Lo que agregamos a cada hoja al guardar.
#[derive(Default, Debug)]
pub struct SheetExtras {
    pub validations: Vec<RawValidation>,
    pub drawings: Vec<RawDrawing>,
    pub notes: Vec<RawNote>,
    pub tables: Vec<RawTable>,
    pub page: Option<RawPage>,
}

/// Una tabla lista para escribirla (tableN.xml).
#[derive(Clone, Debug, PartialEq)]
pub struct RawTable {
    /// Número único en todo el libro (desde 1).
    pub id: u32,
    pub name: String,
    /// Toda la tabla ("A1:C7") y la parte con filtro, sin la fila de totales ("A1:C6").
    pub reference: String,
    pub filter_ref: String,
    /// Nombre de cada columna (el texto de su encabezado).
    pub columns: Vec<String>,
    /// "TableStyleMedium2"…
    pub style: String,
    pub banded: bool,
    pub totals: bool,
}

/// Configuración de página de una hoja, ya con los códigos de Excel.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct RawPage {
    /// "&CReporte &D"
    pub header: String,
    pub footer: String,
    /// Fórmula de las filas que se repiten ('Hoja1'!$1:$1) y del área de impresión.
    pub titles: Option<String>,
    pub area: Option<String>,
    /// Posición de la hoja en el libro (para localSheetId).
    pub sheet_index: u32,
}

/// Nota de una celda, lista para escribirla (fila y columna desde 0).
#[derive(Clone, Debug, PartialEq)]
pub struct RawNote {
    /// "B3"
    pub cell_ref: String,
    pub row: i32,
    pub col: i32,
    pub text: String,
    pub author: String,
}

/// Posición de un dibujo como la guarda Excel: celda (desde 0) y
/// desplazamiento dentro de ella en EMU (1 píxel = 9525 EMU).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CellOffset {
    pub col: i32,
    pub col_off: i64,
    pub row: i32,
    pub row_off: i64,
}

#[derive(Clone, Debug, PartialEq)]
pub enum RawAnchor {
    /// Esquina superior izquierda y esquina inferior derecha.
    TwoCell(CellOffset, CellOffset),
    /// Esquina superior izquierda y tamaño en EMU.
    OneCell(CellOffset, i64, i64),
    /// Posición y tamaño absolutos en EMU.
    Absolute(i64, i64, i64, i64),
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct RawSeries {
    pub name_ref: Option<String>,
    pub name: Option<String>,
    pub categories: Option<String>,
    pub values: String,
    pub color: Option<String>,
    /// Valores guardados en el archivo (los usamos al escribir para otros programas).
    pub category_cache: Vec<String>,
    pub value_cache: Vec<Option<f64>>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RawChart {
    /// column, bar, line, area, pie, doughnut, scatter o combo (columnas + la última serie como línea)
    pub kind: String,
    pub title: String,
    pub legend: bool,
    pub series: Vec<RawSeries>,
    pub stacked: bool,
    /// Valores escritos sobre las barras o puntos.
    pub labels: bool,
    /// Títulos del eje de categorías (o X) y del de valores (o Y).
    pub x_title: String,
    pub y_title: String,
}

#[derive(Clone, Debug, PartialEq)]
pub enum RawContent {
    Chart(RawChart),
    Image { name: String, mime: String, data: Vec<u8> },
}

#[derive(Clone, Debug, PartialEq)]
pub struct RawDrawing {
    pub anchor: RawAnchor,
    pub content: RawContent,
}

pub const EMU_PER_PIXEL: f64 = 9525.0;

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

/// "xl/worksheets/sheet1.xml" + "../drawings/drawing1.xml" → "xl/drawings/drawing1.xml"
fn resolve(base: &str, target: &str) -> String {
    if let Some(absolute) = target.strip_prefix('/') {
        return absolute.to_string();
    }
    let mut parts: Vec<&str> = base.split('/').collect();
    parts.pop(); // el nombre del archivo
    for piece in target.split('/') {
        match piece {
            ".." => {
                parts.pop();
            }
            "." | "" => {}
            p => parts.push(p),
        }
    }
    parts.join("/")
}

/// Archivo de relaciones de una parte: xl/worksheets/sheet1.xml → xl/worksheets/_rels/sheet1.xml.rels
fn rels_path(part: &str) -> String {
    match part.rsplit_once('/') {
        Some((dir, file)) => format!("{dir}/_rels/{file}.rels"),
        None => format!("_rels/{part}.rels"),
    }
}

/// Relaciones de una parte: Id → (tipo, ruta resuelta).
fn relationships(entries: &Entries, part: &str) -> HashMap<String, (String, String)> {
    let mut map = HashMap::new();
    let Some(xml) = entry(entries, &rels_path(part)) else { return map };
    let mut reader = Reader::from_reader(xml);
    let mut buf = Vec::new();
    while let Ok(event) = reader.read_event_into(&mut buf) {
        match event {
            Event::Start(e) | Event::Empty(e) if e.local_name().as_ref() == "Relationship" => {
                let a = attributes(&e);
                if let (Some(id), Some(target)) = (a.get("Id"), a.get("Target")) {
                    let kind = a.get("Type").map(|t| t.rsplit('/').next().unwrap_or("").to_string()).unwrap_or_default();
                    map.insert(id.clone(), (kind, resolve(part, target)));
                }
            }
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }
    map
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

/// Gráficas e imágenes de cada hoja. Devuelve también si había algo que WEPO
/// no sabe conservar (formas, cuadros de texto, otros tipos de gráfica…).
pub fn read_drawings(path: &str) -> Result<(Vec<(String, Vec<RawDrawing>)>, bool), String> {
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    let entries = read_zip(&bytes)?;
    let mut result = Vec::new();
    let mut unsupported = false;
    for (name, sheet_path) in sheet_paths(&entries)? {
        let Some(sheet_xml) = entry(&entries, &sheet_path) else { continue };
        let sheet_rels = relationships(&entries, &sheet_path);
        let mut drawings = Vec::new();
        for id in drawing_ids(sheet_xml)? {
            let Some((_, drawing_path)) = sheet_rels.get(&id) else { continue };
            let Some(drawing_xml) = entry(&entries, drawing_path) else { continue };
            let drawing_rels = relationships(&entries, drawing_path);
            let (anchors, skipped) = parse_drawing(drawing_xml)?;
            unsupported |= skipped;
            for (anchor, target) in anchors {
                let content = match target {
                    Target::Chart(rid) => {
                        let Some((_, chart_path)) = drawing_rels.get(&rid) else { continue };
                        let Some(chart_xml) = entry(&entries, chart_path) else { continue };
                        match parse_chart(chart_xml)? {
                            (Some(chart), partial) => {
                                unsupported |= partial;
                                RawContent::Chart(chart)
                            }
                            (None, _) => {
                                unsupported = true;
                                continue;
                            }
                        }
                    }
                    Target::Image(rid, name) => {
                        let Some((_, media_path)) = drawing_rels.get(&rid) else { continue };
                        let Some(data) = entry(&entries, media_path) else { continue };
                        let mime = match media_path.rsplit('.').next().unwrap_or("").to_ascii_lowercase().as_str() {
                            "png" => "image/png",
                            "jpg" | "jpeg" => "image/jpeg",
                            "gif" => "image/gif",
                            _ => {
                                unsupported = true;
                                continue;
                            }
                        };
                        RawContent::Image { name, mime: mime.into(), data: data.to_vec() }
                    }
                };
                drawings.push(RawDrawing { anchor, content });
            }
        }
        // Tablas dinámicas u otros dibujos "heredados" (VML) que no
        // conservamos. El VML que acompaña a las notas sí: WEPO lo vuelve a escribir.
        let has_notes = sheet_rels.values().any(|(kind, _)| kind == "comments");
        unsupported |= sheet_rels.values().any(|(kind, _)| match kind.as_str() {
            "pivotTable" => true,
            "vmlDrawing" => !has_notes,
            _ => false,
        });
        if !drawings.is_empty() {
            result.push((name, drawings));
        }
    }
    Ok((result, unsupported))
}

/// Encabezado y pie de cada hoja, y sus filas que se repiten y área de impresión
/// (nombres definidos _xlnm.Print_Titles y _xlnm.Print_Area del libro).
pub fn read_pages(path: &str) -> Result<Vec<(String, RawPage)>, String> {
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    let entries = read_zip(&bytes)?;
    let paths = sheet_paths(&entries)?;
    let mut pages: Vec<(String, RawPage)> = paths
        .iter()
        .enumerate()
        .map(|(i, (name, _))| (name.clone(), RawPage { sheet_index: i as u32, ..Default::default() }))
        .collect();

    for (i, (_, sheet_path)) in paths.iter().enumerate() {
        let Some(xml) = entry(&entries, sheet_path) else { continue };
        let mut reader = Reader::from_reader(xml);
        let mut buf = Vec::new();
        let mut inside: Option<&str> = None;
        loop {
            match reader.read_event_into(&mut buf).map_err(|e| e.to_string())? {
                Event::Start(e) if e.local_name().as_ref() == "oddHeader" => inside = Some("header"),
                Event::Start(e) if e.local_name().as_ref() == "oddFooter" => inside = Some("footer"),
                Event::End(e) if matches!(e.local_name().as_ref(), "oddHeader" | "oddFooter") => inside = None,
                Event::Text(t) => {
                    let text = t.xml10_content().to_string();
                    match inside {
                        Some("header") => pages[i].1.header.push_str(&text),
                        Some("footer") => pages[i].1.footer.push_str(&text),
                        _ => {}
                    }
                }
                Event::GeneralRef(r) => match inside {
                    Some("header") => pages[i].1.header.push_str(&entity(&r)),
                    Some("footer") => pages[i].1.footer.push_str(&entity(&r)),
                    _ => {}
                },
                Event::Eof => break,
                _ => {}
            }
            buf.clear();
        }
    }

    if let Some(workbook) = entry(&entries, "xl/workbook.xml") {
        let mut reader = Reader::from_reader(workbook);
        let mut buf = Vec::new();
        let mut current: Option<(String, Option<usize>)> = None;
        let mut text = String::new();
        loop {
            match reader.read_event_into(&mut buf).map_err(|e| e.to_string())? {
                Event::Start(e) if e.local_name().as_ref() == "definedName" => {
                    let a = attributes(&e);
                    current = Some((a.get("name").cloned().unwrap_or_default(), a.get("localSheetId").and_then(|i| i.parse().ok())));
                    text.clear();
                }
                Event::Text(t) if current.is_some() => text.push_str(&t.xml10_content()),
                Event::GeneralRef(r) if current.is_some() => text.push_str(&entity(&r)),
                Event::End(e) if e.local_name().as_ref() == "definedName" => {
                    if let Some((name, Some(index))) = current.take() {
                        if let Some((_, page)) = pages.get_mut(index) {
                            match name.as_str() {
                                "_xlnm.Print_Titles" => page.titles = Some(text.clone()),
                                "_xlnm.Print_Area" => page.area = Some(text.clone()),
                                _ => {}
                            }
                        }
                    }
                }
                Event::Eof => break,
                _ => {}
            }
            buf.clear();
        }
    }
    Ok(pages.into_iter().filter(|(_, p)| !p.header.is_empty() || !p.footer.is_empty() || p.titles.is_some() || p.area.is_some()).collect())
}

/// Estilo de cada tabla del archivo (nombre de la tabla → "TableStyleMedium2").
pub fn read_table_styles(path: &str) -> Result<HashMap<String, String>, String> {
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    let entries = read_zip(&bytes)?;
    let mut styles = HashMap::new();
    for (name, data) in &entries {
        if !(name.starts_with("xl/tables/") && name.ends_with(".xml")) {
            continue;
        }
        let mut reader = Reader::from_reader(data.as_slice());
        let mut buf = Vec::new();
        let mut table = String::new();
        loop {
            match reader.read_event_into(&mut buf).map_err(|e| e.to_string())? {
                Event::Start(e) | Event::Empty(e) if e.local_name().as_ref() == "table" => {
                    table = attributes(&e).get("name").cloned().unwrap_or_default();
                }
                Event::Start(e) | Event::Empty(e) if e.local_name().as_ref() == "tableStyleInfo" => {
                    if let Some(style) = attributes(&e).get("name") {
                        styles.insert(table.clone(), style.clone());
                    }
                }
                Event::Eof => break,
                _ => {}
            }
            buf.clear();
        }
    }
    Ok(styles)
}

fn drawing_ids(sheet_xml: &[u8]) -> Result<Vec<String>, String> {
    let mut reader = Reader::from_reader(sheet_xml);
    let mut buf = Vec::new();
    let mut ids = Vec::new();
    loop {
        match reader.read_event_into(&mut buf).map_err(|e| e.to_string())? {
            Event::Start(e) | Event::Empty(e) if e.local_name().as_ref() == "drawing" => {
                if let Some(id) = attributes(&e).get("r:id").or(attributes(&e).get("id")) {
                    ids.push(id.clone());
                }
            }
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }
    Ok(ids)
}

enum Target {
    Chart(String),
    Image(String, String),
}

/// Anclas de un drawingN.xml con lo que contienen. El booleano indica si se
/// saltó algo que no es gráfica ni imagen.
fn parse_drawing(xml: &[u8]) -> Result<(Vec<(RawAnchor, Target)>, bool), String> {
    let mut reader = Reader::from_reader(xml);
    let mut buf = Vec::new();
    let mut found = Vec::new();
    let mut skipped = false;
    let mut stack: Vec<String> = Vec::new();
    let mut kind = String::new();
    let mut from = CellOffset { col: 0, col_off: 0, row: 0, row_off: 0 };
    let mut to = from;
    let (mut pos, mut ext) = ((0i64, 0i64), (0i64, 0i64));
    let mut target: Option<Target> = None;
    let mut pic_name = String::new();
    let mut text = String::new();

    loop {
        let event = reader.read_event_into(&mut buf).map_err(|e| e.to_string())?;
        match &event {
            Event::Start(e) | Event::Empty(e) => {
                let local = e.local_name().as_ref().to_string();
                let a = attributes(e);
                match local.as_str() {
                    "twoCellAnchor" | "oneCellAnchor" | "absoluteAnchor" => {
                        kind = local.clone();
                        target = None;
                        pic_name.clear();
                    }
                    "pos" => pos = (num(&a, "x"), num(&a, "y")),
                    "ext" if stack.iter().any(|s| s.ends_with("Anchor")) && !stack.iter().any(|s| s == "xfrm") => {
                        ext = (num(&a, "cx"), num(&a, "cy"));
                    }
                    "chart" if stack.iter().any(|s| s == "graphicData") => {
                        if let Some(id) = a.get("r:id").or(a.get("id")) {
                            target = Some(Target::Chart(id.clone()));
                        }
                    }
                    "cNvPr" if stack.iter().any(|s| s == "pic") => pic_name = a.get("name").cloned().unwrap_or_default(),
                    "blip" => {
                        if let Some(id) = a.get("r:embed").or(a.get("embed")) {
                            target = Some(Target::Image(id.clone(), pic_name.clone()));
                        }
                    }
                    "sp" | "grpSp" | "cxnSp" if stack.last().is_some_and(|s| s.ends_with("Anchor")) => skipped = true,
                    _ => {}
                }
                if matches!(event, Event::Start(_)) {
                    stack.push(local);
                    text.clear();
                }
            }
            Event::Text(t) => text.push_str(&t.xml10_content()),
            Event::End(e) => {
                let local = e.local_name().as_ref().to_string();
                stack.pop();
                let value: i64 = text.trim().parse().unwrap_or(0);
                let in_from = stack.last().is_some_and(|s| s == "from");
                let point = if in_from { &mut from } else { &mut to };
                if stack.last().is_some_and(|s| s == "from" || s == "to") {
                    match local.as_str() {
                        "col" => point.col = value as i32,
                        "colOff" => point.col_off = value,
                        "row" => point.row = value as i32,
                        "rowOff" => point.row_off = value,
                        _ => {}
                    }
                }
                if local == kind {
                    let anchor = match kind.as_str() {
                        "twoCellAnchor" => RawAnchor::TwoCell(from, to),
                        "oneCellAnchor" => RawAnchor::OneCell(from, ext.0, ext.1),
                        _ => RawAnchor::Absolute(pos.0, pos.1, ext.0, ext.1),
                    };
                    match target.take() {
                        Some(t) => found.push((anchor, t)),
                        None => skipped = true,
                    }
                }
                text.clear();
            }
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }
    Ok((found, skipped))
}

fn num(a: &HashMap<String, String>, key: &str) -> i64 {
    a.get(key).and_then(|v| v.parse().ok()).unwrap_or(0)
}

/// Lee una gráfica. Devuelve None si su tipo no es uno de los que WEPO dibuja;
/// el booleano indica que tenía partes que no se conservan (p. ej. gráfica combinada).
fn parse_chart(xml: &[u8]) -> Result<(Option<RawChart>, bool), String> {
    let mut reader = Reader::from_reader(xml);
    let mut buf = Vec::new();
    let mut stack: Vec<String> = Vec::new();
    let mut chart = RawChart {
        kind: String::new(),
        title: String::new(),
        legend: false,
        series: Vec::new(),
        stacked: false,
        labels: false,
        x_title: String::new(),
        y_title: String::new(),
    };
    // Posición del eje de valores que se está leyendo (en dispersión, "b" es el eje X).
    let mut axis_pos = String::new();
    let mut chart_types = 0;
    let mut partial = false;
    let mut series: Option<RawSeries> = None;
    let mut text = String::new();
    let mut title_deleted = false;

    loop {
        let event = reader.read_event_into(&mut buf).map_err(|e| e.to_string())?;
        match &event {
            Event::Start(e) | Event::Empty(e) => {
                let local = e.local_name().as_ref().to_string();
                let a = attributes(e);
                let in_plot = stack.iter().any(|s| s == "plotArea");
                match local.as_str() {
                    "barChart" | "bar3DChart" | "lineChart" | "line3DChart" | "areaChart" | "area3DChart"
                    | "pieChart" | "pie3DChart" | "doughnutChart" | "scatterChart" | "radarChart" | "bubbleChart"
                    | "stockChart" | "surfaceChart" | "surface3DChart" | "ofPieChart"
                        if in_plot =>
                    {
                        chart_types += 1;
                        if chart_types == 2 && chart.kind == "column" && local == "lineChart" {
                            // Columnas con una línea encima: gráfica combinada.
                            chart.kind = "combo".into();
                        } else if chart_types == 1 {
                            chart.kind = match local.as_str() {
                                "barChart" | "bar3DChart" => "column",
                                "lineChart" | "line3DChart" => "line",
                                "areaChart" | "area3DChart" => "area",
                                "pieChart" | "pie3DChart" => "pie",
                                "doughnutChart" => "doughnut",
                                "scatterChart" => "scatter",
                                _ => "",
                            }
                            .to_string();
                            partial |= local.contains("3D");
                        } else {
                            partial = true;
                        }
                    }
                    "barDir" if chart_types == 1 && a.get("val").is_some_and(|v| v == "bar") => chart.kind = "bar".into(),
                    "grouping" if chart_types == 1 => {
                        chart.stacked = a.get("val").is_some_and(|v| v == "stacked" || v == "percentStacked");
                    }
                    "showVal" if stack.iter().any(|s| s == "dLbls") => {
                        chart.labels |= a.get("val").is_some_and(|v| v == "1" || v == "true");
                    }
                    "axPos" => axis_pos = a.get("val").cloned().unwrap_or_default(),
                    "ser" if chart_types == 1 || chart.kind == "combo" => series = Some(RawSeries::default()),
                    "legend" => chart.legend = true,
                    "autoTitleDeleted" => title_deleted = a.get("val").is_some_and(|v| v == "1" || v == "true"),
                    "srgbClr" => {
                        // El color de la serie: el primer relleno directo de su spPr (no el de un punto).
                        if let Some(s) = series.as_mut() {
                            let in_ser_fill = stack.iter().rev().take(3).any(|x| x == "spPr")
                                && stack.iter().rev().nth(2).is_some_and(|x| x == "ser" || x == "spPr");
                            if s.color.is_none() && in_ser_fill && !stack.iter().any(|x| x == "dPt") {
                                s.color = a.get("val").map(|v| format!("#{v}"));
                            }
                        }
                    }
                    _ => {}
                }
                if matches!(event, Event::Start(_)) {
                    stack.push(local);
                }
                text.clear();
            }
            Event::Text(t) => text.push_str(&t.xml10_content()),
            Event::GeneralRef(r) => text.push_str(&entity(r)),
            Event::End(e) => {
                let local = e.local_name().as_ref().to_string();
                stack.pop();
                let in_ser = stack.iter().any(|s| s == "ser");
                let parent = |name: &str| stack.iter().any(|s| s == name);
                if local == "t" && parent("title") && !in_ser {
                    if parent("catAx") || parent("dateAx") {
                        chart.x_title.push_str(&text);
                    } else if parent("valAx") {
                        // En dispersión los dos ejes son de valores: el de abajo es el X.
                        if chart.kind == "scatter" && axis_pos == "b" {
                            chart.x_title.push_str(&text);
                        } else {
                            chart.y_title.push_str(&text);
                        }
                    } else {
                        chart.title.push_str(&text);
                    }
                }
                if let Some(s) = series.as_mut() {
                    match local.as_str() {
                        "f" if parent("tx") => s.name_ref = Some(text.clone()),
                        "f" if parent("cat") || parent("xVal") => s.categories = Some(text.clone()),
                        "f" if parent("val") || parent("yVal") => s.values = text.clone(),
                        "v" if parent("tx") && s.name.is_none() => s.name = Some(text.clone()),
                        "v" if (parent("cat") || parent("xVal")) && parent("pt") => s.category_cache.push(text.clone()),
                        "v" if (parent("val") || parent("yVal")) && parent("pt") => s.value_cache.push(text.trim().parse().ok()),
                        _ => {}
                    }
                }
                if local == "ser" {
                    if let Some(s) = series.take() {
                        if !s.values.is_empty() {
                            chart.series.push(s);
                        } else {
                            partial = true; // serie con datos escritos sin referencia
                        }
                    }
                }
                text.clear();
            }
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }
    if title_deleted {
        chart.title.clear();
    }
    if chart.kind.is_empty() || chart.series.is_empty() {
        return Ok((None, true));
    }
    Ok((Some(chart), partial))
}

/// Solo las validaciones de tipo lista, que son las que WEPO entiende.
fn parse_validations(xml: &[u8]) -> Result<Vec<RawValidation>, String> {
    let mut reader = Reader::from_reader(xml);
    let mut buf = Vec::new();
    let mut found = Vec::new();
    let mut current: Option<RawValidation> = None;
    // En qué fórmula estamos (1 o 2) y su texto.
    let mut in_formula = 0;
    let mut formulas = [String::new(), String::new()];
    loop {
        match reader.read_event_into(&mut buf).map_err(|e| e.to_string())? {
            Event::Start(e) if e.local_name().as_ref() == "dataValidation" => {
                let a = attributes(&e);
                let kind = a.get("type").cloned().unwrap_or_default();
                current = matches!(kind.as_str(), "list" | "whole" | "decimal" | "date").then(|| RawValidation {
                    sqref: a.get("sqref").cloned().unwrap_or_default(),
                    operator: a.get("operator").cloned().unwrap_or_else(|| "between".into()),
                    error: a.get("error").cloned().filter(|e| !e.is_empty()),
                    kind,
                    ..Default::default()
                });
                formulas = [String::new(), String::new()];
            }
            Event::Start(e) if e.local_name().as_ref() == "formula1" => in_formula = 1,
            Event::Start(e) if e.local_name().as_ref() == "formula2" => in_formula = 2,
            Event::End(e) if matches!(e.local_name().as_ref(), "formula1" | "formula2") => in_formula = 0,
            Event::Text(t) if in_formula > 0 => formulas[in_formula - 1].push_str(&t.xml10_content()),
            Event::GeneralRef(r) if in_formula > 0 => formulas[in_formula - 1].push_str(&entity(&r)),
            Event::End(e) if e.local_name().as_ref() == "dataValidation" => {
                if let Some(mut v) = current.take() {
                    if !v.sqref.is_empty() && !formulas[0].is_empty() {
                        v.formula1 = formulas[0].clone();
                        v.formula2 = Some(formulas[1].clone()).filter(|f| !f.is_empty());
                        found.push(v);
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
            let operator = if v.kind == "list" { String::new() } else { format!(r#" operator="{}""#, escape(&v.operator)) };
            let error = v
                .error
                .as_ref()
                .map(|e| format!(r#" errorTitle="WEPO" error="{}""#, escape(e)))
                .unwrap_or_default();
            let formula2 = v.formula2.as_ref().map(|f| format!("<formula2>{}</formula2>", escape(f))).unwrap_or_default();
            format!(
                r#"<dataValidation type="{}"{operator} allowBlank="1" showErrorMessage="1"{error} sqref="{}"><formula1>{}</formula1>{formula2}</dataValidation>"#,
                escape(&v.kind),
                escape(&v.sqref),
                escape(&v.formula1)
            )
        })
        .collect();
    format!(r#"<dataValidations count="{}">{items}</dataValidations>"#, validations.len())
}

/// Etiquetas que van después de <legacyDrawing> (el VML de las notas) en una hoja.
const AFTER_LEGACY_DRAWING: &[&str] = &[
    "<legacyDrawingHF", "<drawingHF", "<picture", "<oleObjects", "<controls", "<webPublishItems",
    "<tableParts", "<extLst", "</worksheet>",
];

const NS_MAIN: &str = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

/// Etiquetas que van después de <headerFooter> en una hoja.
const AFTER_HEADER_FOOTER: &[&str] = &[
    "<rowBreaks", "<colBreaks", "<customProperties", "<cellWatches", "<ignoredErrors", "<smartTags", "<drawing",
    "<legacyDrawing", "<legacyDrawingHF", "<drawingHF", "<picture", "<oleObjects", "<controls", "<webPublishItems",
    "<tableParts", "<extLst", "</worksheet>",
];

/// Etiquetas que van después de <tableParts>.
const AFTER_TABLE_PARTS: &[&str] = &["<extLst", "</worksheet>"];

fn table_xml(table: &RawTable) -> String {
    let columns: String = table
        .columns
        .iter()
        .enumerate()
        .map(|(i, name)| {
            let label = if table.totals && i == 0 { r#" totalsRowLabel="Total""# } else { "" };
            format!(r#"<tableColumn id="{}" name="{}"{label}/>"#, i + 1, escape(name))
        })
        .collect();
    let totals = if table.totals { r#" totalsRowCount="1""# } else { "" };
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><table xmlns="{NS_MAIN}" id="{id}" name="{name}" displayName="{name}" ref="{reference}"{totals}><autoFilter ref="{filter}"/><tableColumns count="{count}">{columns}</tableColumns><tableStyleInfo name="{style}" showFirstColumn="0" showLastColumn="0" showRowStripes="{bands}" showColumnStripes="0"/></table>"#,
        id = table.id,
        name = escape(&table.name),
        reference = table.reference,
        filter = table.filter_ref,
        count = table.columns.len(),
        style = escape(&table.style),
        bands = u8::from(table.banded),
    )
}

/// Quita un elemento completo (<tag …>…</tag> o <tag …/>) si está.
fn remove_element(xml: &str, tag: &str) -> String {
    let open = format!("<{tag}");
    let Some(start) = xml.match_indices(&open).map(|(i, _)| i).find(|&i| matches!(xml[i + open.len()..].chars().next(), Some(' ' | '>' | '/'))) else {
        return xml.to_string();
    };
    let rest = &xml[start..];
    let end = if let Some(close) = rest.find(&format!("</{tag}>")) {
        close + tag.len() + 3
    } else if let Some(close) = rest.find("/>") {
        close + 2
    } else {
        return xml.to_string();
    };
    format!("{}{}", &xml[..start], &xml[start + end..])
}

/// Pone las filas que se repiten y el área de impresión en los nombres definidos del libro.
fn set_print_names(workbook: &str, pages: &[&RawPage]) -> String {
    let mut xml = workbook.to_string();
    // Primero se quitan los que ya hubiera para esas hojas.
    for page in pages {
        for name in ["_xlnm.Print_Titles", "_xlnm.Print_Area"] {
            for quote in ['"', '\''] {
                let marker = format!("name={quote}{name}{quote} localSheetId={quote}{}{quote}", page.sheet_index);
                while let Some(i) = xml.find(&marker) {
                    let start = xml[..i].rfind("<definedName").unwrap_or(i);
                    let Some(end) = xml[start..].find("</definedName>").map(|e| start + e + "</definedName>".len()) else { break };
                    xml.replace_range(start..end, "");
                }
            }
        }
    }
    let mut names = String::new();
    for page in pages {
        if let Some(titles) = &page.titles {
            names.push_str(&format!(r#"<definedName name="_xlnm.Print_Titles" localSheetId="{}">{}</definedName>"#, page.sheet_index, escape(titles)));
        }
        if let Some(area) = &page.area {
            names.push_str(&format!(r#"<definedName name="_xlnm.Print_Area" localSheetId="{}">{}</definedName>"#, page.sheet_index, escape(area)));
        }
    }
    if names.is_empty() {
        return xml.replace("<definedNames></definedNames>", "").replace("<definedNames/>", "");
    }
    if let Some(i) = xml.find("</definedNames>") {
        xml.insert_str(i, &names);
    } else if let Some(i) = xml.find("</sheets>") {
        xml.insert_str(i + "</sheets>".len(), &format!("<definedNames>{names}</definedNames>"));
    }
    xml
}

/// Las notas en el formato de Excel: el texto (commentsN.xml) y el cuadro amarillo
/// que se ve al pasar el mouse, que Excel todavía dibuja con VML (vmlDrawingN.vml).
fn notes_xml(notes: &[RawNote], n: usize) -> (String, String) {
    let mut authors: Vec<&str> = Vec::new();
    let mut list = String::new();
    let mut shapes = String::new();
    for (i, note) in notes.iter().enumerate() {
        let author = match authors.iter().position(|a| *a == note.author) {
            Some(p) => p,
            None => {
                authors.push(&note.author);
                authors.len() - 1
            }
        };
        list.push_str(&format!(
            r#"<comment ref="{}" authorId="{author}"><text><r><t xml:space="preserve">{}</t></r></text></comment>"#,
            note.cell_ref,
            escape(&note.text)
        ));
        let (r, c) = (note.row, note.col);
        shapes.push_str(&format!(
            r##"<v:shape id="_x0000_s{id}" type="#_x0000_t202" style="position:absolute;margin-left:59.25pt;margin-top:1.5pt;width:144pt;height:72pt;z-index:{z};visibility:hidden" fillcolor="#ffffe1" o:insetmode="auto"><v:fill color2="#ffffe1"/><v:shadow on="t" color="black" obscured="t"/><v:path o:connecttype="none"/><v:textbox style="mso-direction-alt:auto"><div style="text-align:left"></div></v:textbox><x:ClientData ObjectType="Note"><x:MoveWithCells/><x:SizeWithCells/><x:Anchor>{c1}, 15, {r0}, 10, {c2}, 15, {r2}, 4</x:Anchor><x:AutoFill>False</x:AutoFill><x:Row>{r}</x:Row><x:Column>{c}</x:Column></x:ClientData></v:shape>"##,
            id = 1024 * n + i + 1,
            z = i + 1,
            c1 = c + 1,
            r0 = r.max(1) - 1,
            c2 = c + 3,
            r2 = r + 3,
        ));
    }
    let authors: String = authors.iter().map(|a| format!("<author>{}</author>", escape(a))).collect();
    let comments = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><comments xmlns="{NS_MAIN}"><authors>{authors}</authors><commentList>{list}</commentList></comments>"#
    );
    let vml = format!(
        r#"<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><o:shapelayout v:ext="edit"><o:idmap v:ext="edit" data="{n}"/></o:shapelayout><v:shapetype id="_x0000_t202" coordsize="21600,21600" o:spt="202" path="m,l,21600r21600,l21600,xe"><v:stroke joinstyle="miter"/><v:path gradientshapeok="t" o:connecttype="rect"/></v:shapetype>{shapes}</xml>"#
    );
    (comments, vml)
}

/// Etiquetas que van después de <drawing> en una hoja.
const AFTER_DRAWING: &[&str] = &[
    "<legacyDrawing", "<legacyDrawingHF", "<drawingHF", "<picture", "<oleObjects", "<controls",
    "<webPublishItems", "<tableParts", "<extLst", "</worksheet>",
];

const NS_R: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_C: &str = "http://schemas.openxmlformats.org/drawingml/2006/chart";
const NS_A: &str = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_XDR: &str = "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing";
const REL_TYPE: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

fn set_entry(entries: &mut Entries, name: &str, data: Vec<u8>) {
    match entries.iter_mut().find(|(n, _)| n == name) {
        Some(e) => e.1 = data,
        None => entries.push((name.to_string(), data)),
    }
}

/// Agrega una relación a un archivo .rels (lo crea si no existe) y devuelve su Id.
fn add_relationship(entries: &mut Entries, part: &str, kind: &str, target: &str) -> String {
    let path = rels_path(part);
    let mut xml = entry(entries, &path)
        .map(|d| String::from_utf8_lossy(d).into_owned())
        .unwrap_or_else(|| format!(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>"#));
    let mut n = 1;
    while xml.contains(&format!(r#"Id="rIdW{n}""#)) {
        n += 1;
    }
    let id = format!("rIdW{n}");
    let rel = format!(r#"<Relationship Id="{id}" Type="{REL_TYPE}/{kind}" Target="{}"/>"#, escape(target));
    xml = xml.replace("</Relationships>", &format!("{rel}</Relationships>"));
    set_entry(entries, &path, xml.into_bytes());
    id
}

fn add_content_type(entries: &mut Entries, part: Option<&str>, extension: Option<(&str, &str)>, content_type: &str) {
    let Some(data) = entry(entries, "[Content_Types].xml") else { return };
    let mut xml = String::from_utf8_lossy(data).into_owned();
    if let Some(part) = part {
        if !xml.contains(&format!(r#"PartName="/{part}""#)) {
            xml = xml.replace("</Types>", &format!(r#"<Override PartName="/{part}" ContentType="{content_type}"/></Types>"#));
        }
    }
    if let Some((ext, ct)) = extension {
        if !xml.contains(&format!(r#"Extension="{ext}""#)) {
            xml = xml.replace("</Types>", &format!(r#"<Default Extension="{ext}" ContentType="{ct}"/></Types>"#));
        }
    }
    set_entry(entries, "[Content_Types].xml", xml.into_bytes());
}

fn marker(tag: &str, p: &CellOffset) -> String {
    format!(
        "<xdr:{tag}><xdr:col>{}</xdr:col><xdr:colOff>{}</xdr:colOff><xdr:row>{}</xdr:row><xdr:rowOff>{}</xdr:rowOff></xdr:{tag}>",
        p.col, p.col_off, p.row, p.row_off
    )
}

fn anchor_xml(anchor: &RawAnchor, body: &str) -> String {
    match anchor {
        RawAnchor::TwoCell(from, to) => format!(
            r#"<xdr:twoCellAnchor editAs="oneCell">{}{}{body}<xdr:clientData/></xdr:twoCellAnchor>"#,
            marker("from", from),
            marker("to", to)
        ),
        RawAnchor::OneCell(from, cx, cy) => format!(
            r#"<xdr:oneCellAnchor>{}<xdr:ext cx="{cx}" cy="{cy}"/>{body}<xdr:clientData/></xdr:oneCellAnchor>"#,
            marker("from", from)
        ),
        RawAnchor::Absolute(x, y, cx, cy) => format!(
            r#"<xdr:absoluteAnchor><xdr:pos x="{x}" y="{y}"/><xdr:ext cx="{cx}" cy="{cy}"/>{body}<xdr:clientData/></xdr:absoluteAnchor>"#
        ),
    }
}

fn number(v: f64) -> String {
    if v.fract() == 0.0 && v.abs() < 1e15 { format!("{}", v as i64) } else { format!("{v}") }
}

fn str_ref(reference: &str, cache: &[String]) -> String {
    let points: String = cache.iter().enumerate().map(|(i, v)| format!(r#"<c:pt idx="{i}"><c:v>{}</c:v></c:pt>"#, escape(v))).collect();
    format!(r#"<c:strRef><c:f>{}</c:f><c:strCache><c:ptCount val="{}"/>{points}</c:strCache></c:strRef>"#, escape(reference), cache.len())
}

fn num_ref(reference: &str, cache: &[Option<f64>]) -> String {
    let points: String = cache
        .iter()
        .enumerate()
        .filter_map(|(i, v)| v.map(|v| format!(r#"<c:pt idx="{i}"><c:v>{}</c:v></c:pt>"#, number(v))))
        .collect();
    format!(
        r#"<c:numRef><c:f>{}</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="{}"/>{points}</c:numCache></c:numRef>"#,
        escape(reference),
        cache.len()
    )
}

/// XML de una gráfica en el formato de Excel (DrawingML).
fn chart_xml(chart: &RawChart) -> String {
    let fill = |color: &Option<String>, line: bool| match color {
        Some(c) => {
            let hex = c.trim_start_matches('#');
            if line {
                format!(r#"<c:spPr><a:ln w="28575" cap="rnd"><a:solidFill><a:srgbClr val="{hex}"/></a:solidFill></a:ln></c:spPr>"#)
            } else {
                format!(r#"<c:spPr><a:solidFill><a:srgbClr val="{hex}"/></a:solidFill></c:spPr>"#)
            }
        }
        None => String::new(),
    };
    let kind = chart.kind.as_str();
    let pie = matches!(kind, "pie" | "doughnut");
    let labels = if chart.labels {
        r#"<c:dLbls><c:showLegendKey val="0"/><c:showVal val="1"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="0"/><c:showBubbleSize val="0"/></c:dLbls>"#
    } else {
        ""
    };
    // Cada serie se escribe según cómo se dibuja (en la combinada, la última es línea).
    let ser = |i: usize, s: &RawSeries, as_kind: &str| {
        let tx = match (&s.name_ref, &s.name) {
            (Some(r), name) => format!("<c:tx>{}</c:tx>", str_ref(r, &name.iter().cloned().collect::<Vec<_>>())),
            (None, Some(n)) => format!("<c:tx><c:v>{}</c:v></c:tx>", escape(n)),
            (None, None) => String::new(),
        };
        let line = as_kind == "line" || as_kind == "scatter";
        let sp = if pie { String::new() } else { fill(&s.color, line) };
        let extra = match as_kind {
            "column" | "bar" => r#"<c:invertIfNegative val="0"/>"#.to_string(),
            "line" => r#"<c:marker><c:symbol val="circle"/><c:size val="5"/></c:marker>"#.to_string(),
            "scatter" => r#"<c:marker><c:symbol val="circle"/><c:size val="6"/></c:marker>"#.to_string(),
            _ => String::new(),
        };
        let data = if as_kind == "scatter" {
            let x = s.categories.as_ref().map(|c| {
                let xs: Vec<Option<f64>> = s.category_cache.iter().map(|v| v.parse().ok()).collect();
                format!("<c:xVal>{}</c:xVal>", num_ref(c, &xs))
            });
            format!("{}<c:yVal>{}</c:yVal><c:smooth val=\"0\"/>", x.unwrap_or_default(), num_ref(&s.values, &s.value_cache))
        } else {
            let cat = s.categories.as_ref().map(|c| format!("<c:cat>{}</c:cat>", str_ref(c, &s.category_cache))).unwrap_or_default();
            let smooth = if as_kind == "line" { r#"<c:smooth val="0"/>"# } else { "" };
            format!("{cat}<c:val>{}</c:val>{smooth}", num_ref(&s.values, &s.value_cache))
        };
        format!(r#"<c:ser><c:idx val="{i}"/><c:order val="{i}"/>{tx}{sp}{extra}{data}</c:ser>"#)
    };
    let all = |as_kind: &str, range: std::ops::Range<usize>| -> String {
        chart.series.iter().enumerate().filter(|(i, _)| range.contains(i)).map(|(i, s)| ser(i, s, as_kind)).collect()
    };
    let n = chart.series.len();
    let grouping = if chart.stacked { "stacked" } else { "clustered" };
    let standard = if chart.stacked { "stacked" } else { "standard" };
    let overlap = if chart.stacked { r#"<c:overlap val="100"/>"# } else { "" };
    let axes_ids = r#"<c:axId val="500000001"/><c:axId val="500000002"/>"#;
    let bar = |dir: &str, series: String| {
        format!(r#"<c:barChart><c:barDir val="{dir}"/><c:grouping val="{grouping}"/><c:varyColors val="0"/>{series}{labels}<c:gapWidth val="150"/>{overlap}{axes_ids}</c:barChart>"#)
    };
    let line = |series: String| format!(r#"<c:lineChart><c:grouping val="{standard}"/><c:varyColors val="0"/>{series}{labels}<c:marker val="1"/>{axes_ids}</c:lineChart>"#);
    let plot = match kind {
        "column" => bar("col", all("column", 0..n)),
        "bar" => bar("bar", all("bar", 0..n)),
        // Combinada: columnas para todas menos la última, que va como línea sobre los mismos ejes.
        "combo" if n > 1 => bar("col", all("column", 0..n - 1)) + &line(all("line", n - 1..n)),
        "combo" => bar("col", all("column", 0..n)),
        "line" => line(all("line", 0..n)),
        "area" => format!(r#"<c:areaChart><c:grouping val="{standard}"/><c:varyColors val="0"/>{}{labels}{axes_ids}</c:areaChart>"#, all("area", 0..n)),
        "pie" => format!(r#"<c:pieChart><c:varyColors val="1"/>{}{labels}<c:firstSliceAng val="0"/></c:pieChart>"#, all("pie", 0..n)),
        "doughnut" => format!(
            r#"<c:doughnutChart><c:varyColors val="1"/>{}{labels}<c:firstSliceAng val="0"/><c:holeSize val="50"/></c:doughnutChart>"#,
            all("doughnut", 0..n)
        ),
        _ => format!(r#"<c:scatterChart><c:scatterStyle val="lineMarker"/><c:varyColors val="0"/>{}{labels}{axes_ids}</c:scatterChart>"#, all("scatter", 0..n)),
    };
    let axis_title = |text: &str| {
        if text.is_empty() {
            String::new()
        } else {
            format!(
                r#"<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>{}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>"#,
                escape(text)
            )
        }
    };
    let axis = |id: &str, cross: &str, pos: &str, value: bool, grid: bool, title: &str| {
        let tag = if value { "valAx" } else { "catAx" };
        let grid = if grid { "<c:majorGridlines/>" } else { "" };
        let title = axis_title(title);
        let extra = if value { r#"<c:crossBetween val="between"/>"# } else { r#"<c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/>"# };
        format!(
            r#"<c:{tag}><c:axId val="{id}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="{pos}"/>{grid}{title}<c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="{cross}"/><c:crosses val="autoZero"/>{extra}</c:{tag}>"#
        )
    };
    let (xt, yt) = (chart.x_title.as_str(), chart.y_title.as_str());
    let axes = match kind {
        "pie" | "doughnut" => String::new(),
        "scatter" => axis("500000001", "500000002", "b", true, false, xt) + &axis("500000002", "500000001", "l", true, true, yt),
        "bar" => axis("500000001", "500000002", "l", false, false, xt) + &axis("500000002", "500000001", "b", true, true, yt),
        _ => axis("500000001", "500000002", "b", false, false, xt) + &axis("500000002", "500000001", "l", true, true, yt),
    };
    let title = if chart.title.is_empty() {
        r#"<c:autoTitleDeleted val="1"/>"#.to_string()
    } else {
        format!(
            r#"<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>{}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>"#,
            escape(&chart.title)
        )
    };
    let legend = if chart.legend { r#"<c:legend><c:legendPos val="r"/><c:overlay val="0"/></c:legend>"# } else { "" };
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><c:chartSpace xmlns:c="{NS_C}" xmlns:a="{NS_A}" xmlns:r="{NS_R}"><c:roundedCorners val="0"/><c:chart>{title}<c:plotArea><c:layout/>{plot}{axes}</c:plotArea>{legend}<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart></c:chartSpace>"#
    )
}

/// Agrega nuestras partes al .xlsx que acaba de escribir IronCalc.
pub fn write_extras(path: &str, sheets: &[(String, SheetExtras)]) -> Result<(), String> {
    if sheets.iter().all(|(_, e)| e.validations.is_empty() && e.drawings.is_empty() && e.notes.is_empty() && e.tables.is_empty() && e.page.is_none()) {
        return Ok(());
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    let mut entries = read_zip(&bytes)?;
    let paths = sheet_paths(&entries)?;
    let (mut drawing_n, mut chart_n, mut image_n, mut notes_n) = (0, 0, 0, 0);

    for (name, extras) in sheets {
        let Some((_, sheet_path)) = paths.iter().find(|(n, _)| n == name) else { continue };
        let sheet_path = sheet_path.clone();
        let Some(index) = entries.iter().position(|(n, _)| *n == sheet_path) else { continue };
        let mut xml = String::from_utf8(entries[index].1.clone()).map_err(|e| e.to_string())?;
        if !extras.validations.is_empty() && !xml.contains("<dataValidations") {
            xml = insert_before_first(&xml, &validations_xml(&extras.validations), AFTER_VALIDATIONS);
        }

        if !extras.drawings.is_empty() && !xml.contains("<drawing ") {
            drawing_n += 1;
            let drawing_path = format!("xl/drawings/drawing{drawing_n}.xml");
            let mut anchors = String::new();
            for (i, drawing) in extras.drawings.iter().enumerate() {
                let shape_id = i + 2;
                let body = match &drawing.content {
                    RawContent::Chart(chart) => {
                        chart_n += 1;
                        let chart_path = format!("xl/charts/chart{chart_n}.xml");
                        set_entry(&mut entries, &chart_path, chart_xml(chart).into_bytes());
                        add_content_type(&mut entries, Some(&chart_path), None, "application/vnd.openxmlformats-officedocument.drawingml.chart+xml");
                        let rid = add_relationship(&mut entries, &drawing_path, "chart", &format!("../charts/chart{chart_n}.xml"));
                        format!(
                            r#"<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="{shape_id}" name="Gráfica {chart_n}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="{NS_C}"><c:chart xmlns:c="{NS_C}" r:id="{rid}"/></a:graphicData></a:graphic></xdr:graphicFrame>"#
                        )
                    }
                    RawContent::Image { name, mime, data } => {
                        image_n += 1;
                        let ext = match mime.as_str() {
                            "image/jpeg" => "jpeg",
                            "image/gif" => "gif",
                            _ => "png",
                        };
                        let media = format!("xl/media/image{image_n}.{ext}");
                        set_entry(&mut entries, &media, data.clone());
                        add_content_type(&mut entries, None, Some((ext, mime)), "");
                        let rid = add_relationship(&mut entries, &drawing_path, "image", &format!("../media/image{image_n}.{ext}"));
                        let (cx, cy) = match drawing.anchor {
                            RawAnchor::OneCell(_, cx, cy) | RawAnchor::Absolute(_, _, cx, cy) => (cx, cy),
                            RawAnchor::TwoCell(..) => (0, 0),
                        };
                        format!(
                            r#"<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="{shape_id}" name="{}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="{rid}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic>"#,
                            escape(if name.is_empty() { "Imagen" } else { name })
                        )
                    }
                };
                anchors.push_str(&anchor_xml(&drawing.anchor, &body));
            }
            let drawing_xml = format!(
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr xmlns:xdr="{NS_XDR}" xmlns:a="{NS_A}" xmlns:r="{NS_R}">{anchors}</xdr:wsDr>"#
            );
            set_entry(&mut entries, &drawing_path, drawing_xml.into_bytes());
            add_content_type(&mut entries, Some(&drawing_path), None, "application/vnd.openxmlformats-officedocument.drawing+xml");
            let file = drawing_path.rsplit('/').next().unwrap_or_default();
            let rid = add_relationship(&mut entries, &sheet_path, "drawing", &format!("../drawings/{file}"));
            xml = insert_before_first(&xml, &format!(r#"<drawing xmlns:r="{NS_R}" r:id="{rid}"/>"#), AFTER_DRAWING);
        }

        if !extras.notes.is_empty() && !xml.contains("<legacyDrawing ") {
            notes_n += 1;
            let (comments, vml) = notes_xml(&extras.notes, notes_n);
            let comments_path = format!("xl/comments{notes_n}.xml");
            let vml_path = format!("xl/drawings/vmlDrawing{notes_n}.vml");
            set_entry(&mut entries, &comments_path, comments.into_bytes());
            set_entry(&mut entries, &vml_path, vml.into_bytes());
            add_content_type(&mut entries, Some(&comments_path), None, "application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml");
            add_content_type(&mut entries, None, Some(("vml", "application/vnd.openxmlformats-officedocument.vmlDrawing")), "");
            add_relationship(&mut entries, &sheet_path, "comments", &format!("../comments{notes_n}.xml"));
            let rid = add_relationship(&mut entries, &sheet_path, "vmlDrawing", &format!("../drawings/vmlDrawing{notes_n}.vml"));
            xml = insert_before_first(&xml, &format!(r#"<legacyDrawing xmlns:r="{NS_R}" r:id="{rid}"/>"#), AFTER_LEGACY_DRAWING);
        }
        if let Some(page) = &extras.page {
            if !page.header.is_empty() || !page.footer.is_empty() {
                xml = remove_element(&xml, "headerFooter");
                let mut hf = String::from("<headerFooter>");
                if !page.header.is_empty() {
                    hf.push_str(&format!("<oddHeader>{}</oddHeader>", escape(&page.header)));
                }
                if !page.footer.is_empty() {
                    hf.push_str(&format!("<oddFooter>{}</oddFooter>", escape(&page.footer)));
                }
                hf.push_str("</headerFooter>");
                xml = insert_before_first(&xml, &hf, AFTER_HEADER_FOOTER);
            }
        }

        if !extras.tables.is_empty() && !xml.contains("<tableParts") {
            let mut parts = String::new();
            for table in &extras.tables {
                let table_path = format!("xl/tables/table{}.xml", table.id);
                set_entry(&mut entries, &table_path, table_xml(table).into_bytes());
                add_content_type(&mut entries, Some(&table_path), None, "application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml");
                let rid = add_relationship(&mut entries, &sheet_path, "table", &format!("../tables/table{}.xml", table.id));
                parts.push_str(&format!(r#"<tablePart r:id="{rid}"/>"#));
            }
            xml = insert_before_first(
                &xml,
                &format!(r#"<tableParts xmlns:r="{NS_R}" count="{}">{parts}</tableParts>"#, extras.tables.len()),
                AFTER_TABLE_PARTS,
            );
        }

        let index = entries.iter().position(|(n, _)| *n == sheet_path).unwrap_or(index);
        entries[index].1 = xml.into_bytes();
    }
    let pages: Vec<&RawPage> = sheets.iter().filter_map(|(_, e)| e.page.as_ref()).collect();
    if !pages.is_empty() {
        if let Some(workbook) = entry(&entries, "xl/workbook.xml") {
            let xml = set_print_names(&String::from_utf8_lossy(workbook), &pages);
            set_entry(&mut entries, "xl/workbook.xml", xml.into_bytes());
        }
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
        assert_eq!(found.len(), 3);
        assert_eq!(found[0].sqref, "B2:B9 D2");
        assert_eq!(found[0].formula1, "\"Sí,No,Tal vez\"");
        assert_eq!((found[1].kind.as_str(), found[1].operator.as_str(), found[1].formula1.as_str()), ("whole", "between", "1"));
        assert_eq!(found[2].formula1, "Opciones!$A$1:$A$3");
    }
}
