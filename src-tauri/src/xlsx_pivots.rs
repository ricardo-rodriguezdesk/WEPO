//! Tablas dinámicas en el .xlsx.
//!
//! IronCalc no las lee ni las escribe. Al abrir leemos su definición (de qué
//! rango salen y qué campo va en filas, columnas, valores y filtros) para que
//! WEPO las pueda actualizar y editar; al guardar escribimos una tabla dinámica
//! de verdad (definición, caché y registros), como la escribe Excel, con
//! «actualizar al abrir» para que Excel la vuelva a calcular él mismo.

use std::collections::HashMap;
use std::fs;

use quick_xml::events::Event;
use quick_xml::Reader;

use crate::xlsx_extras::{add_content_type, add_relationship, attributes, entry, escape, read_zip, relationships, set_entry, sheet_paths, write_zip};

/// Una tabla dinámica tal como viene en el archivo.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct RawPivotIn {
    /// Hoja donde está la tabla dinámica.
    pub sheet: String,
    pub name: String,
    /// Dónde está la tabla (sin los filtros de arriba): "A3:C7".
    pub location: String,
    /// De dónde salen los datos: una hoja y un rango, o el nombre de una tabla.
    pub source_sheet: Option<String>,
    pub source_ref: Option<String>,
    pub source_name: Option<String>,
    /// Nombre de cada campo (columna de los datos).
    pub fields: Vec<String>,
    pub rows: Vec<u32>,
    pub cols: Vec<u32>,
    /// (campo, función: sum, count, average, max o min).
    pub values: Vec<(u32, String)>,
    /// Filtros de arriba: (campo, elementos que no se muestran).
    pub filters: Vec<(u32, Vec<String>)>,
}

/// Un valor de los datos, para la caché que va en el archivo.
#[derive(Clone, Debug, PartialEq)]
pub enum CacheValue {
    Text(String),
    /// El número y cómo se ve en la hoja.
    Number(f64, String),
    Blank,
}

impl CacheValue {
    /// El texto con que aparece en la tabla dinámica.
    pub fn label(&self) -> &str {
        match self {
            CacheValue::Text(t) | CacheValue::Number(_, t) => t,
            CacheValue::Blank => "",
        }
    }
}

/// Una tabla dinámica lista para escribirla.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct RawPivotOut {
    pub sheet: String,
    pub name: String,
    /// La tabla sin los filtros: "A3:C7".
    pub location: String,
    pub source_sheet: String,
    pub source_ref: String,
    pub fields: Vec<String>,
    /// Una fila por registro de los datos, un valor por campo.
    pub records: Vec<Vec<CacheValue>>,
    pub rows: Vec<u32>,
    pub cols: Vec<u32>,
    /// (campo, función, título como «Suma de Ventas»).
    pub values: Vec<(u32, String, String)>,
    pub filters: Vec<(u32, Vec<String>)>,
}

const NS_MAIN: &str = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const NS_R: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

// ───────────── leer ─────────────

#[derive(Default)]
struct Cache {
    source_sheet: Option<String>,
    source_ref: Option<String>,
    source_name: Option<String>,
    fields: Vec<String>,
    /// Elementos de cada campo, como texto.
    items: Vec<Vec<String>>,
    /// Campos calculados o agrupados (fechas por mes, rangos…): WEPO no los sabe rehacer.
    unsupported: bool,
}

fn number_text(v: &str) -> String {
    match v.parse::<f64>() {
        Ok(n) if n.fract() == 0.0 && n.abs() < 1e15 => format!("{}", n as i64),
        Ok(n) => format!("{n}"),
        Err(_) => v.to_string(),
    }
}

