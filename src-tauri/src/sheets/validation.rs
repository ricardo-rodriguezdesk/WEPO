//! Listas desplegables (validación de datos de tipo lista).
//!
//! IronCalc no las maneja, así que WEPO las guarda por su cuenta: las lee del
//! .xlsx al abrir (ver xlsx_extras.rs), las aplica al escribir en una celda y
//! las vuelve a escribir al guardar.

use serde::{Deserialize, Serialize};

use super::{Rect, SheetDocument};
use crate::xlsx_extras::{RawValidation, SheetExtras};

/// De dónde salen las opciones de la lista.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ListSource {
    /// Opciones escritas: "Sí", "No", "Tal vez".
    Items { items: Vec<String> },
    /// Un rango del libro: "$H$1:$H$5" o "Opciones!$A$1:$A$9".
    Range { range: String },
}

#[derive(Clone, Debug)]
pub struct Validation {
    /// Hoja (por su identificador estable) y celdas donde aplica.
    pub sheet_id: u32,
    pub rect: Rect,
    pub source: ListSource,
}

/// Lo que necesita la interfaz para mostrar la flecha y la lista.
#[derive(Serialize, Debug)]
pub struct ValidationView {
    pub row1: i32,
    pub col1: i32,
    pub row2: i32,
    pub col2: i32,
    /// Opciones ya resueltas (si viene de un rango, sus valores actuales).
    pub items: Vec<String>,
    /// Cómo se definió, para poder editarla: "Sí, No" o "=$H$1:$H$5".
    pub source: String,
}

/// Parte un rango en los pedazos que quedan al quitarle `hole` (hasta 4).
fn subtract(rect: Rect, hole: Rect) -> Vec<Rect> {
    let (r, h) = (rect.normalized(), hole.normalized());
    if !r.intersects(&h) {
        return vec![r];
    }
    let mut pieces = Vec::new();
    if h.row1 > r.row1 {
        pieces.push(Rect { row2: h.row1 - 1, ..r });
    }
    if h.row2 < r.row2 {
        pieces.push(Rect { row1: h.row2 + 1, ..r });
    }
    let (top, bottom) = (h.row1.max(r.row1), h.row2.min(r.row2));
    if h.col1 > r.col1 {
        pieces.push(Rect { row1: top, row2: bottom, col2: h.col1 - 1, ..r });
    }
    if h.col2 < r.col2 {
        pieces.push(Rect { row1: top, row2: bottom, col1: h.col2 + 1, ..r });
    }
    pieces
}

impl SheetDocument {
    /// Opciones actuales de una lista.
    fn resolve(&self, sheet: u32, source: &ListSource) -> Vec<String> {
        match source {
            ListSource::Items { items } => items.clone(),
            ListSource::Range { range } => {
                // "Opciones!$A$1:$A$9" apunta a otra hoja; "$H$1:$H$5", a la misma.
                let target = match range.rsplit_once('!') {
                    Some((name, _)) => {
                        let name = name.trim_start_matches('=').trim_matches('\'');
                        match self.sheet_names().iter().position(|n| n == name) {
                            Some(i) => i as u32,
                            None => return Vec::new(),
                        }
                    }
                    None => sheet,
                };
                let Some(rect) = Rect::from_a1(range) else { return Vec::new() };
                let model = self.model.get_model();
                let mut items = Vec::new();
                for row in rect.row1..=rect.row2.min(rect.row1 + 1000) {
                    for col in rect.col1..=rect.col2 {
                        if let Ok(text) = model.get_formatted_cell_value(target, row, col) {
                            if !text.is_empty() && !items.contains(&text) {
                                items.push(text);
                            }
                        }
                    }
                }
                items
            }
        }
    }

