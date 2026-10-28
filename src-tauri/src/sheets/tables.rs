//! Tablas (lo que Excel llama "Dar formato como tabla") y configuración de
//! página (encabezado, pie, filas que se repiten y área de impresión).
//!
//! IronCalc lee las tablas de un .xlsx pero no las escribe, y no maneja la
//! configuración de página: WEPO las guarda por su cuenta y las escribe al
//! guardar (ver xlsx_extras.rs).

use ironcalc::base::cell::CellValue;
use serde::Serialize;

use super::{column_letters, Rect, SheetDocument, Step};
use crate::xlsx_extras::{RawPage, RawTable, SheetExtras};

/// Estilos de tabla de WEPO y su equivalente en Excel.
pub const TABLE_STYLES: &[(&str, &str)] = &[
    ("oscuro", "TableStyleMedium1"),
    ("azul", "TableStyleMedium2"),
    ("naranja", "TableStyleMedium3"),
    ("gris", "TableStyleMedium4"),
    ("dorado", "TableStyleMedium5"),
    ("celeste", "TableStyleMedium6"),
    ("verde", "TableStyleMedium7"),
];

/// "TableStyleMedium9" → "azul" (los estilos de Excel se repiten de 7 en 7 colores).
fn preset_for(excel: Option<&str>) -> String {
    let number = excel
        .and_then(|name| name.trim_start_matches(|c: char| !c.is_ascii_digit()).parse::<usize>().ok())
        .unwrap_or(2);
    let index = (number.max(1) - 1) % TABLE_STYLES.len();
    TABLE_STYLES[index].0.to_string()
}

fn excel_style(preset: &str) -> &'static str {
    TABLE_STYLES.iter().find(|(p, _)| *p == preset).map_or("TableStyleMedium2", |(_, e)| e)
}

#[derive(Clone, Debug, PartialEq)]
pub struct Table {
    pub sheet_id: u32,
    /// Toda la tabla: encabezados, datos y (si tiene) la fila de totales.
    pub rect: Rect,
    pub name: String,
    pub style: String,
    pub banded: bool,
    pub totals: bool,
}

#[derive(Serialize, Debug)]
pub struct TableView {
    pub row1: i32,
    pub col1: i32,
    pub row2: i32,
    pub col2: i32,
    pub name: String,
    pub style: String,
    pub banded: bool,
    pub totals: bool,
}

/// Configuración de página de una hoja.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct PageSetup {
    pub sheet_id: u32,
    pub header: String,
    pub footer: String,
    /// Filas que se repiten arriba en cada página (desde 1).
    pub repeat_rows: Option<(i32, i32)>,
    pub print_area: Option<Rect>,
    /// Saltos de página puestos a mano: la fila o columna (desde 0) con que empieza la página nueva,
    /// como el `id` de <brk> en Excel.
    pub row_breaks: Vec<i32>,
    pub col_breaks: Vec<i32>,
}

#[derive(Serialize, Debug, Default)]
pub struct PageView {
    pub header: String,
    pub footer: String,
    pub repeat_rows: Option<(i32, i32)>,
    /// (fila1, columna1, fila2, columna2), desde 1.
    pub print_area: Option<(i32, i32, i32, i32)>,
    /// Saltos de página a mano: fila o columna (desde 0) con que empieza cada página nueva.
    pub row_breaks: Vec<i32>,
    pub col_breaks: Vec<i32>,
}

/// Encabezado o pie de Excel ("&L…&CTexto &D&R…") → texto de WEPO ("Texto [Fecha]").
fn from_excel_codes(text: &str) -> String {
    let mut out = String::new();
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '&' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('D') => out.push_str("[Fecha]"),
            Some('F') => out.push_str("[Archivo]"),
            Some('A') => out.push_str("[Hoja]"),
            Some('P') => out.push_str("[Página]"),
            Some('N') => out.push_str("[Páginas]"),
            Some('&') => out.push('&'),
            // &L, &C, &R separan izquierda, centro y derecha: aquí van seguidos.
            Some('L' | 'C' | 'R') => {
                if !out.is_empty() && !out.ends_with(' ') {
                    out.push_str("   ");
                }
            }
            // Fuente, tamaño y otros códigos de formato: se ignoran.
            Some('"') => {
                for c in chars.by_ref() {
                    if c == '"' {
                        break;
                    }
                }
            }
            Some(d) if d.is_ascii_digit() => {
                while chars.peek().is_some_and(char::is_ascii_digit) {
                    chars.next();
                }
            }
            _ => {}
        }
    }
    out.trim().to_string()
}

