//! Agrupar filas y columnas (el «esquema» de Excel): cada fila o columna tiene
//! un nivel (0 = sin grupo, hasta 7). Los grupos son las rachas de filas
//! seguidas con nivel ≥ N; se contraen con − (las filas se esconden) y se
//! expanden con +. Se lee y se guarda en el .xlsx como `outlineLevel`.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::SheetDocument;
use crate::xlsx_outline::RawOutline;

pub const MAX_LEVEL: u8 = 7;

#[derive(Clone, Debug, PartialEq, Default)]
pub struct Outline {
    pub sheet_id: u32,
    pub columns: bool,
    /// Nivel de cada fila o columna (desde 1) que está en algún grupo.
    pub levels: BTreeMap<i32, u8>,
    /// Grupos contraídos: (nivel, primera fila del grupo).
    pub collapsed: Vec<(u8, i32)>,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct GroupView {
    pub level: u8,
    /// Primera y última fila (o columna) del grupo, desde 1.
    pub start: i32,
    pub end: i32,
    pub collapsed: bool,
}

#[derive(Serialize, Debug, Default)]
pub struct OutlineView {
    pub rows: Vec<GroupView>,
    pub cols: Vec<GroupView>,
    /// Nivel más alto (los botones 1, 2… de la esquina van hasta este + 1).
    pub row_levels: u8,
    pub col_levels: u8,
}

/// Los grupos de un esquema: para cada nivel, las rachas seguidas con nivel ≥ ese.
pub fn groups(outline: &Outline) -> Vec<GroupView> {
    let max = outline.levels.values().copied().max().unwrap_or(0);
    let mut out = Vec::new();
    for level in 1..=max {
        let mut start: Option<i32> = None;
        let mut last = 0;
        for (&i, &l) in &outline.levels {
            if l >= level {
                if start.is_some() && i == last + 1 {
                    last = i;
                    continue;
                }
                if let Some(s) = start {
                    out.push(GroupView { level, start: s, end: last, collapsed: outline.collapsed.contains(&(level, s)) });
                }
                start = Some(i);
                last = i;
            }
        }
        if let Some(s) = start {
            out.push(GroupView { level, start: s, end: last, collapsed: outline.collapsed.contains(&(level, s)) });
        }
    }
    out
}

/// Lo que se hace con los grupos.
#[derive(Deserialize, Debug, Clone)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum OutlineAction {
    Group { columns: bool, start: i32, end: i32 },
    Ungroup { columns: bool, start: i32, end: i32 },
    /// «Borrar esquema».
    Clear { columns: bool },
    /// − (contraer) o + (expandir) en un grupo.
    Collapse { columns: bool, level: u8, start: i32, collapsed: bool },
    /// Botones 1, 2, 3… de la esquina.
    Level { columns: bool, level: u8 },
}

impl SheetDocument {
    pub fn outline(&mut self, sheet: u32, action: OutlineAction) -> Result<(), String> {
        match action {
            OutlineAction::Group { columns, start, end } => self.group(sheet, columns, start, end),
            OutlineAction::Ungroup { columns, start, end } => self.ungroup(sheet, columns, start, end),
            OutlineAction::Clear { columns } => self.clear_outline(sheet, columns),
            OutlineAction::Collapse { columns, level, start, collapsed } => self.set_group_collapsed(sheet, columns, level, start, collapsed),
            OutlineAction::Level { columns, level } => self.show_outline_level(sheet, columns, level),
        }
    }

    pub fn outline_view(&self, sheet: u32) -> OutlineView {
        let Some(id) = self.sheet_id(sheet) else { return OutlineView::default() };
        let mut view = OutlineView::default();
        for o in self.extras.outlines.iter().filter(|o| o.sheet_id == id) {
            let list = groups(o);
            let max = o.levels.values().copied().max().unwrap_or(0);
            if o.columns {
                view.cols = list;
                view.col_levels = max;
            } else {
                view.rows = list;
                view.row_levels = max;
            }
        }
        view
    }

    fn outline_index(&mut self, sheet_id: u32, columns: bool) -> usize {
        match self.extras.outlines.iter().position(|o| o.sheet_id == sheet_id && o.columns == columns) {
            Some(i) => i,
            None => {
                self.extras.outlines.push(Outline { sheet_id, columns, ..Default::default() });
                self.extras.outlines.len() - 1
            }
        }
    }

