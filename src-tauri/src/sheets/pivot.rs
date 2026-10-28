//! Tablas dinámicas, como en Excel: se elige un rango con encabezados y se
//! acomodan sus columnas (campos) en filas, columnas, valores y filtros. WEPO
//! calcula el resumen y lo escribe en la hoja como celdas normales; al guardar,
//! además, escribe la tabla dinámica de verdad en el .xlsx (ver xlsx_pivots.rs)
//! para que Excel y LibreOffice la reconozcan y la puedan actualizar.

use std::collections::HashMap;

use ironcalc::base::cell::CellValue;
use serde::{Deserialize, Serialize};

use super::{Rect, SheetDocument};
use crate::xlsx_pivots::{compare_values, CacheValue, RawPivotOut};

/// Un campo en «Valores» y cómo se resume.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PivotValueField {
    pub field: u32,
    /// sum, count, average, max o min.
    pub func: String,
}

/// Un campo en «Filtros» y los elementos que no se toman en cuenta.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PivotFilter {
    pub field: u32,
    #[serde(default)]
    pub hidden: Vec<String>,
}

/// Dónde va cada campo (por su número de columna en los datos, desde 0).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct PivotLayout {
    #[serde(default)]
    pub rows: Vec<u32>,
    #[serde(default)]
    pub cols: Vec<u32>,
    #[serde(default)]
    pub values: Vec<PivotValueField>,
    #[serde(default)]
    pub filters: Vec<PivotFilter>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Pivot {
    /// Hoja donde está la tabla dinámica.
    pub sheet_id: u32,
    pub name: String,
    /// De dónde salen los datos (con la fila de encabezados).
    pub source_sheet_id: u32,
    pub source: Rect,
    /// Esquina de arriba a la izquierda (desde 1); los filtros van ahí y la tabla debajo.
    pub anchor: (i32, i32),
    pub layout: PivotLayout,
    /// Todo lo que ocupa en la hoja (filtros y tabla) y solo la tabla.
    pub output: Rect,
    pub table: Rect,
}

#[derive(Serialize, Debug)]
pub struct PivotView {
    pub name: String,
    /// Lo que ocupa en la hoja, desde 1.
    pub row1: i32,
    pub col1: i32,
    pub row2: i32,
    pub col2: i32,
    /// "Ventas!A1:D40"
    pub source: String,
    /// Nombre de cada campo y si es de números (para ponerlo en «Valores» al marcarlo).
    pub fields: Vec<String>,
    pub numeric: Vec<bool>,
    pub layout: PivotLayout,
    /// Elementos de cada campo que está en «Filtros»: (campo, elementos).
    pub items: Vec<(u32, Vec<String>)>,
}

/// Lo que se escribe en una celda de la tabla dinámica.
#[derive(Clone, Debug, PartialEq)]
enum Out {
    Empty,
    Text(String),
    Number(f64),
}

/// La tabla dinámica ya calculada, lista para escribirla desde la esquina.
#[derive(Debug, Default)]
struct Grid {
    cells: Vec<Vec<Out>>,
    /// Fila (desde 0) donde empieza la tabla (después de los filtros).
    table_row: usize,
    /// Filas en negritas con fondo (encabezados y totales) y filas de filtros.
    header_rows: Vec<usize>,
    total_rows: Vec<usize>,
    filter_rows: Vec<usize>,
    /// Columnas de valores: (columna desde 0, campo de los datos, función).
    value_cols: Vec<(usize, u32, String)>,
}

#[derive(Default, Clone, Copy)]
struct Acc {
    sum: f64,
    count: usize,
    numbers: usize,
    min: f64,
    max: f64,
}

impl Acc {
    fn add(&mut self, v: &CacheValue) {
        match v {
            CacheValue::Blank => {}
            CacheValue::Text(_) => self.count += 1,
            CacheValue::Number(n, _) => {
                if self.numbers == 0 {
                    self.min = *n;
                    self.max = *n;
                } else {
                    self.min = self.min.min(*n);
                    self.max = self.max.max(*n);
                }
                self.sum += n;
                self.numbers += 1;
                self.count += 1;
            }
        }
    }

    fn result(&self, func: &str) -> Out {
        match func {
            "count" if self.count > 0 => Out::Number(self.count as f64),
            "average" if self.numbers > 0 => Out::Number(self.sum / self.numbers as f64),
            "max" if self.numbers > 0 => Out::Number(self.max),
            "min" if self.numbers > 0 => Out::Number(self.min),
            "sum" if self.count > 0 => Out::Number(self.sum),
            _ => Out::Empty,
        }
    }
}

