//! Gráficas e imágenes flotando sobre la hoja.
//!
//! IronCalc no las maneja: WEPO las guarda por su cuenta (en `Extras`), calcula
//! los datos de cada gráfica a partir de las celdas, y las lee y escribe en el
//! .xlsx (ver xlsx_extras.rs). Las posiciones se guardan en píxeles desde la
//! esquina de la celda A1; al guardar se convierten a celdas, como hace Excel.

use std::sync::Arc;

use ironcalc::base::cell::CellValue;
use serde::{Deserialize, Serialize};

use super::{Rect, SheetDocument};
use crate::xlsx_extras::{CellOffset, RawAnchor, RawChart, RawContent, RawDrawing, RawSeries, SheetExtras, EMU_PER_PIXEL};

pub const PALETTE: [&str; 8] = ["#4472C4", "#ED7D31", "#A5A5A5", "#FFC000", "#5B9BD5", "#70AD47", "#264478", "#9E480E"];

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChartType {
    Column,
    Bar,
    Line,
    Area,
    Pie,
    Doughnut,
    Scatter,
    /// Columnas y, la última serie, como línea.
    Combo,
}

/// Una serie: de dónde salen su nombre, sus categorías (eje X) y sus valores.
/// Las referencias van en notación de Excel con la hoja: `Hoja1!$B$2:$B$7`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Series {
    /// Referencia a la celda con el nombre, o el nombre escrito.
    pub name: Option<String>,
    pub name_is_ref: bool,
    pub categories: Option<String>,
    pub values: String,
    pub color: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Chart {
    pub kind: ChartType,
    pub title: String,
    pub legend: bool,
    pub series: Vec<Series>,
    /// Columnas, barras, áreas o líneas apiladas.
    #[serde(default)]
    pub stacked: bool,
    /// Mostrar el valor sobre cada barra o punto.
    #[serde(default)]
    pub labels: bool,
    /// Títulos de los ejes: el de las categorías y el de los valores.
    #[serde(default)]
    pub x_title: String,
    #[serde(default)]
    pub y_title: String,
}

#[derive(Clone, Debug)]
pub struct Image {
    pub name: String,
    pub mime: String,
    pub data: Arc<Vec<u8>>,
}

#[derive(Clone, Debug)]
pub enum Content {
    Chart(Chart),
    Image(Image),
}

#[derive(Clone, Debug)]
pub struct Drawing {
    pub id: u32,
    pub sheet_id: u32,
    /// Posición y tamaño en píxeles, desde la esquina superior izquierda de A1.
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub content: Content,
}

/// Datos ya calculados de una serie, para dibujarla.
#[derive(Serialize, Debug)]
pub struct SeriesView {
    pub name: String,
    pub color: String,
    pub values: Vec<Option<f64>>,
    pub categories: Vec<String>,
    /// Para dispersión: los valores numéricos del eje X.
    pub x: Vec<Option<f64>>,
    pub refs: Series,
}

#[derive(Serialize, Debug)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum DrawingView {
    Chart {
        id: u32,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        kind: ChartType,
        title: String,
        legend: bool,
        series: Vec<SeriesView>,
        stacked: bool,
        labels: bool,
        x_title: String,
        y_title: String,
    },
    Image {
        id: u32,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        name: String,
    },
}

/// Cambios que la interfaz puede pedir sobre un dibujo.
#[derive(Deserialize, Debug, Default)]
pub struct DrawingPatch {
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub w: Option<f64>,
    pub h: Option<f64>,
    pub kind: Option<ChartType>,
    pub title: Option<String>,
    pub legend: Option<bool>,
    pub stacked: Option<bool>,
    pub labels: Option<bool>,
    pub x_title: Option<String>,
    pub y_title: Option<String>,
    /// Nuevo rango de datos (A1, en la hoja de la gráfica): se rehacen las series.
    pub data: Option<String>,
}

// ───────────── utilidades ─────────────

/// "Hoja1!$B$2:$B$7" → (nombre de la hoja, rango). Sin hoja, None en el nombre.
pub fn split_ref(reference: &str) -> (Option<String>, &str) {
    match reference.rsplit_once('!') {
        Some((sheet, range)) => (Some(sheet.trim_start_matches('=').trim_matches('\'').replace("''", "'")), range),
        None => (None, reference.trim_start_matches('=')),
    }
}

