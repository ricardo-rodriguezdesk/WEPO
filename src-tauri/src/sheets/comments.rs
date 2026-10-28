//! Comentarios de las celdas, como los de Excel 365: una conversación con
//! respuestas que se puede marcar como resuelta. Son distintos de las notas
//! (annotations.rs), que son un texto suelto. Se leen y se guardan en el .xlsx
//! (ver xlsx_comments.rs).

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use super::{column_letters, parse_cell, SheetDocument};
use crate::xlsx_comments::{legacy_text, RawMessage, RawThread};
use crate::xlsx_extras::{RawNote, SheetExtras};

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Message {
    pub id: String,
    pub author: String,
    /// "2026-10-28T10:30:00.00" (hora UTC, como la guarda Excel).
    pub date: String,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Thread {
    pub sheet_id: u32,
    /// Celda, desde 1.
    pub row: i32,
    pub col: i32,
    pub done: bool,
    /// El primero es el comentario; los demás, las respuestas.
    pub messages: Vec<Message>,
}

#[derive(Serialize, Debug)]
pub struct CommentView {
    pub row: i32,
    pub col: i32,
    /// Id de la conversación (el del primer mensaje).
    pub id: String,
    pub done: bool,
    pub messages: Vec<Message>,
}

/// Lo que se hace con un comentario.
#[derive(Deserialize, Debug, Clone)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum CommentAction {
    /// Comentario nuevo en una celda (desde 1). Si ya hay uno, se agrega como respuesta.
    Add { row: i32, col: i32, author: String, text: String },
    Reply { thread: String, author: String, text: String },
    Edit { thread: String, message: String, text: String },
    /// Borrar el primer mensaje borra toda la conversación.
    Delete { thread: String, message: String },
    Resolve { thread: String, done: bool },
}

/// Identificador nuevo con forma de GUID ({8-4-4-4-12}), como los de Excel.
fn new_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let count = COUNTER.fetch_add(1, Ordering::Relaxed) as u128;
    // Mezcla (splitmix) para que no se parezcan entre sí.
    let mut x = nanos ^ (count << 64) ^ ((std::process::id() as u128) << 32);
    x = x.wrapping_mul(0x9E3779B97F4A7C15F39CC0605CEDC835);
    x ^= x >> 61;
    x = x.wrapping_mul(0xBF58476D1CE4E5B994D049BB133111EB);
    x ^= x >> 59;
    let h = format!("{x:032X}");
    format!("{{{}-{}-4{}-A{}-{}}}", &h[0..8], &h[8..12], &h[13..16], &h[17..20], &h[20..32])
}