pub fn value_label(func: &str, field: &str) -> String {
    let word = match func {
        "count" => "Cuenta de",
        "average" => "Promedio de",
        "max" => "Máx. de",
        "min" => "Mín. de",
        _ => "Suma de",
    };
    format!("{word} {field}")
}

fn func_xml(func: &str) -> &'static str {
    match func {
        "count" => "count",
        "average" => "average",
        "max" => "max",
        "min" => "min",
        _ => "sum",
    }
}

/// Texto con que se muestra un elemento (los vacíos, como en Excel).
fn item_label(v: &CacheValue) -> String {
    match v {
        CacheValue::Blank => "(en blanco)".into(),
        other => other.label().to_string(),
    }
}

/// Une varios elementos en una sola clave.
fn join_key(values: &[&CacheValue]) -> String {
    values.iter().map(|v| item_label(v)).collect::<Vec<_>>().join("\u{1}")
}

/// Calcula la tabla dinámica. `fields` son los nombres de los campos; `records`, los datos.
fn build(fields: &[String], records: &[Vec<CacheValue>], layout: &PivotLayout) -> Grid {
    let mut grid = Grid::default();
    let field_name = |f: u32| fields.get(f as usize).cloned().unwrap_or_default();
    let blank = CacheValue::Blank;
    let value_of = |r: &Vec<CacheValue>, f: u32| -> CacheValue { r.get(f as usize).cloned().unwrap_or(CacheValue::Blank) };

    // Filtros: arriba, campo y lo que se eligió.
    for filter in &layout.filters {
        let mut all: Vec<CacheValue> = Vec::new();
        for r in records {
            let v = value_of(r, filter.field);
            if !all.iter().any(|x| item_label(x) == item_label(&v)) {
                all.push(v);
            }
        }
        let visible: Vec<&CacheValue> = all.iter().filter(|v| !filter.hidden.contains(&item_label(v))).collect();
        let chosen = if filter.hidden.is_empty() {
            "(Todos)".to_string()
        } else if visible.len() == 1 {
            item_label(visible[0])
        } else {
            "(Varios elementos)".to_string()
        };
        grid.filter_rows.push(grid.cells.len());
        grid.cells.push(vec![Out::Text(field_name(filter.field)), Out::Text(chosen)]);
    }
    if !layout.filters.is_empty() {
        grid.cells.push(Vec::new());
    }
    grid.table_row = grid.cells.len();

    if layout.rows.is_empty() && layout.cols.is_empty() && layout.values.is_empty() {
        grid.cells.push(vec![Out::Text("Tabla dinámica: elige los campos en el panel".into())]);
        return grid;
    }

    let kept: Vec<&Vec<CacheValue>> = records
        .iter()
        .filter(|r| layout.filters.iter().all(|f| !f.hidden.contains(&item_label(&value_of(r, f.field)))))
        .collect();

    // Claves distintas de filas y de columnas, en orden.
    let keys = |list: &[u32]| -> Vec<Vec<CacheValue>> {
        let mut seen: HashMap<String, ()> = HashMap::new();
        let mut out: Vec<Vec<CacheValue>> = Vec::new();
        for r in &kept {
            let key: Vec<CacheValue> = list.iter().map(|f| value_of(r, *f)).collect();
            let k = join_key(&key.iter().collect::<Vec<_>>());
            if seen.insert(k, ()).is_none() {
                out.push(key);
            }
        }
        out.sort_by(|a, b| {
            for (x, y) in a.iter().zip(b) {
                let o = compare_values(x, y);
                if o != std::cmp::Ordering::Equal {
                    return o;
                }
            }
            std::cmp::Ordering::Equal
        });
        out
    };
    let row_keys = if layout.rows.is_empty() { vec![Vec::new()] } else { keys(&layout.rows) };
    let col_keys = if layout.cols.is_empty() { vec![Vec::new()] } else { keys(&layout.cols) };
    let row_index: HashMap<String, usize> = row_keys.iter().enumerate().map(|(i, k)| (join_key(&k.iter().collect::<Vec<_>>()), i)).collect();
    let col_index: HashMap<String, usize> = col_keys.iter().enumerate().map(|(i, k)| (join_key(&k.iter().collect::<Vec<_>>()), i)).collect();
    let nv = layout.values.len();

    // Acumulados: por celda, por fila (total de la derecha), por columna (total de abajo) y el general.
    let mut cells: HashMap<(usize, usize), Vec<Acc>> = HashMap::new();
    let mut row_tot: Vec<Vec<Acc>> = vec![vec![Acc::default(); nv]; row_keys.len()];
    let mut col_tot: Vec<Vec<Acc>> = vec![vec![Acc::default(); nv]; col_keys.len()];
    let mut grand = vec![Acc::default(); nv];
    for r in &kept {
        let rk: Vec<CacheValue> = layout.rows.iter().map(|f| value_of(r, *f)).collect();
        let ck: Vec<CacheValue> = layout.cols.iter().map(|f| value_of(r, *f)).collect();
        let ri = row_index[&join_key(&rk.iter().collect::<Vec<_>>())];
        let ci = col_index[&join_key(&ck.iter().collect::<Vec<_>>())];
        let accs = cells.entry((ri, ci)).or_insert_with(|| vec![Acc::default(); nv]);
        for (k, v) in layout.values.iter().enumerate() {
            let value = value_of(r, v.field);
            accs[k].add(&value);
            row_tot[ri][k].add(&value);
            col_tot[ci][k].add(&value);
            grand[k].add(&value);
        }
    }

    let has_rows = !layout.rows.is_empty();
    let has_cols = !layout.cols.is_empty();
    let labels = if has_rows { layout.rows.len() } else { 0 };
    let col_label = |ck: &Vec<CacheValue>| ck.iter().map(item_label).collect::<Vec<_>>().join(" - ");

    // Encabezados.
    let mut header: Vec<Out> = layout.rows.iter().map(|f| Out::Text(field_name(*f))).collect();
    let mut col = labels;
    for ck in &col_keys {
        if nv == 0 {
            if has_cols {
                header.push(Out::Text(col_label(ck)));
                col += 1;
            }
            continue;
        }
        for v in &layout.values {
            let vlabel = value_label(&v.func, &field_name(v.field));
            let text = match (has_cols, nv) {
                (false, _) => vlabel,
                (true, 1) => col_label(ck),
                (true, _) => format!("{} - {vlabel}", col_label(ck)),
            };
            header.push(Out::Text(text));
            grid.value_cols.push((col, v.field, v.func.clone()));
            col += 1;
        }
    }
    if has_cols && nv > 0 {
        for v in &layout.values {
            let text = if nv == 1 { "Total general".to_string() } else { format!("Total {}", value_label(&v.func, &field_name(v.field))) };
            header.push(Out::Text(text));
            grid.value_cols.push((col, v.field, v.func.clone()));
            col += 1;
        }
    }
    grid.header_rows.push(grid.cells.len());
    grid.cells.push(header);

    // Una fila por cada combinación de filas (las etiquetas repetidas se dejan en blanco, como en Excel).
    let mut previous: Vec<CacheValue> = Vec::new();
    for (ri, rk) in row_keys.iter().enumerate() {
        let mut line: Vec<Out> = Vec::new();
        let mut same = true;
        for (i, v) in rk.iter().enumerate() {
            same = same && previous.get(i).is_some_and(|p| item_label(p) == item_label(v));
            line.push(if same { Out::Empty } else { Out::Text(item_label(v)) });
        }
        previous = rk.clone();
        for ci in 0..col_keys.len() {
            if nv == 0 && has_cols {
                line.push(Out::Empty);
            }
            for k in 0..nv {
                line.push(cells.get(&(ri, ci)).map_or(Out::Empty, |a| a[k].result(&layout.values[k].func)));
            }
        }
        if has_cols {
            for k in 0..nv {
                line.push(row_tot[ri][k].result(&layout.values[k].func));
            }
        }
        grid.cells.push(line);
    }
    // Fila de «Total general».
    if has_rows && (nv > 0 || has_cols) {
        let mut line: Vec<Out> = vec![Out::Text("Total general".into())];
        line.resize(labels, Out::Empty);
        for ci in 0..col_keys.len() {
            if nv == 0 && has_cols {
                line.push(Out::Empty);
            }
            for k in 0..nv {
                line.push(col_tot[ci][k].result(&layout.values[k].func));
            }
        }
        if has_cols {
            for k in 0..nv {
                line.push(grand[k].result(&layout.values[k].func));
            }
        }
        grid.total_rows.push(grid.cells.len());
        grid.cells.push(line);
    }
    let _ = &blank;
    grid
}

