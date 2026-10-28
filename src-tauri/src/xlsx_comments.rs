//! Comentarios con respuestas de Excel (los "threaded comments" de Excel 365).
//!
//! Van en dos partes del .xlsx: xl/threadedComments/threadedCommentN.xml (uno por
//! hoja, con cada comentario y sus respuestas) y xl/persons/person.xml (quién los
//! escribió). Para los programas que no los conocen (LibreOffice, Excel viejito),
//! cada conversación lleva además una nota normal con el texto, y su autor es
//! "tc={id}": así Excel sabe que esa nota es la misma conversación.

use std::collections::HashMap;
use std::fs;

use quick_xml::events::Event;
use quick_xml::Reader;

use crate::xlsx_extras::{add_content_type, attributes, entry, escape, read_zip, relationships, rels_path, set_entry, sheet_paths, write_zip, Entries};

const NS_TC: &str = "http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments";
const NS_MAIN: &str = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL_THREADED: &str = "http://schemas.microsoft.com/office/2017/10/relationships/threadedComment";
const REL_PERSON: &str = "http://schemas.microsoft.com/office/2017/10/relationships/person";

/// Un mensaje de una conversación (el comentario o una respuesta).
#[derive(Clone, Debug, PartialEq, Default)]
pub struct RawMessage {
    pub id: String,
    pub author: String,
    /// "2026-10-28T10:30:00.00"
    pub date: String,
    pub text: String,
}

/// Una conversación en una celda.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct RawThread {
    /// "B3"
    pub cell_ref: String,
    pub done: bool,
    /// El primero es el comentario; los demás, las respuestas.
    pub messages: Vec<RawMessage>,
}

/// Conversaciones de cada hoja: (nombre de la hoja, conversaciones).
pub fn read_threads(path: &str) -> Result<Vec<(String, Vec<RawThread>)>, String> {
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    let entries = read_zip(&bytes)?;
    // Personas: id → nombre.
    let mut people: HashMap<String, String> = HashMap::new();
    for (kind, target) in relationships(&entries, "xl/workbook.xml").into_values() {
        if kind != "person" {
            continue;
        }
        let Some(xml) = entry(&entries, &target) else { continue };
        let mut reader = Reader::from_reader(xml);
        let mut buf = Vec::new();
        loop {
            match reader.read_event_into(&mut buf).map_err(|e| e.to_string())? {
                Event::Start(e) | Event::Empty(e) if e.local_name().as_ref() == "person" => {
                    let a = attributes(&e);
                    if let (Some(id), Some(name)) = (a.get("id"), a.get("displayName")) {
                        people.insert(id.clone(), name.clone());
                    }
                }
                Event::Eof => break,
                _ => {}
            }
            buf.clear();
        }
    }

    let mut result = Vec::new();
    for (sheet, sheet_path) in sheet_paths(&entries)? {
        let mut threads: Vec<RawThread> = Vec::new();
        for (kind, target) in relationships(&entries, &sheet_path).into_values() {
            if kind != "threadedComment" {
                continue;
            }
            let Some(xml) = entry(&entries, &target) else { continue };
            let mut reader = Reader::from_reader(xml);
            let mut buf = Vec::new();
            // (ref, id, parent, persona, fecha, resuelto)
            let mut current: Option<(String, String, Option<String>, String, String, bool)> = None;
            let mut text = String::new();
            let mut in_text = false;
            loop {
                match reader.read_event_into(&mut buf).map_err(|e| e.to_string())? {
                    Event::Start(e) if e.local_name().as_ref() == "threadedComment" => {
                        let a = attributes(&e);
                        current = Some((
                            a.get("ref").cloned().unwrap_or_default(),
                            a.get("id").cloned().unwrap_or_default(),
                            a.get("parentId").cloned(),
                            a.get("personId").cloned().unwrap_or_default(),
                            a.get("dT").cloned().unwrap_or_default(),
                            a.get("done").is_some_and(|d| d == "1" || d == "true"),
                        ));
                        text.clear();
                    }
                    Event::Start(e) if e.local_name().as_ref() == "text" => in_text = true,
                    Event::End(e) if e.local_name().as_ref() == "text" => in_text = false,
                    Event::Text(t) if in_text => text.push_str(&t.xml10_content()),
                    Event::GeneralRef(r) if in_text => text.push_str(&crate::xlsx_extras::entity(&r)),
                    Event::End(e) if e.local_name().as_ref() == "threadedComment" => {
                        if let Some((cell_ref, id, parent, person, date, done)) = current.take() {
                            let message = RawMessage { id: id.clone(), author: people.get(&person).cloned().unwrap_or_default(), date, text: text.replace("\r\n", "\n") };
                            match parent.and_then(|p| threads.iter_mut().find(|t| t.messages.first().is_some_and(|m| m.id == p))) {
                                Some(thread) => thread.messages.push(message),
                                None => threads.push(RawThread { cell_ref, done, messages: vec![message] }),
                            }
                        }
                    }
                    Event::Eof => break,
                    _ => {}
                }
                buf.clear();
            }
        }
        if !threads.is_empty() {
            result.push((sheet, threads));
        }
    }
    Ok(result)
}

