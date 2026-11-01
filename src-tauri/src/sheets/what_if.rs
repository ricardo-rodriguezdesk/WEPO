//! Texto en columnas («Juan Pérez» → «Juan» | «Pérez») y Buscar objetivo
//! (qué valor necesita una celda para que una fórmula dé lo que quieres).

use ironcalc::base::cell::CellValue;
use serde::{Deserialize, Serialize};

use super::{Rect, SheetDocument};

/// Cómo se parte el texto: por separadores o por anchos fijos (en letras).
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum SplitSpec {
    Delimited {
        delimiters: Vec<char>,
        /// Varios separadores seguidos cuentan como uno (como «Considerar separadores consecutivos como uno solo»).
        #[serde(default)]
        merge: bool,
        /// Lo que va entre comillas no se parte ("Pérez, Juan").
        #[serde(default)]
        quote: Option<char>,
    },
    Fixed { breaks: Vec<usize> },
}

/// Parte un texto según la especificación.
pub fn split_text(text: &str, spec: &SplitSpec) -> Vec<String> {
    match spec {
        SplitSpec::Fixed { breaks } => {
            let chars: Vec<char> = text.chars().collect();
            let mut out = Vec::new();
            let mut start = 0;
            let mut cuts: Vec<usize> = breaks.iter().copied().filter(|&b| b > 0).collect();
            cuts.sort_unstable();
            cuts.dedup();
            for b in cuts {
                if b >= chars.len() {
                    break;
                }
                out.push(chars[start..b].iter().collect::<String>().trim().to_string());
                start = b;
            }
            out.push(chars[start.min(chars.len())..].iter().collect::<String>().trim().to_string());
            out
        }
        SplitSpec::Delimited { delimiters, merge, quote } => {
            let mut out = Vec::new();
            let mut current = String::new();
            let mut quoted = false;
            let mut last_was_delimiter = false;
            for ch in text.chars() {
                if Some(ch) == *quote {
                    quoted = !quoted;
                    last_was_delimiter = false;
                    continue;
                }
                if !quoted && delimiters.contains(&ch) {
                    if *merge && last_was_delimiter {
                        continue;
                    }
                    out.push(std::mem::take(&mut current));
                    last_was_delimiter = true;
                } else {
                    current.push(ch);
                    last_was_delimiter = false;
                }
            }
            out.push(current);
            out
        }
    }
}

#[derive(Serialize, Debug, Clone)]
pub struct GoalSeek {
    /// Se encontró un valor (la fórmula llega al objetivo).
    pub found: bool,
    /// El valor que quedó en la celda que cambia.
    pub value: f64,
    /// Lo que da la fórmula con ese valor.
    pub result: f64,
    /// Lo que tenía antes la celda que cambia (para «Cancelar»).
    pub before: String,
}

impl SheetDocument {
    /// Parte el texto de las celdas `col` (filas `row1..=row2`) y lo pone a partir de la columna `dest`.
    /// Devuelve cuántas columnas salieron.
    pub fn text_to_columns(&mut self, sheet: u32, col: i32, row1: i32, row2: i32, dest: i32, spec: &SplitSpec) -> Result<usize, String> {
        let mut rows: Vec<(i32, Vec<String>)> = Vec::new();
        for row in row1..=row2 {
            let text = self.model.get_formatted_cell_value(sheet, row, col)?;
            if text.is_empty() {
                continue;
            }
            rows.push((row, split_text(&text, spec)));
        }
        let width = rows.iter().map(|(_, p)| p.len()).max().unwrap_or(0);
        if width == 0 {
            return Err("Las celdas elegidas están vacías".into());
        }
        self.check_cells(sheet, Rect { row1, col1: dest, row2, col2: dest + width as i32 - 1 })?;
        self.transaction(|doc, steps| {
            for (row, parts) in &rows {
                for k in 0..width {
                    let target = dest + k as i32;
                    let part = parts.get(k).map(|s| s.as_str()).unwrap_or("");
                    if part.is_empty() {
                        // Lo que hubiera en esa celda se quita (las columnas nuevas quedan limpias).
                        if target != col || k == 0 {
                            let rect = Rect { row1: *row, col1: target, row2: *row, col2: target };
                            doc.model.range_clear_contents(&rect.area(sheet))?;
                            *steps += 1;
                        }
                        continue;
                    }
                    // Un pedazo que empieza con = es texto, no una fórmula.
                    let input = if part.starts_with('=') { format!("'{part}") } else { part.to_string() };
                    doc.model.set_user_input(sheet, *row, target, &input)?;
                    *steps += 1;
                }
            }
            Ok(())
        })?;
        Ok(width)
    }

