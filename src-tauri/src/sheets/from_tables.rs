//! Un libro nuevo a partir de tablas (las que se sacan de un PDF): una hoja por
//! tabla, con sus valores, celdas combinadas, encabezado en negrita, colores de
//! fondo, bordes, y anchos y altos como en el PDF.

use serde::Deserialize;

use super::{Rect, SheetDocument};

#[derive(Deserialize, Debug)]
pub struct TableCell {
    /// Fila y columna desde 0.
    pub row: i32,
    pub col: i32,
    pub text: String,
    pub rowspan: i32,
    pub colspan: i32,
    pub bold: bool,
    /// Color de fondo (#RRGGBB).
    pub fill: Option<String>,
}

#[derive(Deserialize, Debug)]
pub struct TableSheet {
    pub name: String,
    pub cells: Vec<TableCell>,
    /// Ancho de cada columna y alto de cada fila, en píxeles.
    pub widths: Vec<f64>,
    pub heights: Vec<f64>,
    /// Color de los bordes (#RRGGBB); sin color, la tabla no lleva bordes.
    pub border: Option<String>,
}

/// Nombre válido para una hoja: sin los caracteres que Excel no permite y de 31 letras como máximo.
fn sheet_name(name: &str, used: &[String]) -> String {
    let clean: String = name.chars().filter(|c| !"[]:*?/\\".contains(*c)).take(31).collect();
    let base = if clean.trim().is_empty() { "Tabla".to_string() } else { clean.trim().to_string() };
    let mut candidate = base.clone();
    let mut n = 2;
    while used.iter().any(|u| u.eq_ignore_ascii_case(&candidate)) {
        let suffix = format!(" ({n})");
        candidate = format!("{}{}", base.chars().take(31 - suffix.chars().count()).collect::<String>(), suffix);
        n += 1;
    }
    candidate
}

impl SheetDocument {
    pub fn from_tables(tables: &[TableSheet]) -> Result<Self, String> {
        let mut doc = Self::new_empty()?;
        let mut used: Vec<String> = Vec::new();
        for (i, table) in tables.iter().enumerate() {
            let sheet = if i == 0 { 0 } else { doc.add_sheet()? };
            let name = sheet_name(&table.name, &used);
            doc.rename_sheet(sheet, &name)?;
            used.push(name);

            for cell in &table.cells {
                let text = cell.text.trim();
                if text.is_empty() {
                    continue;
                }
                // Lo que empieza con "=" es texto del PDF, no una fórmula.
                let input = if text.starts_with('=') { format!("'{text}") } else { text.to_string() };
                doc.model.set_user_input(sheet, cell.row + 1, cell.col + 1, &input)?;
            }
            for cell in &table.cells {
                let rect = Rect {
                    row1: cell.row + 1,
                    col1: cell.col + 1,
                    row2: cell.row + cell.rowspan.max(1),
                    col2: cell.col + cell.colspan.max(1),
                };
                if cell.rowspan > 1 || cell.colspan > 1 {
                    doc.merge(sheet, rect)?;
                }
                if cell.bold {
                    doc.set_style(sheet, rect, "font.b", "true")?;
                }
                if let Some(fill) = &cell.fill {
                    doc.set_style(sheet, rect, "fill.fg_color", fill)?;
                }
                doc.set_style(sheet, rect, "alignment.wrap_text", "true")?;
                doc.set_style(sheet, rect, "alignment.vertical", "top")?;
            }
            let rows = table.heights.len() as i32;
            let cols = table.widths.len() as i32;
            if let (Some(color), true) = (&table.border, rows > 0 && cols > 0) {
                doc.set_border(sheet, Rect { row1: 1, col1: 1, row2: rows, col2: cols }, "all", "thin", color)?;
            }
            for (c, width) in table.widths.iter().enumerate() {
                doc.set_column_width(sheet, c as i32 + 1, c as i32 + 1, *width)?;
            }
            for (r, height) in table.heights.iter().enumerate() {
                doc.set_row_height(sheet, r as i32 + 1, r as i32 + 1, *height)?;
            }
        }
        // Es un libro nuevo: no hay nada que deshacer.
        doc.history.clear();
        doc.future.clear();
        doc.model.set_selected_sheet(0)?;
        Ok(doc)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cell(row: i32, col: i32, text: &str) -> TableCell {
        TableCell { row, col, text: text.into(), rowspan: 1, colspan: 1, bold: row == 0, fill: if row == 0 { Some("#E3EBF5".into()) } else { None } }
    }

    #[test]
    fn libro_desde_tablas() {
        let mut combined = cell(2, 0, "Total del semestre");
        combined.colspan = 2;
        let tables = vec![
            TableSheet {
                name: "Ventas".into(),
                cells: vec![cell(0, 0, "Mes"), cell(0, 1, "Ventas"), cell(1, 0, "Enero"), cell(1, 1, "48200"), combined, cell(2, 2, "=no es fórmula")],
                widths: vec![120.0, 90.0, 90.0],
                heights: vec![22.0, 22.0, 22.0],
                border: Some("#C9D3E0".into()),
            },
            TableSheet { name: "Ventas".into(), cells: vec![cell(0, 0, "Otra")], widths: vec![80.0], heights: vec![20.0], border: None },
        ];
        let doc = SheetDocument::from_tables(&tables).unwrap();
        assert_eq!(doc.sheet_names(), vec!["Ventas".to_string(), "Ventas (2)".to_string()]);
        let view = doc.view(0).unwrap();
        assert_eq!(view.rows[1][1].0, "48200");
        assert!(view.merged.iter().any(|m| *m == (3, 1, 2, 1)), "{:?}", view.merged);
        assert_eq!(doc.cell_input(0, 3, 3).unwrap(), "'=no es fórmula");
        assert!(view.styles[view.rows[0][0].2 as usize].b);
        assert!(doc.history.is_empty());
    }
}