/// Texto de WEPO → código de Excel, centrado.
fn to_excel_codes(text: &str) -> String {
    let escaped = text
        .replace('&', "&&")
        .replace("[Fecha]", "&D")
        .replace("[Archivo]", "&F")
        .replace("[Hoja]", "&A")
        .replace("[Página]", "&P")
        .replace("[Páginas]", "&N");
    format!("&C{escaped}")
}

fn quote_sheet(name: &str) -> String {
    format!("'{}'", name.replace('\'', "''"))
}

impl SheetDocument {
    /// Cambios en el motor y en lo que WEPO guarda aparte, como una sola acción.
    fn mixed(&mut self, action: impl FnOnce(&mut Self, &mut usize) -> Result<(), String>) -> Result<(), String> {
        let before = self.extras.clone();
        let mut steps = 0;
        if let Err(e) = action(self, &mut steps) {
            for _ in 0..steps {
                let _ = self.model.undo();
            }
            self.extras = before;
            return Err(e);
        }
        if steps > 0 {
            self.history.push(Step::Both(steps, before));
            self.future.clear();
        } else if self.extras.tables != before.tables || self.extras.pages != before.pages {
            self.record_extras(before);
        }
        Ok(())
    }

    // ───────────── tablas ─────────────

    pub fn table_views(&self, sheet: u32) -> Vec<TableView> {
        let Some(id) = self.sheet_id(sheet) else { return Vec::new() };
        self.extras
            .tables
            .iter()
            .filter(|t| t.sheet_id == id)
            .map(|t| {
                let r = t.rect.normalized();
                TableView {
                    row1: r.row1,
                    col1: r.col1,
                    row2: r.row2,
                    col2: r.col2,
                    name: t.name.clone(),
                    style: t.style.clone(),
                    banded: t.banded,
                    totals: t.totals,
                }
            })
            .collect()
    }

    fn free_table_name(&self) -> String {
        let model = self.model.get_model();
        (1..)
            .map(|n| format!("Tabla{n}"))
            .find(|name| {
                !self.extras.tables.iter().any(|t| t.name.eq_ignore_ascii_case(name))
                    && !model.workbook.tables.keys().any(|k| k.eq_ignore_ascii_case(name))
            })
            .unwrap_or_default()
    }

    /// Escribe (o borra) la fila de totales debajo de los datos de una tabla.
    fn write_totals(&mut self, sheet: u32, rect: Rect, row: i32, steps: &mut usize) -> Result<(), String> {
        let model = self.model.get_model();
        let mut inputs = Vec::new();
        for col in rect.col1..=rect.col2 {
            // Una columna de números lleva su suma; la primera, la palabra "Total".
            let numbers = (rect.row1 + 1..row)
                .filter(|r| matches!(model.get_cell_value_by_index(sheet, *r, col), Ok(CellValue::Number(_))))
                .count();
            let input = if col == rect.col1 {
                "Total".to_string()
            } else if numbers > 0 {
                let letters = column_letters(col);
                format!("=SUBTOTAL(109,{letters}{}:{letters}{})", rect.row1 + 1, row - 1)
            } else {
                continue;
            };
            inputs.push((col, input));
        }
        for (col, input) in inputs {
            self.set_english_formula(sheet, row, col, &input)?;
            *steps += 1;
        }
        Ok(())
    }