fn width_of(grid: &Grid) -> i32 {
    grid.cells.iter().map(Vec::len).max().unwrap_or(1).max(1) as i32
}

impl SheetDocument {
    /// Encabezados y registros del rango de datos de una tabla dinámica.
    fn pivot_source(&self, source_sheet_id: u32, source: Rect) -> Result<(Vec<String>, Vec<Vec<CacheValue>>), String> {
        let sheet = self.sheet_index(source_sheet_id).ok_or("La hoja de los datos ya no existe")?;
        let model = self.model.get_model();
        let r = source.normalized();
        let mut fields: Vec<String> = Vec::new();
        for col in r.col1..=r.col2 {
            let mut name = model.get_formatted_cell_value(sheet, r.row1, col).unwrap_or_default().trim().to_string();
            if name.is_empty() {
                name = format!("Columna{}", col - r.col1 + 1);
            }
            let base = name.clone();
            let mut k = 2;
            while fields.iter().any(|f| f.eq_ignore_ascii_case(&name)) {
                name = format!("{base}{k}");
                k += 1;
            }
            fields.push(name);
        }
        let mut records = Vec::new();
        for row in r.row1 + 1..=r.row2 {
            let mut record = Vec::with_capacity(fields.len());
            for col in r.col1..=r.col2 {
                let value = match model.get_cell_value_by_index(sheet, row, col) {
                    Ok(CellValue::Number(n)) => CacheValue::Number(n, model.get_formatted_cell_value(sheet, row, col).unwrap_or_default()),
                    Ok(CellValue::String(s)) if s.trim().is_empty() => CacheValue::Blank,
                    Ok(CellValue::String(s)) => CacheValue::Text(s),
                    Ok(CellValue::Boolean(_)) => CacheValue::Text(model.get_formatted_cell_value(sheet, row, col).unwrap_or_default()),
                    _ => CacheValue::Blank,
                };
                record.push(value);
            }
            if record.iter().any(|v| *v != CacheValue::Blank) {
                records.push(record);
            }
        }
        Ok((fields, records))
    }

