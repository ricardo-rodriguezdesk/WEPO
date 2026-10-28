//! Herramientas de datos: ordenar, filtrar, buscar y reemplazar.

use std::cmp::Ordering;

use ironcalc::base::cell::CellValue;
use serde::{Deserialize, Serialize};

use super::{Rect, SheetDocument};

/// Filtro de una columna (desde 1): los valores (tal como se ven) que se
/// quedan, o una condición como "mayor que 100" o "contiene Norte".
#[derive(Deserialize, Clone, Debug, Default)]
pub struct ColumnFilter {
    pub col: i32,
    #[serde(default)]
    pub keep: Option<Vec<String>>,
    #[serde(default)]
    pub condition: Option<FilterCondition>,
}

#[derive(Deserialize, Clone, Debug, PartialEq)]
pub struct FilterCondition {
    /// equals, not_equals, contains, not_contains, begins, ends,
    /// greater, greater_or_equal, less, less_or_equal, between
    pub op: String,
    pub value: String,
    #[serde(default)]
    pub value2: Option<String>,
}

impl FilterCondition {
    /// ¿El valor de la celda (número si lo es, y su texto como se ve) cumple la condición?
    pub fn holds(&self, number: Option<f64>, text: &str) -> bool {
        let text = text.to_lowercase();
        let wanted = self.value.trim().to_lowercase();
        let as_number = |v: &str| v.trim().replace(',', ".").parse::<f64>().ok();
        let compare = |f: fn(f64, f64) -> bool| match (number, as_number(&self.value)) {
            (Some(n), Some(v)) => f(n, v),
            _ => false,
        };
        match self.op.as_str() {
            "equals" => match (number, as_number(&self.value)) {
                (Some(n), Some(v)) => n == v,
                _ => text == wanted,
            },
            "not_equals" => match (number, as_number(&self.value)) {
                (Some(n), Some(v)) => n != v,
                _ => text != wanted,
            },
            "contains" => text.contains(&wanted),
            "not_contains" => !text.contains(&wanted),
            "begins" => text.starts_with(&wanted),
            "ends" => text.ends_with(&wanted),
            "greater" => compare(|n, v| n > v),
            "greater_or_equal" => compare(|n, v| n >= v),
            "less" => compare(|n, v| n < v),
            "less_or_equal" => compare(|n, v| n <= v),
            "between" => match (number, as_number(&self.value), self.value2.as_deref().and_then(as_number)) {
                (Some(n), Some(a), Some(b)) => n >= a.min(b) && n <= a.max(b),
                _ => false,
            },
            _ => true,
        }
    }
}

/// Columna por la que se ordena (desde 1) y en qué sentido.
#[derive(Deserialize, Clone, Copy, Debug)]
pub struct SortKey {
    pub col: i32,
    pub ascending: bool,
}

/// Celda que coincide con una búsqueda (desde 1).
#[derive(Serialize, Debug, PartialEq)]
pub struct FindMatch {
    pub sheet: u32,
    pub row: i32,
    pub col: i32,
}

/// Orden de Excel al ordenar de menor a mayor: números, texto, verdadero/falso.
/// Las celdas vacías van siempre al final, sin importar el sentido.
fn compare(a: &CellValue, b: &CellValue, ascending: bool) -> Ordering {
    fn rank(v: &CellValue) -> u8 {
        match v {
            CellValue::Number(_) => 0,
            CellValue::String(_) => 1,
            CellValue::Boolean(_) => 2,
            CellValue::None => 3,
        }
    }
    match (a, b) {
        (CellValue::None, CellValue::None) => return Ordering::Equal,
        (CellValue::None, _) => return Ordering::Greater,
        (_, CellValue::None) => return Ordering::Less,
        _ => {}
    }
    let ordering = match (a, b) {
        (CellValue::Number(x), CellValue::Number(y)) => x.partial_cmp(y).unwrap_or(Ordering::Equal),
        (CellValue::String(x), CellValue::String(y)) => x.to_lowercase().cmp(&y.to_lowercase()),
        (CellValue::Boolean(x), CellValue::Boolean(y)) => x.cmp(y),
        _ => rank(a).cmp(&rank(b)),
    };
    if ascending { ordering } else { ordering.reverse() }
}

/// Texto en minúsculas carácter por carácter, para comparar sin importar mayúsculas
/// y sin cambiar la cantidad de caracteres.
fn fold(text: &str) -> Vec<char> {
    text.chars().map(|c| c.to_lowercase().next().unwrap_or(c)).collect()
}