    /// Esconde o muestra filas (o columnas) de `start` a `end` como un paso del motor.
    fn hide_span(&mut self, sheet: u32, columns: bool, start: i32, end: i32, hidden: bool, steps: &mut usize) -> Result<(), String> {
        if end < start {
            return Ok(());
        }
        if columns {
            self.model.set_columns_hidden(sheet, start, end, hidden)?;
        } else {
            self.model.set_rows_hidden(sheet, start, end, hidden)?;
        }
        *steps += 1;
        Ok(())
    }

    /// Muestra lo que deben verse según los grupos contraídos (dentro de `start..=end`).
    fn apply_collapsed(&mut self, sheet: u32, index: usize, start: i32, end: i32, steps: &mut usize) -> Result<(), String> {
        let outline = self.extras.outlines[index].clone();
        let list = groups(&outline);
        let hidden_by = |i: i32| list.iter().any(|g| g.collapsed && i >= g.start && i <= g.end);
        // Rachas de filas que quedan escondidas o visibles.
        let mut i = start;
        while i <= end {
            let hide = hidden_by(i);
            let mut j = i;
            while j < end && hidden_by(j + 1) == hide {
                j += 1;
            }
            self.hide_span(sheet, outline.columns, i, j, hide, steps)?;
            i = j + 1;
        }
        Ok(())
    }

    /// Agrupa filas (o columnas) de `start` a `end` (desde 1): suben un nivel.
    pub fn group(&mut self, sheet: u32, columns: bool, start: i32, end: i32) -> Result<(), String> {
        self.check_sheet(sheet)?;
        let id = self.sheet_id(sheet).ok_or("Hoja inválida")?;
        let (start, end) = (start.min(end).max(1), start.max(end));
        self.mixed(|doc, _| {
            let index = doc.outline_index(id, columns);
            let levels = &mut doc.extras.outlines[index].levels;
            if (start..=end).any(|i| levels.get(&i).copied().unwrap_or(0) >= MAX_LEVEL) {
                return Err("Excel permite hasta 7 niveles de grupos".into());
            }
            for i in start..=end {
                *levels.entry(i).or_insert(0) += 1;
            }
            Ok(())
        })
    }

    /// Desagrupa: bajan un nivel (lo que estaba contraído ahí se vuelve a ver).
    pub fn ungroup(&mut self, sheet: u32, columns: bool, start: i32, end: i32) -> Result<(), String> {
        self.check_sheet(sheet)?;
        let id = self.sheet_id(sheet).ok_or("Hoja inválida")?;
        let (start, end) = (start.min(end).max(1), start.max(end));
        let Some(index) = self.extras.outlines.iter().position(|o| o.sheet_id == id && o.columns == columns) else {
            return Err(format!("No hay {} agrupadas ahí", if columns { "columnas" } else { "filas" }));
        };
        if !(start..=end).any(|i| self.extras.outlines[index].levels.contains_key(&i)) {
            return Err(format!("No hay {} agrupadas ahí", if columns { "columnas" } else { "filas" }));
        }
        self.mixed(|doc, steps| {
            let before = groups(&doc.extras.outlines[index]);
            let outline = &mut doc.extras.outlines[index];
            for i in start..=end {
                if let Some(l) = outline.levels.get_mut(&i) {
                    *l -= 1;
                    if *l == 0 {
                        outline.levels.remove(&i);
                    }
                }
            }
            // Los grupos contraídos que se tocaron se abren (como en Excel).
            let touched: Vec<(u8, i32)> = before.iter().filter(|g| g.collapsed && g.start <= end && g.end >= start).map(|g| (g.level, g.start)).collect();
            outline.collapsed.retain(|c| !touched.contains(c));
            let (lo, hi) = before.iter().filter(|g| g.start <= end && g.end >= start).fold((start, end), |(a, b), g| (a.min(g.start), b.max(g.end)));
            doc.apply_collapsed(sheet, index, lo, hi, steps)
        })
    }

    /// «Borrar esquema»: quita todos los grupos de filas (o columnas) de la hoja y muestra lo escondido por ellos.
    pub fn clear_outline(&mut self, sheet: u32, columns: bool) -> Result<(), String> {
        self.check_sheet(sheet)?;
        let id = self.sheet_id(sheet).ok_or("Hoja inválida")?;
        let Some(index) = self.extras.outlines.iter().position(|o| o.sheet_id == id && o.columns == columns) else { return Ok(()) };
        self.mixed(|doc, steps| {
            let spans: Vec<(i32, i32)> = groups(&doc.extras.outlines[index]).into_iter().filter(|g| g.collapsed).map(|g| (g.start, g.end)).collect();
            doc.extras.outlines.remove(index);
            for (a, b) in spans {
                doc.hide_span(sheet, columns, a, b, false, steps)?;
            }
            Ok(())
        })
    }

