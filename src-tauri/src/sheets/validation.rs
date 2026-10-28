//! Listas desplegables (validación de datos de tipo lista).
//!
//! IronCalc no las maneja, así que WEPO las guarda por su cuenta: las lee del
//! .xlsx al abrir (ver xlsx_extras.rs), las aplica al escribir en una celda y
//! las vuelve a escribir al guardar.

use serde::{Deserialize, Serialize};

use super::{Rect, SheetDocument};
use crate::xlsx_extras::{RawValidation, SheetExtras};

/// Qué se permite escribir en las celdas: una lista de opciones, números o fechas.
/// (Se llama así porque empezó solo con listas desplegables.)
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ListSource {
    /// Opciones escritas: "Sí", "No", "Tal vez".
    Items { items: Vec<String> },
    /// Un rango del libro: "$H$1:$H$5" o "Opciones!$A$1:$A$9".
    Range { range: String },
    /// Números (enteros o con decimales) que cumplen una condición.
    Number { integer: bool, op: CompareOp, a: f64, b: Option<f64> },
    /// Fechas ("2026-01-31") que cumplen una condición.
    Date { op: CompareOp, a: String, b: Option<String> },
}

/// Condición de una validación de números o fechas (los mismos nombres que en Excel).
#[derive(Clone, Copy, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CompareOp {
    Between,
    NotBetween,
    Equal,
    NotEqual,
    Greater,
    Less,
    GreaterOrEqual,
    LessOrEqual,
}

impl CompareOp {
    fn xml(self) -> &'static str {
        match self {
            Self::Between => "between",
            Self::NotBetween => "notBetween",
            Self::Equal => "equal",
            Self::NotEqual => "notEqual",
            Self::Greater => "greaterThan",
            Self::Less => "lessThan",
            Self::GreaterOrEqual => "greaterThanOrEqual",
            Self::LessOrEqual => "lessThanOrEqual",
        }
    }

    fn from_xml(text: &str) -> Self {
        match text {
            "notBetween" => Self::NotBetween,
            "equal" => Self::Equal,
            "notEqual" => Self::NotEqual,
            "greaterThan" => Self::Greater,
            "lessThan" => Self::Less,
            "greaterThanOrEqual" => Self::GreaterOrEqual,
            "lessThanOrEqual" => Self::LessOrEqual,
            _ => Self::Between,
        }
    }

    pub fn holds(self, value: f64, a: f64, b: Option<f64>) -> bool {
        let (low, high) = match b {
            Some(b) => (a.min(b), a.max(b)),
            None => (a, a),
        };
        match self {
            Self::Between => value >= low && value <= high,
            Self::NotBetween => value < low || value > high,
            Self::Equal => value == a,
            Self::NotEqual => value != a,
            Self::Greater => value > a,
            Self::Less => value < a,
            Self::GreaterOrEqual => value >= a,
            Self::LessOrEqual => value <= a,
        }
    }

    /// "entre 1 y 10", "mayor que 5"…
    fn describe(self, a: &str, b: Option<&str>) -> String {
        let b = b.unwrap_or("");
        match self {
            Self::Between => format!("entre {a} y {b}"),
            Self::NotBetween => format!("fuera de {a} a {b}"),
            Self::Equal => format!("igual a {a}"),
            Self::NotEqual => format!("distinto de {a}"),
            Self::Greater => format!("mayor que {a}"),
            Self::Less => format!("menor que {a}"),
            Self::GreaterOrEqual => format!("mayor o igual a {a}"),
            Self::LessOrEqual => format!("menor o igual a {a}"),
        }
    }

    fn needs_b(self) -> bool {
        matches!(self, Self::Between | Self::NotBetween)
    }
}

/// "2026-01-31" → número de serie de Excel (días desde el 30/12/1899).
pub fn date_serial(text: &str) -> Option<f64> {
    let mut parts = text.trim().split(['-', '/']).map(|p| p.parse::<i64>().ok());
    let (y, m, d) = (parts.next()??, parts.next()??, parts.next()??);
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    // Días desde 1970-01-01 (algoritmo de Howard Hinnant).
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some((days + 25_569) as f64)
}