/// Fecha y hora actuales en UTC: "2026-10-28T10:30:00.00".
pub fn now_iso() -> String {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    let (days, rest) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Días desde 1970 → año, mes y día (algoritmo de Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.00", rest / 3600, rest % 3600 / 60, rest % 60)
}

impl SheetDocument {
    pub fn comment_views(&self, sheet: u32) -> Vec<CommentView> {
        let Some(id) = self.sheet_id(sheet) else { return Vec::new() };
        self.extras
            .comments
            .iter()
            .filter(|t| t.sheet_id == id && !t.messages.is_empty())
            .map(|t| CommentView { row: t.row, col: t.col, id: t.messages[0].id.clone(), done: t.done, messages: t.messages.clone() })
            .collect()
    }

    pub fn comment(&mut self, sheet: u32, action: CommentAction) -> Result<(), String> {
        self.check_sheet(sheet)?;
        let sheet_id = self.sheet_id(sheet).ok_or("Hoja no encontrada")?;
        let before = self.extras.clone();
        let find = |threads: &[Thread], id: &str| threads.iter().position(|t| t.sheet_id == sheet_id && t.messages.first().is_some_and(|m| m.id == id));
        let message = |author: &str, text: &str| Message {
            id: new_id(),
            author: if author.trim().is_empty() { "WEPO".into() } else { author.trim().into() },
            date: now_iso(),
            text: text.trim_end().into(),
        };
        let comments = &mut self.extras.comments;
        match action {
            CommentAction::Add { row, col, author, text } => {
                if text.trim().is_empty() {
                    return Ok(());
                }
                match comments.iter_mut().find(|t| t.sheet_id == sheet_id && t.row == row && t.col == col) {
                    Some(thread) => thread.messages.push(message(&author, &text)),
                    None => comments.push(Thread { sheet_id, row, col, done: false, messages: vec![message(&author, &text)] }),
                }
                // Una celda tiene nota o comentario, no las dos cosas (como en Excel).
                self.extras.notes.retain(|n| !(n.sheet_id == sheet_id && n.row == row && n.col == col));
            }
            CommentAction::Reply { thread, author, text } => {
                if text.trim().is_empty() {
                    return Ok(());
                }
                let i = find(comments, &thread).ok_or("No se encontró el comentario")?;
                comments[i].messages.push(message(&author, &text));
                // Responder vuelve a abrir una conversación resuelta (como en Excel).
                comments[i].done = false;
            }
            CommentAction::Edit { thread, message: id, text } => {
                let i = find(comments, &thread).ok_or("No se encontró el comentario")?;
                let m = comments[i].messages.iter_mut().find(|m| m.id == id).ok_or("No se encontró el mensaje")?;
                if text.trim().is_empty() {
                    return Err("El comentario no puede quedar vacío".into());
                }
                m.text = text.trim_end().into();
            }
            CommentAction::Delete { thread, message: id } => {
                let i = find(comments, &thread).ok_or("No se encontró el comentario")?;
                if comments[i].messages.first().is_some_and(|m| m.id == id) {
                    comments.remove(i);
                } else {
                    comments[i].messages.retain(|m| m.id != id);
                }
            }
            CommentAction::Resolve { thread, done } => {
                let i = find(comments, &thread).ok_or("No se encontró el comentario")?;
                comments[i].done = done;
            }
        }
        self.record_extras(before);
        Ok(())
    }

    /// Los comentarios siguen a su celda al insertar o eliminar filas y columnas (como las notas).
    pub(super) fn shift_comments(&mut self, sheet: u32, columns: bool, at: i32, delta: i32) -> bool {
        let Some(id) = self.sheet_id(sheet) else { return false };
        let before = self.extras.comments.clone();
        self.extras.comments.retain_mut(|t| {
            if t.sheet_id != id {
                return true;
            }
            let value = if columns { &mut t.col } else { &mut t.row };
            if delta < 0 && *value >= at && *value < at - delta {
                return false;
            }
            if *value >= at {
                *value += delta;
            }
            true
        });
        before != self.extras.comments
    }

    /// Lee las conversaciones del archivo y quita las notas que solo las acompañan.
    pub(super) fn load_comments(&mut self, path: &str) {
        let Ok(found) = crate::xlsx_comments::read_threads(path) else { return };
        let names = self.sheet_names();
        let mut comments = Vec::new();
        for (name, threads) in found {
            let Some(index) = names.iter().position(|n| *n == name) else { continue };
            let Some(sheet_id) = self.sheet_id(index as u32) else { continue };
            for raw in threads {
                let Some((row, col)) = parse_cell(&raw.cell_ref) else { continue };
                let messages: Vec<Message> = raw.messages.into_iter().map(|m| Message { id: m.id, author: m.author, date: m.date, text: m.text }).collect();
                if messages.is_empty() {
                    continue;
                }
                self.extras.notes.retain(|n| !(n.sheet_id == sheet_id && n.row == row && n.col == col));
                comments.push(Thread { sheet_id, row, col, done: raw.done, messages });
            }
        }
        // Notas de conversaciones cuyo archivo de comentarios no vino (otro programa las quitó):
        // se quedan como notas, sin el aviso de Excel.
        for note in &mut self.extras.notes {
            if note.author.starts_with("tc=") {
                note.author.clear();
                if let Some(pos) = note.text.find("Comment:\n").or_else(|| note.text.find("Comentario:\n")) {
                    let body = note.text[pos..].split_once('\n').map(|x| x.1).unwrap_or("");
                    note.text = body.lines().map(str::trim).collect::<Vec<_>>().join("\n").trim().to_string();
                }
            }
        }
        self.extras.comments = comments;
    }

    /// Conversaciones para el .xlsx, y la nota que acompaña a cada una.
    pub(super) fn comments_for_xlsx(&self, sheets: &mut Vec<(String, SheetExtras)>) -> Vec<(String, Vec<RawThread>)> {
        let names = self.sheet_names();
        let mut out: Vec<(String, Vec<RawThread>)> = Vec::new();
        for thread in &self.extras.comments {
            let Some(index) = self.sheet_index(thread.sheet_id) else { continue };
            let Some(first) = thread.messages.first() else { continue };
            let name = names[index as usize].clone();
            let cell_ref = format!("{}{}", column_letters(thread.col), thread.row);
            let raw = RawThread {
                cell_ref: cell_ref.clone(),
                done: thread.done,
                messages: thread.messages.iter().map(|m| RawMessage { id: m.id.clone(), author: m.author.clone(), date: m.date.clone(), text: m.text.clone() }).collect(),
            };
            let note = RawNote { cell_ref, row: thread.row - 1, col: thread.col - 1, text: legacy_text(&raw), author: format!("tc={}", first.id) };
            match sheets.iter_mut().find(|(n, _)| *n == name) {
                Some((_, extras)) => extras.notes.push(note),
                None => sheets.push((name.clone(), SheetExtras { notes: vec![note], ..Default::default() })),
            }
            match out.iter_mut().find(|(n, _)| *n == name) {
                Some((_, list)) => list.push(raw),
                None => out.push((name, vec![raw])),
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fecha_iso() {
        let date = now_iso();
        assert_eq!(date.len(), 22);
        assert!(date.starts_with("20") && date.contains('T') && date.ends_with(".00"), "{date}");
    }

    #[test]
    fn conversacion_con_respuestas_que_se_guarda_y_se_lee() {
        let mut doc = SheetDocument::new_empty().unwrap();
        doc.set_cell(0, 2, 2, "100").unwrap();
        doc.set_note(0, 4, 1, "una nota normal").unwrap();
        doc.comment(0, CommentAction::Add { row: 2, col: 2, author: "Ana".into(), text: "¿Este monto está bien?".into() }).unwrap();
        let id = doc.comment_views(0)[0].id.clone();
        doc.comment(0, CommentAction::Reply { thread: id.clone(), author: "Luis".into(), text: "Sí, ya lo revisé".into() }).unwrap();
        doc.comment(0, CommentAction::Resolve { thread: id.clone(), done: true }).unwrap();
        let view = &doc.comment_views(0)[0];
        assert!(view.done);
        assert_eq!(view.messages.iter().map(|m| m.author.as_str()).collect::<Vec<_>>(), ["Ana", "Luis"]);

        // Deshacer quita «resuelto».
        doc.undo().unwrap();
        assert!(!doc.comment_views(0)[0].done);
        doc.redo().unwrap();

        // Insertar una fila arriba lo mueve con su celda.
        doc.insert_rows(0, 1, 1).unwrap();
        assert_eq!((doc.comment_views(0)[0].row, doc.comment_views(0)[0].col), (3, 2));

        let dir = std::env::temp_dir().join("wepo-comments-test");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("comentarios.xlsx");
        let path = path.to_str().unwrap();
        doc.save(path, 0).unwrap();

        let entries = crate::xlsx_pivots::entries_of(path);
        let get = |name: &str| String::from_utf8_lossy(&entries.iter().find(|(n, _)| n == name).unwrap_or_else(|| panic!("falta {name}")).1).into_owned();
        let threaded = get("xl/threadedComments/threadedComment1.xml");
        assert!(threaded.contains(r#"ref="B3""#) && threaded.contains(r#"done="1""#) && threaded.contains("parentId="));
        assert!(get("xl/persons/person.xml").contains(r#"displayName="Luis""#));
        let legacy = get("xl/comments1.xml");
        assert!(legacy.contains("tc={") && legacy.contains("una nota normal"));

        let reopened = SheetDocument::open(path).unwrap();
        let views = reopened.comment_views(0);
        assert_eq!(views.len(), 1);
        assert_eq!(views[0].id, id);
        assert!(views[0].done);
        assert_eq!(views[0].messages[1].text, "Sí, ya lo revisé");
        // La nota de la conversación no aparece como nota; la nota normal sí.
        let notes = reopened.note_views(0);
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].text, "una nota normal");
    }
}