    fn number_at(&self, sheet: u32, row: i32, col: i32) -> Option<f64> {
        match self.model.get_model().get_cell_value_by_index(sheet, row, col).ok()? {
            CellValue::Number(n) => Some(n),
            CellValue::Boolean(b) => Some(if b { 1.0 } else { 0.0 }),
            _ => None,
        }
    }

    /// Buscar objetivo: cambia `changing` hasta que la fórmula de `target` dé `goal`.
    /// Queda como una sola acción (se deshace con ⌘Z).
    pub fn goal_seek(&mut self, sheet: u32, target: (i32, i32), goal: f64, changing: (i32, i32)) -> Result<GoalSeek, String> {
        let formula = self.model.get_cell_content(sheet, target.0, target.1)?;
        if !formula.starts_with('=') {
            return Err("La celda a definir debe tener una fórmula".into());
        }
        let before = self.model.get_cell_content(sheet, changing.0, changing.1)?;
        if before.starts_with('=') {
            return Err("La celda que cambia debe tener un valor, no una fórmula".into());
        }
        self.check_cells(sheet, Rect { row1: changing.0, col1: changing.1, row2: changing.0, col2: changing.1 })?;
        let start = self.number_at(sheet, changing.0, changing.1).unwrap_or(0.0);
        let mut tries = 0usize;
        // Cada prueba es un paso del motor; al final se deshacen todos y queda uno solo.
        let mut eval = |doc: &mut Self, x: f64| -> Result<Option<f64>, String> {
            doc.model.set_user_input(sheet, changing.0, changing.1, &format_number(x))?;
            tries += 1;
            Ok(doc.number_at(sheet, target.0, target.1).map(|v| v - goal))
        };
        let tolerance = (goal.abs() * 1e-9).max(1e-7);
        let mut best: Option<(f64, f64)> = None;
        let consider = |x: f64, f: f64, best: &mut Option<(f64, f64)>| {
            if best.is_none_or(|(_, bf)| f.abs() < bf.abs()) {
                *best = Some((x, f));
            }
        };
        // 1) Secante desde el valor actual.
        let mut x0 = start;
        let mut x1 = if start == 0.0 { 1.0 } else { start * 1.1 };
        let mut f0 = eval(self, x0)?;
        let mut f1 = eval(self, x1)?;
        let mut found = false;
        if let (Some(a), Some(b)) = (f0, f1) {
            consider(x0, a, &mut best);
            consider(x1, b, &mut best);
            for _ in 0..60 {
                let (Some(a), Some(b)) = (f0, f1) else { break };
                if b.abs() <= tolerance {
                    found = true;
                    break;
                }
                if (b - a).abs() < f64::EPSILON {
                    break;
                }
                let x2 = x1 - b * (x1 - x0) / (b - a);
                if !x2.is_finite() {
                    break;
                }
                x0 = x1;
                f0 = f1;
                x1 = x2;
                f1 = eval(self, x1)?;
                if let Some(v) = f1 {
                    consider(x1, v, &mut best);
                }
            }
        }
        // 2) Si no llegó, se busca un cambio de signo y se parte a la mitad.
        if !found {
            let mut lo = None;
            let base = if start == 0.0 { 1.0 } else { start.abs() };
            'outer: for k in 0..40 {
                let span = base * 2f64.powi(k);
                for x in [start - span, start + span] {
                    if let (Some(fs), Some(fx)) = (eval(self, start)?, eval(self, x)?) {
                        consider(x, fx, &mut best);
                        if fs.signum() != fx.signum() {
                            lo = Some((start.min(x), start.max(x)));
                            break 'outer;
                        }
                    }
                }
            }
            if let Some((mut a, mut b)) = lo {
                let mut fa = eval(self, a)?.unwrap_or(0.0);
                for _ in 0..200 {
                    let m = (a + b) / 2.0;
                    let Some(fm) = eval(self, m)? else { break };
                    consider(m, fm, &mut best);
                    if fm.abs() <= tolerance {
                        found = true;
                        break;
                    }
                    if fa.signum() == fm.signum() {
                        a = m;
                        fa = fm;
                    } else {
                        b = m;
                    }
                }
            }
        }
        // Se deshacen las pruebas y se pone el mejor valor como un solo cambio.
        for _ in 0..tries {
            self.model.undo()?;
        }
        let Some((x, f)) = best else {
            return Err("La fórmula no da un número con esos valores".into());
        };
        let found = found || f.abs() <= tolerance.max(1e-6);
        self.step(|m| m.set_user_input(sheet, changing.0, changing.1, &format_number(x)))?;
        let result = self.number_at(sheet, target.0, target.1).unwrap_or(f + goal);
        Ok(GoalSeek { found, value: x, result, before })
    }
}