    pub fn pivot_views(&self, sheet: u32) -> Vec<PivotView> {
        let Some(id) = self.sheet_id(sheet) else { return Vec::new() };
        let names = self.sheet_names();
        self.extras
            .pivots
            .iter()
            .filter(|p| p.sheet_id == id)
            .filter_map(|p| {
                let (fields, records) = self.pivot_source(p.source_sheet_id, p.source).ok()?;
                let numeric = (0..fields.len())
                    .map(|f| {
                        let mut seen = records.iter().filter_map(|r| r.get(f)).filter(|v| **v != CacheValue::Blank).take(50).peekable();
                        seen.peek().is_some() && seen.all(|v| matches!(v, CacheValue::Number(..)))
                    })
                    .collect();
                let items = p
                    .layout
                    .filters
                    .iter()
                    .map(|filter| {
                        let mut list: Vec<CacheValue> = Vec::new();
                        for r in &records {
                            let v = r.get(filter.field as usize).cloned().unwrap_or(CacheValue::Blank);
                            if !list.iter().any(|x| item_label(x) == item_label(&v)) {
                                list.push(v);
                            }
                            if list.len() >= 500 {
                                break;
                            }
                        }
                        list.sort_by(compare_values);
                        (filter.field, list.iter().map(item_label).collect())
                    })
                    .collect();
                let source_name = self.sheet_index(p.source_sheet_id).and_then(|i| names.get(i as usize)).cloned().unwrap_or_default();
                let o = p.output.normalized();
                Some(PivotView {
                    name: p.name.clone(),
                    row1: o.row1,
                    col1: o.col1,
                    row2: o.row2,
                    col2: o.col2,
                    source: format!("{source_name}!{}", p.source.to_a1()),
                    fields,
                    numeric,
                    layout: p.layout.clone(),
                    items,
                })
            })
            .collect()
    }

    fn free_pivot_name(&self) -> String {
        (1..)
            .map(|n| format!("TablaDinámica{n}"))
            .find(|name| !self.extras.pivots.iter().any(|p| p.name.eq_ignore_ascii_case(name)))
            .unwrap_or_default()
    }

