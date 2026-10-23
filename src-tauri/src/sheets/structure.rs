//! Estructura de la hoja: filas y columnas, celdas combinadas, paneles
//! inmovilizados, pestañas y autollenado.

use super::{Rect, SheetDocument};

impl SheetDocument {
    // ───────────── filas y columnas ─────────────

    pub fn insert_rows(&mut self, sheet: u32, row: i32, count: i32) -> Result<(), String> {
        self.step(|m| m.insert_rows(sheet, row, count.max(1)))
    }

    pub fn delete_rows(&mut self, sheet: u32, row: i32, count: i32) -> Result<(), String> {
        self.step(|m| m.delete_rows(sheet, row, count.max(1)))
    }

    pub fn insert_columns(&mut self, sheet: u32, col: i32, count: i32) -> Result<(), String> {
        self.step(|m| m.insert_columns(sheet, col, count.max(1)))
    }

    pub fn delete_columns(&mut self, sheet: u32, col: i32, count: i32) -> Result<(), String> {
        self.step(|m| m.delete_columns(sheet, col, count.max(1)))
    }

    pub fn set_rows_hidden(&mut self, sheet: u32, row1: i32, row2: i32, hidden: bool) -> Result<(), String> {
        let (row1, row2) = (row1.min(row2), row1.max(row2));
        // Al ocultar, IronCalc mueve su selección a la primera celda de la fila
        // visible siguiente; si esa celda está dentro de una combinada, falla.
        let target = self.next_visible(sheet, row2, row1, false)?;
        self.around_merge(sheet, (target, 1), hidden, |m| m.set_rows_hidden(sheet, row1, row2, hidden))
    }

    pub fn set_columns_hidden(&mut self, sheet: u32, col1: i32, col2: i32, hidden: bool) -> Result<(), String> {
        let (col1, col2) = (col1.min(col2), col1.max(col2));
        let target = self.next_visible(sheet, col2, col1, true)?;
        self.around_merge(sheet, (1, target), hidden, |m| m.set_columns_hidden(sheet, col1, col2, hidden))
    }

    /// La fila (o columna) visible después de `last`, o antes de `first` si no hay.
    fn next_visible(&self, sheet: u32, last: i32, first: i32, columns: bool) -> Result<i32, String> {
        let worksheet = self.model.get_model().workbook.worksheet(sheet)?;
        let limit = if columns { 16_384 } else { 1_048_576 };
        let hidden = |i: i32| if columns { worksheet.is_column_hidden(i) } else { worksheet.is_row_hidden(i) };
        let mut i = last + 1;
        while i <= limit && hidden(i)? {
            i += 1;
        }
        if i > limit {
            i = first - 1;
            while i > 1 && hidden(i)? {
                i -= 1;
            }
        }
        Ok(i.max(1))
    }