    pub fn validation_views(&self, sheet: u32) -> Result<Vec<ValidationView>, String> {
        let Some(id) = self.sheet_id(sheet) else { return Ok(Vec::new()) };
        Ok(self
            .extras
            .validations
            .iter()
            .filter(|v| v.sheet_id == id)
            .map(|v| {
                let r = v.rect.normalized();
                ValidationView {
                    row1: r.row1,
                    col1: r.col1,
                    row2: r.row2,
                    col2: r.col2,
                    items: self.resolve(sheet, &v.source),
                    source: match &v.source {
                        ListSource::Items { items } => items.join(", "),
                        ListSource::Range { range } => format!("={}", range.trim_start_matches('=')),
                    },
                }
            })
            .collect())
    }

    /// Pone una lista desplegable en `rect`, o la quita si `source` es None.
    /// Una lista que ya cubría parte del rango se recorta.
    pub fn set_validation(&mut self, sheet: u32, rect: Rect, source: Option<ListSource>) -> Result<(), String> {
        let id = self.sheet_id(sheet).ok_or("Hoja inválida")?;
        if let Some(ListSource::Items { items }) = &source {
            if items.iter().all(|i| i.trim().is_empty()) {
                return Err("Escribe al menos una opción para la lista".into());
            }
        }
        let before = self.extras.clone();
        let mut kept = Vec::new();
        for v in self.extras.validations.drain(..) {
            if v.sheet_id != id || !v.rect.intersects(&rect) {
                kept.push(v);
                continue;
            }
            for piece in subtract(v.rect, rect) {
                kept.push(Validation { rect: piece, ..v.clone() });
            }
        }
        if let Some(source) = source {
            let source = match source {
                ListSource::Items { items } => ListSource::Items {
                    items: items.into_iter().map(|i| i.trim().to_string()).filter(|i| !i.is_empty()).collect(),
                },
                ListSource::Range { range } => ListSource::Range { range: range.trim().trim_start_matches('=').to_string() },
            };
            kept.push(Validation { sheet_id: id, rect: rect.normalized(), source });
        }
        self.extras.validations = kept;
        self.record_extras(before);
        Ok(())
    }

    /// Rechaza un valor escrito a mano que no está en la lista de la celda (como Excel).
    pub(super) fn check_validation(&self, sheet: u32, row: i32, col: i32, input: &str) -> Result<(), String> {
        if input.starts_with('=') {
            return Ok(()); // las fórmulas no se validan
        }
        let Some(id) = self.sheet_id(sheet) else { return Ok(()) };
        for v in self.extras.validations.iter().filter(|v| v.sheet_id == id && v.rect.contains(row, col)) {
            let items = self.resolve(sheet, &v.source);
            if !items.iter().any(|i| i.eq_ignore_ascii_case(input.trim()) || i.to_lowercase() == input.trim().to_lowercase()) {
                return Err(format!("«{input}» no está en la lista de esta celda. Elige una de las opciones."));
            }
        }
        Ok(())
    }

    // ───────────── leer y escribir en el .xlsx ─────────────

    pub(super) fn load_validations(&mut self, path: &str) {
        let Ok(found) = crate::xlsx_extras::read_validations(path) else { return };
        let names = self.sheet_names();
        for (name, raw) in found {
            let Some(index) = names.iter().position(|n| *n == name) else { continue };
            let Some(id) = self.sheet_id(index as u32) else { continue };
            for v in raw {
                let formula = v.formula1.trim();
                let source = if let Some(list) = formula.strip_prefix('"').and_then(|f| f.strip_suffix('"')) {
                    ListSource::Items { items: list.split(',').map(|i| i.trim().to_string()).collect() }
                } else {
                    ListSource::Range { range: formula.trim_start_matches('=').to_string() }
                };
                for part in v.sqref.split_whitespace() {
                    if let Some(rect) = Rect::from_a1(part) {
                        self.extras.validations.push(Validation { sheet_id: id, rect, source: source.clone() });
                    }
                }
            }
        }
    }