    /// "Dar formato como tabla": `rect` incluye la fila de encabezados.
    pub fn create_table(&mut self, sheet: u32, rect: Rect, style: &str, banded: bool, totals: bool) -> Result<String, String> {
        let id = self.sheet_id(sheet).ok_or("Hoja inválida")?;
        let rect = rect.normalized();
        if rect.row2 <= rect.row1 {
            return Err("Selecciona los encabezados y al menos una fila de datos".into());
        }
        let grown = Rect { row2: rect.row2 + i32::from(totals), ..rect };
        if self.extras.tables.iter().any(|t| t.sheet_id == id && t.rect.intersects(&grown)) {
            return Err("Ya hay una tabla en esas celdas".into());
        }
        let name = self.free_table_name();
        let style = if TABLE_STYLES.iter().any(|(p, _)| *p == style) { style } else { "azul" }.to_string();
        let model = self.model.get_model();
        // Excel necesita un nombre en cada encabezado.
        let mut headers = Vec::new();
        for col in rect.col1..=rect.col2 {
            if model.get_formatted_cell_value(sheet, rect.row1, col)?.trim().is_empty() {
                headers.push((col, format!("Columna{}", col - rect.col1 + 1)));
            }
        }
        let table_name = name.clone();
        self.mixed(|doc, steps| {
            for (col, text) in &headers {
                doc.model.set_user_input(sheet, rect.row1, *col, text)?;
                *steps += 1;
            }
            if totals {
                doc.write_totals(sheet, rect, rect.row2 + 1, steps)?;
            }
            doc.extras.tables.push(Table { sheet_id: id, rect: grown, name: table_name, style, banded, totals });
            Ok(())
        })?;
        Ok(name)
    }

    /// Cambia el estilo, las bandas o la fila de totales de una tabla.
    pub fn update_table(&mut self, sheet: u32, name: &str, style: &str, banded: bool, totals: bool) -> Result<(), String> {
        let id = self.sheet_id(sheet).ok_or("Hoja inválida")?;
        let index = self
            .extras
            .tables
            .iter()
            .position(|t| t.sheet_id == id && t.name == name)
            .ok_or("No se encontró la tabla")?;
        let table = self.extras.tables[index].clone();
        self.mixed(|doc, steps| {
            let mut rect = table.rect;
            if totals && !table.totals {
                let row = rect.row2 + 1;
                doc.write_totals(sheet, rect, row, steps)?;
                rect.row2 = row;
            } else if !totals && table.totals {
                let row = rect.row2;
                doc.model.range_clear_contents(&Rect { row1: row, row2: row, ..rect }.area(sheet))?;
                *steps += 1;
                rect.row2 = row - 1;
            }
            let t = &mut doc.extras.tables[index];
            t.rect = rect;
            t.style = style.to_string();
            t.banded = banded;
            t.totals = totals;
            Ok(())
        })
    }

    /// Convierte la tabla en un rango normal (los datos se quedan).
    pub fn delete_table(&mut self, sheet: u32, name: &str) -> Result<(), String> {
        let id = self.sheet_id(sheet).ok_or("Hoja inválida")?;
        self.mixed(|doc, _| {
            doc.extras.tables.retain(|t| !(t.sheet_id == id && t.name == name));
            Ok(())
        })
    }

    pub(super) fn load_tables(&mut self, path: &str) {
        // IronCalc lee las tablas pero no siempre su estilo: ese lo leemos aparte.
        let styles = crate::xlsx_extras::read_table_styles(path).unwrap_or_default();
        let model = self.model.get_model();
        let names = self.sheet_names();
        let mut tables: Vec<Table> = model
            .workbook
            .tables
            .values()
            .filter_map(|t| {
                let index = names.iter().position(|n| *n == t.sheet_name)?;
                Some(Table {
                    sheet_id: self.sheet_id(index as u32)?,
                    rect: Rect::from_a1(&t.reference)?,
                    name: t.name.clone(),
                    style: preset_for(styles.get(&t.name).map(String::as_str).or(t.style_info.name.as_deref())),
                    banded: t.style_info.show_row_stripes,
                    totals: t.totals_row_count > 0,
                })
            })
            .collect();
        tables.sort_by(|a, b| a.name.cmp(&b.name));
        self.extras.tables = tables;
    }

