//! Notas en celdas, hipervínculos, pegado especial y el resumen de la
//! selección (suma, promedio y recuento de la barra de estado).
//!
//! - Las notas las guarda WEPO por su cuenta (IronCalc las lee del .xlsx pero
//!   no las escribe): ver `xlsx_extras::write_extras`.
//! - Los vínculos son de IronCalc: se leen y se guardan solos en el .xlsx.

use ironcalc::base::cell::CellValue;
use ironcalc::base::types::{Link, Style};
use serde::Serialize;

use super::{column_letters, parse_cell, Rect, SheetDocument, Step};
use crate::xlsx_extras::{RawNote, SheetExtras};

/// Nota de una celda (lo que Excel llama "nota" y antes "comentario").
#[derive(Clone, Debug, PartialEq)]
pub struct Note {
    pub sheet_id: u32,
    pub row: i32,
    pub col: i32,
    pub text: String,
    pub author: String,
}

#[derive(Serialize, Debug)]
pub struct NoteView {
    pub row: i32,
    pub col: i32,
    pub text: String,
    pub author: String,
}

#[derive(Serialize, Debug)]
pub struct LinkView {
    pub row: i32,
    pub col: i32,
    /// URL, correo (mailto:) o, si `internal`, una celda del libro como "Hoja2!A1".
    pub target: String,
    pub internal: bool,
    /// Creado por una fórmula (=HIPERVINCULO): no se edita, solo la fórmula.
    pub dynamic: bool,
}

/// Resumen de la selección para la barra de estado.
#[derive(Serialize, Debug, Default, PartialEq)]
pub struct SelectionStats {
    /// Celdas con algo (como "Recuento" en Excel).
    pub count: u32,
    /// Celdas con números.
    pub numbers: u32,
    pub sum: f64,
    pub min: Option<f64>,
    pub max: Option<f64>,
}

/// Cómo pegar en "Pegado especial".
#[derive(Clone, Copy, Debug, PartialEq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PasteMode {
    /// Solo los resultados (sin fórmulas ni formato).
    Values,
    /// Solo el formato.
    Formats,
    /// Filas como columnas (valores y formato).
    Transpose,
}

/// "www.algo.com" → "https://www.algo.com"; "ana@correo.com" → "mailto:ana@correo.com";
/// "Hoja2!B4" o "#Hoja2!B4" → vínculo dentro del libro.
fn link_from(target: &str) -> Result<Link, String> {
    let target = target.trim();
    if target.is_empty() {
        return Err("Escribe una dirección para el vínculo".into());
    }
    if let Some(location) = target.strip_prefix('#') {
        return Ok(Link::Internal { location: location.to_string(), tooltip: None });
    }
    let has_scheme = target.contains("://") || target.starts_with("mailto:") || target.starts_with("tel:");
    if !has_scheme && target.contains('!') {
        return Ok(Link::Internal { location: target.to_string(), tooltip: None });
    }
    let external = if has_scheme {
        target.to_string()
    } else if target.contains('@') && !target.contains('/') {
        format!("mailto:{target}")
    } else {
        format!("https://{target}")
    };
    Ok(Link::External { target: external, tooltip: None })
}

impl SheetDocument {
    // ───────────── notas ─────────────

    pub fn note_views(&self, sheet: u32) -> Vec<NoteView> {
        let Some(id) = self.sheet_id(sheet) else { return Vec::new() };
        self.extras
            .notes
            .iter()
            .filter(|n| n.sheet_id == id)
            .map(|n| NoteView { row: n.row, col: n.col, text: n.text.clone(), author: n.author.clone() })
            .collect()
    }

    /// Escribe (o borra, si `text` está vacío) la nota de una celda.
    pub fn set_note(&mut self, sheet: u32, row: i32, col: i32, text: &str) -> Result<(), String> {
        let id = self.sheet_id(sheet).ok_or("Hoja no encontrada")?;
        let before = self.extras.clone();
        let text = text.trim_end();
        let position = self.extras.notes.iter().position(|n| n.sheet_id == id && n.row == row && n.col == col);
        match (position, text.is_empty()) {
            (Some(i), true) => {
                self.extras.notes.remove(i);
            }
            (Some(i), false) => self.extras.notes[i].text = text.to_string(),
            (None, false) => self.extras.notes.push(Note {
                sheet_id: id,
                row,
                col,
                text: text.to_string(),
                author: "WEPO".into(),
            }),
            (None, true) => return Ok(()),
        }
        self.record_extras(before);
        Ok(())
    }