    pub(super) fn extras_for_xlsx(&self) -> Vec<(String, SheetExtras)> {
        let names = self.sheet_names();
        let mut sheets: Vec<(String, SheetExtras)> = Vec::new();
        for v in &self.extras.validations {
            let Some(index) = self.sheet_index(v.sheet_id) else { continue };
            let name = names[index as usize].clone();
            let formula1 = match &v.source {
                ListSource::Items { items } => format!("\"{}\"", items.join(",")),
                ListSource::Range { range } => range.clone(),
            };
            let raw = RawValidation { sqref: v.rect.to_a1(), formula1 };
            match sheets.iter_mut().find(|(n, _)| *n == name) {
                Some((_, extras)) => extras.validations.push(raw),
                None => sheets.push((name, SheetExtras { validations: vec![raw], ..Default::default() })),
            }
        }
        // Gráficas e imágenes (ver drawings.rs).
        self.drawings_for_xlsx(&mut sheets);
        sheets
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(row1: i32, col1: i32, row2: i32, col2: i32) -> Rect {
        Rect { row1, col1, row2, col2 }
    }

    #[test]
    fn recorta_rangos() {
        // Quitar el centro de un bloque de 3x3 deja 4 pedazos.
        let pieces = subtract(rect(1, 1, 3, 3), rect(2, 2, 2, 2));
        assert_eq!(pieces.len(), 4);
        let cells: i32 = pieces.iter().map(|p| (p.row2 - p.row1 + 1) * (p.col2 - p.col1 + 1)).sum();
        assert_eq!(cells, 8);
        assert_eq!(subtract(rect(1, 1, 3, 1), rect(1, 1, 5, 5)), Vec::<Rect>::new());
    }

    #[test]
    fn listas_desplegables() {
        let mut doc = SheetDocument::new_empty().unwrap();
        doc.set_cell(0, 1, 8, "Rojo").unwrap();
        doc.set_cell(0, 2, 8, "Verde").unwrap();
        doc.set_validation(0, rect(2, 2, 10, 2), Some(ListSource::Items { items: vec!["Sí".into(), " No ".into()] })).unwrap();
        doc.set_validation(0, rect(2, 3, 10, 3), Some(ListSource::Range { range: "=$H$1:$H$5".into() })).unwrap();

        let views = doc.validation_views(0).unwrap();
        assert_eq!(views[0].items, vec!["Sí", "No"]);
        assert_eq!(views[1].items, vec!["Rojo", "Verde"]);
        assert_eq!(views[1].source, "=$H$1:$H$5");

        // Se acepta lo que está en la lista (sin importar mayúsculas) y se rechaza lo demás.
        doc.set_cell(0, 3, 2, "sí").unwrap();
        assert!(doc.set_cell(0, 3, 2, "Quizá").is_err());
        doc.set_cell(0, 3, 3, "Verde").unwrap();
        doc.set_cell(0, 3, 3, "=H1").unwrap(); // las fórmulas no se validan

        // Quitar la lista de una celda del medio recorta el rango.
        doc.set_validation(0, rect(5, 2, 5, 2), None).unwrap();
        doc.set_cell(0, 5, 2, "Lo que sea").unwrap();
        assert!(doc.set_cell(0, 6, 2, "Lo que sea").is_err());

        // Deshacer devuelve la lista completa.
        doc.undo().unwrap(); // escribir en B5
        doc.undo().unwrap(); // recortar
        assert!(doc.set_cell(0, 5, 2, "Otra cosa").is_err());

        // Se guardan en el .xlsx y se leen al abrir.
        let path = std::env::temp_dir().join(format!("wepo-listas-{}.xlsx", std::process::id()));
        let path = path.to_str().unwrap();
        doc.save(path, 0).unwrap();
        let reopened = SheetDocument::open(path).unwrap();
        let views = reopened.validation_views(0).unwrap();
        assert_eq!(views.len(), 2);
        assert_eq!(views[0].items, vec!["Sí", "No"]);
        assert_eq!(views[1].items, vec!["Rojo", "Verde"]);
        std::fs::remove_file(path).unwrap();
    }
}