    pub(super) fn tables_for_xlsx(&self, sheets: &mut Vec<(String, SheetExtras)>) {
        let names = self.sheet_names();
        let model = self.model.get_model();
        for (n, table) in self.extras.tables.iter().enumerate() {
            let Some(index) = self.sheet_index(table.sheet_id) else { continue };
            let r = table.rect.normalized();
            let mut columns: Vec<String> = Vec::new();
            for col in r.col1..=r.col2 {
                let mut text = model.get_formatted_cell_value(index, r.row1, col).unwrap_or_default().trim().to_string();
                if text.is_empty() {
                    text = format!("Columna{}", col - r.col1 + 1);
                }
                // Los nombres de columna no se pueden repetir.
                let base = text.clone();
                let mut k = 2;
                while columns.iter().any(|c| c.eq_ignore_ascii_case(&text)) {
                    text = format!("{base}{k}");
                    k += 1;
                }
                columns.push(text);
            }
            let data_end = if table.totals { r.row2 - 1 } else { r.row2 };
            let raw = RawTable {
                id: n as u32 + 1,
                name: table.name.clone(),
                reference: r.to_a1(),
                filter_ref: Rect { row2: data_end, ..r }.to_a1(),
                columns,
                style: excel_style(&table.style).to_string(),
                banded: table.banded,
                totals: table.totals,
            };
            let name = names[index as usize].clone();
            match sheets.iter_mut().find(|(s, _)| *s == name) {
                Some((_, extras)) => extras.tables.push(raw),
                None => sheets.push((name, SheetExtras { tables: vec![raw], ..Default::default() })),
            }
        }
    }

    // ───────────── configuración de página ─────────────

    pub fn page_view(&self, sheet: u32) -> PageView {
        let Some(id) = self.sheet_id(sheet) else { return PageView::default() };
        let Some(page) = self.extras.pages.iter().find(|p| p.sheet_id == id) else { return PageView::default() };
        PageView {
            header: page.header.clone(),
            footer: page.footer.clone(),
            repeat_rows: page.repeat_rows,
            print_area: page.print_area.map(|r| {
                let r = r.normalized();
                (r.row1, r.col1, r.row2, r.col2)
            }),
            row_breaks: page.row_breaks.clone(),
            col_breaks: page.col_breaks.clone(),
        }
    }

    /// Cambia los saltos de página puestos a mano de la hoja (fila o columna desde 0 con que empieza la página).
    pub fn set_page_breaks(&mut self, sheet: u32, rows: &[i32], cols: &[i32]) -> Result<(), String> {
        let id = self.sheet_id(sheet).ok_or("Hoja inválida")?;
        let clean = |list: &[i32], max: i32| {
            let mut v: Vec<i32> = list.iter().copied().filter(|&i| i > 0 && i < max).collect();
            v.sort_unstable();
            v.dedup();
            v
        };
        let (rows, cols) = (clean(rows, 1_048_576), clean(cols, 16_384));
        self.mixed(|doc, _| {
            let mut page = doc.extras.pages.iter().find(|p| p.sheet_id == id).cloned().unwrap_or(PageSetup { sheet_id: id, ..Default::default() });
            page.row_breaks = rows.clone();
            page.col_breaks = cols.clone();
            doc.extras.pages.retain(|p| p.sheet_id != id);
            if page != (PageSetup { sheet_id: id, ..Default::default() }) {
                doc.extras.pages.push(page);
            }
            Ok(())
        })
    }

    /// `repeat_rows` como "1:2" (o "1"); `print_area` como "A1:F20". Vacíos los quitan.
    pub fn set_page_setup(&mut self, sheet: u32, header: &str, footer: &str, repeat_rows: &str, print_area: &str) -> Result<(), String> {
        let id = self.sheet_id(sheet).ok_or("Hoja inválida")?;
        let repeat = repeat_rows.trim().replace('$', "");
        let repeat_rows = if repeat.is_empty() {
            None
        } else {
            let mut parts = repeat.split(':').map(|p| p.trim().parse::<i32>().ok());
            match (parts.next().flatten(), parts.next()) {
                (Some(a), None) if a > 0 => Some((a, a)),
                (Some(a), Some(Some(b))) if a > 0 && b > 0 => Some((a.min(b), a.max(b))),
                _ => return Err("Escribe las filas que se repiten como «1» o «1:2»".into()),
            }
        };
        let area = print_area.trim();
        let print_area = if area.is_empty() {
            None
        } else {
            Some(Rect::from_a1(area).ok_or("Escribe el área de impresión como «A1:F20»")?)
        };
        // Los saltos de página no cambian aquí (tienen su propia orden).
        let (row_breaks, col_breaks) = self
            .extras
            .pages
            .iter()
            .find(|p| p.sheet_id == id)
            .map(|p| (p.row_breaks.clone(), p.col_breaks.clone()))
            .unwrap_or_default();
        let page = PageSetup { sheet_id: id, header: header.trim().into(), footer: footer.trim().into(), repeat_rows, print_area, row_breaks, col_breaks };
        self.mixed(|doc, _| {
            doc.extras.pages.retain(|p| p.sheet_id != id);
            if page != (PageSetup { sheet_id: id, ..Default::default() }) {
                doc.extras.pages.push(page);
            }
            Ok(())
        })
    }