/// Reemplaza `query` por `replacement` en `text`. Devuelve None si no aparece.
fn replace_in(text: &str, query: &str, replacement: &str, match_case: bool) -> Option<String> {
    if query.is_empty() {
        return None;
    }
    if match_case {
        return text.contains(query).then(|| text.replace(query, replacement));
    }
    let chars: Vec<char> = text.chars().collect();
    let (hay, needle) = (fold(text), fold(query));
    let mut out = String::with_capacity(text.len());
    let (mut i, mut found) = (0, false);
    while i < chars.len() {
        if hay[i..].starts_with(&needle) {
            out.push_str(replacement);
            i += needle.len();
            found = true;
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    found.then_some(out)
}

fn matches(text: &str, query: &str, match_case: bool, whole_cell: bool) -> bool {
    if query.is_empty() || text.is_empty() {
        return false;
    }
    match (match_case, whole_cell) {
        (true, true) => text == query,
        (true, false) => text.contains(query),
        (false, true) => fold(text) == fold(query),
        (false, false) => {
            let (hay, needle) = (fold(text), fold(query));
            hay.windows(needle.len()).any(|w| w == needle.as_slice())
        }
    }
}

impl SheetDocument {
    // ───────────── ordenar ─────────────

    /// Ordena las filas de `rect` según `keys`. Si `has_header`, la primera
    /// fila se queda en su lugar. Las fórmulas y el formato viajan con su fila.
    pub fn sort(&mut self, sheet: u32, rect: Rect, keys: &[SortKey], has_header: bool) -> Result<(), String> {
        self.check_cells(sheet, rect)?;
        let area = rect.area(sheet);
        let (col1, col2) = (area.column, area.column + area.width - 1);
        let first = area.row + i32::from(has_header);
        let last = area.row + area.height - 1;
        if first >= last || keys.is_empty() {
            return Ok(());
        }

        let model = self.model.get_model();
        let mut rows: Vec<(i32, Vec<CellValue>)> = Vec::new();
        for row in first..=last {
            let values = keys
                .iter()
                .map(|k| model.get_cell_value_by_index(sheet, row, k.col))
                .collect::<Result<_, _>>()?;
            rows.push((row, values));
        }
        // Orden estable: filas iguales conservan su orden original.
        rows.sort_by(|(_, a), (_, b)| {
            keys.iter()
                .enumerate()
                .map(|(i, k)| compare(&a[i], &b[i], k.ascending))
                .find(|o| *o != Ordering::Equal)
                .unwrap_or(Ordering::Equal)
        });

        // Primero copiamos cada fila tal como está y después la pegamos en su
        // nuevo lugar: al pegar, las fórmulas ajustan sus referencias.
        let mut moves = Vec::new();
        for (i, (source, _)) in rows.iter().enumerate() {
            let target = first + i as i32;
            if *source != target {
                let (_, range, data) = self.capture(sheet, *source, col1, *source, col2)?;
                moves.push((target, range, data));
            }
        }
        if moves.is_empty() {
            return Ok(());
        }
        self.transaction(|doc, steps| {
            for (target, range, data) in &moves {
                doc.select(sheet, *target, col1, *target, col2)?;
                doc.model.paste_from_clipboard(sheet, *range, data, false)?;
                *steps += 1;
            }
            Ok(())
        })
    }

    // ───────────── filtrar ─────────────

    /// Oculta las filas de datos (debajo del encabezado de `rect`) que no
    /// pasan todos los filtros, y muestra las demás. Cada filtro dice qué
    /// valores (tal como se ven) se quedan en su columna.
    pub fn filter(&mut self, sheet: u32, rect: Rect, filters: &[ColumnFilter]) -> Result<(), String> {
        let area = rect.area(sheet);
        let (first, last) = (area.row + 1, area.row + area.height - 1);
        let model = self.model.get_model();
        let mut hidden = Vec::new();
        for row in first..=last {
            let mut hide = false;
            for f in filters {
                let text = model.get_formatted_cell_value(sheet, row, f.col)?;
                let passes = match (&f.keep, &f.condition) {
                    (Some(keep), _) => keep.contains(&text),
                    (None, Some(condition)) => {
                        let number = match model.get_cell_value_by_index(sheet, row, f.col)? {
                            CellValue::Number(n) => Some(n),
                            _ => None,
                        };
                        condition.holds(number, &text)
                    }
                    (None, None) => true,
                };
                if !passes {
                    hide = true;
                    break;
                }
            }
            hidden.push((row, hide));
        }
        // Agrupamos filas seguidas con el mismo estado para hacer menos pasos.
        self.transaction(|doc, steps| {
            let mut i = 0;
            while i < hidden.len() {
                let (start, state) = hidden[i];
                let mut end = start;
                while i + 1 < hidden.len() && hidden[i + 1].1 == state {
                    i += 1;
                    end = hidden[i].0;
                }
                doc.model.set_rows_hidden(sheet, start, end, state)?;
                *steps += 1;
                i += 1;
            }
            Ok(())
        })
    }

    // ───────────── quitar duplicados ─────────────

    /// Quita las filas de `rect` que repiten los valores de `cols` (desde 1) de una
    /// fila anterior. Las que quedan suben, como en Excel; lo de fuera de `rect`
    /// no se mueve. Devuelve cuántas filas se quitaron.
    pub fn remove_duplicates(&mut self, sheet: u32, rect: Rect, cols: &[i32], has_header: bool) -> Result<usize, String> {
        self.check_cells(sheet, rect)?;
        let area = rect.area(sheet);
        let (col1, col2) = (area.column, area.column + area.width - 1);
        let first = area.row + i32::from(has_header);
        let last = area.row + area.height - 1;
        if first > last || cols.is_empty() {
            return Ok(0);
        }
        let model = self.model.get_model();
        let mut seen = std::collections::HashSet::new();
        let mut kept = Vec::new();
        for row in first..=last {
            let mut key = Vec::new();
            for col in cols {
                key.push(model.get_formatted_cell_value(sheet, row, *col)?.to_lowercase());
            }
            if seen.insert(key) {
                kept.push(row);
            }
        }
        let removed = (last - first + 1) as usize - kept.len();
        if removed == 0 {
            return Ok(0);
        }
        // Como al ordenar: se copia cada fila que se queda y se pega en su nuevo lugar.
        let mut moves = Vec::new();
        for (i, source) in kept.iter().enumerate() {
            let target = first + i as i32;
            if *source != target {
                let (_, range, data) = self.capture(sheet, *source, col1, *source, col2)?;
                moves.push((target, range, data));
            }
        }
        let clear_from = first + kept.len() as i32;
        self.transaction(|doc, steps| {
            for (target, range, data) in &moves {
                doc.select(sheet, *target, col1, *target, col2)?;
                doc.model.paste_from_clipboard(sheet, *range, data, false)?;
                *steps += 1;
            }
            let rest = Rect { row1: clear_from, col1, row2: last, col2 }.area(sheet);
            doc.model.range_clear_all(&rest)?;
            *steps += 1;
            Ok(())
        })?;
        Ok(removed)
    }

    /// Vuelve a mostrar todas las filas de datos de `rect`.
    pub fn clear_filter(&mut self, sheet: u32, rect: Rect) -> Result<(), String> {
        let area = rect.area(sheet);
        if area.height < 2 {
            return Ok(());
        }
        self.step(|m| m.set_rows_hidden(sheet, area.row + 1, area.row + area.height - 1, false))
    }

    // ───────────── buscar y reemplazar ─────────────

    fn sheets_to_search(&self, sheet: u32, all_sheets: bool) -> Vec<u32> {
        if all_sheets {
            (0..self.sheet_names().len() as u32).collect()
        } else {
            vec![sheet]
        }
    }

    /// Celdas con contenido, de arriba abajo y de izquierda a derecha.
    fn cells_of(&self, sheet: u32) -> Result<Vec<(i32, i32)>, String> {
        let data = &self.model.get_model().workbook.worksheet(sheet)?.sheet_data;
        let mut rows = data.rows();
        rows.sort_unstable();
        let mut cells = Vec::new();
        for row in rows {
            let mut cols = data.columns_in_row(row);
            cols.sort_unstable();
            cells.extend(cols.into_iter().map(|c| (row, c)));
        }
        Ok(cells)
    }

    /// Busca en lo que se ve en la celda y en su fórmula.
    pub fn find(
        &self,
        sheet: u32,
        query: &str,
        match_case: bool,
        whole_cell: bool,
        all_sheets: bool,
    ) -> Result<Vec<FindMatch>, String> {
        let model = self.model.get_model();
        let mut found = Vec::new();
        for s in self.sheets_to_search(sheet, all_sheets) {
            for (row, col) in self.cells_of(s)? {
                let shown = model.get_formatted_cell_value(s, row, col)?;
                let input = self.model.get_cell_content(s, row, col)?;
                if matches(&shown, query, match_case, whole_cell) || matches(&input, query, match_case, whole_cell) {
                    found.push(FindMatch { sheet: s, row, col });
                }
            }
        }
        Ok(found)
    }

    /// Reemplaza en el contenido de las celdas (también dentro de fórmulas).
    /// Devuelve cuántas celdas cambiaron; todo se deshace con un solo ⌘Z.
    pub fn replace_all(
        &mut self,
        sheet: u32,
        query: &str,
        replacement: &str,
        match_case: bool,
        whole_cell: bool,
        all_sheets: bool,
    ) -> Result<usize, String> {
        let mut changes = Vec::new();
        for s in self.sheets_to_search(sheet, all_sheets) {
            for (row, col) in self.cells_of(s)? {
                let input = self.model.get_cell_content(s, row, col)?;
                let new_input = if whole_cell {
                    matches(&input, query, match_case, true).then(|| replacement.to_string())
                } else {
                    replace_in(&input, query, replacement, match_case)
                };
                if let Some(new_input) = new_input.filter(|n| *n != input) {
                    changes.push((s, row, col, new_input));
                }
            }
        }
        let count = changes.len();
        self.transaction(|doc, steps| {
            for (s, row, col, input) in &changes {
                doc.model.set_user_input(*s, *row, *col, input)?;
                *steps += 1;
            }
            Ok(())
        })?;
        Ok(count)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reemplaza_sin_importar_mayusculas() {
        assert_eq!(replace_in("Hola hola HOLA", "hola", "adiós", false).unwrap(), "adiós adiós adiós");
        assert_eq!(replace_in("Hola hola", "hola", "x", true).unwrap(), "Hola x");
        assert!(replace_in("nada", "hola", "x", false).is_none());
        assert!(matches("Peñón", "PEÑ", false, false));
        assert!(!matches("Peñón", "PEÑ", false, true));
    }
}