    /// Contrae (−) o expande (+) el grupo de nivel `level` que empieza en `start`.
    pub fn set_group_collapsed(&mut self, sheet: u32, columns: bool, level: u8, start: i32, collapsed: bool) -> Result<(), String> {
        let id = self.sheet_id(sheet).ok_or("Hoja inválida")?;
        let index = self.extras.outlines.iter().position(|o| o.sheet_id == id && o.columns == columns).ok_or("No hay grupos")?;
        let group = groups(&self.extras.outlines[index]).into_iter().find(|g| g.level == level && g.start == start).ok_or("No se encontró el grupo")?;
        self.mixed(|doc, steps| {
            let outline = &mut doc.extras.outlines[index];
            outline.collapsed.retain(|c| *c != (level, start));
            if collapsed {
                outline.collapsed.push((level, start));
            }
            doc.apply_collapsed(sheet, index, group.start, group.end, steps)
        })
    }

    /// Botones 1, 2, 3… de la esquina: muestra hasta ese nivel (con 1, solo lo que no está en grupos).
    pub fn show_outline_level(&mut self, sheet: u32, columns: bool, level: u8) -> Result<(), String> {
        let id = self.sheet_id(sheet).ok_or("Hoja inválida")?;
        let index = self.extras.outlines.iter().position(|o| o.sheet_id == id && o.columns == columns).ok_or("No hay grupos")?;
        self.mixed(|doc, steps| {
            let list = groups(&doc.extras.outlines[index]);
            let outline = &mut doc.extras.outlines[index];
            outline.collapsed = list.iter().filter(|g| g.level >= level).map(|g| (g.level, g.start)).collect();
            let (Some(&first), Some(&last)) = (outline.levels.keys().next(), outline.levels.keys().next_back()) else { return Ok(()) };
            doc.apply_collapsed(sheet, index, first, last, steps)
        })
    }

    /// Los grupos siguen a sus filas al insertar o borrar (las filas nuevas dentro de un grupo entran en él).
    pub(super) fn shift_outline(&mut self, sheet: u32, columns: bool, at: i32, delta: i32) -> bool {
        let Some(id) = self.sheet_id(sheet) else { return false };
        let Some(outline) = self.extras.outlines.iter_mut().find(|o| o.sheet_id == id && o.columns == columns) else { return false };
        let before = outline.clone();
        let shift = |i: i32| -> Option<i32> {
            if delta > 0 {
                Some(if i >= at { i + delta } else { i })
            } else if i >= at && i < at - delta {
                None
            } else if i >= at {
                Some(i + delta)
            } else {
                Some(i)
            }
        };
        let mut levels: BTreeMap<i32, u8> = outline.levels.iter().filter_map(|(&i, &l)| shift(i).map(|j| (j, l))).collect();
        if delta > 0 {
            let inside = before.levels.get(&(at - 1)).copied().unwrap_or(0).min(before.levels.get(&at).copied().unwrap_or(0));
            if inside > 0 {
                for i in at..at + delta {
                    levels.insert(i, inside);
                }
            }
        }
        outline.levels = levels;
        outline.collapsed = before.collapsed.iter().filter_map(|&(l, s)| shift(s).map(|t| (l, t))).collect();
        *outline != before
    }

    pub(super) fn load_outline(&mut self, path: &str) {
        let Ok(found) = crate::xlsx_outline::read_outline(path) else { return };
        let names = self.sheet_names();
        for raw in found {
            let Some(index) = names.iter().position(|n| *n == raw.sheet) else { continue };
            let Some(sheet_id) = self.sheet_id(index as u32) else { continue };
            for (columns, levels, summaries) in [(false, &raw.rows, &raw.collapsed_rows), (true, &raw.cols, &raw.collapsed_cols)] {
                if levels.is_empty() {
                    continue;
                }
                let mut outline = Outline { sheet_id, columns, levels: levels.iter().map(|&(i, l)| (i, l.min(MAX_LEVEL))).filter(|&(_, l)| l > 0).collect(), collapsed: Vec::new() };
                // Excel marca contraído el renglón de resumen (el de abajo del grupo): el grupo
                // que termina justo antes y tiene un nivel más que él.
                let list = groups(&outline);
                for &summary in summaries {
                    let level = outline.levels.get(&summary).copied().unwrap_or(0) + 1;
                    if let Some(g) = list.iter().find(|g| g.level == level && g.end == summary - 1) {
                        outline.collapsed.push((g.level, g.start));
                    }
                }
                self.extras.outlines.push(outline);
            }
        }
    }

