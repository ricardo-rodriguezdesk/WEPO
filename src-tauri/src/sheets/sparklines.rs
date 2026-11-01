//! Minigráficos (sparklines): una gráfica chiquita dentro de una celda, con los
//! datos de una fila o columna. De línea, de columnas o de ganancia/pérdida,
//! como en Excel. Se guardan en el .xlsx como los de Excel 2010 (ver xlsx_sparklines.rs).

use ironcalc::base::cell::CellValue;
use serde::{Deserialize, Serialize};

use super::{column_letters, Rect, SheetDocument};
use crate::xlsx_sparklines::{RawGroup, RawSparkline};

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SparkKind {
    Line,
    Column,
    Winloss,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Sparkline {
    /// Celda donde se dibuja (desde 1).
    pub row: i32,
    pub col: i32,
    /// De dónde salen los datos, como en Excel: "Ventas!B2:M2" o "B2:M2".
    pub source: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SparkGroup {
    pub sheet_id: u32,
    pub kind: SparkKind,
    pub color: String,
    /// Puntos en la línea (o el más alto y el más bajo marcados).
    pub markers: bool,
    pub items: Vec<Sparkline>,
}

#[derive(Serialize, Debug, Clone)]
pub struct SparklineView {
    pub row: i32,
    pub col: i32,
    pub kind: SparkKind,
    pub color: String,
    pub markers: bool,
    pub values: Vec<Option<f64>>,
    pub source: String,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(tag = "action", rename_all = "lowercase")]
pub enum SparkAction {
    /// Datos (rango de la hoja) y dónde ponerlos (una fila o columna de celdas).
    Add { data: String, row1: i32, col1: i32, row2: i32, col2: i32, kind: SparkKind, color: String, markers: bool },
    /// Cambiar tipo, color o puntos de los que están en ese rango.
    Update { row1: i32, col1: i32, row2: i32, col2: i32, kind: SparkKind, color: String, markers: bool },
    /// Quitar los que están en ese rango.
    Remove { row1: i32, col1: i32, row2: i32, col2: i32 },
}

/// "B2:M4" (o "Hoja!B2:M4") → hoja y rectángulo.
fn parse_range(text: &str) -> Option<(Option<String>, Rect)> {
    let (sheet, range) = match text.rfind('!') {
        Some(i) => (Some(text[..i].trim_matches('\'').replace("''", "'")), &text[i + 1..]),
        None => (None, text),
    };
    let cell = |s: &str| crate::xlsx_extras::cell_ref(&s.replace('$', "").to_uppercase());
    let mut parts = range.split(':');
    let (r1, c1) = cell(parts.next()?.trim())?;
    let (r2, c2) = match parts.next() {
        Some(p) => cell(p.trim())?,
        None => (r1, c1),
    };
    Some((sheet, Rect { row1: r1.min(r2), col1: c1.min(c2), row2: r1.max(r2), col2: c1.max(c2) }))
}

fn quoted(name: &str) -> String {
    if name.chars().all(|c| c.is_alphanumeric() || c == '_') {
        name.to_string()
    } else {
        format!("'{}'", name.replace('\'', "''"))
    }
}

impl SheetDocument {
    pub fn sparkline_views(&self, sheet: u32) -> Vec<SparklineView> {
        let Some(id) = self.sheet_id(sheet) else { return Vec::new() };
        let names = self.sheet_names();
        let model = self.model.get_model();
        let mut out = Vec::new();
        for g in self.extras.sparklines.iter().filter(|g| g.sheet_id == id) {
            for s in &g.items {
                let mut values = Vec::new();
                if let Some((sheet_name, r)) = parse_range(&s.source) {
                    let index = sheet_name.and_then(|n| names.iter().position(|x| *x == n)).map(|i| i as u32).unwrap_or(sheet);
                    for row in r.row1..=r.row2 {
                        for col in r.col1..=r.col2 {
                            values.push(match model.get_cell_value_by_index(index, row, col) {
                                Ok(CellValue::Number(n)) => Some(n),
                                _ => None,
                            });
                        }
                    }
                }
                out.push(SparklineView { row: s.row, col: s.col, kind: g.kind, color: g.color.clone(), markers: g.markers, values, source: s.source.clone() });
            }
        }
        out
    }

    pub fn sparkline_action(&mut self, sheet: u32, action: SparkAction) -> Result<(), String> {
        let id = self.sheet_id(sheet).ok_or("No existe esa hoja")?;
        let before = self.extras.clone();
        let inside = |s: &Sparkline, r: &Rect| s.row >= r.row1 && s.row <= r.row2 && s.col >= r.col1 && s.col <= r.col2;
        match action {
            SparkAction::Add { data, row1, col1, row2, col2, kind, color, markers } => {
                let location = Rect { row1, col1, row2, col2 }.normalized();
                self.check_sheet(sheet)?;
                let (sheet_name, d) = parse_range(&data).ok_or_else(|| format!("«{data}» no es un rango (por ejemplo, B2:M4)"))?;
                let prefix = quoted(&sheet_name.unwrap_or_else(|| self.sheet_names()[sheet as usize].clone()));
                let cells = (location.row2 - location.row1 + 1) * (location.col2 - location.col1 + 1);
                let rows = d.row2 - d.row1 + 1;
                let cols = d.col2 - d.col1 + 1;
                // Como en Excel: un minigráfico por fila de datos (o por columna, si así cuadra).
                let by_row = if location.col1 == location.col2 && cells == rows {
                    true
                } else if location.row1 == location.row2 && cells == cols {
                    false
                } else if cells == 1 && (rows == 1 || cols == 1) {
                    rows == 1
                } else {
                    return Err(format!("Los datos ({rows} × {cols}) no cuadran con las celdas elegidas: pon una celda por cada fila (o columna) de datos"));
                };
                let mut items = Vec::new();
                let locations: Vec<(i32, i32)> = (location.row1..=location.row2).flat_map(|r| (location.col1..=location.col2).map(move |c| (r, c))).collect();
                for (k, (row, col)) in locations.into_iter().enumerate() {
                    let k = k as i32;
                    let range = if cells == 1 {
                        format!("{}{}:{}{}", column_letters(d.col1), d.row1, column_letters(d.col2), d.row2)
                    } else if by_row {
                        format!("{}{}:{}{}", column_letters(d.col1), d.row1 + k, column_letters(d.col2), d.row1 + k)
                    } else {
                        format!("{}{}:{}{}", column_letters(d.col1 + k), d.row1, column_letters(d.col1 + k), d.row2)
                    };
                    items.push(Sparkline { row, col, source: format!("{prefix}!{range}") });
                }
                // Los que ya había en esas celdas se reemplazan.
                for g in self.extras.sparklines.iter_mut().filter(|g| g.sheet_id == id) {
                    g.items.retain(|s| !inside(s, &location));
                }
                self.extras.sparklines.retain(|g| !g.items.is_empty());
                self.extras.sparklines.push(SparkGroup { sheet_id: id, kind, color, markers, items });
            }
            SparkAction::Update { row1, col1, row2, col2, kind, color, markers } => {
                let r = Rect { row1, col1, row2, col2 }.normalized();
                let mut changed = false;
                for g in self.extras.sparklines.iter_mut().filter(|g| g.sheet_id == id) {
                    if g.items.iter().any(|s| inside(s, &r)) {
                        g.kind = kind;
                        g.color = color.clone();
                        g.markers = markers;
                        changed = true;
                    }
                }
                if !changed {
                    return Err("No hay minigráficos en esas celdas".into());
                }
            }
            SparkAction::Remove { row1, col1, row2, col2 } => {
                let r = Rect { row1, col1, row2, col2 }.normalized();
                for g in self.extras.sparklines.iter_mut().filter(|g| g.sheet_id == id) {
                    g.items.retain(|s| !inside(s, &r));
                }
                self.extras.sparklines.retain(|g| !g.items.is_empty());
            }
        }
        if self.extras.sparklines != before.sparklines {
            self.record_extras(before);
        }
        Ok(())
    }

    pub(super) fn load_sparklines(&mut self, path: &str) {
        let Ok(found) = crate::xlsx_sparklines::read_sparklines(path) else { return };
        let names = self.sheet_names();
        for raw in found {
            let Some(index) = names.iter().position(|n| *n == raw.sheet) else { continue };
            let Some(sheet_id) = self.sheet_id(index as u32) else { continue };
            self.extras.sparklines.push(SparkGroup {
                sheet_id,
                kind: match raw.kind.as_str() {
                    "column" => SparkKind::Column,
                    "stacked" => SparkKind::Winloss,
                    _ => SparkKind::Line,
                },
                color: raw.color,
                markers: raw.markers,
                items: raw.items.into_iter().map(|s| Sparkline { row: s.row, col: s.col, source: s.source }).collect(),
            });
        }
    }

    pub(super) fn sparklines_for_xlsx(&self) -> Vec<RawGroup> {
        let names = self.sheet_names();
        self.extras
            .sparklines
            .iter()
            .filter_map(|g| {
                let index = self.sheet_index(g.sheet_id)?;
                Some(RawGroup {
                    sheet: names.get(index as usize)?.clone(),
                    kind: match g.kind {
                        SparkKind::Line => "line",
                        SparkKind::Column => "column",
                        SparkKind::Winloss => "stacked",
                    }
                    .to_string(),
                    color: g.color.clone(),
                    markers: g.markers,
                    items: g.items.iter().map(|s| RawSparkline { row: s.row, col: s.col, source: s.source.clone() }).collect(),
                })
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uno_por_fila_y_con_sus_valores() {
        let mut doc = SheetDocument::new_empty().unwrap();
        for (r, vals) in [(1, ["1", "3", "2"]), (2, ["5", "4", "6"])] {
            for (c, v) in vals.iter().enumerate() {
                doc.set_cell(0, r, c as i32 + 1, v).unwrap();
            }
        }
        doc.sparkline_action(0, SparkAction::Add { data: "A1:C2".into(), row1: 1, col1: 4, row2: 2, col2: 4, kind: SparkKind::Line, color: "#376092".into(), markers: false }).unwrap();
        let views = doc.sparkline_views(0);
        assert_eq!(views.len(), 2);
        assert_eq!((views[0].row, views[0].col), (1, 4));
        assert_eq!(views[1].values, vec![Some(5.0), Some(4.0), Some(6.0)]);
        assert!(views[0].source.ends_with("!A1:C1"));
        // Los datos cambian: el minigráfico también.
        doc.set_cell(0, 1, 2, "9").unwrap();
        assert_eq!(doc.sparkline_views(0)[0].values[1], Some(9.0));
        // Se deshace como cualquier cambio.
        doc.undo().unwrap();
        doc.undo().unwrap();
        assert!(doc.sparkline_views(0).is_empty());
    }

    #[test]
    fn se_guardan_y_se_leen_en_el_xlsx() {
        let mut doc = SheetDocument::new_empty().unwrap();
        for c in 1..=4 {
            doc.set_cell(0, 1, c, &(c * 2).to_string()).unwrap();
        }
        doc.sparkline_action(0, SparkAction::Add { data: "A1:D1".into(), row1: 1, col1: 5, row2: 1, col2: 5, kind: SparkKind::Column, color: "#1F8A55".into(), markers: true }).unwrap();
        let path = std::env::temp_dir().join("wepo-minigraficos.xlsx");
        let path = path.to_string_lossy().to_string();
        doc.save(&path, 0).unwrap();
        let xml = {
            let bytes = std::fs::read(&path).unwrap();
            let entries = crate::xlsx_extras::read_zip(&bytes).unwrap();
            String::from_utf8_lossy(crate::xlsx_extras::entry(&entries, "xl/worksheets/sheet1.xml").unwrap()).into_owned()
        };
        assert!(xml.contains(r#"type="column""#));
        assert!(xml.ends_with("</extLst></worksheet>"), "{}", &xml[xml.len() - 80..]);
        let again = SheetDocument::open(&path).unwrap();
        let views = again.sparkline_views(0);
        assert_eq!(views.len(), 1);
        assert_eq!(views[0].kind, SparkKind::Column);
        assert_eq!(views[0].color, "#1F8A55");
        assert_eq!(views[0].values, vec![Some(2.0), Some(4.0), Some(6.0), Some(8.0)]);
    }

    #[test]
    fn no_cuadra() {
        let mut doc = SheetDocument::new_empty().unwrap();
        let r = doc.sparkline_action(0, SparkAction::Add { data: "A1:C3".into(), row1: 1, col1: 4, row2: 2, col2: 4, kind: SparkKind::Column, color: "#000000".into(), markers: false });
        assert!(r.is_err());
    }
}