fn parse_cache(xml: &[u8]) -> Result<Cache, String> {
    let mut cache = Cache::default();
    let mut reader = Reader::from_reader(xml);
    let mut buf = Vec::new();
    let mut in_shared = false;
    loop {
        let event = reader.read_event_into(&mut buf).map_err(|e| e.to_string())?;
        let empty = matches!(event, Event::Empty(_));
        match event {
            Event::Start(e) | Event::Empty(e) => {
                let a = attributes(&e);
                match e.local_name().as_ref() {
                    "worksheetSource" => {
                        cache.source_sheet = a.get("sheet").cloned();
                        cache.source_ref = a.get("ref").cloned();
                        cache.source_name = a.get("name").cloned();
                        if a.contains_key("r:id") || a.contains_key("id") {
                            cache.unsupported = true;
                        }
                    }
                    "cacheSource" if a.get("type").is_some_and(|t| t != "worksheet") => cache.unsupported = true,
                    "cacheField" => {
                        cache.fields.push(a.get("name").cloned().unwrap_or_default());
                        cache.items.push(Vec::new());
                        if a.contains_key("formula") || a.get("databaseField").is_some_and(|v| v == "0") {
                            cache.unsupported = true;
                        }
                    }
                    "fieldGroup" => cache.unsupported = true,
                    "sharedItems" => in_shared = !empty,
                    "s" | "n" | "b" | "d" | "e" | "m" if in_shared => {
                        let v = a.get("v").cloned().unwrap_or_default();
                        let text = match e.local_name().as_ref() {
                            "n" => number_text(&v),
                            "b" => if v == "1" || v == "true" { "VERDADERO".into() } else { "FALSO".into() },
                            "m" => String::new(),
                            _ => v,
                        };
                        if let Some(list) = cache.items.last_mut() {
                            list.push(text);
                        }
                    }
                    _ => {}
                }
            }
            Event::End(e) if e.local_name().as_ref() == "sharedItems" => in_shared = false,
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }
    Ok(cache)
}

#[derive(Default)]
struct Definition {
    name: String,
    location: String,
    /// Por campo: elementos (índice en la caché, ¿escondido?).
    items: Vec<Vec<(usize, bool)>>,
    rows: Vec<i32>,
    cols: Vec<i32>,
    /// (campo, elemento elegido)
    pages: Vec<(u32, Option<usize>)>,
    values: Vec<(u32, String)>,
    unsupported: bool,
}

fn parse_definition(xml: &[u8]) -> Result<Definition, String> {
    let mut def = Definition::default();
    let mut reader = Reader::from_reader(xml);
    let mut buf = Vec::new();
    let mut section = String::new();
    loop {
        match reader.read_event_into(&mut buf).map_err(|e| e.to_string())? {
            Event::Start(e) | Event::Empty(e) => {
                let a = attributes(&e);
                let tag = e.local_name().as_ref().to_string();
                match tag.as_str() {
                    "pivotTableDefinition" => def.name = a.get("name").cloned().unwrap_or_default(),
                    "location" => def.location = a.get("ref").cloned().unwrap_or_default(),
                    "pivotFields" | "rowFields" | "colFields" => section = tag,
                    "pivotField" => def.items.push(Vec::new()),
                    "item" if section == "pivotFields" => {
                        if let (Some(x), Some(list)) = (a.get("x").and_then(|x| x.parse().ok()), def.items.last_mut()) {
                            list.push((x, a.get("h").is_some_and(|h| h == "1" || h == "true")));
                        }
                    }
                    "field" => {
                        let x: i32 = a.get("x").and_then(|x| x.parse().ok()).unwrap_or(-2);
                        match section.as_str() {
                            "rowFields" => def.rows.push(x),
                            "colFields" => def.cols.push(x),
                            _ => {}
                        }
                    }
                    "pageField" => {
                        if let Some(fld) = a.get("fld").and_then(|x| x.parse().ok()) {
                            def.pages.push((fld, a.get("item").and_then(|x| x.parse().ok())));
                        }
                    }
                    "dataField" => {
                        let fld = a.get("fld").and_then(|x| x.parse().ok()).unwrap_or(0);
                        let func = match a.get("subtotal").map(String::as_str).unwrap_or("sum") {
                            "sum" => "sum",
                            "count" | "countNums" => "count",
                            "average" => "average",
                            "max" => "max",
                            "min" => "min",
                            _ => {
                                def.unsupported = true;
                                "sum"
                            }
                        };
                        if a.get("showDataAs").is_some_and(|v| v != "normal") {
                            def.unsupported = true;
                        }
                        def.values.push((fld, func.to_string()));
                    }
                    _ => {}
                }
            }
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }
    Ok(def)
}

/// Tablas dinámicas del libro. El `bool` dice si alguna tiene algo que WEPO no sabe rehacer.
pub fn read_pivots(path: &str) -> Result<(Vec<RawPivotIn>, bool), String> {
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    let entries = read_zip(&bytes)?;
    let mut found = Vec::new();
    let mut unsupported = false;
    for (sheet, sheet_path) in sheet_paths(&entries)? {
        for (kind, pivot_path) in relationships(&entries, &sheet_path).into_values() {
            if kind != "pivotTable" {
                continue;
            }
            let Some(xml) = entry(&entries, &pivot_path) else { continue };
            let def = parse_definition(xml)?;
            let cache_path = relationships(&entries, &pivot_path).into_values().find(|(k, _)| k == "pivotCacheDefinition").map(|(_, p)| p);
            let Some(cache) = cache_path.and_then(|p| entry(&entries, &p)).map(parse_cache).transpose()? else {
                unsupported = true;
                continue;
            };
            if def.unsupported || cache.unsupported || def.location.is_empty() {
                unsupported = true;
            }
            let item_text = |field: usize, x: usize| cache.items.get(field).and_then(|l| l.get(x)).cloned().unwrap_or_default();
            let filters = def
                .pages
                .iter()
                .map(|&(fld, chosen)| {
                    let items = def.items.get(fld as usize).cloned().unwrap_or_default();
                    let hidden: Vec<String> = match chosen {
                        // Un solo elemento elegido: los demás no se muestran.
                        Some(k) => items.iter().enumerate().filter(|(i, _)| *i != k).map(|(_, (x, _))| item_text(fld as usize, *x)).collect(),
                        None => items.iter().filter(|(_, h)| *h).map(|(x, _)| item_text(fld as usize, *x)).collect(),
                    };
                    (fld, hidden)
                })
                .collect();
            let positive = |list: &[i32]| list.iter().filter(|&&x| x >= 0).map(|&x| x as u32).collect::<Vec<_>>();
            found.push(RawPivotIn {
                sheet: sheet.clone(),
                name: def.name,
                location: def.location,
                source_sheet: cache.source_sheet,
                source_ref: cache.source_ref,
                source_name: cache.source_name,
                fields: cache.fields,
                rows: positive(&def.rows),
                cols: positive(&def.cols),
                values: def.values,
                filters,
            });
        }
    }
    Ok((found, unsupported))
}

// ───────────── escribir ─────────────

/// Orden de los elementos: primero los números (de menor a mayor), luego el texto (A → Z) y al final los vacíos.
pub fn compare_values(a: &CacheValue, b: &CacheValue) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    match (a, b) {
        (CacheValue::Number(x, _), CacheValue::Number(y, _)) => x.partial_cmp(y).unwrap_or(Ordering::Equal),
        (CacheValue::Number(..), _) => Ordering::Less,
        (_, CacheValue::Number(..)) => Ordering::Greater,
        (CacheValue::Blank, CacheValue::Blank) => Ordering::Equal,
        (CacheValue::Blank, _) => Ordering::Greater,
        (_, CacheValue::Blank) => Ordering::Less,
        (CacheValue::Text(x), CacheValue::Text(y)) => x.to_lowercase().cmp(&y.to_lowercase()),
    }
}

fn number_xml(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

fn value_xml(v: &CacheValue) -> String {
    match v {
        CacheValue::Text(t) => format!(r#"<s v="{}"/>"#, escape(t)),
        CacheValue::Number(n, _) => format!(r#"<n v="{}"/>"#, number_xml(*n)),
        CacheValue::Blank => "<m/>".into(),
    }
}

/// Atributos de <sharedItems> según lo que hay en la columna (Excel los revisa).
fn shared_flags(values: &[&CacheValue]) -> String {
    let numbers: Vec<f64> = values.iter().filter_map(|v| if let CacheValue::Number(n, _) = v { Some(*n) } else { None }).collect();
    let texts = values.iter().any(|v| matches!(v, CacheValue::Text(_)));
    let blanks = values.iter().any(|v| matches!(v, CacheValue::Blank));
    let mut flags = String::new();
    if !numbers.is_empty() {
        let min = numbers.iter().copied().fold(f64::INFINITY, f64::min);
        let max = numbers.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        if !texts {
            flags.push_str(r#" containsSemiMixedTypes="0" containsString="0""#);
        } else {
            flags.push_str(r#" containsMixedTypes="1""#);
        }
        flags.push_str(r#" containsNumber="1""#);
        if numbers.iter().all(|n| n.fract() == 0.0) {
            flags.push_str(r#" containsInteger="1""#);
        }
        flags.push_str(&format!(r#" minValue="{}" maxValue="{}""#, number_xml(min), number_xml(max)));
    } else if !texts && blanks {
        flags.push_str(r#" containsString="0""#);
    }
    if blanks {
        flags.push_str(r#" containsBlank="1""#);
    }
    flags
}

struct Written {
    cache: String,
    records: String,
    table: String,
}

fn pivot_parts(p: &RawPivotOut, cache_id: u32) -> Written {
    let n = p.fields.len();
    let axis: Vec<u32> = p.rows.iter().chain(&p.cols).chain(p.filters.iter().map(|(f, _)| f)).copied().collect();
    // Elementos distintos de cada campo que va en filas, columnas o filtros (en orden de aparición).
    let mut shared: Vec<Vec<CacheValue>> = vec![Vec::new(); n];
    let mut index: Vec<HashMap<String, usize>> = vec![HashMap::new(); n];
    let key = |v: &CacheValue| match v {
        CacheValue::Text(t) => format!("s{t}"),
        CacheValue::Number(x, _) => format!("n{x}"),
        CacheValue::Blank => "m".into(),
    };
    let mut records = String::new();
    for record in &p.records {
        records.push_str("<r>");
        for (f, value) in record.iter().enumerate().take(n) {
            if axis.contains(&(f as u32)) {
                let k = key(value);
                let next = shared[f].len();
                let x = *index[f].entry(k).or_insert(next);
                if x == next {
                    shared[f].push(value.clone());
                }
                records.push_str(&format!(r#"<x v="{x}"/>"#));
            } else {
                records.push_str(&value_xml(value));
            }
        }
        records.push_str("</r>");
    }

    let mut fields_xml = String::new();
    for (f, name) in p.fields.iter().enumerate() {
        let column: Vec<&CacheValue> = p.records.iter().filter_map(|r| r.get(f)).collect();
        let flags = shared_flags(&column);
        if axis.contains(&(f as u32)) {
            let items: String = shared[f].iter().map(value_xml).collect();
            fields_xml.push_str(&format!(
                r#"<cacheField name="{}" numFmtId="0"><sharedItems{flags} count="{}">{items}</sharedItems></cacheField>"#,
                escape(name),
                shared[f].len()
            ));
        } else {
            fields_xml.push_str(&format!(r#"<cacheField name="{}" numFmtId="0"><sharedItems{flags}/></cacheField>"#, escape(name)));
        }
    }
    let cache = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><pivotCacheDefinition xmlns="{NS_MAIN}" xmlns:r="{NS_R}" r:id="rIdW1" refreshOnLoad="1" refreshedBy="WEPO" createdVersion="6" refreshedVersion="6" minRefreshableVersion="3" recordCount="{}"><cacheSource type="worksheet"><worksheetSource ref="{}" sheet="{}"/></cacheSource><cacheFields count="{n}">{fields_xml}</cacheFields></pivotCacheDefinition>"#,
        p.records.len(),
        escape(&p.source_ref),
        escape(&p.source_sheet),
    );
    let records = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><pivotCacheRecords xmlns="{NS_MAIN}" xmlns:r="{NS_R}" count="{}">{records}</pivotCacheRecords>"#,
        p.records.len()
    );

    // Definición de la tabla: cada campo, con sus elementos en el orden en que se muestran.
    let mut pivot_fields = String::new();
    for f in 0..n as u32 {
        let data = if p.values.iter().any(|(v, _, _)| *v == f) { r#" dataField="1""# } else { "" };
        let axis_name = if p.rows.contains(&f) {
            Some("axisRow")
        } else if p.cols.contains(&f) {
            Some("axisCol")
        } else if p.filters.iter().any(|(x, _)| *x == f) {
            Some("axisPage")
        } else {
            None
        };
        match axis_name {
            Some(axis_name) => {
                let hidden = p.filters.iter().find(|(x, _)| *x == f).map(|(_, h)| h.clone()).unwrap_or_default();
                let mut order: Vec<usize> = (0..shared[f as usize].len()).collect();
                order.sort_by(|a, b| compare_values(&shared[f as usize][*a], &shared[f as usize][*b]));
                let items: String = order
                    .iter()
                    .map(|&x| {
                        let h = if hidden.iter().any(|t| t == shared[f as usize][x].label()) { r#" h="1""# } else { "" };
                        format!(r#"<item x="{x}"{h}/>"#)
                    })
                    .collect();
                let multi = if axis_name == "axisPage" && !hidden.is_empty() { r#" multipleItemSelectionAllowed="1""# } else { "" };
                pivot_fields.push_str(&format!(
                    r#"<pivotField axis="{axis_name}"{data}{multi} showAll="0"><items count="{}">{items}<item t="default"/></items></pivotField>"#,
                    order.len() + 1
                ));
            }
            None => pivot_fields.push_str(&format!(r#"<pivotField{data} showAll="0"/>"#)),
        }
    }
    let field_list = |list: &[u32], with_values: bool| {
        let mut items: Vec<String> = list.iter().map(|x| format!(r#"<field x="{x}"/>"#)).collect();
        if with_values {
            items.push(r#"<field x="-2"/>"#.into());
        }
        items
    };
    let mut table = String::new();
    let rows = field_list(&p.rows, false);
    if !rows.is_empty() {
        table.push_str(&format!(r#"<rowFields count="{}">{}</rowFields>"#, rows.len(), rows.concat()));
    }
    // Con varios valores, Excel los pone en columnas con el campo especial -2.
    let cols = field_list(&p.cols, p.values.len() > 1);
    if !cols.is_empty() {
        table.push_str(&format!(r#"<colFields count="{}">{}</colFields>"#, cols.len(), cols.concat()));
    }
    if !p.filters.is_empty() {
        let pages: String = p.filters.iter().map(|(f, _)| format!(r#"<pageField fld="{f}" hier="-1"/>"#)).collect();
        table.push_str(&format!(r#"<pageFields count="{}">{pages}</pageFields>"#, p.filters.len()));
    }
    if !p.values.is_empty() {
        let data: String = p
            .values
            .iter()
            .map(|(f, func, label)| {
                let subtotal = if func == "sum" { String::new() } else { format!(r#" subtotal="{func}""#) };
                format!(r#"<dataField name="{}" fld="{f}"{subtotal} baseField="0" baseItem="0"/>"#, escape(label))
            })
            .collect();
        table.push_str(&format!(r#"<dataFields count="{}">{data}</dataFields>"#, p.values.len()));
    }
    let pages_attr = if p.filters.is_empty() { String::new() } else { format!(r#" rowPageCount="{}" colPageCount="1""#, p.filters.len()) };
    let table = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><pivotTableDefinition xmlns="{NS_MAIN}" name="{}" cacheId="{cache_id}" applyNumberFormats="0" applyBorderFormats="0" applyFontFormats="0" applyPatternFormats="0" applyAlignmentFormats="0" applyWidthHeightFormats="1" dataCaption="Valores" updatedVersion="6" minRefreshableVersion="3" useAutoFormatting="1" itemPrintTitles="1" createdVersion="6" indent="0" outline="1" outlineData="1" multipleFieldFilters="0" rowHeaderCaption="Etiquetas de fila" colHeaderCaption="Etiquetas de columna" grandTotalCaption="Total general"><location ref="{}" firstHeaderRow="1" firstDataRow="1" firstDataCol="1"{pages_attr}/><pivotFields count="{n}">{pivot_fields}</pivotFields>{table}<pivotTableStyleInfo name="PivotStyleLight16" showRowHeaders="1" showColHeaders="1" showRowStripes="0" showColStripes="0" showLastColumn="1"/></pivotTableDefinition>"#,
        escape(&p.name),
        escape(&p.location),
    );
    Written { cache, records, table }
}

/// Quita del libro las tablas dinámicas que hubiera (por si el archivo ya las traía) y escribe las de WEPO.
pub fn write_pivots(path: &str, pivots: &[RawPivotOut]) -> Result<(), String> {
    if pivots.is_empty() {
        return Ok(());
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    let mut entries = read_zip(&bytes)?;
    let sheets = sheet_paths(&entries)?;
    let mut caches = String::new();
    for (i, pivot) in pivots.iter().enumerate() {
        let Some((_, sheet_path)) = sheets.iter().find(|(n, _)| *n == pivot.sheet) else { continue };
        let k = i + 1;
        let cache_id = k as u32;
        let parts = pivot_parts(pivot, cache_id);
        let table_path = format!("xl/pivotTables/pivotTable{k}.xml");
        let cache_path = format!("xl/pivotCache/pivotCacheDefinition{k}.xml");
        let records_path = format!("xl/pivotCache/pivotCacheRecords{k}.xml");
        set_entry(&mut entries, &table_path, parts.table.into_bytes());
        set_entry(&mut entries, &cache_path, parts.cache.into_bytes());
        set_entry(&mut entries, &records_path, parts.records.into_bytes());
        add_content_type(&mut entries, Some(&table_path), None, "application/vnd.openxmlformats-officedocument.spreadsheetml.pivotTable+xml");
        add_content_type(&mut entries, Some(&cache_path), None, "application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheDefinition+xml");
        add_content_type(&mut entries, Some(&records_path), None, "application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheRecords+xml");
        // La caché apunta a sus registros (el Id rIdW1 ya va escrito en la definición).
        add_relationship(&mut entries, &cache_path, "pivotCacheRecords", &format!("pivotCacheRecords{k}.xml"));
        add_relationship(&mut entries, &table_path, "pivotCacheDefinition", &format!("../pivotCache/pivotCacheDefinition{k}.xml"));
        add_relationship(&mut entries, sheet_path, "pivotTable", &format!("../pivotTables/pivotTable{k}.xml"));
        let rid = add_relationship(&mut entries, "xl/workbook.xml", "pivotCacheDefinition", &format!("pivotCache/pivotCacheDefinition{k}.xml"));
        caches.push_str(&format!(r#"<pivotCache cacheId="{cache_id}" r:id="{rid}"/>"#));
    }
    if !caches.is_empty() {
        let Some(workbook) = entry(&entries, "xl/workbook.xml") else { return Err("El libro no tiene xl/workbook.xml".into()) };
        let xml = String::from_utf8_lossy(workbook).into_owned();
        let block = format!(r#"<pivotCaches xmlns:r="{NS_R}">{caches}</pivotCaches>"#);
        // Va después de <calcPr>, <oleSize> y <customWorkbookViews>, y antes de lo demás.
        let after = ["<smartTagPr", "<smartTagTypes", "<webPublishing", "<fileRecoveryPr", "<webPublishObjects", "<extLst", "</workbook>"];
        let at = after.iter().filter_map(|t| xml.find(t)).min().unwrap_or(xml.len());
        let xml = format!("{}{block}{}", &xml[..at], &xml[at..]);
        set_entry(&mut entries, "xl/workbook.xml", xml.into_bytes());
    }
    write_zip(path, &entries)
}

#[cfg(test)]
pub(crate) fn entries_of(path: &str) -> crate::xlsx_extras::Entries {
    read_zip(&fs::read(path).unwrap()).unwrap()
}