    /// Vuelve a calcular la tabla dinámica `index` y la escribe (dentro de una acción de `mixed`).
    /// `fresh`: recién creada, todavía no hay nada suyo escrito que borrar.
    fn write_pivot(&mut self, index: usize, steps: &mut usize, fresh: bool) -> Result<(), String> {
        let pivot = self.extras.pivots[index].clone();
        let sheet = self.sheet_index(pivot.sheet_id).ok_or("La hoja de la tabla dinámica ya no existe")?;
        let (fields, records) = self.pivot_source(pivot.source_sheet_id, pivot.source)?;
        let grid = build(&fields, &records, &pivot.layout);
        let (row0, col0) = pivot.anchor;
        let rows = grid.cells.len() as i32;
        let output = Rect { row1: row0, col1: col0, row2: row0 + rows - 1, col2: col0 + width_of(&grid) - 1 };

        // Se borra lo que había escrito antes (valores y formato).
        if !fresh {
            self.model.range_clear_all(&pivot.output.normalized().area(sheet))?;
            *steps += 1;
        }
        // No se escribe encima de otros datos de la hoja.
        {
            let model = self.model.get_model();
            for row in output.row1..=output.row2 {
                for col in output.col1..=output.col2 {
                    if !model.get_formatted_cell_value(sheet, row, col).unwrap_or_default().is_empty() {
                        return Err(format!(
                            "La tabla dinámica necesita las celdas {} y en ellas ya hay datos: deja espacio o ponla en una hoja nueva",
                            output.to_a1()
                        ));
                    }
                }
            }
        }
        // Formato de número de cada campo de los datos (para que la suma de pesos salga en pesos).
        let source_sheet = self.sheet_index(pivot.source_sheet_id).unwrap_or(sheet);
        let src = pivot.source.normalized();
        let formats: Vec<String> = (src.col1..=src.col2)
            .map(|col| {
                let row = (src.row1 + 1).min(src.row2);
                self.model.get_model().get_style_for_cell(source_sheet, row, col).map(|s| s.num_fmt).unwrap_or_default()
            })
            .collect();

        for (r, line) in grid.cells.iter().enumerate() {
            for (c, out) in line.iter().enumerate() {
                let input = match out {
                    Out::Empty => continue,
                    Out::Number(n) => format!("{n}"),
                    // Un texto que parece número o fórmula se escribe como texto.
                    Out::Text(t) if t.parse::<f64>().is_ok() || t.starts_with(['=', '+', '-', '@']) => format!("'{t}"),
                    Out::Text(t) => t.clone(),
                };
                self.model.set_user_input(sheet, row0 + r as i32, col0 + c as i32, &input)?;
                *steps += 1;
            }
        }
        let width = width_of(&grid);
        let line_rect = |r: usize| Rect { row1: row0 + r as i32, col1: col0, row2: row0 + r as i32, col2: col0 + width - 1 };
        for &r in grid.header_rows.iter().chain(&grid.total_rows) {
            let area = line_rect(r).area(sheet);
            self.model.update_range_style(&area, "font.b", "true")?;
            self.model.update_range_style(&area, "fill.fg_color", "#DDEBF7")?;
            *steps += 2;
        }
        for &r in &grid.filter_rows {
            let area = Rect { row1: row0 + r as i32, col1: col0, row2: row0 + r as i32, col2: col0 }.area(sheet);
            self.model.update_range_style(&area, "font.b", "true")?;
            *steps += 1;
        }
        let data_rows = (grid.table_row + 1) as i32..rows;
        if !data_rows.is_empty() {
            for (c, field, func) in &grid.value_cols {
                let format = if func == "count" { "general" } else { formats.get(*field as usize).map_or("general", String::as_str) };
                if format.is_empty() || format.eq_ignore_ascii_case("general") {
                    continue;
                }
                let col = col0 + *c as i32;
                let area = Rect { row1: row0 + data_rows.start, col1: col, row2: row0 + rows - 1, col2: col }.area(sheet);
                self.model.update_range_style(&area, "num_fmt", format)?;
                *steps += 1;
            }
        }
        // Las columnas se ensanchan para que se lea todo (nunca se hacen más angostas).
        let model = self.model.get_model();
        let mut widths = Vec::new();
        for c in 0..width {
            let chars = grid
                .cells
                .iter()
                .enumerate()
                .filter_map(|(r, line)| {
                    let text = match line.get(c as usize)? {
                        Out::Text(t) => t.clone(),
                        Out::Number(_) => model.get_formatted_cell_value(sheet, row0 + r as i32, col0 + c).ok()?,
                        Out::Empty => return None,
                    };
                    let bold = grid.header_rows.contains(&r) || grid.total_rows.contains(&r);
                    Some(text.chars().count() as f64 * if bold { 8.2 } else { 7.4 })
                })
                .fold(0.0, f64::max);
            let wanted = (chars + 16.0).min(320.0);
            let col = col0 + c;
            // El texto de «Tabla dinámica vacía…» no ensancha la columna.
            if grid.cells.len() > grid.table_row + 1 && wanted > model.get_column_width(sheet, col).unwrap_or(super::DEFAULT_COLUMN_WIDTH) {
                widths.push((col, wanted.ceil()));
            }
        }
        for (col, w) in widths {
            self.model.set_columns_width(sheet, col, col, w)?;
            *steps += 1;
        }
        let p = &mut self.extras.pivots[index];
        p.output = output;
        p.table = Rect { row1: row0 + grid.table_row as i32, ..output };
        Ok(())
    }