    /// Las notas siguen a su celda al insertar o eliminar filas y columnas.
    /// `at` es la primera fila (o columna) afectada; `delta` cuántas se
    /// insertan (positivo) o eliminan (negativo).
    pub(super) fn shift_notes(&mut self, sheet: u32, columns: bool, at: i32, delta: i32) -> bool {
        let Some(id) = self.sheet_id(sheet) else { return false };
        let before = self.extras.notes.clone();
        self.extras.notes.retain_mut(|n| {
            if n.sheet_id != id {
                return true;
            }
            let value = if columns { &mut n.col } else { &mut n.row };
            if delta < 0 && *value >= at && *value < at - delta {
                return false; // estaba en lo que se eliminó
            }
            if *value >= at {
                *value += delta;
            }
            true
        });
        before != self.extras.notes
    }

    /// Ejecuta un paso del motor que mueve filas o columnas y lleva las notas con él.
    pub(super) fn step_moving_notes(
        &mut self,
        sheet: u32,
        columns: bool,
        at: i32,
        delta: i32,
        action: impl FnOnce(&mut ironcalc::base::UserModel<'static>) -> Result<(), String>,
    ) -> Result<(), String> {
        let before = self.extras.clone();
        action(&mut self.model)?;
        if self.shift_notes(sheet, columns, at, delta) {
            self.history.push(Step::Both(1, before));
            self.future.clear();
        } else {
            self.record(1);
        }
        Ok(())
    }

    pub(super) fn load_notes(&mut self) {
        let model = self.model.get_model();
        let mut notes = Vec::new();
        for (index, sheet) in model.workbook.worksheets.iter().enumerate() {
            let Some(id) = self.sheet_id(index as u32) else { continue };
            for comment in &sheet.comments {
                let Some((row, col)) = parse_cell(&comment.cell_ref) else { continue };
                notes.push(Note {
                    sheet_id: id,
                    row,
                    col,
                    text: comment.text.trim_end().to_string(),
                    author: comment.author_name.clone(),
                });
            }
        }
        self.extras.notes = notes;
    }

    pub(super) fn notes_for_xlsx(&self, sheets: &mut Vec<(String, SheetExtras)>) {
        let names = self.sheet_names();
        for note in &self.extras.notes {
            let Some(index) = self.sheet_index(note.sheet_id) else { continue };
            let name = names[index as usize].clone();
            let raw = RawNote {
                cell_ref: format!("{}{}", column_letters(note.col), note.row),
                row: note.row - 1,
                col: note.col - 1,
                text: note.text.clone(),
                author: if note.author.is_empty() { "WEPO".into() } else { note.author.clone() },
            };
            match sheets.iter_mut().find(|(n, _)| *n == name) {
                Some((_, extras)) => extras.notes.push(raw),
                None => sheets.push((name, SheetExtras { notes: vec![raw], ..Default::default() })),
            }
        }
    }

    // ───────────── vínculos ─────────────

    pub fn link_views(&self, sheet: u32) -> Vec<LinkView> {
        self.model
            .get_links_list(sheet)
            .unwrap_or_default()
            .into_iter()
            .map(|l| {
                let (target, internal) = match l.link {
                    Link::External { target, .. } => (target, false),
                    Link::Internal { location, .. } => (location, true),
                };
                LinkView { row: l.row, col: l.column, target, internal, dynamic: l.dynamic }
            })
            .collect()
    }

    /// Pone un vínculo en la celda. Si `label` viene, es el texto que se ve.
    pub fn set_link(&mut self, sheet: u32, row: i32, col: i32, target: &str, label: Option<&str>) -> Result<(), String> {
        let link = link_from(target)?;
        let label = label.map(str::trim).filter(|l| !l.is_empty());
        self.step(|m| m.set_cell_link(sheet, row, col, link, label))
    }

    pub fn delete_link(&mut self, sheet: u32, row: i32, col: i32) -> Result<(), String> {
        if self.model.get_cell_link(sheet, row, col)?.is_none() {
            return Ok(());
        }
        self.step(|m| m.delete_cell_link(sheet, row, col))
    }

    // ───────────── resumen de la selección ─────────────

    pub fn stats(&self, sheet: u32, rect: Rect) -> Result<SelectionStats, String> {
        let rect = rect.normalized();
        let model = self.model.get_model();
        let worksheet = model.workbook.worksheet(sheet)?;
        let mut stats = SelectionStats::default();
        // Solo las celdas que existen; las filas y columnas ocultas no cuentan (como en Excel).
        for row in worksheet.sheet_data.rows() {
            if row < rect.row1 || row > rect.row2 || worksheet.is_row_hidden(row)? {
                continue;
            }
            for col in worksheet.sheet_data.columns_in_row(row) {
                if col < rect.col1 || col > rect.col2 || worksheet.is_column_hidden(col)? {
                    continue;
                }
                match model.get_cell_value_by_index(sheet, row, col)? {
                    CellValue::None => {}
                    CellValue::Number(n) => {
                        stats.count += 1;
                        stats.numbers += 1;
                        stats.sum += n;
                        stats.min = Some(stats.min.map_or(n, |m| m.min(n)));
                        stats.max = Some(stats.max.map_or(n, |m| m.max(n)));
                    }
                    CellValue::String(s) if s.is_empty() => {}
                    _ => stats.count += 1,
                }
            }
        }
        Ok(stats)
    }

    // ───────────── pegado especial ─────────────

    /// Pega lo último que se copió en WEPO: solo valores, solo formato o transpuesto.
    pub fn paste_special(&mut self, sheet: u32, row: i32, col: i32, mode: PasteMode) -> Result<(), String> {
        let clip = self.clipboard.as_ref().ok_or("Primero copia algo en WEPO")?;
        let (source_sheet, (r1, c1, r2, c2)) = (clip.sheet, clip.range);
        let (height, width) = (r2 - r1 + 1, c2 - c1 + 1);
        let transpose = mode == PasteMode::Transpose;

        // Se lee todo antes de escribir: el origen y el destino pueden encimarse.
        let model = self.model.get_model();
        let mut values = Vec::new();
        let mut styles: Vec<Vec<Style>> = Vec::new();
        for i in 0..height {
            let mut style_row = Vec::new();
            for j in 0..width {
                let (sr, sc) = (r1 + i, c1 + j);
                values.push((i, j, model.get_cell_value_by_index(source_sheet, sr, sc)?));
                style_row.push(self.model.get_cell_style(source_sheet, sr, sc)?);
            }
            styles.push(style_row);
        }
        if transpose {
            styles = (0..width as usize).map(|j| styles.iter().map(|r| r[j].clone()).collect()).collect();
        }
        let (out_height, out_width) = if transpose { (width, height) } else { (height, width) };

        self.transaction(|doc, steps| {
            if mode != PasteMode::Formats {
                for (i, j, value) in &values {
                    let (tr, tc) = if transpose { (row + j, col + i) } else { (row + i, col + j) };
                    let input = match value {
                        CellValue::None => {
                            if doc.model.get_cell_content(sheet, tr, tc)?.is_empty() {
                                continue;
                            }
                            let area = Rect { row1: tr, col1: tc, row2: tr, col2: tc }.area(sheet);
                            doc.model.range_clear_contents(&area)?;
                            *steps += 1;
                            continue;
                        }
                        CellValue::Number(n) => n.to_string(),
                        CellValue::Boolean(b) => if *b { "TRUE" } else { "FALSE" }.to_string(),
                        // El apóstrofo hace que se quede como texto aunque parezca número o fórmula.
                        CellValue::String(s) => format!("'{s}"),
                    };
                    doc.model.set_user_input(sheet, tr, tc, &input)?;
                    *steps += 1;
                }
            }
            if mode != PasteMode::Values {
                doc.select(sheet, row, col, row + out_height - 1, col + out_width - 1)?;
                doc.model.on_paste_styles(&styles)?;
                *steps += 1;
            }
            Ok(())
        })
    }

    // ───────────── copiar formato (brocha) ─────────────

    /// Copia el formato de `source` sobre `target`, repitiéndolo si `target` es más grande.
    pub fn paste_styles_from(&mut self, sheet: u32, source: Rect, target: Rect) -> Result<(), String> {
        let (source, target) = (source.normalized(), target.normalized());
        let mut styles = Vec::new();
        for r in source.row1..=source.row2 {
            let mut row = Vec::new();
            for c in source.col1..=source.col2 {
                row.push(self.model.get_cell_style(sheet, r, c)?);
            }
            styles.push(row);
        }
        self.select(sheet, target.row1, target.col1, target.row2, target.col2)?;
        self.step(|m| m.on_paste_styles(&styles))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(row1: i32, col1: i32, row2: i32, col2: i32) -> Rect {
        Rect { row1, col1, row2, col2 }
    }

    #[test]
    fn interpreta_direcciones() {
        assert_eq!(link_from("www.wepo.app").unwrap(), Link::External { target: "https://www.wepo.app".into(), tooltip: None });
        assert_eq!(link_from("ana@correo.com").unwrap(), Link::External { target: "mailto:ana@correo.com".into(), tooltip: None });
        assert_eq!(link_from("Hoja2!B4").unwrap(), Link::Internal { location: "Hoja2!B4".into(), tooltip: None });
        assert!(link_from("  ").is_err());
    }

    #[test]
    fn resume_la_seleccion() {
        let mut doc = SheetDocument::new_empty().unwrap();
        for (r, v) in [(1, "10"), (2, "20"), (3, "hola"), (4, "=A1*3")] {
            doc.set_cell(0, r, 1, v).unwrap();
        }
        let s = doc.stats(0, rect(1, 1, 10, 1)).unwrap();
        assert_eq!((s.count, s.numbers, s.sum, s.min, s.max), (4, 3, 60.0, Some(10.0), Some(30.0)));
        doc.set_rows_hidden(0, 2, 2, true).unwrap();
        assert_eq!(doc.stats(0, rect(1, 1, 10, 1)).unwrap().sum, 40.0, "las filas ocultas no cuentan");
    }

    #[test]
    fn pega_valores_y_transpuesto() {
        let mut doc = SheetDocument::new_empty().unwrap();
        doc.set_cell(0, 1, 1, "5").unwrap();
        doc.set_cell(0, 1, 2, "=A1*2").unwrap();
        doc.set_cell(0, 1, 3, "007").unwrap();
        doc.set_style(0, rect(1, 1, 1, 1), "font.b", "true").unwrap();
        doc.copy(0, rect(1, 1, 1, 3), false).unwrap();

        doc.paste_special(0, 3, 1, PasteMode::Values).unwrap();
        assert_eq!(doc.cell_input(0, 3, 2).unwrap(), "10", "el resultado, no la fórmula");
        assert!(!doc.model.get_cell_style(0, 3, 1).unwrap().font.b, "sin el formato");

        doc.paste_special(0, 5, 1, PasteMode::Transpose).unwrap();
        assert_eq!(doc.cell_input(0, 6, 1).unwrap(), "10");
        assert!(doc.model.get_cell_style(0, 5, 1).unwrap().font.b);

        doc.paste_special(0, 10, 4, PasteMode::Formats).unwrap();
        assert!(doc.model.get_cell_style(0, 10, 4).unwrap().font.b);
        assert_eq!(doc.cell_input(0, 10, 4).unwrap(), "");

        // Todo pegado especial se deshace de una vez.
        doc.undo().unwrap();
        assert!(!doc.model.get_cell_style(0, 10, 4).unwrap().font.b);
    }

    #[test]
    fn notas_siguen_a_su_celda_y_se_guardan() {
        let mut doc = SheetDocument::new_empty().unwrap();
        doc.set_cell(0, 3, 2, "Total").unwrap();
        doc.set_note(0, 3, 2, "Revisar con Ana").unwrap();
        doc.insert_rows(0, 1, 2).unwrap();
        assert_eq!(doc.note_views(0)[0].row, 5);
        doc.undo().unwrap();
        assert_eq!(doc.note_views(0)[0].row, 3, "deshacer regresa la nota");
        doc.delete_columns(0, 1, 1).unwrap();
        assert_eq!(doc.note_views(0)[0].col, 1);

        doc.set_link(0, 1, 1, "www.wepo.app", Some("Sitio")).unwrap();
        let path = std::env::temp_dir().join(format!("wepo-notas-{}.xlsx", std::process::id()));
        let path = path.to_str().unwrap();
        doc.save(path, 0).unwrap();
        let reopened = SheetDocument::open(path).unwrap();
        let notes = reopened.note_views(0);
        assert_eq!((notes[0].row, notes[0].col, notes[0].text.as_str()), (3, 1, "Revisar con Ana"));
        let links = reopened.link_views(0);
        assert_eq!(links[0].target, "https://www.wepo.app");
        assert_eq!(reopened.cell_input(0, 1, 1).unwrap(), "Sitio");
        assert!(!reopened.view(0).unwrap().has_drawings, "las notas no cuentan como algo que WEPO no conserva");

        doc.set_note(0, 3, 1, "").unwrap();
        assert!(doc.note_views(0).is_empty());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn quita_duplicados() {
        let mut doc = SheetDocument::new_empty().unwrap();
        let data = [["Nombre", "Ciudad"], ["Ana", "León"], ["Luis", "Puebla"], ["ana", "León"], ["Ana", "Puebla"], ["Luis", "Puebla"]];
        for (r, row) in data.iter().enumerate() {
            for (c, v) in row.iter().enumerate() {
                doc.set_cell(0, r as i32 + 1, c as i32 + 1, v).unwrap();
            }
        }
        doc.set_cell(0, 3, 4, "fuera de la tabla").unwrap();
        let removed = doc.remove_duplicates(0, rect(1, 1, 6, 2), &[1, 2], true).unwrap();
        assert_eq!(removed, 2, "«ana, León» (sin importar mayúsculas) y el segundo «Luis, Puebla»");
        let names: Vec<String> = (2..=6).map(|r| doc.cell_input(0, r, 1).unwrap()).collect();
        assert_eq!(names, ["Ana", "Luis", "Ana", "", ""]);
        assert_eq!(doc.cell_input(0, 3, 4).unwrap(), "fuera de la tabla", "lo de fuera no se mueve");
        doc.undo().unwrap();
        assert_eq!(doc.cell_input(0, 4, 1).unwrap(), "ana", "se deshace de una vez");
    }
}