    /// Ejecuta `action` y, si una celda combinada cubre `cell` (sin ser su
    /// esquina), la separa antes y la vuelve a combinar después. Todo cuenta
    /// como una sola acción para deshacer.
    fn around_merge(
        &mut self,
        sheet: u32,
        cell: (i32, i32),
        hidden: bool,
        action: impl FnOnce(&mut ironcalc::base::UserModel<'static>) -> Result<(), String>,
    ) -> Result<(), String> {
        let (row, col) = cell;
        let blocking = if hidden && self.model.get_selected_sheet() == sheet {
            self.model.get_merged_cells(sheet)?.into_iter().find(|m| {
                row >= m.row && row < m.row + m.height && col >= m.column && col < m.column + m.width
                    && (m.row, m.column) != (row, col)
            })
        } else {
            None
        };
        let Some(m) = blocking else { return self.step(action) };
        let area = Rect { row1: m.row, col1: m.column, row2: m.row + m.height - 1, col2: m.column + m.width - 1 }.area(sheet);
        self.transaction(|doc, steps| {
            doc.model.unmerge_cells(&area)?;
            *steps += 1;
            action(&mut doc.model)?;
            *steps += 1;
            doc.model.merge_cells(&area)?;
            *steps += 1;
            Ok(())
        })
    }

    // ───────────── combinar e inmovilizar ─────────────

    /// Combina el rango en una sola celda (se conserva el contenido de la esquina superior izquierda).
    pub fn merge(&mut self, sheet: u32, rect: Rect) -> Result<(), String> {
        let area = rect.area(sheet);
        if area.width == 1 && area.height == 1 {
            return Err("Selecciona al menos dos celdas para combinarlas".into());
        }
        self.step(|m| m.merge_cells(&area))
    }

    pub fn unmerge(&mut self, sheet: u32, rect: Rect) -> Result<(), String> {
        self.step(|m| m.unmerge_cells(&rect.area(sheet)))
    }

    /// Deja fijas las primeras `rows` filas y `cols` columnas (0 para quitar).
    pub fn freeze(&mut self, sheet: u32, rows: i32, cols: i32) -> Result<(), String> {
        self.transaction(|doc, steps| {
            if doc.model.get_frozen_rows_count(sheet)? != rows {
                doc.model.set_frozen_rows_count(sheet, rows.max(0))?;
                *steps += 1;
            }
            if doc.model.get_frozen_columns_count(sheet)? != cols {
                doc.model.set_frozen_columns_count(sheet, cols.max(0))?;
                *steps += 1;
            }
            Ok(())
        })
    }

    // ───────────── pestañas ─────────────

    pub fn rename_sheet(&mut self, sheet: u32, name: &str) -> Result<(), String> {
        let name = name.trim();
        if name.is_empty() {
            return Err("El nombre de la hoja no puede quedar vacío".into());
        }
        let old = self.sheet_names().get(sheet as usize).cloned().unwrap_or_default();
        self.step(|m| m.rename_sheet(sheet, name))?;
        // Las gráficas que usan esta hoja siguen apuntando a ella.
        self.rename_in_charts(&old, name);
        Ok(())
    }

    pub fn delete_sheet(&mut self, sheet: u32) -> Result<(), String> {
        if self.sheet_names().len() <= 1 {
            return Err("El libro necesita al menos una hoja".into());
        }
        self.step(|m| m.delete_sheet(sheet))
    }

    /// Duplica una hoja y devuelve el índice de la copia.
    pub fn duplicate_sheet(&mut self, sheet: u32) -> Result<u32, String> {
        self.step(|m| {
            m.duplicate_sheet(sheet)?;
            Ok(m.get_selected_sheet())
        })
    }

    pub fn move_sheet(&mut self, sheet: u32, to: u32) -> Result<(), String> {
        if sheet == to {
            return Ok(());
        }
        self.step(|m| m.move_sheet(sheet, to))
    }

    // ───────────── autollenado ─────────────

    /// Continúa el contenido de `source` hasta cubrir `target`, como al
    /// arrastrar la esquina de la selección en Excel: series (1, 2, 3…,
    /// lunes, martes…) y fórmulas con sus referencias ajustadas.
    pub fn auto_fill(&mut self, sheet: u32, source: Rect, target: Rect) -> Result<(), String> {
        let src = source.area(sheet);
        let dst = target.area(sheet);
        let (src_last_row, src_last_col) = (src.row + src.height - 1, src.column + src.width - 1);
        let (dst_last_row, dst_last_col) = (dst.row + dst.height - 1, dst.column + dst.width - 1);

        if dst.column == src.column && dst.width == src.width {
            // Hacia abajo o hacia arriba.
            let to_row = if dst_last_row > src_last_row { dst_last_row } else { dst.row };
            if to_row == src.row || to_row == src_last_row {
                return Ok(());
            }
            self.step(|m| m.auto_fill_rows(&src, to_row))
        } else if dst.row == src.row && dst.height == src.height {
            // Hacia la derecha o hacia la izquierda.
            let to_col = if dst_last_col > src_last_col { dst_last_col } else { dst.column };
            if to_col == src.column || to_col == src_last_col {
                return Ok(());
            }
            self.step(|m| m.auto_fill_columns(&src, to_col))
        } else {
            Err("El autollenado solo funciona en una dirección a la vez".into())
        }
    }
}