    /// Crea una tabla dinámica con los datos de `source` (con encabezados). Con `at` la pone en
    /// esa celda de la hoja `target`; sin `at`, en una hoja nueva. Devuelve la hoja donde quedó.
    pub fn create_pivot(&mut self, sheet: u32, source: Rect, target: u32, at: Option<(i32, i32)>) -> Result<u32, String> {
        let source = source.normalized();
        if source.row2 <= source.row1 {
            return Err("Elige los datos con su fila de encabezados y al menos una fila más".into());
        }
        let source_sheet_id = self.sheet_id(sheet).ok_or("Hoja inválida")?;
        if at.is_some() {
            self.check_sheet(target)?;
        }
        let name = self.free_pivot_name();
        let names = self.sheet_names();
        let mut result_sheet = target;
        self.mixed(|doc, steps| {
            let (target_id, anchor) = match at {
                Some(cell) => (doc.sheet_id(target).ok_or("Hoja inválida")?, cell),
                None => {
                    // Hoja nueva al final, como «Hoja2», con la tabla en A3 (deja lugar a los filtros).
                    let new_name = (1..).map(|n| format!("Hoja{n}")).find(|c| !names.contains(c)).unwrap_or_default();
                    let index = names.len() as u32;
                    doc.model.new_sheet()?;
                    doc.model.rename_sheet(index, &new_name)?;
                    *steps += 2;
                    result_sheet = index;
                    (doc.sheet_id(index).ok_or("Hoja inválida")?, (3, 1))
                }
            };
            if target_id == source_sheet_id && source.contains(anchor.0, anchor.1) {
                return Err("La tabla dinámica no puede ir encima de sus propios datos".into());
            }
            let empty = Rect { row1: anchor.0, col1: anchor.1, row2: anchor.0, col2: anchor.1 };
            doc.extras.pivots.push(Pivot {
                sheet_id: target_id,
                name: name.clone(),
                source_sheet_id,
                source,
                anchor,
                layout: PivotLayout::default(),
                output: empty,
                table: empty,
            });
            let index = doc.extras.pivots.len() - 1;
            doc.write_pivot(index, steps, true)
        })?;
        Ok(result_sheet)
    }

    fn pivot_index(&self, sheet: u32, name: &str) -> Result<usize, String> {
        let id = self.sheet_id(sheet).ok_or("Hoja inválida")?;
        self.extras.pivots.iter().position(|p| p.sheet_id == id && p.name == name).ok_or_else(|| "No se encontró la tabla dinámica".into())
    }

    /// Cambia qué campo va en filas, columnas, valores y filtros, y la vuelve a calcular.
    pub fn update_pivot(&mut self, sheet: u32, name: &str, layout: PivotLayout) -> Result<(), String> {
        self.check_sheet(sheet)?;
        let index = self.pivot_index(sheet, name)?;
        let (fields, _) = {
            let p = &self.extras.pivots[index];
            self.pivot_source(p.source_sheet_id, p.source)?
        };
        let n = fields.len() as u32;
        let mut layout = layout;
        layout.rows.retain(|f| *f < n);
        layout.cols.retain(|f| *f < n);
        layout.values.retain(|v| v.field < n);
        layout.filters.retain(|f| f.field < n);
        for v in &mut layout.values {
            v.func = func_xml(&v.func).to_string();
        }
        self.mixed(|doc, steps| {
            doc.extras.pivots[index].layout = layout;
            doc.write_pivot(index, steps, false)
        })
    }

    /// «Actualizar»: vuelve a leer los datos. Con `name` vacío, todas las del libro.
    pub fn refresh_pivot(&mut self, sheet: u32, name: &str) -> Result<(), String> {
        self.check_sheet(sheet)?;
        let targets: Vec<usize> = if name.is_empty() { (0..self.extras.pivots.len()).collect() } else { vec![self.pivot_index(sheet, name)?] };
        self.mixed(|doc, steps| {
            for index in targets {
                doc.write_pivot(index, steps, false)?;
            }
            Ok(())
        })
    }

    /// Quita la tabla dinámica y lo que tenía escrito (como «Borrar todo» en Excel).
    pub fn delete_pivot(&mut self, sheet: u32, name: &str) -> Result<(), String> {
        self.check_sheet(sheet)?;
        let index = self.pivot_index(sheet, name)?;
        self.mixed(|doc, steps| {
            let p = doc.extras.pivots.remove(index);
            if let Some(s) = doc.sheet_index(p.sheet_id) {
                doc.model.range_clear_all(&p.output.normalized().area(s))?;
                *steps += 1;
            }
            Ok(())
        })
    }