    pub(super) fn outline_for_xlsx(&self) -> Vec<RawOutline> {
        let names = self.sheet_names();
        let mut out: Vec<RawOutline> = Vec::new();
        for o in &self.extras.outlines {
            let Some(index) = self.sheet_index(o.sheet_id) else { continue };
            if o.levels.is_empty() {
                continue;
            }
            let name = names[index as usize].clone();
            let position = match out.iter().position(|r| r.sheet == name) {
                Some(p) => p,
                None => {
                    out.push(RawOutline { sheet: name, ..Default::default() });
                    out.len() - 1
                }
            };
            let raw = &mut out[position];
            let levels: Vec<(i32, u8)> = o.levels.iter().map(|(&i, &l)| (i, l)).collect();
            let summaries: Vec<i32> = groups(o).into_iter().filter(|g| g.collapsed).map(|g| g.end + 1).collect();
            if o.columns {
                raw.cols = levels;
                raw.collapsed_cols = summaries;
            } else {
                raw.rows = levels;
                raw.collapsed_rows = summaries;
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hidden(doc: &SheetDocument) -> Vec<i32> {
        let mut rows = doc.view(0).unwrap().hidden_rows;
        rows.sort_unstable();
        rows
    }

    #[test]
    fn grupos_anidados_contraer_y_guardar() {
        let mut doc = SheetDocument::new_empty().unwrap();
        for r in 1..=12 {
            doc.set_cell(0, r, 1, &format!("fila {r}")).unwrap();
        }
        doc.group(0, false, 2, 10).unwrap();
        doc.group(0, false, 4, 6).unwrap();
        doc.group(0, true, 2, 3).unwrap();
        let view = doc.outline_view(0);
        assert_eq!(view.row_levels, 2);
        assert_eq!(
            view.rows,
            vec![GroupView { level: 1, start: 2, end: 10, collapsed: false }, GroupView { level: 2, start: 4, end: 6, collapsed: false }]
        );

        // Contraer el de adentro esconde 4–6; contraer el de afuera, 2–10.
        doc.set_group_collapsed(0, false, 2, 4, true).unwrap();
        assert_eq!(hidden(&doc), vec![4, 5, 6]);
        doc.set_group_collapsed(0, false, 1, 2, true).unwrap();
        assert_eq!(hidden(&doc), (2..=10).collect::<Vec<_>>());
        // Expandir el de afuera deja contraído el de adentro.
        doc.set_group_collapsed(0, false, 1, 2, false).unwrap();
        assert_eq!(hidden(&doc), vec![4, 5, 6]);
        // Botón «2»: se ve el nivel 1 completo, el 2 contraído.
        doc.show_outline_level(0, false, 3).unwrap();
        assert!(hidden(&doc).is_empty());
        doc.show_outline_level(0, false, 1).unwrap();
        assert_eq!(hidden(&doc), (2..=10).collect::<Vec<_>>());
        doc.undo().unwrap();
        assert!(hidden(&doc).is_empty());
        doc.set_group_collapsed(0, false, 2, 4, true).unwrap();

        // Insertar una fila dentro del grupo lo agranda.
        doc.insert_rows(0, 3, 1).unwrap();
        assert_eq!(doc.outline_view(0).rows[0], GroupView { level: 1, start: 2, end: 11, collapsed: false });

        let dir = std::env::temp_dir().join("wepo-outline-test");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("grupos.xlsx");
        let path = path.to_str().unwrap();
        doc.save(path, 0).unwrap();
        let sheet = String::from_utf8_lossy(&crate::xlsx_pivots::entries_of(path).into_iter().find(|(n, _)| n == "xl/worksheets/sheet1.xml").unwrap().1).into_owned();
        assert!(sheet.contains(r#"outlineLevelRow="2""#), "{sheet}");
        assert!(sheet.contains(r#"outlineLevel="2""#) && sheet.contains(r#"collapsed="1""#));

        let reopened = SheetDocument::open(path).unwrap();
        let view = reopened.outline_view(0);
        assert_eq!(view.rows, doc.outline_view(0).rows);
        assert_eq!(view.cols, vec![GroupView { level: 1, start: 2, end: 3, collapsed: false }]);
        assert_eq!(hidden(&reopened), vec![5, 6, 7]);

        doc.ungroup(0, false, 2, 11).unwrap();
        assert_eq!(doc.outline_view(0).row_levels, 1);
        assert!(hidden(&doc).is_empty(), "al desagrupar se abre lo contraído");
        doc.clear_outline(0, false).unwrap();
        assert!(doc.outline_view(0).rows.is_empty());
    }
}