    pub(super) fn load_pages(&mut self, path: &str) {
        let Ok(found) = crate::xlsx_extras::read_pages(path) else { return };
        let names = self.sheet_names();
        for (name, raw) in found {
            let Some(index) = names.iter().position(|n| *n == name) else { continue };
            let Some(id) = self.sheet_id(index as u32) else { continue };
            // 'Hoja 1'!$1:$2 → (1, 2);  'Hoja 1'!$A$1:$F$20 → A1:F20
            let after = |f: &str| f.rsplit('!').next().unwrap_or(f).replace('$', "");
            // Puede traer filas y columnas: 'Hoja'!$A:$B,'Hoja'!$1:$2. Nos quedamos con las filas.
            let repeat_rows = raw.titles.as_deref().and_then(|f| {
                f.split(',').find_map(|part| {
                    let refs = after(part);
                    let mut parts = refs.split(':').map(|p| p.trim().parse::<i32>().ok());
                    let a = parts.next()??;
                    let b = parts.next().flatten().unwrap_or(a);
                    Some((a.min(b), a.max(b)))
                })
            });
            let print_area = raw.area.as_deref().and_then(|f| Rect::from_a1(&after(f)));
            let page = PageSetup {
                sheet_id: id,
                header: from_excel_codes(&raw.header),
                footer: from_excel_codes(&raw.footer),
                repeat_rows,
                print_area,
                row_breaks: raw.row_breaks.clone(),
                col_breaks: raw.col_breaks.clone(),
            };
            if page != (PageSetup { sheet_id: id, ..Default::default() }) {
                self.extras.pages.push(page);
            }
        }
    }