    pub(super) fn load_pivots(&mut self, path: &str) {
        let Ok((found, unsupported)) = crate::xlsx_pivots::read_pivots(path) else {
            self.has_drawings = true;
            return;
        };
        if unsupported {
            self.has_drawings = true;
        }
        let names = self.sheet_names();
        let id_of = |name: &str| names.iter().position(|n| n == name).and_then(|i| self.sheet_id(i as u32));
        let mut pivots = Vec::new();
        let mut missing = false;
        for raw in found {
            let Some(sheet_id) = id_of(&raw.sheet) else { continue };
            let Some(table) = Rect::from_a1(&raw.location) else { continue };
            // Los datos: hoja y rango, o el nombre de una tabla del libro.
            let source = match (&raw.source_ref, &raw.source_name) {
                (Some(r), _) => Rect::from_a1(r).and_then(|rect| id_of(raw.source_sheet.as_deref().unwrap_or(&raw.sheet)).map(|id| (id, rect))),
                (None, Some(name)) => self
                    .model
                    .get_model()
                    .workbook
                    .tables
                    .values()
                    .find(|t| t.name.eq_ignore_ascii_case(name))
                    .and_then(|t| Some((id_of(&t.sheet_name)?, Rect::from_a1(&t.reference)?))),
                _ => None,
            };
            let Some((source_sheet_id, source)) = source else {
                missing = true;
                continue;
            };
            let table = table.normalized();
            let top = if raw.filters.is_empty() { table.row1 } else { (table.row1 - raw.filters.len() as i32 - 1).max(1) };
            let layout = PivotLayout {
                rows: raw.rows.clone(),
                cols: raw.cols.clone(),
                values: raw.values.iter().map(|(field, func)| PivotValueField { field: *field, func: func.clone() }).collect(),
                filters: raw.filters.iter().map(|(field, hidden)| PivotFilter { field: *field, hidden: hidden.clone() }).collect(),
            };
            pivots.push(Pivot {
                sheet_id,
                name: raw.name.clone(),
                source_sheet_id,
                source,
                anchor: (top, table.col1),
                layout,
                output: Rect { row1: top, col2: table.col2.max(table.col1 + 1), ..table },
                table,
            });
        }
        self.extras.pivots = pivots;
        if missing {
            self.has_drawings = true;
        }
    }