/// Texto de la nota que acompaña a una conversación (lo que ven LibreOffice o un Excel viejito).
pub fn legacy_text(thread: &RawThread) -> String {
    let mut out = String::from("[Comentario con respuestas]\n\nTu versión de Excel puede leer este comentario, pero los cambios que le hagas se perderán al abrirlo en una versión más nueva.\n");
    for (i, m) in thread.messages.iter().enumerate() {
        out.push_str(if i == 0 { "\nComentario:\n" } else { "\nRespuesta:\n" });
        let who = if m.author.is_empty() { String::new() } else { format!("{}: ", m.author) };
        out.push_str(&format!("    {who}{}\n", m.text.replace('\n', "\n    ")));
    }
    out.trim_end().to_string()
}

/// Identificador estable de una persona a partir de su nombre (con forma de GUID, como Excel).
fn person_id(name: &str) -> String {
    // FNV-1a de 128 bits, partido como GUID.
    let mut h: u128 = 0x6c62272e07bb014262b821756295c58d;
    for b in name.bytes() {
        h ^= b as u128;
        h = h.wrapping_mul(0x0000000001000000000000000000013B);
    }
    let x = format!("{h:032X}");
    format!("{{{}-{}-{}-{}-{}}}", &x[0..8], &x[8..12], &x[12..16], &x[16..20], &x[20..32])
}

fn add_typed_relationship(entries: &mut Entries, part: &str, full_type: &str, target: &str) -> String {
    let path = rels_path(part);
    let mut xml = entry(entries, &path)
        .map(|d| String::from_utf8_lossy(d).into_owned())
        .unwrap_or_else(|| r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>"#.to_string());
    let mut n = 1;
    while xml.contains(&format!(r#"Id="rIdC{n}""#)) {
        n += 1;
    }
    let id = format!("rIdC{n}");
    xml = xml.replace("</Relationships>", &format!(r#"<Relationship Id="{id}" Type="{full_type}" Target="{}"/></Relationships>"#, escape(target)));
    set_entry(entries, &path, xml.into_bytes());
    id
}

/// Escribe las conversaciones de cada hoja (las notas que las acompañan ya las escribió `write_extras`).
pub fn write_threads(path: &str, sheets: &[(String, Vec<RawThread>)]) -> Result<(), String> {
    if sheets.iter().all(|(_, t)| t.is_empty()) {
        return Ok(());
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    let mut entries = read_zip(&bytes)?;
    let paths = sheet_paths(&entries)?;
    let mut people: Vec<String> = Vec::new();
    let mut n = 0;
    for (name, threads) in sheets {
        if threads.is_empty() {
            continue;
        }
        let Some((_, sheet_path)) = paths.iter().find(|(s, _)| s == name) else { continue };
        n += 1;
        let mut body = String::new();
        for thread in threads {
            let Some(first) = thread.messages.first() else { continue };
            for (i, m) in thread.messages.iter().enumerate() {
                let author = if m.author.is_empty() { "WEPO".to_string() } else { m.author.clone() };
                if !people.contains(&author) {
                    people.push(author.clone());
                }
                let parent = if i == 0 { String::new() } else { format!(r#" parentId="{}""#, escape(&first.id)) };
                let done = if i == 0 && thread.done { r#" done="1""# } else { "" };
                body.push_str(&format!(
                    r#"<threadedComment ref="{}" dT="{}" personId="{}" id="{}"{parent}{done}><text>{}</text></threadedComment>"#,
                    escape(&thread.cell_ref),
                    escape(&m.date),
                    person_id(&author),
                    escape(&m.id),
                    escape(&m.text)
                ));
            }
        }
        let part = format!("xl/threadedComments/threadedComment{n}.xml");
        let xml = format!(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><ThreadedComments xmlns="{NS_TC}" xmlns:x="{NS_MAIN}">{body}</ThreadedComments>"#);
        set_entry(&mut entries, &part, xml.into_bytes());
        add_content_type(&mut entries, Some(&part), None, "application/vnd.ms-excel.threadedcomments+xml");
        add_typed_relationship(&mut entries, sheet_path, REL_THREADED, &format!("../threadedComments/threadedComment{n}.xml"));
    }
    let list: String = people
        .iter()
        .map(|p| format!(r#"<person displayName="{}" id="{}" userId="{}" providerId="None"/>"#, escape(p), person_id(p), escape(p)))
        .collect();
    let part = "xl/persons/person.xml";
    set_entry(
        &mut entries,
        part,
        format!(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><personList xmlns="{NS_TC}" xmlns:x="{NS_MAIN}">{list}</personList>"#).into_bytes(),
    );
    add_content_type(&mut entries, Some(part), None, "application/vnd.ms-excel.person+xml");
    add_typed_relationship(&mut entries, "xl/workbook.xml", REL_PERSON, "persons/person.xml");
    write_zip(path, &entries)
}