    pub(super) fn pages_for_xlsx(&self, sheets: &mut Vec<(String, SheetExtras)>) {
        let names = self.sheet_names();
        for page in &self.extras.pages {
            let Some(index) = self.sheet_index(page.sheet_id) else { continue };
            let name = names[index as usize].clone();
            let sheet = quote_sheet(&name);
            let raw = RawPage {
                header: if page.header.is_empty() { String::new() } else { to_excel_codes(&page.header) },
                footer: if page.footer.is_empty() { String::new() } else { to_excel_codes(&page.footer) },
                titles: page.repeat_rows.map(|(a, b)| format!("{sheet}!${a}:${b}")),
                area: page.print_area.map(|r| {
                    let r = r.normalized();
                    format!(
                        "{sheet}!${}${}:${}${}",
                        column_letters(r.col1),
                        r.row1,
                        column_letters(r.col2),
                        r.row2
                    )
                }),
                sheet_index: index,
                row_breaks: page.row_breaks.clone(),
                col_breaks: page.col_breaks.clone(),
            };
            match sheets.iter_mut().find(|(s, _)| *s == name) {
                Some((_, extras)) => extras.page = Some(raw),
                None => sheets.push((name, SheetExtras { page: Some(raw), ..Default::default() })),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(row1: i32, col1: i32, row2: i32, col2: i32) -> Rect {
        Rect { row1, col1, row2, col2 }
    }

    #[test]
    fn codigos_de_encabezado() {
        assert_eq!(from_excel_codes("&L&\"Arial,Bold\"&12Ventas&CPágina &P de &N&R&D"), "Ventas   Página [Página] de [Páginas]   [Fecha]");
        assert_eq!(to_excel_codes("Reporte & más [Fecha]"), "&CReporte && más &D");
        assert_eq!(preset_for(Some("TableStyleMedium9")), "azul");
        assert_eq!(preset_for(Some("TableStyleLight14")), "verde");
    }

    #[test]
    fn tablas_y_pagina_se_guardan() {
        let mut doc = SheetDocument::new_empty().unwrap();
        // Con las fórmulas en español, la fila de totales también debe funcionar.
        doc.set_language("es").unwrap();
        let data = [["Producto", "Precio"], ["Pan", "10"], ["Leche", "25"]];
        for (r, row) in data.iter().enumerate() {
            for (c, v) in row.iter().enumerate() {
                doc.set_cell(0, r as i32 + 1, c as i32 + 1, v).unwrap();
            }
        }
        let name = doc.create_table(0, rect(1, 1, 3, 2), "verde", true, true).unwrap();
        assert_eq!(name, "Tabla1");
        assert_eq!(doc.cell_input(0, 4, 1).unwrap(), "Total");
        assert_eq!(doc.cell_input(0, 4, 2).unwrap(), "=SUBTOTALES(109,B2:B3)", "se muestra en español");
        assert_eq!(doc.view(0).unwrap().rows[3][1].0, "35");
        assert!(doc.create_table(0, rect(2, 2, 5, 3), "azul", false, false).is_err(), "no se enciman");

        doc.update_table(0, "Tabla1", "naranja", false, false).unwrap();
        assert_eq!(doc.cell_input(0, 4, 2).unwrap(), "", "quitar totales borra la fila");
        doc.undo().unwrap();
        assert_eq!(doc.table_views(0)[0].style, "verde");
        assert_eq!(doc.cell_input(0, 4, 2).unwrap(), "=SUBTOTALES(109,B2:B3)");

        doc.set_page_setup(0, "Reporte [Fecha]", "Hecho con WEPO", "1", "A1:B4").unwrap();
        let path = std::env::temp_dir().join(format!("wepo-tablas-{}.xlsx", std::process::id()));
        let path = path.to_str().unwrap();
        doc.save(path, 0).unwrap();

        let reopened = SheetDocument::open(path).unwrap();
        let view = reopened.view(0).unwrap();
        assert!(!view.has_drawings, "las tablas ya no impiden sobrescribir el archivo");
        let tables = reopened.table_views(0);
        assert_eq!((tables[0].row2, tables[0].style.as_str(), tables[0].totals, tables[0].banded), (4, "verde", true, true));
        let page = reopened.page_view(0);
        assert_eq!(page.header, "Reporte [Fecha]");
        assert_eq!(page.footer, "Hecho con WEPO");
        assert_eq!(page.repeat_rows, Some((1, 1)));
        assert_eq!(page.print_area, Some((1, 1, 4, 2)));
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn saltos_de_pagina_a_mano() {
        let mut doc = SheetDocument::new_empty().unwrap();
        for r in 1..=60 {
            doc.set_cell(0, r, 1, &r.to_string()).unwrap();
        }
        doc.set_page_setup(0, "Encabezado", "", "", "").unwrap();
        doc.set_page_breaks(0, &[40, 20, 20, 0], &[3]).unwrap();
        let page = doc.page_view(0);
        assert_eq!((page.row_breaks.clone(), page.col_breaks.clone()), (vec![20, 40], vec![3]), "ordenados y sin repetir (ni el 0)");
        // Cambiar el encabezado no quita los saltos; deshacer sí regresa al anterior.
        doc.set_page_setup(0, "Otro", "", "", "").unwrap();
        assert_eq!(doc.page_view(0).row_breaks, vec![20, 40]);
        doc.undo().unwrap();
        doc.undo().unwrap();
        assert!(doc.page_view(0).row_breaks.is_empty());
        doc.redo().unwrap();

        let path = std::env::temp_dir().join(format!("wepo-saltos-{}.xlsx", std::process::id()));
        let path = path.to_str().unwrap();
        doc.save(path, 0).unwrap();
        let xml = crate::xlsx_extras::read_pages(path).unwrap();
        assert_eq!(xml[0].1.row_breaks, vec![20, 40]);
        let reopened = SheetDocument::open(path).unwrap();
        let page = reopened.page_view(0);
        assert_eq!((page.row_breaks, page.col_breaks, page.header.as_str()), (vec![20, 40], vec![3], "Encabezado"));
        std::fs::remove_file(path).unwrap();

        // Insertar 2 filas arriba de la 10 recorre los dos saltos; borrar la 1 los sube uno.
        doc.insert_rows(0, 10, 2).unwrap();
        assert_eq!(doc.page_view(0).row_breaks, vec![22, 42]);
        doc.delete_rows(0, 1, 1).unwrap();
        assert_eq!(doc.page_view(0).row_breaks, vec![21, 41]);
        doc.undo().unwrap();
        assert_eq!(doc.page_view(0).row_breaks, vec![22, 42]);
        doc.insert_columns(0, 2, 1).unwrap();
        assert_eq!(doc.page_view(0).col_breaks, vec![4]);
    }
}