/// Nombre de hoja listo para una referencia: con comillas si tiene espacios u otros signos.
pub fn quote_sheet(sheet: &str) -> String {
    if sheet.chars().all(|c| c.is_alphanumeric() || c == '_') {
        sheet.to_string()
    } else {
        format!("'{}'", sheet.replace('\'', "''"))
    }
}

/// Referencia absoluta con nombre de hoja, con comillas si hace falta: 'Mi hoja'!$A$1:$A$9
pub fn absolute_ref(sheet: &str, rect: &Rect) -> String {
    let r = rect.normalized();
    let cell = |row: i32, col: i32| format!("${}${}", super::column_letters(col), row);
    let range = if r.row1 == r.row2 && r.col1 == r.col2 {
        cell(r.row1, r.col1)
    } else {
        format!("{}:{}", cell(r.row1, r.col1), cell(r.row2, r.col2))
    };
    format!("{}!{range}", quote_sheet(sheet))
}

/// Tamaño en píxeles de una imagen PNG, JPEG o GIF, leyendo su encabezado.
pub fn image_size(data: &[u8]) -> Option<(u32, u32)> {
    if data.starts_with(b"\x89PNG") && data.len() >= 24 {
        let w = u32::from_be_bytes(data[16..20].try_into().ok()?);
        let h = u32::from_be_bytes(data[20..24].try_into().ok()?);
        return Some((w, h));
    }
    if data.starts_with(b"GIF") && data.len() > 10 {
        return Some((u16::from_le_bytes([data[6], data[7]]) as u32, u16::from_le_bytes([data[8], data[9]]) as u32));
    }
    if data.starts_with(&[0xFF, 0xD8]) {
        // JPEG: buscar el bloque SOF que trae el tamaño.
        let mut i = 2;
        while i + 9 < data.len() {
            if data[i] != 0xFF {
                i += 1;
                continue;
            }
            let marker = data[i + 1];
            let len = u16::from_be_bytes([data[i + 2], data[i + 3]]) as usize;
            if (0xC0..=0xCF).contains(&marker) && ![0xC4, 0xC8, 0xCC].contains(&marker) {
                let h = u16::from_be_bytes([data[i + 5], data[i + 6]]) as u32;
                let w = u16::from_be_bytes([data[i + 7], data[i + 8]]) as u32;
                return Some((w, h));
            }
            i += 2 + len;
        }
    }
    None
}

pub fn mime_for(path: &str) -> Option<&'static str> {
    match super::extension(path).as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        _ => None,
    }
}