/// Número de serie → "2026-01-31".
fn serial_date(serial: f64) -> String {
    let z = serial.floor() as i64 - 25_569 + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

#[derive(Clone, Debug)]
pub struct Validation {
    /// Hoja (por su identificador estable) y celdas donde aplica.
    pub sheet_id: u32,
    pub rect: Rect,
    pub source: ListSource,
    /// Mensaje propio cuando el valor no es válido.
    pub message: Option<String>,
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
    /// "list", "number" o "date". Solo las listas muestran la flecha.
    pub kind: &'static str,
    /// La regla completa, para el diálogo.
    pub spec: ListSource,
    /// Descripción legible: "Número entero entre 1 y 10".
    pub rule: String,
    pub message: Option<String>,
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

/// "Número entero entre 1 y 10", "Fecha posterior a…", "Lista: Sí, No".
fn describe(source: &ListSource) -> String {
    let number = |n: f64| if n.fract() == 0.0 { format!("{n:.0}") } else { n.to_string() };
    match source {
        ListSource::Items { items } => format!("Lista: {}", items.join(", ")),
        ListSource::Range { range } => format!("Lista de {range}"),
        ListSource::Number { integer, op, a, b } => format!(
            "{} {}",
            if *integer { "Número entero" } else { "Número" },
            op.describe(&number(*a), b.map(number).as_deref())
        ),
        ListSource::Date { op, a, b } => format!("Fecha {}", op.describe(a, b.as_deref())),
    }
}

impl SheetDocument {
    /// Opciones actuales de una lista.
    fn resolve(&self, sheet: u32, source: &ListSource) -> Vec<String> {
        match source {
            ListSource::Items { items } => items.clone(),
            ListSource::Number { .. } | ListSource::Date { .. } => Vec::new(),
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
                        _ => String::new(),
                    },
                    kind: match v.source {
                        ListSource::Items { .. } | ListSource::Range { .. } => "list",
                        ListSource::Number { .. } => "number",
                        ListSource::Date { .. } => "date",
                    },
                    rule: describe(&v.source),
                    spec: v.source.clone(),
                    message: v.message.clone(),
                }
            })
            .collect())
    }

    /// Pone una lista desplegable en `rect`, o la quita si `source` es None.
    /// Una lista que ya cubría parte del rango se recorta.
    pub fn set_validation(&mut self, sheet: u32, rect: Rect, source: Option<ListSource>, message: Option<String>) -> Result<(), String> {
        self.check_sheet(sheet)?;
        let id = self.sheet_id(sheet).ok_or("Hoja inválida")?;
        match &source {
            Some(ListSource::Items { items }) if items.iter().all(|i| i.trim().is_empty()) => {
                return Err("Escribe al menos una opción para la lista".into());
            }
            Some(ListSource::Number { op, b: None, .. }) if op.needs_b() => {
                return Err("Escribe los dos límites".into());
            }
            Some(ListSource::Date { op, a, b }) => {
                if date_serial(a).is_none() || (op.needs_b() && b.as_deref().and_then(date_serial).is_none()) {
                    return Err("Escribe las fechas como 2026-01-31".into());
                }
            }
            _ => {}
        }
        let message = message.map(|m| m.trim().to_string()).filter(|m| !m.is_empty());
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
                other => other,
            };
            kept.push(Validation { sheet_id: id, rect: rect.normalized(), source, message });
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
            if !matches!(v.source, ListSource::Items { .. } | ListSource::Range { .. }) {
                continue; // números y fechas se revisan después de escribir (ver check_value)
            }
            let items = self.resolve(sheet, &v.source);
            if !items.iter().any(|i| i.eq_ignore_ascii_case(input.trim()) || i.to_lowercase() == input.trim().to_lowercase()) {
                return Err(v.message.clone().unwrap_or_else(|| format!("«{input}» no está en la lista de esta celda. Elige una de las opciones.")));
            }
        }
        Ok(())
    }

    /// Después de escribir: ¿el valor cumple la regla de números o fechas de la celda?
    /// Se revisa ya escrito porque así "15/01/2026" o "10 %" ya son números.
    pub(super) fn check_value(&self, sheet: u32, row: i32, col: i32) -> Result<(), String> {
        let Some(id) = self.sheet_id(sheet) else { return Ok(()) };
        let model = self.model.get_model();
        for v in self.extras.validations.iter().filter(|v| v.sheet_id == id && v.rect.contains(row, col)) {
            let (ok, what) = match &v.source {
                ListSource::Number { integer, op, a, b } => {
                    let ok = match model.get_cell_value_by_index(sheet, row, col)? {
                        ironcalc::base::cell::CellValue::Number(n) => (!integer || n.fract() == 0.0) && op.holds(n, *a, *b),
                        ironcalc::base::cell::CellValue::None => true,
                        _ => false,
                    };
                    (ok, describe(&v.source))
                }
                ListSource::Date { op, a, b } => {
                    let (Some(a), b) = (date_serial(a), b.as_deref().and_then(date_serial)) else { continue };
                    let ok = match model.get_cell_value_by_index(sheet, row, col)? {
                        ironcalc::base::cell::CellValue::Number(n) => op.holds(n.floor(), a, b),
                        ironcalc::base::cell::CellValue::None => true,
                        _ => false,
                    };
                    (ok, describe(&v.source))
                }
                _ => continue,
            };
            if !ok {
                let rule = what[..1].to_lowercase() + &what[1..];
                return Err(v.message.clone().unwrap_or_else(|| format!("Esta celda solo acepta: {rule}.")));
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
                let number = |f: &str| f.trim().trim_start_matches('=').parse::<f64>().ok();
                let op = CompareOp::from_xml(&v.operator);
                let source = match v.kind.as_str() {
                    "whole" | "decimal" => {
                        let Some(a) = number(formula) else { continue };
                        ListSource::Number { integer: v.kind == "whole", op, a, b: v.formula2.as_deref().and_then(number) }
                    }
                    "date" => {
                        let Some(a) = number(formula) else { continue };
                        ListSource::Date { op, a: serial_date(a), b: v.formula2.as_deref().and_then(number).map(serial_date) }
                    }
                    _ => match formula.strip_prefix('"').and_then(|f| f.strip_suffix('"')) {
                        Some(list) => ListSource::Items { items: list.split(',').map(|i| i.trim().to_string()).collect() },
                        None => ListSource::Range { range: formula.trim_start_matches('=').to_string() },
                    },
                };
                for part in v.sqref.split_whitespace() {
                    if let Some(rect) = Rect::from_a1(part) {
                        self.extras.validations.push(Validation { sheet_id: id, rect, source: source.clone(), message: v.error.clone() });
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
            let mut raw = RawValidation { sqref: v.rect.to_a1(), kind: "list".into(), error: v.message.clone(), ..Default::default() };
            match &v.source {
                ListSource::Items { items } => raw.formula1 = format!("\"{}\"", items.join(",")),
                ListSource::Range { range } => raw.formula1 = range.clone(),
                ListSource::Number { integer, op, a, b } => {
                    raw.kind = if *integer { "whole" } else { "decimal" }.into();
                    raw.operator = op.xml().into();
                    raw.formula1 = a.to_string();
                    raw.formula2 = b.filter(|_| op.needs_b()).map(|b| b.to_string());
                }
                ListSource::Date { op, a, b } => {
                    raw.kind = "date".into();
                    raw.operator = op.xml().into();
                    raw.formula1 = date_serial(a).unwrap_or_default().to_string();
                    raw.formula2 = b.as_deref().filter(|_| op.needs_b()).and_then(date_serial).map(|b| b.to_string());
                }
            }
            match sheets.iter_mut().find(|(n, _)| *n == name) {
                Some((_, extras)) => extras.validations.push(raw),
                None => sheets.push((name, SheetExtras { validations: vec![raw], ..Default::default() })),
            }
        }
        // Gráficas e imágenes (ver drawings.rs) y notas (ver annotations.rs).
        self.drawings_for_xlsx(&mut sheets);
        self.notes_for_xlsx(&mut sheets);
        // Tablas y configuración de página (ver tables.rs).
        self.tables_for_xlsx(&mut sheets);
        self.pages_for_xlsx(&mut sheets);
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
        doc.set_validation(0, rect(2, 2, 10, 2), Some(ListSource::Items { items: vec!["Sí".into(), " No ".into()] }), None).unwrap();
        doc.set_validation(0, rect(2, 3, 10, 3), Some(ListSource::Range { range: "=$H$1:$H$5".into() }), None).unwrap();

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
        doc.set_validation(0, rect(5, 2, 5, 2), None, None).unwrap();
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

    #[test]
    fn numeros_y_fechas() {
        assert_eq!(date_serial("2026-01-31"), Some(46053.0));
        assert_eq!(serial_date(46053.0), "2026-01-31");

        let mut doc = SheetDocument::new_empty().unwrap();
        let entero = ListSource::Number { integer: true, op: CompareOp::Between, a: 1.0, b: Some(10.0) };
        doc.set_validation(0, rect(1, 1, 20, 1), Some(entero), Some("Del 1 al 10, por favor".into())).unwrap();
        doc.set_cell(0, 1, 1, "7").unwrap();
        assert_eq!(doc.set_cell(0, 2, 1, "11").unwrap_err(), "Del 1 al 10, por favor");
        assert!(doc.set_cell(0, 2, 1, "2.5").is_err(), "no es entero");
        assert_eq!(doc.cell_input(0, 2, 1).unwrap(), "", "el valor rechazado no se queda");

        let fecha = ListSource::Date { op: CompareOp::GreaterOrEqual, a: "2026-01-01".into(), b: None };
        doc.set_validation(0, rect(1, 2, 20, 2), Some(fecha), None).unwrap();
        doc.set_cell(0, 1, 2, "2026-03-15").unwrap();
        let error = doc.set_cell(0, 2, 2, "2025-12-31").unwrap_err();
        assert!(error.contains("mayor o igual a 2026-01-01"), "{error}");

        let path = std::env::temp_dir().join(format!("wepo-reglas-{}.xlsx", std::process::id()));
        let path = path.to_str().unwrap();
        doc.save(path, 0).unwrap();
        let views = SheetDocument::open(path).unwrap().validation_views(0).unwrap();
        assert_eq!(views[0].rule, "Número entero entre 1 y 10");
        assert_eq!(views[0].message.as_deref(), Some("Del 1 al 10, por favor"));
        assert_eq!(views[1].rule, "Fecha mayor o igual a 2026-01-01");
        std::fs::remove_file(path).unwrap();
    }
}
