//! Minigráficos en el .xlsx, como los guarda Excel 2010 en adelante: en la
//! hoja, dentro de <extLst>, con <x14:sparklineGroups>. Cada grupo tiene su
//! tipo y colores, y cada minigráfico su rango de datos (<xm:f>) y su celda (<xm:sqref>).

use std::fs;

use quick_xml::events::Event;
use quick_xml::Reader;

use crate::xlsx_extras::{attributes, entry, read_zip, set_entry, sheet_paths, write_zip};

#[derive(Clone, Debug, PartialEq)]
pub struct RawSparkline {
    pub row: i32,
    pub col: i32,
    pub source: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RawGroup {
    pub sheet: String,
    /// "line", "column" o "stacked" (ganancia/pérdida).
    pub kind: String,
    /// "#RRGGBB".
    pub color: String,
    pub markers: bool,
    pub items: Vec<RawSparkline>,
}

const EXT_URI: &str = "{05C60535-1F16-4fd2-B633-F4F36F0B64E0}";

fn argb(color: &str) -> String {
    format!("FF{}", color.trim_start_matches('#').to_uppercase())
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

pub fn read_sparklines(path: &str) -> Result<Vec<RawGroup>, String> {
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    let entries = read_zip(&bytes)?;
    let mut out = Vec::new();
    for (sheet, sheet_path) in sheet_paths(&entries)? {
        let Some(xml) = entry(&entries, &sheet_path) else { continue };
        if !String::from_utf8_lossy(xml).contains("sparklineGroup") {
            continue;
        }
        let mut reader = Reader::from_reader(xml);
        let mut buf = Vec::new();
        let mut group: Option<RawGroup> = None;
        let mut text_of: Option<&'static str> = None;
        let mut formula = String::new();
        let mut sqref = String::new();
        loop {
            match reader.read_event_into(&mut buf).map_err(|e| e.to_string())? {
                Event::Start(e) | Event::Empty(e) => {
                    let a = attributes(&e);
                    match e.local_name().as_ref() {
                        "sparklineGroup" => {
                            group = Some(RawGroup {
                                sheet: sheet.clone(),
                                kind: a.get("type").cloned().unwrap_or_else(|| "line".into()),
                                color: "#376092".into(),
                                markers: a.get("markers").is_some_and(|v| v == "1" || v == "true") || a.get("high").is_some_and(|v| v == "1"),
                                items: Vec::new(),
                            })
                        }
                        "colorSeries" => {
                            if let (Some(g), Some(rgb)) = (group.as_mut(), a.get("rgb")) {
                                let hex = rgb.trim_start_matches('#');
                                let hex = if hex.len() == 8 { &hex[2..] } else { hex };
                                g.color = format!("#{}", hex.to_uppercase());
                            }
                        }
                        "f" => {
                            text_of = Some("f");
                            formula.clear();
                        }
                        "sqref" => {
                            text_of = Some("sqref");
                            sqref.clear();
                        }
                        _ => {}
                    }
                }
                Event::Text(t) => match text_of {
                    Some("f") => formula.push_str(&t.xml10_content()),
                    Some("sqref") => sqref.push_str(&t.xml10_content()),
                    _ => {}
                },
                Event::GeneralRef(r) => {
                    if text_of == Some("f") {
                        formula.push_str(&crate::xlsx_extras::entity(&r));
                    }
                }
                Event::End(e) => match e.local_name().as_ref() {
                    "f" | "sqref" => text_of = None,
                    "sparkline" => {
                        if let (Some(g), Some((row, col))) = (group.as_mut(), crate::xlsx_extras::cell_ref(sqref.trim())) {
                            g.items.push(RawSparkline { row, col, source: formula.trim().to_string() });
                        }
                    }
                    "sparklineGroup" => {
                        if let Some(g) = group.take().filter(|g| !g.items.is_empty()) {
                            out.push(g);
                        }
                    }
                    _ => {}
                },
                Event::Eof => break,
                _ => {}
            }
            buf.clear();
        }
    }
    Ok(out)
}

fn group_xml(g: &RawGroup) -> String {
    let kind = if g.kind == "line" { String::new() } else { format!(r#" type="{}""#, g.kind) };
    let markers = if g.markers {
        if g.kind == "line" { r#" markers="1""# } else { r#" high="1" low="1""# }
    } else {
        ""
    };
    let items: String = g
        .items
        .iter()
        .map(|s| format!("<x14:sparkline><xm:f>{}</xm:f><xm:sqref>{}{}</xm:sqref></x14:sparkline>", escape(&s.source), crate::sheets::column_letters(s.col), s.row))
        .collect();
    let c = argb(&g.color);
    format!(
        r#"<x14:sparklineGroup displayEmptyCellsAs="gap"{kind}{markers}><x14:colorSeries rgb="{c}"/><x14:colorNegative rgb="FFD00000"/><x14:colorAxis rgb="FF000000"/><x14:colorMarkers rgb="{c}"/><x14:colorFirst rgb="{c}"/><x14:colorLast rgb="{c}"/><x14:colorHigh rgb="FF1F8A55"/><x14:colorLow rgb="FFD00000"/><x14:sparklines>{items}</x14:sparklines></x14:sparklineGroup>"#
    )
}

/// Agrega los minigráficos a cada hoja (al final: <extLst> va después de todo lo demás).
pub fn write_sparklines(path: &str, groups: &[RawGroup]) -> Result<(), String> {
    if groups.is_empty() {
        return Ok(());
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    let mut entries = read_zip(&bytes)?;
    for (sheet, sheet_path) in sheet_paths(&entries)? {
        let mine: Vec<&RawGroup> = groups.iter().filter(|g| g.sheet == sheet).collect();
        if mine.is_empty() {
            continue;
        }
        let Some(xml) = entry(&entries, &sheet_path) else { continue };
        let mut xml = String::from_utf8_lossy(xml).into_owned();
        let body: String = mine.iter().map(|g| group_xml(g)).collect();
        let ext = format!(
            r#"<ext uri="{EXT_URI}" xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main"><x14:sparklineGroups xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main">{body}</x14:sparklineGroups></ext>"#
        );
        if let Some(at) = xml.rfind("</extLst>") {
            xml.insert_str(at, &ext);
        } else if let Some(at) = xml.rfind("</worksheet>") {
            xml.insert_str(at, &format!("<extLst>{ext}</extLst>"));
        } else {
            continue;
        }
        set_entry(&mut entries, &sheet_path, xml.into_bytes());
    }
    write_zip(path, &entries)
}