/// Codifica en base64 (para mostrar la imagen en la interfaz como data URL).
pub fn base64(data: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (b[0] as u32) << 16 | (b[1] as u32) << 8 | b[2] as u32;
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(TABLE[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

impl SheetDocument {
    fn next_drawing_id(&self) -> u32 {
        self.extras.drawings.iter().map(|d| d.id).max().unwrap_or(0) + 1
    }

    /// Valores de un rango, en orden (por filas o por columnas, según su forma).
    fn range_values(&self, reference: &str, default_sheet: u32) -> Vec<CellValue> {
        let (sheet_name, range) = split_ref(reference);
        let sheet = match sheet_name {
            Some(name) => match self.sheet_names().iter().position(|n| *n == name) {
                Some(i) => i as u32,
                None => return Vec::new(),
            },
            None => default_sheet,
        };
        let Some(rect) = Rect::from_a1(range) else { return Vec::new() };
        let model = self.model.get_model();
        let mut values = Vec::new();
        // Como mucho 5000 puntos por serie.
        for row in rect.row1..=rect.row2.min(rect.row1 + 5000) {
            for col in rect.col1..=rect.col2 {
                values.push(model.get_cell_value_by_index(sheet, row, col).unwrap_or(CellValue::None));
            }
        }
        values
    }

    fn range_texts(&self, reference: &str, default_sheet: u32) -> Vec<String> {
        self.range_values(reference, default_sheet)
            .into_iter()
            .map(|v| match v {
                CellValue::None => String::new(),
                CellValue::String(s) => s,
                CellValue::Number(n) => {
                    if n.fract() == 0.0 && n.abs() < 1e15 { format!("{}", n as i64) } else { format!("{n}") }
                }
                CellValue::Boolean(b) => if b { "VERDADERO".into() } else { "FALSO".into() },
            })
            .collect()
    }

    fn number(v: &CellValue) -> Option<f64> {
        match v {
            CellValue::Number(n) => Some(*n),
            CellValue::Boolean(b) => Some(if *b { 1.0 } else { 0.0 }),
            _ => None,
        }
    }

    pub fn drawing_views(&self, sheet: u32) -> Vec<DrawingView> {
        let Some(id) = self.sheet_id(sheet) else { return Vec::new() };
        self.extras
            .drawings
            .iter()
            .filter(|d| d.sheet_id == id)
            .map(|d| match &d.content {
                Content::Image(image) => DrawingView::Image { id: d.id, x: d.x, y: d.y, w: d.w, h: d.h, name: image.name.clone() },
                Content::Chart(chart) => DrawingView::Chart {
                    id: d.id,
                    x: d.x,
                    y: d.y,
                    w: d.w,
                    h: d.h,
                    kind: chart.kind,
                    title: chart.title.clone(),
                    legend: chart.legend,
                    stacked: chart.stacked,
                    labels: chart.labels,
                    x_title: chart.x_title.clone(),
                    y_title: chart.y_title.clone(),
                    series: chart
                        .series
                        .iter()
                        .enumerate()
                        .map(|(i, s)| {
                            let values: Vec<CellValue> = self.range_values(&s.values, sheet);
                            let categories = s.categories.as_ref().map(|c| self.range_texts(c, sheet)).unwrap_or_default();
                            let x = s
                                .categories
                                .as_ref()
                                .map(|c| self.range_values(c, sheet).iter().map(Self::number).collect())
                                .unwrap_or_default();
                            let name = match (&s.name, s.name_is_ref) {
                                (Some(r), true) => self.range_texts(r, sheet).into_iter().next().unwrap_or_default(),
                                (Some(n), false) => n.clone(),
                                (None, _) => format!("Serie {}", i + 1),
                            };
                            SeriesView {
                                name,
                                color: s.color.clone().unwrap_or_else(|| PALETTE[i % PALETTE.len()].to_string()),
                                values: values.iter().map(Self::number).collect(),
                                categories,
                                x,
                                refs: s.clone(),
                            }
                        })
                        .collect(),
                },
            })
            .collect()
    }

    /// Series a partir de una tabla, como hace Excel: si la primera fila es de
    /// texto son los nombres; si la primera columna es de texto, las categorías;
    /// cada columna restante es una serie.
    fn series_from(&self, sheet: u32, rect: Rect, kind: ChartType) -> Result<Vec<Series>, String> {
        let r = rect.normalized();
        let model = self.model.get_model();
        let name = self.sheet_names().get(sheet as usize).cloned().ok_or("Hoja inválida")?;
        let is_text = |row: i32, col: i32| matches!(model.get_cell_value_by_index(sheet, row, col), Ok(CellValue::String(_)));
        let is_empty = |row: i32, col: i32| matches!(model.get_cell_value_by_index(sheet, row, col), Ok(CellValue::None));

        let header_row = r.row2 > r.row1 && (r.col1..=r.col2).all(|c| is_text(r.row1, c) || is_empty(r.row1, c));
        let first_data_row = r.row1 + i32::from(header_row);
        let category_col = r.col2 > r.col1
            && (first_data_row..=r.row2).all(|row| is_text(row, r.col1) || is_empty(row, r.col1))
            || (kind == ChartType::Scatter && r.col2 > r.col1);
        let first_value_col = r.col1 + i32::from(category_col);
        if first_value_col > r.col2 || first_data_row > r.row2 {
            return Err("Selecciona una tabla con al menos una columna de números".into());
        }
        let categories = category_col.then(|| {
            absolute_ref(&name, &Rect { row1: first_data_row, col1: r.col1, row2: r.row2, col2: r.col1 })
        });
        Ok((first_value_col..=r.col2)
            .map(|col| Series {
                name: header_row.then(|| absolute_ref(&name, &Rect { row1: r.row1, col1: col, row2: r.row1, col2: col })),
                name_is_ref: header_row,
                categories: categories.clone(),
                values: absolute_ref(&name, &Rect { row1: first_data_row, col1: col, row2: r.row2, col2: col }),
                color: None,
            })
            .collect())
    }

    /// Píxeles desde A1 hasta el borde izquierdo de una columna / superior de una fila (desde 1).
    pub(super) fn column_x(&self, sheet: u32, col: i32) -> f64 {
        let model = self.model.get_model();
        (1..col).map(|c| model.get_column_width(sheet, c).unwrap_or(super::DEFAULT_COLUMN_WIDTH)).sum()
    }

    pub(super) fn row_y(&self, sheet: u32, row: i32) -> f64 {
        let model = self.model.get_model();
        (1..row).map(|r| model.get_row_height(sheet, r).unwrap_or(super::DEFAULT_ROW_HEIGHT)).sum()
    }

    /// Celda (desde 1) y desplazamiento en píxeles dentro de ella para una posición.
    pub(super) fn cell_at(&self, sheet: u32, x: f64, y: f64) -> (i32, f64, i32, f64) {
        let model = self.model.get_model();
        let (mut col, mut left) = (1, 0.0);
        loop {
            let w = model.get_column_width(sheet, col).unwrap_or(super::DEFAULT_COLUMN_WIDTH);
            if left + w > x || col >= 16_384 {
                break;
            }
            left += w;
            col += 1;
        }
        let (mut row, mut top) = (1, 0.0);
        loop {
            let h = model.get_row_height(sheet, row).unwrap_or(super::DEFAULT_ROW_HEIGHT);
            if top + h > y || row >= 1_048_576 {
                break;
            }
            top += h;
            row += 1;
        }
        (col, (x - left).max(0.0), row, (y - top).max(0.0))
    }

    // ───────────── acciones ─────────────

    /// Inserta una gráfica con los datos de `rect`, a la derecha de la tabla. Devuelve su id.
    pub fn add_chart(&mut self, sheet: u32, rect: Rect, kind: ChartType) -> Result<u32, String> {
        let series = self.series_from(sheet, rect, kind)?;
        let sheet_id = self.sheet_id(sheet).ok_or("Hoja inválida")?;
        let r = rect.normalized();
        let before = self.extras.clone();
        let id = self.next_drawing_id();
        self.extras.drawings.push(Drawing {
            id,
            sheet_id,
            x: self.column_x(sheet, r.col2 + 1) + 24.0,
            y: self.row_y(sheet, r.row1),
            w: 480.0,
            h: 300.0,
            content: Content::Chart(Chart {
                kind,
                title: String::new(),
                legend: series.len() > 1 || matches!(kind, ChartType::Pie | ChartType::Doughnut),
                series,
                stacked: false,
                labels: false,
                x_title: String::new(),
                y_title: String::new(),
            }),
        });
        self.record_extras(before);
        Ok(id)
    }

    /// Inserta una imagen en la posición (x, y), con un ancho máximo de 480 px. Devuelve su id.
    pub fn add_image(&mut self, sheet: u32, path: &str, x: f64, y: f64) -> Result<u32, String> {
        let mime = mime_for(path).ok_or("WEPO acepta imágenes PNG, JPEG o GIF")?;
        let data = std::fs::read(path).map_err(|e| e.to_string())?;
        let (w, h) = image_size(&data).ok_or("No se pudo leer el tamaño de la imagen")?;
        let scale = (480.0 / w as f64).min(1.0);
        let sheet_id = self.sheet_id(sheet).ok_or("Hoja inválida")?;
        let name = std::path::Path::new(path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let before = self.extras.clone();
        let id = self.next_drawing_id();
        self.extras.drawings.push(Drawing {
            id,
            sheet_id,
            x,
            y,
            w: (w as f64 * scale).round(),
            h: (h as f64 * scale).round(),
            content: Content::Image(Image { name, mime: mime.to_string(), data: Arc::new(data) }),
        });
        self.record_extras(before);
        Ok(id)
    }

    pub fn update_drawing(&mut self, sheet: u32, id: u32, patch: DrawingPatch) -> Result<(), String> {
        let new_series = match &patch.data {
            Some(range) => {
                let rect = Rect::from_a1(range).ok_or("Escribe un rango como A1:C7")?;
                let kind = match self.extras.drawings.iter().find(|d| d.id == id).map(|d| &d.content) {
                    Some(Content::Chart(c)) => patch.kind.unwrap_or(c.kind),
                    _ => ChartType::Column,
                };
                Some(self.series_from(sheet, rect, kind)?)
            }
            None => None,
        };
        let before = self.extras.clone();
        let drawing = self.extras.drawings.iter_mut().find(|d| d.id == id).ok_or("Ese objeto ya no existe")?;
        if let Some(v) = patch.x { drawing.x = v.max(0.0) }
        if let Some(v) = patch.y { drawing.y = v.max(0.0) }
        if let Some(v) = patch.w { drawing.w = v.max(20.0) }
        if let Some(v) = patch.h { drawing.h = v.max(20.0) }
        if let Content::Chart(chart) = &mut drawing.content {
            if let Some(kind) = patch.kind { chart.kind = kind }
            if let Some(title) = patch.title { chart.title = title }
            if let Some(legend) = patch.legend { chart.legend = legend }
            if let Some(v) = patch.stacked { chart.stacked = v }
            if let Some(v) = patch.labels { chart.labels = v }
            if let Some(v) = patch.x_title { chart.x_title = v }
            if let Some(v) = patch.y_title { chart.y_title = v }
            if let Some(series) = new_series { chart.series = series }
        }
        self.record_extras(before);
        Ok(())
    }

    pub fn delete_drawing(&mut self, id: u32) -> Result<(), String> {
        let before = self.extras.clone();
        let count = self.extras.drawings.len();
        self.extras.drawings.retain(|d| d.id != id);
        if self.extras.drawings.len() == count {
            return Err("Ese objeto ya no existe".into());
        }
        self.record_extras(before);
        Ok(())
    }

    /// La imagen como data URL, para mostrarla en la interfaz.
    pub fn image_data(&self, id: u32) -> Result<String, String> {
        match self.extras.drawings.iter().find(|d| d.id == id).map(|d| &d.content) {
            Some(Content::Image(image)) => Ok(format!("data:{};base64,{}", image.mime, base64(&image.data))),
            _ => Err("Esa imagen ya no existe".into()),
        }
    }

    // ───────────── leer y escribir en el .xlsx ─────────────

    /// Lee las gráficas e imágenes de un .xlsx. Si había algo que WEPO no sabe
    /// conservar, se marca el archivo para no sobrescribirlo al guardar.
    pub(super) fn load_drawings(&mut self, path: &str) {
        let Ok((found, unsupported)) = crate::xlsx_extras::read_drawings(path) else {
            self.has_drawings = true;
            return;
        };
        self.has_drawings = unsupported;
        let names = self.sheet_names();
        for (name, raw_drawings) in found {
            let Some(sheet) = names.iter().position(|n| *n == name).map(|i| i as u32) else { continue };
            let Some(sheet_id) = self.sheet_id(sheet) else { continue };
            for raw in raw_drawings {
                let point = |p: &CellOffset| {
                    (
                        self.column_x(sheet, p.col + 1) + p.col_off as f64 / EMU_PER_PIXEL,
                        self.row_y(sheet, p.row + 1) + p.row_off as f64 / EMU_PER_PIXEL,
                    )
                };
                let (x, y, w, h) = match &raw.anchor {
                    RawAnchor::TwoCell(from, to) => {
                        let ((x1, y1), (x2, y2)) = (point(from), point(to));
                        (x1, y1, x2 - x1, y2 - y1)
                    }
                    RawAnchor::OneCell(from, cx, cy) => {
                        let (x, y) = point(from);
                        (x, y, *cx as f64 / EMU_PER_PIXEL, *cy as f64 / EMU_PER_PIXEL)
                    }
                    RawAnchor::Absolute(x, y, cx, cy) => (
                        *x as f64 / EMU_PER_PIXEL,
                        *y as f64 / EMU_PER_PIXEL,
                        *cx as f64 / EMU_PER_PIXEL,
                        *cy as f64 / EMU_PER_PIXEL,
                    ),
                };
                let content = match raw.content {
                    RawContent::Image { name, mime, data } => Content::Image(Image { name, mime, data: Arc::new(data) }),
                    RawContent::Chart(chart) => {
                        let kind = match chart.kind.as_str() {
                            "bar" => ChartType::Bar,
                            "line" => ChartType::Line,
                            "area" => ChartType::Area,
                            "pie" => ChartType::Pie,
                            "doughnut" => ChartType::Doughnut,
                            "scatter" => ChartType::Scatter,
                            "combo" => ChartType::Combo,
                            _ => ChartType::Column,
                        };
                        Content::Chart(Chart {
                            kind,
                            title: chart.title,
                            legend: chart.legend,
                            stacked: chart.stacked,
                            labels: chart.labels,
                            x_title: chart.x_title,
                            y_title: chart.y_title,
                            series: chart
                                .series
                                .into_iter()
                                .map(|s| Series {
                                    name_is_ref: s.name_ref.is_some(),
                                    name: s.name_ref.or(s.name),
                                    categories: s.categories,
                                    values: s.values,
                                    color: s.color,
                                })
                                .collect(),
                        })
                    }
                };
                let id = self.next_drawing_id();
                self.extras.drawings.push(Drawing { id, sheet_id, x, y, w: w.max(1.0), h: h.max(1.0), content });
            }
        }
    }

    /// Prepara las gráficas e imágenes de cada hoja para escribirlas en el .xlsx.
    pub(super) fn drawings_for_xlsx(&self, sheets: &mut Vec<(String, SheetExtras)>) {
        let names = self.sheet_names();
        for d in &self.extras.drawings {
            let Some(sheet) = self.sheet_index(d.sheet_id) else { continue };
            let offset = |x: f64, y: f64| {
                let (col, col_px, row, row_px) = self.cell_at(sheet, x, y);
                CellOffset {
                    col: col - 1,
                    col_off: (col_px * EMU_PER_PIXEL).round() as i64,
                    row: row - 1,
                    row_off: (row_px * EMU_PER_PIXEL).round() as i64,
                }
            };
            let from = offset(d.x, d.y);
            let raw = match &d.content {
                Content::Image(image) => RawDrawing {
                    // Imágenes: esquina + tamaño, para que no se deformen si cambian los anchos.
                    anchor: RawAnchor::OneCell(from, (d.w * EMU_PER_PIXEL).round() as i64, (d.h * EMU_PER_PIXEL).round() as i64),
                    content: RawContent::Image { name: image.name.clone(), mime: image.mime.clone(), data: image.data.as_ref().clone() },
                },
                Content::Chart(chart) => RawDrawing {
                    anchor: RawAnchor::TwoCell(from, offset(d.x + d.w, d.y + d.h)),
                    content: RawContent::Chart(RawChart {
                        kind: serde_json::to_value(chart.kind).ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_default(),
                        title: chart.title.clone(),
                        legend: chart.legend,
                        stacked: chart.stacked,
                        labels: chart.labels,
                        x_title: chart.x_title.clone(),
                        y_title: chart.y_title.clone(),
                        series: chart
                            .series
                            .iter()
                            .map(|s| RawSeries {
                                name_ref: s.name.clone().filter(|_| s.name_is_ref),
                                // El nombre ya calculado, para los programas que no leen las celdas.
                                name: match (&s.name, s.name_is_ref) {
                                    (Some(r), true) => self.range_texts(r, sheet).into_iter().next(),
                                    (n, _) => n.clone(),
                                },
                                categories: s.categories.clone(),
                                values: s.values.clone(),
                                color: s.color.clone(),
                                category_cache: s.categories.as_ref().map(|c| self.range_texts(c, sheet)).unwrap_or_default(),
                                value_cache: self.range_values(&s.values, sheet).iter().map(Self::number).collect(),
                            })
                            .collect(),
                    }),
                },
            };
            let name = names[sheet as usize].clone();
            match sheets.iter_mut().find(|(n, _)| *n == name) {
                Some((_, extras)) => extras.drawings.push(raw),
                None => sheets.push((name, SheetExtras { drawings: vec![raw], ..Default::default() })),
            }
        }
    }

    /// Al renombrar una hoja, las gráficas que la usan actualizan sus referencias.
    pub(super) fn rename_in_charts(&mut self, old: &str, new: &str) {
        let rewrite = |reference: &mut String| {
            if let (Some(sheet), range) = split_ref(reference) {
                if sheet == old {
                    *reference = format!("{}!{range}", quote_sheet(new));
                }
            }
        };
        for d in &mut self.extras.drawings {
            if let Content::Chart(chart) = &mut d.content {
                for s in &mut chart.series {
                    rewrite(&mut s.values);
                    if let Some(c) = &mut s.categories { rewrite(c) }
                    if s.name_is_ref {
                        if let Some(n) = &mut s.name { rewrite(n) }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_y_tamanos() {
        assert_eq!(base64(b"Hola"), "SG9sYQ==");
        assert_eq!(base64(b"abc"), "YWJj");
        let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        png.extend_from_slice(&640u32.to_be_bytes());
        png.extend_from_slice(&480u32.to_be_bytes());
        assert_eq!(image_size(&png), Some((640, 480)));
        assert_eq!(absolute_ref("Mi hoja", &Rect { row1: 2, col1: 1, row2: 7, col2: 1 }), "'Mi hoja'!$A$2:$A$7");
        assert_eq!(split_ref("'Mi hoja'!$A$2:$A$7"), (Some("Mi hoja".into()), "$A$2:$A$7"));
    }

    #[test]
    fn graficas_desde_una_tabla() {
        let mut doc = SheetDocument::new_empty().unwrap();
        let data = [["Mes", "Ventas", "Gastos"], ["Ene", "100", "80"], ["Feb", "150", "90"], ["Mar", "120", "=B4/2"]];
        for (r, row) in data.iter().enumerate() {
            for (c, v) in row.iter().enumerate() {
                doc.set_cell(0, r as i32 + 1, c as i32 + 1, v).unwrap();
            }
        }
        let id = doc.add_chart(0, Rect { row1: 1, col1: 1, row2: 4, col2: 3 }, ChartType::Column).unwrap();
        let views = doc.drawing_views(0);
        let DrawingView::Chart { series, legend, x, .. } = &views[0] else { panic!("no es gráfica") };
        assert_eq!(series.len(), 2);
        assert_eq!(series[0].name, "Ventas");
        assert_eq!(series[0].categories, vec!["Ene", "Feb", "Mar"]);
        assert_eq!(series[1].values, vec![Some(80.0), Some(90.0), Some(60.0)]);
        assert_eq!(series[0].refs.values, "Hoja1!$B$2:$B$4");
        assert!(*legend);
        assert_eq!(*x, 3.0 * 90.0 + 24.0, "a la derecha de la tabla");

        // Cambiar un número cambia la gráfica.
        doc.set_cell(0, 2, 2, "500").unwrap();
        let DrawingView::Chart { series, .. } = &doc.drawing_views(0)[0] else { panic!() };
        assert_eq!(series[0].values[0], Some(500.0));

        // Mover, cambiar tipo y título; deshacer; borrar.
        doc.update_drawing(0, id, DrawingPatch { x: Some(10.0), kind: Some(ChartType::Pie), title: Some("Ventas".into()), ..Default::default() }).unwrap();
        let DrawingView::Chart { kind, title, x, .. } = &doc.drawing_views(0)[0] else { panic!() };
        assert_eq!((*kind, title.as_str(), *x), (ChartType::Pie, "Ventas", 10.0));
        doc.undo().unwrap();
        let DrawingView::Chart { kind, .. } = &doc.drawing_views(0)[0] else { panic!() };
        assert_eq!(*kind, ChartType::Column);

        // Renombrar la hoja actualiza las referencias.
        doc.rename_sheet(0, "Datos 2026").unwrap();
        let DrawingView::Chart { series, .. } = &doc.drawing_views(0)[0] else { panic!() };
        assert_eq!(series[0].refs.values, "'Datos 2026'!$B$2:$B$4");
        assert_eq!(series[0].values[1], Some(150.0));

        doc.delete_drawing(id).unwrap();
        assert!(doc.drawing_views(0).is_empty());
        doc.undo().unwrap();
        assert_eq!(doc.drawing_views(0).len(), 1);
    }

    #[test]
    fn graficas_combinadas_apiladas_y_con_titulos() {
        let mut doc = SheetDocument::new_empty().unwrap();
        let data = [["Mes", "Norte", "Sur", "Meta"], ["Ene", "10", "20", "25"], ["Feb", "15", "18", "30"]];
        for (r, row) in data.iter().enumerate() {
            for (c, v) in row.iter().enumerate() {
                doc.set_cell(0, r as i32 + 1, c as i32 + 1, v).unwrap();
            }
        }
        let combo = doc.add_chart(0, Rect { row1: 1, col1: 1, row2: 3, col2: 4 }, ChartType::Combo).unwrap();
        let patch = DrawingPatch {
            labels: Some(true),
            x_title: Some("Mes".into()),
            y_title: Some("Ventas (miles)".into()),
            ..Default::default()
        };
        doc.update_drawing(0, combo, patch).unwrap();
        let stacked = doc.add_chart(0, Rect { row1: 1, col1: 1, row2: 3, col2: 3 }, ChartType::Bar).unwrap();
        doc.update_drawing(0, stacked, DrawingPatch { stacked: Some(true), ..Default::default() }).unwrap();

        let path = std::env::temp_dir().join(format!("wepo-combo-{}.xlsx", std::process::id()));
        let path = path.to_str().unwrap();
        doc.save(path, 0).unwrap();
        let reopened = SheetDocument::open(path).unwrap();
        let views = reopened.drawing_views(0);
        let DrawingView::Chart { kind, labels, x_title, y_title, series, .. } = &views[0] else { panic!() };
        assert_eq!((*kind, *labels, x_title.as_str(), y_title.as_str(), series.len()), (ChartType::Combo, true, "Mes", "Ventas (miles)", 3));
        let DrawingView::Chart { kind, stacked, .. } = &views[1] else { panic!() };
        assert_eq!((*kind, *stacked), (ChartType::Bar, true));
        std::fs::remove_file(path).unwrap();
    }

    /// PNG real de 2x2 píxeles.
    const PNG: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
        0x02, 0x00, 0x00, 0x00, 0x02, 0x08, 0x02, 0x00, 0x00, 0x00, 0xFD, 0xD4, 0x9A, 0x73, 0x00, 0x00, 0x00, 0x14, 0x49,
        0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0xF8, 0xCF, 0xC0, 0xF0, 0x1F, 0x08, 0x19, 0x18, 0x18, 0x00, 0x00, 0x2F, 0xEE,
        0x05, 0xFB, 0xA3, 0x07, 0x6F, 0x31, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ];

    #[test]
    fn guarda_y_reabre_graficas_e_imagenes() {
        let dir = std::env::temp_dir();
        let image_path = dir.join(format!("wepo-img-{}.png", std::process::id()));
        std::fs::write(&image_path, PNG).unwrap();

        let mut doc = SheetDocument::new_empty().unwrap();
        doc.rename_sheet(0, "Ventas 2026").unwrap();
        for (r, (m, v)) in [("Mes", "Total"), ("Ene", "10"), ("Feb", "25"), ("Mar", "18")].iter().enumerate() {
            doc.set_cell(0, r as i32 + 1, 1, m).unwrap();
            doc.set_cell(0, r as i32 + 1, 2, v).unwrap();
        }
        let chart = doc.add_chart(0, Rect { row1: 1, col1: 1, row2: 4, col2: 2 }, ChartType::Line).unwrap();
        doc.update_drawing(0, chart, DrawingPatch { title: Some("Ventas & gastos".into()), ..Default::default() }).unwrap();
        doc.add_chart(0, Rect { row1: 1, col1: 1, row2: 4, col2: 2 }, ChartType::Pie).unwrap();
        doc.add_image(0, image_path.to_str().unwrap(), 50.0, 400.0).unwrap();

        let path = dir.join(format!("wepo-graficas-{}.xlsx", std::process::id()));
        let path = path.to_str().unwrap();
        doc.save(path, 0).unwrap();

        let reopened = SheetDocument::open(path).unwrap();
        assert!(!reopened.view(0).unwrap().has_drawings, "todo se entiende: el original se puede sobrescribir");
        let views = reopened.drawing_views(0);
        assert_eq!(views.len(), 3);
        let DrawingView::Chart { kind, title, series, x, w, .. } = &views[0] else { panic!("no es gráfica") };
        assert_eq!((*kind, title.as_str()), (ChartType::Line, "Ventas & gastos"));
        assert_eq!(series[0].name, "Total");
        assert_eq!(series[0].refs.values, "'Ventas 2026'!$B$2:$B$4");
        assert_eq!(series[0].values, vec![Some(10.0), Some(25.0), Some(18.0)]);
        assert!((x - (2.0 * 90.0 + 24.0)).abs() < 1.0, "posición conservada: {x}");
        assert!((w - 480.0).abs() < 1.0, "tamaño conservado: {w}");
        let DrawingView::Chart { kind, .. } = &views[1] else { panic!() };
        assert_eq!(*kind, ChartType::Pie);
        let DrawingView::Image { id, x, y, w, h, .. } = &views[2] else { panic!("no es imagen") };
        assert_eq!((*x, *y, *w, *h), (50.0, 400.0, 2.0, 2.0));
        assert!(reopened.image_data(*id).unwrap().starts_with("data:image/png;base64,iVBOR"));

        std::fs::remove_file(path).unwrap();
        std::fs::remove_file(image_path).unwrap();
    }

}