    pub(super) fn pivots_for_xlsx(&self) -> Vec<RawPivotOut> {
        let names = self.sheet_names();
        self.extras
            .pivots
            .iter()
            .filter_map(|p| {
                let sheet = names.get(self.sheet_index(p.sheet_id)? as usize)?.clone();
                let source_sheet = names.get(self.sheet_index(p.source_sheet_id)? as usize)?.clone();
                let (fields, records) = self.pivot_source(p.source_sheet_id, p.source).ok()?;
                Some(RawPivotOut {
                    sheet,
                    name: p.name.clone(),
                    location: p.table.normalized().to_a1(),
                    source_sheet,
                    source_ref: p.source.normalized().to_a1(),
                    values: p.layout.values.iter().map(|v| (v.field, func_xml(&v.func).to_string(), value_label(&v.func, fields.get(v.field as usize).map_or("", String::as_str)))).collect(),
                    fields,
                    records,
                    rows: p.layout.rows.clone(),
                    cols: p.layout.cols.clone(),
                    filters: p.layout.filters.iter().map(|f| (f.field, f.hidden.clone())).collect(),
                })
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> SheetDocument {
        let mut doc = SheetDocument::new_empty().unwrap();
        let data = [
            ["Región", "Producto", "Mes", "Ventas"],
            ["Norte", "Café", "Ene", "100"],
            ["Sur", "Café", "Ene", "50"],
            ["Norte", "Té", "Feb", "30"],
            ["Norte", "Café", "Feb", "20"],
            ["Sur", "Té", "Feb", "70"],
        ];
        for (r, line) in data.iter().enumerate() {
            for (c, v) in line.iter().enumerate() {
                doc.set_cell(0, r as i32 + 1, c as i32 + 1, v).unwrap();
            }
        }
        doc
    }

    fn text(doc: &SheetDocument, sheet: u32, a1: &str) -> String {
        let (row, col) = super::super::parse_cell(a1).unwrap();
        doc.model.get_model().get_formatted_cell_value(sheet, row, col).unwrap()
    }

    #[test]
    fn suma_por_region_y_producto() {
        let mut doc = sample();
        let sheet = doc.create_pivot(0, Rect::from_a1("A1:D6").unwrap(), 0, None).unwrap();
        assert_eq!(sheet, 1);
        assert_eq!(text(&doc, 1, "A3"), "Tabla dinámica: elige los campos en el panel");
        let name = doc.pivot_views(1)[0].name.clone();
        assert_eq!(name, "TablaDinámica1");
        let layout = PivotLayout { rows: vec![0], cols: vec![1], values: vec![PivotValueField { field: 3, func: "sum".into() }], filters: vec![] };
        doc.update_pivot(1, &name, layout).unwrap();
        // Región | Café | Té | Total general
        assert_eq!([text(&doc, 1, "A3"), text(&doc, 1, "B3"), text(&doc, 1, "C3"), text(&doc, 1, "D3")], ["Región", "Café", "Té", "Total general"]);
        assert_eq!([text(&doc, 1, "A4"), text(&doc, 1, "B4"), text(&doc, 1, "C4"), text(&doc, 1, "D4")], ["Norte", "120", "30", "150"]);
        assert_eq!([text(&doc, 1, "A5"), text(&doc, 1, "B5"), text(&doc, 1, "C5"), text(&doc, 1, "D5")], ["Sur", "50", "70", "120"]);
        assert_eq!([text(&doc, 1, "A6"), text(&doc, 1, "D6")], ["Total general", "270"]);

        // Un filtro arriba: solo febrero. La tabla baja dos filas.
        let layout = PivotLayout {
            rows: vec![0],
            cols: vec![],
            values: vec![PivotValueField { field: 3, func: "sum".into() }, PivotValueField { field: 3, func: "count".into() }],
            filters: vec![PivotFilter { field: 2, hidden: vec!["Ene".into()] }],
        };
        doc.update_pivot(1, &name, layout).unwrap();
        assert_eq!([text(&doc, 1, "A3"), text(&doc, 1, "B3")], ["Mes", "Feb"]);
        assert_eq!([text(&doc, 1, "A5"), text(&doc, 1, "B5"), text(&doc, 1, "C5")], ["Región", "Suma de Ventas", "Cuenta de Ventas"]);
        assert_eq!([text(&doc, 1, "A6"), text(&doc, 1, "B6"), text(&doc, 1, "C6")], ["Norte", "50", "2"]);
        assert_eq!([text(&doc, 1, "A8"), text(&doc, 1, "B8"), text(&doc, 1, "C8")], ["Total general", "120", "3"]);
        // Lo que había antes más abajo ya no está.
        assert_eq!(text(&doc, 1, "D6"), "");

        // Cambia un dato y se actualiza.
        doc.set_cell(0, 4, 4, "130").unwrap();
        doc.refresh_pivot(1, "").unwrap();
        assert_eq!(text(&doc, 1, "B6"), "150");

        // Deshacer regresa el valor anterior de la tabla dinámica.
        doc.undo().unwrap();
        assert_eq!(text(&doc, 1, "B6"), "50");
    }

    #[test]
    fn se_guarda_como_tabla_dinamica_de_excel_y_se_vuelve_a_leer() {
        let mut doc = sample();
        doc.create_pivot(0, Rect::from_a1("A1:D6").unwrap(), 0, Some((2, 7))).unwrap();
        let layout = PivotLayout {
            rows: vec![0, 1],
            cols: vec![],
            values: vec![PivotValueField { field: 3, func: "average".into() }],
            filters: vec![PivotFilter { field: 2, hidden: vec!["Ene".into()] }],
        };
        doc.update_pivot(0, "TablaDinámica1", layout.clone()).unwrap();
        let dir = std::env::temp_dir().join("wepo-pivot-test");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("dinamica.xlsx");
        let path = path.to_str().unwrap();
        doc.save(path, 0).unwrap();

        let entries = crate::xlsx_pivots::entries_of(path);
        let names: Vec<&str> = entries.iter().map(|(n, _)| n.as_str()).collect();
        assert!(names.contains(&"xl/pivotTables/pivotTable1.xml"));
        assert!(names.contains(&"xl/pivotCache/pivotCacheDefinition1.xml"));
        assert!(names.contains(&"xl/pivotCache/pivotCacheRecords1.xml"));
        let workbook = String::from_utf8_lossy(&entries.iter().find(|(n, _)| n == "xl/workbook.xml").unwrap().1).into_owned();
        assert!(workbook.contains("<pivotCaches"));

        let reopened = SheetDocument::open(path).unwrap();
        let view = reopened.view(0).unwrap();
        assert!(!view.has_drawings, "la tabla dinámica ya no obliga a guardar una copia");
        let pivots = reopened.pivot_views(0);
        assert_eq!(pivots.len(), 1);
        assert_eq!(pivots[0].layout.rows, vec![0, 1]);
        assert_eq!(pivots[0].layout.values, layout.values);
        assert_eq!(pivots[0].layout.filters, layout.filters);
        assert_eq!((pivots[0].row1, pivots[0].col1), (2, 7));
        assert_eq!(pivots[0].source, "Hoja1!A1:D6");
    }

    #[test]
    fn no_escribe_encima_de_otros_datos() {
        let mut doc = sample();
        doc.set_cell(0, 2, 8, "algo").unwrap();
        let err = doc.create_pivot(0, Rect::from_a1("A1:D6").unwrap(), 0, Some((2, 8))).unwrap_err();
        assert!(err.contains("ya hay datos"), "{err}");
        assert!(doc.extras.pivots.is_empty());
    }
}