/// Un número como se escribiría (sin «e» para los normales y sin ceros de más).
fn format_number(x: f64) -> String {
    if x == x.trunc() && x.abs() < 1e15 {
        format!("{}", x as i64)
    } else {
        let s = format!("{x:.12}");
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parte_por_separadores_y_comillas() {
        let spec = SplitSpec::Delimited { delimiters: vec![' '], merge: true, quote: Some('"') };
        assert_eq!(split_text("Juan   Pérez", &spec), vec!["Juan", "Pérez"]);
        let spec = SplitSpec::Delimited { delimiters: vec![','], merge: false, quote: Some('"') };
        assert_eq!(split_text("\"Pérez, Juan\",30,,MX", &spec), vec!["Pérez, Juan", "30", "", "MX"]);
    }

    #[test]
    fn parte_por_anchos_fijos() {
        let spec = SplitSpec::Fixed { breaks: vec![4, 8] };
        assert_eq!(split_text("2026ABCD12", &spec), vec!["2026", "ABCD", "12"]);
    }

    #[test]
    fn buscar_objetivo_encuentra_el_valor() {
        let mut doc = SheetDocument::new_empty().unwrap();
        doc.set_cell(0, 1, 1, "100").unwrap(); // A1: precio
        doc.set_cell(0, 2, 1, "=A1*1.16").unwrap(); // A2: con IVA
        let r = doc.goal_seek(0, (2, 1), 580.0, (1, 1)).unwrap();
        assert!(r.found);
        assert!((r.value - 500.0).abs() < 1e-6, "{}", r.value);
        assert!((r.result - 580.0).abs() < 1e-6);
        // Una sola acción: se deshace de una vez.
        doc.undo().unwrap();
        assert_eq!(doc.model.get_cell_content(0, 1, 1).unwrap(), "100");
    }

    #[test]
    fn buscar_objetivo_no_lineal() {
        let mut doc = SheetDocument::new_empty().unwrap();
        doc.set_cell(0, 1, 1, "1").unwrap();
        doc.set_cell(0, 2, 1, "=A1*A1*A1-27").unwrap();
        let r = doc.goal_seek(0, (2, 1), 0.0, (1, 1)).unwrap();
        assert!(r.found);
        assert!((r.value - 3.0).abs() < 1e-5, "{}", r.value);
    }

    #[test]
    fn texto_en_columnas_en_la_hoja() {
        let mut doc = SheetDocument::new_empty().unwrap();
        doc.set_cell(0, 1, 1, "Juan Pérez").unwrap();
        doc.set_cell(0, 2, 1, "Ana María López").unwrap();
        let spec = SplitSpec::Delimited { delimiters: vec![' '], merge: true, quote: None };
        assert_eq!(doc.text_to_columns(0, 1, 1, 2, 1, &spec).unwrap(), 3);
        assert_eq!(doc.model.get_cell_content(0, 1, 1).unwrap(), "Juan");
        assert_eq!(doc.model.get_cell_content(0, 1, 2).unwrap(), "Pérez");
        assert_eq!(doc.model.get_cell_content(0, 2, 3).unwrap(), "López");
        doc.undo().unwrap();
        assert_eq!(doc.model.get_cell_content(0, 1, 1).unwrap(), "Juan Pérez");
    }
}
