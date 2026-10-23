//! Núcleo de WEPO Sheets.
//!
//! El libro abierto vive aquí, en Rust, dentro de un modelo de IronCalc:
//! él guarda los valores y las fórmulas, recalcula, deshace/rehace y
//! exporta a .xlsx. La interfaz solo pide "fotos" de la hoja visible y
//! manda los cambios que hace el usuario.

use std::collections::HashMap;
use std::fs;
use std::io::BufWriter;
use std::path::Path;

use calamine::{open_workbook_auto, Data, Reader};
use ironcalc::base::expressions::types::Area;
use ironcalc::base::types::{BorderItem, CellType, Color};
use ironcalc::base::{BorderArea, ClipboardData};
use ironcalc::base::{Model, UserModel};
use ironcalc::export::save_xlsx_to_writer;
use ironcalc::import::load_from_xlsx;
use serde::Serialize;

use crate::sheet_format::{border_style, border_type, style_view, StyleView};

const LOCALE: &str = "en";
const TIMEZONE: &str = "UTC";
const LANGUAGE: &str = "en";

/// Medidas por defecto de IronCalc, en píxeles.
pub const DEFAULT_COLUMN_WIDTH: f64 = 90.0;
pub const DEFAULT_ROW_HEIGHT: f64 = 25.0;
/// Hasta qué columna revisamos anchos personalizados (más allá casi nunca hay).
const MAX_SCANNED_COLUMN: i32 = 2000;

/// Libro abierto en el editor.
pub struct SheetDocument {
    model: UserModel<'static>,
    /// El archivo original tiene gráficas o imágenes que IronCalc no conserva.
    has_drawings: bool,
    /// Lo último que se copió dentro de WEPO (con fórmulas y formato).
    clipboard: Option<InternalClipboard>,
}

struct InternalClipboard {
    text: String,
    sheet: u32,
    range: (i32, i32, i32, i32),
    data: ClipboardData,
    is_cut: bool,
}

/// Rectángulo de celdas en base 1, como en Excel.
#[derive(Clone, Copy, Debug)]
pub struct Rect {
    pub row1: i32,
    pub col1: i32,
    pub row2: i32,
    pub col2: i32,
}

impl Rect {
    fn area(&self, sheet: u32) -> Area {
        Area {
            sheet,
            row: self.row1.min(self.row2),
            column: self.col1.min(self.col2),
            width: (self.col2 - self.col1).abs() + 1,
            height: (self.row2 - self.row1).abs() + 1,
        }
    }
}

/// Una celda tal como la ve la interfaz: texto ya formateado, si es número
/// (los números se alinean a la derecha) y el índice de su estilo en `styles`.
#[derive(Serialize, Debug, PartialEq)]
pub struct CellView(pub String, pub bool, pub u32);

/// "Foto" de una hoja: su contenido, formato y medidas.
#[derive(Serialize, Debug)]
pub struct SheetView {
    pub sheet_names: Vec<String>,
    pub sheet: u32,
    /// Filas desde la 1. Cada fila llega hasta su última celda con contenido o formato.
    pub rows: Vec<Vec<CellView>>,
    /// Estilos usados en la hoja. El 0 es el de una celda vacía.
    pub styles: Vec<StyleView>,
    /// Columnas con ancho distinto al normal: (columna desde 1, píxeles).
    pub col_widths: Vec<(i32, f64)>,
    /// Filas con alto distinto al normal: (fila desde 1, píxeles).
    pub row_heights: Vec<(i32, f64)>,
    pub has_drawings: bool,
}

fn extension(path: &str) -> String {
    Path::new(path)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default()
}

/// Un .xlsx es un ZIP: los nombres de sus archivos internos aparecen en claro
/// en el índice, así que basta buscar las carpetas de gráficas e imágenes.
fn xlsx_has_drawings(path: &str) -> bool {
    let Ok(bytes) = fs::read(path) else { return false };
    [&b"xl/drawings/"[..], b"xl/charts/", b"xl/media/"]
        .iter()
        .any(|needle| bytes.windows(needle.len()).any(|w| w == *needle))
}

impl SheetDocument {
    fn wrap(model: UserModel<'static>) -> Self {
        Self { model, has_drawings: false, clipboard: None }
    }

    /// Libro vacío con una hoja.
    pub fn new_empty() -> Result<Self, String> {
        let mut model = UserModel::new_empty("Libro", LOCALE, TIMEZONE, LANGUAGE)?;
        model.rename_sheet(0, "Hoja1")?;
        Ok(Self::wrap(model))
    }

    /// Abre un archivo según su extensión.
    pub fn open(path: &str) -> Result<Self, String> {
        match extension(path).as_str() {
            // IronCalc lee .xlsx completo: valores, fórmulas y estilos.
            "xlsx" | "xlsm" => {
                let mut model = load_from_xlsx(path, LOCALE, TIMEZONE, LANGUAGE)
                    .map_err(|e| format!("{e:?}"))?;
                // Recalcula por si el archivo no guardó los resultados de sus fórmulas.
                model.evaluate();
                let mut doc = Self::wrap(UserModel::from_model(model));
                doc.has_drawings = xlsx_has_drawings(path);
                Ok(doc)
            }
            "csv" => Self::from_csv(path),
            // .xls, .xlsb y .ods se leen con calamine y se pasan al modelo.
            _ => Self::from_calamine(path),
        }
    }

    fn from_csv(path: &str) -> Result<Self, String> {
        let mut reader = csv::ReaderBuilder::new()
            .has_headers(false)
            .flexible(true)
            .from_path(path)
            .map_err(|e| e.to_string())?;

        let mut model = Model::new_empty("Libro", LOCALE, TIMEZONE, LANGUAGE)?;
        for (r, record) in reader.records().enumerate() {
            let record = record.map_err(|e| e.to_string())?;
            for (c, value) in record.iter().enumerate() {
                if !value.is_empty() {
                    model.set_user_input(0, r as i32 + 1, c as i32 + 1, value.to_string())?;
                }
            }
        }
        model.evaluate();
        Ok(Self::wrap(UserModel::from_model(model)))
    }

    fn from_calamine(path: &str) -> Result<Self, String> {
        let ext = extension(path);
        let (is_xls, is_ods) = (ext == "xls", ext == "ods");
        let mut wb = open_workbook_auto(path).map_err(|e| e.to_string())?;
        let names = wb.sheet_names().to_owned();

        let mut model = Model::new_empty("Libro", LOCALE, TIMEZONE, LANGUAGE)?;
        for (index, name) in names.iter().enumerate() {
            let sheet = index as u32;
            if index == 0 {
                model.rename_sheet_by_index(0, name)?;
            } else {
                model.add_sheet(name)?;
            }

            // Primero los valores…
            if let Ok(range) = wb.worksheet_range(name) {
                let (row0, col0) = range.start().unwrap_or((0, 0));
                for (r, row) in range.rows().enumerate() {
                    for (c, cell) in row.iter().enumerate() {
                        let input = match cell {
                            Data::Empty => continue,
                            Data::String(s) => s.clone(),
                            other => other.to_string(),
                        };
                        let (r, c) = (row0 as i32 + r as i32 + 1, col0 as i32 + c as i32 + 1);
                        model.set_user_input(sheet, r, c, input)?;
                    }
                }
            }
            // …y después las fórmulas, que reemplazan el valor guardado.
            // En .xls la lectura de fórmulas no es confiable, así que se queda
            // con los valores ya calculados.
            if is_xls {
                continue;
            }
            if let Ok(formulas) = wb.worksheet_formula(name) {
                let (row0, col0) = formulas.start().unwrap_or((0, 0));
                for (r, row) in formulas.rows().enumerate() {
                    for (c, formula) in row.iter().enumerate() {
                        if formula.is_empty() {
                            continue;
                        }
                        let (r, c) = (row0 as i32 + r as i32 + 1, col0 as i32 + c as i32 + 1);
                        let formula = if is_ods {
                            ods_formula_to_excel(formula)
                        } else {
                            formula.clone()
                        };
                        // Si IronCalc no entiende la fórmula, conservamos el valor leído.
                        let _ = model.set_user_input(sheet, r, c, format!("={formula}"));
                    }
                }
            }
        }
        model.evaluate();
        Ok(Self::wrap(UserModel::from_model(model)))
    }

    /// Foto de una hoja para dibujarla en la interfaz.
    pub fn view(&self, sheet: u32) -> Result<SheetView, String> {
        let model = self.model.get_model();
        let worksheet = model.workbook.worksheet(sheet)?;

        // Tabla de estilos: cada estilo distinto se manda una sola vez y las
        // celdas solo llevan su número. El 0 es el de una celda vacía.
        let default_style = model.get_style_for_cell(sheet, 1_048_576, 16_384)?;
        let mut styles = vec![style_view(&self.model, &default_style)];
        let mut style_ids: HashMap<i32, u32> = HashMap::new();

        let mut rows: Vec<Vec<CellView>> = Vec::new();
        // Recorremos solo las celdas que existen, no todo el rectángulo.
        let mut row_numbers = worksheet.sheet_data.rows();
        row_numbers.sort_unstable();
        for row in row_numbers {
            let mut cols = worksheet.sheet_data.columns_in_row(row);
            cols.sort_unstable();
            let Some(&last_col) = cols.last() else { continue };

            let mut cells: Vec<CellView> =
                (0..last_col).map(|_| CellView(String::new(), false, 0)).collect();
            for col in cols {
                let text = model.get_formatted_cell_value(sheet, row, col)?;
                let numeric = !text.is_empty()
                    && matches!(model.get_cell_type(sheet, row, col)?, CellType::Number);

                let xf = model.get_cell_style_index(sheet, row, col)?;
                let style = match style_ids.get(&xf) {
                    Some(&id) => id,
                    None => {
                        let view = style_view(&self.model, &model.get_style_for_cell(sheet, row, col)?);
                        let id = match styles.iter().position(|s| *s == view) {
                            Some(existing) => existing as u32,
                            None => {
                                styles.push(view);
                                (styles.len() - 1) as u32
                            }
                        };
                        style_ids.insert(xf, id);
                        id
                    }
                };
                cells[(col - 1) as usize] = CellView(text, numeric, style);
            }
            let index = (row - 1) as usize;
            if rows.len() <= index {
                rows.resize_with(index + 1, Vec::new);
            }
            rows[index] = cells;
        }

        // Anchos de columna y altos de fila que no son los normales.
        let mut col_widths = Vec::new();
        for col in &worksheet.cols {
            for c in col.min..=col.max.min(MAX_SCANNED_COLUMN) {
                let width = model.get_column_width(sheet, c)?;
                if (width - DEFAULT_COLUMN_WIDTH).abs() > 0.5 {
                    col_widths.push((c, width));
                }
            }
        }
        let mut row_heights = Vec::new();
        for row in &worksheet.rows {
            let height = model.get_row_height(sheet, row.r)?;
            if (height - DEFAULT_ROW_HEIGHT).abs() > 0.5 {
                row_heights.push((row.r, height));
            }
        }

        Ok(SheetView {
            sheet_names: self.sheet_names(),
            sheet,
            rows,
            styles,
            col_widths,
            row_heights,
            has_drawings: self.has_drawings,
        })
    }

    pub fn sheet_names(&self) -> Vec<String> {
        self.model
            .get_worksheets_properties()
            .into_iter()
            .map(|p| p.name)
            .collect()
    }

    /// Lo que el usuario escribió en la celda: la fórmula (=SUMA…) o el valor.
    pub fn cell_input(&self, sheet: u32, row: i32, col: i32) -> Result<String, String> {
        self.model.get_cell_content(sheet, row, col)
    }

    /// Escribe en una celda (texto, número o fórmula) y recalcula el libro.
    pub fn set_cell(&mut self, sheet: u32, row: i32, col: i32, input: &str) -> Result<(), String> {
        if input.is_empty() {
            let rect = Rect { row1: row, col1: col, row2: row, col2: col };
            return self.clear_range(sheet, rect);
        }
        self.model.set_user_input(sheet, row, col, input)
    }

    pub fn clear_range(&mut self, sheet: u32, rect: Rect) -> Result<(), String> {
        self.model.range_clear_contents(&rect.area(sheet))
    }

    pub fn undo(&mut self) -> Result<(), String> {
        self.model.undo()
    }

    pub fn redo(&mut self) -> Result<(), String> {
        self.model.redo()
    }

    /// Agrega una hoja al final con un nombre libre (Hoja2, Hoja3…) y devuelve su índice.
    pub fn add_sheet(&mut self) -> Result<u32, String> {
        let names = self.sheet_names();
        let name = (1..)
            .map(|n| format!("Hoja{n}"))
            .find(|candidate| !names.contains(candidate))
            .unwrap_or_default();
        self.model.new_sheet()?;
        let index = names.len() as u32;
        self.model.rename_sheet(index, &name)?;
        Ok(index)
    }

    // ───────────── formato ─────────────

    /// Cambia una propiedad de estilo en un rango.
    ///
    /// `path` sigue la convención de IronCalc: `font.b`, `font.size`,
    /// `font.color`, `fill.fg_color`, `alignment.horizontal`, `num_fmt`…
    /// Además aceptamos `font.name`, que IronCalc no expone directamente.
    pub fn set_style(&mut self, sheet: u32, rect: Rect, path: &str, value: &str) -> Result<(), String> {
        let area = rect.area(sheet);
        if path == "font.name" {
            return self.set_font_name(&area, value);
        }
        self.model.update_range_style(&area, path, value)
    }

    /// Para cambiar la fuente copiamos el estilo de cada celda con el nombre
    /// nuevo y lo "pegamos" sobre el rango; así también se puede deshacer.
    fn set_font_name(&mut self, area: &Area, name: &str) -> Result<(), String> {
        let mut styles = Vec::with_capacity(area.height as usize);
        for row in area.row..area.row + area.height {
            let mut line = Vec::with_capacity(area.width as usize);
            for col in area.column..area.column + area.width {
                let mut style = self.model.get_model().get_style_for_cell(area.sheet, row, col)?;
                style.font.name = name.to_string();
                line.push(style);
            }
            styles.push(line);
        }
        self.select(area.sheet, area.row, area.column, area.row + area.height - 1, area.column + area.width - 1)?;
        self.model.on_paste_styles(&styles)
    }

    /// Bordes de un rango. `kind`: all, outer, inner, top, bottom, left, right, none.
    /// `style`: thin, medium, thick, double, dotted, dashed. `color`: #RRGGBB.
    pub fn set_border(&mut self, sheet: u32, rect: Rect, kind: &str, style: &str, color: &str) -> Result<(), String> {
        let item = BorderItem {
            style: border_style(style)?,
            color: Color::from_param(color)?,
        };
        let json = serde_json::json!({ "item": item, "type": border_type(kind)? });
        let border: BorderArea = serde_json::from_value(json).map_err(|e| e.to_string())?;
        self.model.set_area_with_border(&rect.area(sheet), &border)
    }

    /// Ancho de una o varias columnas, en píxeles.
    pub fn set_column_width(&mut self, sheet: u32, col1: i32, col2: i32, width: f64) -> Result<(), String> {
        self.model.set_columns_width(sheet, col1.min(col2), col1.max(col2), width.max(8.0))
    }

    /// Alto de una o varias filas, en píxeles.
    pub fn set_row_height(&mut self, sheet: u32, row1: i32, row2: i32, height: f64) -> Result<(), String> {
        self.model.set_rows_height(sheet, row1.min(row2), row1.max(row2), height.max(8.0))
    }

    // ───────────── portapapeles ─────────────

    fn select(&mut self, sheet: u32, row1: i32, col1: i32, row2: i32, col2: i32) -> Result<(), String> {
        self.model.set_selected_sheet(sheet)?;
        self.model.set_selected_cell(row1, col1)?;
        self.model.set_selected_range(row1, col1, row2, col2)
    }

    /// Copia (o corta) un rango. Devuelve el texto separado por tabuladores,
    /// que es lo que entienden Excel, Numbers y Google Sheets al pegar.
    pub fn copy(&mut self, sheet: u32, rect: Rect, is_cut: bool) -> Result<String, String> {
        let area = rect.area(sheet);
        self.select(sheet, area.row, area.column, area.row + area.height - 1, area.column + area.width - 1)?;
        // Los campos del portapapeles de IronCalc son privados, pero se
        // pueden serializar: así recuperamos los datos para pegarlos después.
        let copied = self.model.copy_to_clipboard()?;
        let mut value = serde_json::to_value(&copied).map_err(|e| e.to_string())?;
        let field = |v: &mut serde_json::Value, key: &str| v.get_mut(key).map(serde_json::Value::take);

        let text: String = serde_json::from_value(field(&mut value, "csv").unwrap_or_default())
            .map_err(|e| e.to_string())?;
        let data: ClipboardData = serde_json::from_value(field(&mut value, "data").unwrap_or_default())
            .map_err(|e| e.to_string())?;
        let range: (i32, i32, i32, i32) = serde_json::from_value(field(&mut value, "range").unwrap_or_default())
            .map_err(|e| e.to_string())?;

        self.clipboard = Some(InternalClipboard { text: text.clone(), sheet, range, data, is_cut });
        Ok(text)
    }

    /// Pega en (row, col). Si `text` es lo último que se copió en WEPO, pega
    /// con fórmulas y formato; si viene de otra aplicación, pega el texto.
    pub fn paste(&mut self, sheet: u32, row: i32, col: i32, text: &str) -> Result<(), String> {
        let internal = self
            .clipboard
            .as_ref()
            .is_some_and(|c| c.text.trim() == text.trim());

        if internal {
            let clip = self.clipboard.take().expect("revisado arriba");
            let height = clip.range.2 - clip.range.0;
            let width = clip.range.3 - clip.range.1;
            self.select(sheet, row, col, row + height, col + width)?;
            self.model.paste_from_clipboard(clip.sheet, clip.range, &clip.data, clip.is_cut)?;
            // Lo cortado solo se pega una vez; lo copiado se puede pegar de nuevo.
            if !clip.is_cut {
                self.clipboard = Some(clip);
            }
            return Ok(());
        }

        let lines = text.lines().count().max(1) as i32;
        let columns = text.lines().map(|l| l.split('\t').count()).max().unwrap_or(1) as i32;
        let rect = Rect { row1: row, col1: col, row2: row + lines - 1, col2: col + columns - 1 };
        self.select(sheet, rect.row1, rect.col1, rect.row2, rect.col2)?;
        self.model.paste_csv_string(&rect.area(sheet), text)
    }

    /// Guarda en .xlsx (todo el libro) o .csv (solo la hoja indicada).
    pub fn save(&self, path: &str, sheet: u32) -> Result<(), String> {
        // Escribimos a un archivo temporal y luego lo movemos: si algo falla
        // a medias, el archivo original queda intacto.
        let tmp = format!("{path}.wepo-tmp");
        let result = match extension(path).as_str() {
            "xlsx" => self.write_xlsx(&tmp),
            "csv" => self.write_csv(&tmp, sheet),
            other => Err(format!("WEPO todavía no puede guardar archivos .{other}")),
        };
        match result {
            Ok(()) => fs::rename(&tmp, path).map_err(|e| e.to_string()),
            Err(e) => {
                let _ = fs::remove_file(&tmp);
                Err(e)
            }
        }
    }

    fn write_xlsx(&self, path: &str) -> Result<(), String> {
        let file = fs::File::create(path).map_err(|e| e.to_string())?;
        save_xlsx_to_writer(self.model.get_model(), BufWriter::new(file))
            .map(|_| ())
            .map_err(|e| format!("{e:?}"))
    }

    fn write_csv(&self, path: &str, sheet: u32) -> Result<(), String> {
        let view = self.view(sheet)?;
        let width = view.rows.iter().map(Vec::len).max().unwrap_or(0);
        let mut writer = csv::Writer::from_path(path).map_err(|e| e.to_string())?;
        for row in view.rows {
            let mut record: Vec<String> = row.into_iter().map(|c| c.0).collect();
            record.resize(width, String::new());
            writer.write_record(&record).map_err(|e| e.to_string())?;
        }
        writer.flush().map_err(|e| e.to_string())
    }
}

/// Traduce una fórmula de OpenDocument (.ods) al formato de Excel.
///
/// `of:=SUM([.A1:.A3];[$Hoja2.B1])` → `SUM(A1:A3,Hoja2!B1)`
pub fn ods_formula_to_excel(formula: &str) -> String {
    let body = formula.strip_prefix("of:").unwrap_or(formula);
    let body = body.strip_prefix('=').unwrap_or(body);

    let mut out = String::with_capacity(body.len());
    let mut chars = body.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            // Texto entre comillas: se copia tal cual.
            '"' => {
                out.push('"');
                for c in chars.by_ref() {
                    out.push(c);
                    if c == '"' {
                        break;
                    }
                }
            }
            // Referencia entre corchetes: [.A1], [.A1:.B2], [$Hoja.A1]
            '[' => {
                let mut reference = String::new();
                for c in chars.by_ref() {
                    if c == ']' {
                        break;
                    }
                    reference.push(c);
                }
                let parts: Vec<String> = reference.split(':').map(ods_cell_ref).collect();
                out.push_str(&parts.join(":"));
            }
            // OpenDocument separa argumentos con punto y coma.
            ';' => out.push(','),
            _ => out.push(ch),
        }
    }
    out
}

/// `.A1` → `A1`, `$Hoja.$B$2` → `Hoja!$B$2`, `$'Mi hoja'.A1` → `'Mi hoja'!A1`
fn ods_cell_ref(part: &str) -> String {
    match part.rfind('.') {
        Some(0) => part[1..].to_string(),
        Some(dot) => {
            let sheet = part[..dot].trim_start_matches('$');
            format!("{sheet}!{}", &part[dot + 1..])
        }
        None => part.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn traduce_formulas_ods() {
        assert_eq!(ods_formula_to_excel("of:=[.$B$1]-[.$B$1]/10*[.A6]"), "$B$1-$B$1/10*A6");
        assert_eq!(ods_formula_to_excel("of:=SUM([.C5:.C15])"), "SUM(C5:C15)");
        assert_eq!(ods_formula_to_excel("of:=[$SPR3.F1]*2"), "SPR3!F1*2");
        assert_eq!(ods_formula_to_excel("of:=IF([.A1]>1;\"a;b\";[$'Mi hoja'.B2])"), "IF(A1>1,\"a;b\",'Mi hoja'!B2)");
    }

    fn rect(row1: i32, col1: i32, row2: i32, col2: i32) -> Rect {
        Rect { row1, col1, row2, col2 }
    }

    fn style_of(doc: &SheetDocument, row: usize, col: usize) -> StyleView {
        let view = doc.view(0).unwrap();
        let id = view.rows[row - 1][col - 1].2;
        view.styles[id as usize].clone()
    }

    #[test]
    fn formato_bordes_y_medidas() {
        let mut doc = SheetDocument::new_empty().unwrap();
        doc.set_cell(0, 1, 1, "Título").unwrap();
        doc.set_cell(0, 2, 2, "1234.5").unwrap();

        doc.set_style(0, rect(1, 1, 1, 1), "font.b", "true").unwrap();
        doc.set_style(0, rect(1, 1, 1, 1), "font.size", "18").unwrap();
        doc.set_style(0, rect(1, 1, 1, 1), "font.color", "#C00000").unwrap();
        doc.set_style(0, rect(1, 1, 1, 1), "fill.fg_color", "#FFF2CC").unwrap();
        doc.set_style(0, rect(1, 1, 1, 1), "font.name", "Georgia").unwrap();
        doc.set_style(0, rect(1, 1, 1, 1), "alignment.horizontal", "center").unwrap();
        doc.set_style(0, rect(2, 2, 2, 2), "num_fmt", "$#,##0.00").unwrap();

        let title = style_of(&doc, 1, 1);
        assert!(title.b);
        assert_eq!(title.size, 18);
        assert_eq!(title.font, "Georgia");
        assert_eq!(title.color.as_deref(), Some("#C00000"));
        assert_eq!(title.fill.as_deref(), Some("#FFF2CC"));
        assert_eq!(title.h.as_deref(), Some("center"));
        assert_eq!(doc.view(0).unwrap().rows[1][1].0, "$1,234.50");

        // Cambiar la fuente también se puede deshacer.
        doc.undo().unwrap(); // num_fmt
        doc.undo().unwrap(); // alineación
        doc.undo().unwrap(); // fuente
        assert_ne!(style_of(&doc, 1, 1).font, "Georgia");
        doc.redo().unwrap();
        assert_eq!(style_of(&doc, 1, 1).font, "Georgia");

        // Bordes alrededor de A1:B2 y en celdas vacías también.
        doc.set_border(0, rect(1, 1, 2, 2), "outer", "medium", "#000000").unwrap();
        let view = doc.view(0).unwrap();
        let a2 = &view.styles[view.rows[1][0].2 as usize];
        assert_eq!(a2.borders[3].as_ref().unwrap().style, "medium"); // izquierda
        assert!(a2.borders[0].is_none()); // arriba no: es borde interior

        doc.set_column_width(0, 1, 1, 200.0).unwrap();
        doc.set_row_height(0, 1, 1, 40.0).unwrap();
        let view = doc.view(0).unwrap();
        assert_eq!(view.col_widths, vec![(1, 200.0)]);
        assert_eq!(view.row_heights, vec![(1, 40.0)]);

        // Todo se conserva al guardar y reabrir.
        let path = std::env::temp_dir().join(format!("wepo-formato-{}.xlsx", std::process::id()));
        let path = path.to_str().unwrap();
        doc.save(path, 0).unwrap();
        let reopened = SheetDocument::open(path).unwrap();
        let title = style_of(&reopened, 1, 1);
        assert!(title.b && title.size == 18 && title.font == "Georgia");
        assert_eq!(title.fill.as_deref(), Some("#FFF2CC"));
        assert_eq!(reopened.view(0).unwrap().col_widths, vec![(1, 200.0)]);
        assert!(!reopened.view(0).unwrap().has_drawings);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn copiar_cortar_y_pegar() {
        let mut doc = SheetDocument::new_empty().unwrap();
        doc.set_cell(0, 1, 1, "5").unwrap();
        doc.set_cell(0, 1, 2, "=A1*2").unwrap();
        doc.set_style(0, rect(1, 1, 1, 2), "font.b", "true").unwrap();

        // Copiar dentro de WEPO conserva fórmulas (ajustando referencias) y formato.
        let text = doc.copy(0, rect(1, 1, 1, 2), false).unwrap();
        assert_eq!(text, "5\t10");
        doc.paste(0, 3, 1, &text).unwrap();
        doc.set_cell(0, 3, 1, "7").unwrap();
        assert_eq!(doc.cell_input(0, 3, 2).unwrap(), "=A3*2");
        assert_eq!(doc.view(0).unwrap().rows[2][1].0, "14");
        assert!(style_of(&doc, 3, 2).b);

        // Texto de otra aplicación (Excel, Numbers…) llega separado por tabuladores.
        doc.paste(0, 5, 1, "uno\tdos\n3\t4").unwrap();
        let view = doc.view(0).unwrap();
        assert_eq!(view.rows[4][1].0, "dos");
        assert_eq!(view.rows[5][1].0, "4");
        assert!(view.rows[5][1].1, "los números pegados siguen siendo números");

        // Cortar mueve el contenido y solo se pega una vez.
        let text = doc.copy(0, rect(5, 1, 5, 1), true).unwrap();
        doc.paste(0, 8, 4, &text).unwrap();
        assert_eq!(doc.cell_input(0, 8, 4).unwrap(), "uno");
        assert_eq!(doc.cell_input(0, 5, 1).unwrap(), "");
    }

    #[test]
    fn detecta_graficas_e_imagenes() {
        let dir = std::env::temp_dir();
        let with = dir.join(format!("wepo-con-grafica-{}.xlsx", std::process::id()));
        // Un ZIP mínimo cuyo índice menciona xl/charts/ basta para la detección.
        std::fs::write(&with, b"PK...xl/charts/chart1.xml...").unwrap();
        assert!(xlsx_has_drawings(with.to_str().unwrap()));
        std::fs::remove_file(&with).unwrap();
    }

    #[test]
    fn edita_guarda_y_reabre_xlsx() {
        let mut doc = SheetDocument::new_empty().unwrap();
        doc.set_cell(0, 1, 1, "Precio").unwrap();
        doc.set_cell(0, 2, 1, "40").unwrap();
        doc.set_cell(0, 3, 1, "=A2*2").unwrap();
        assert_eq!(doc.view(0).unwrap().rows[2][0].0, "80");

        // Deshacer quita la fórmula; rehacer la devuelve.
        doc.undo().unwrap();
        assert_eq!(doc.view(0).unwrap().rows[2][0].0, "");
        doc.redo().unwrap();

        let path = std::env::temp_dir().join(format!("wepo-prueba-{}.xlsx", std::process::id()));
        let path = path.to_str().unwrap();
        doc.save(path, 0).unwrap();
        doc.save(path, 0).unwrap(); // sobrescribir también funciona

        let reopened = SheetDocument::open(path).unwrap();
        assert_eq!(reopened.cell_input(0, 3, 1).unwrap(), "=A2*2");
        assert_eq!(reopened.view(0).unwrap().rows[2][0].0, "80");
        assert_eq!(reopened.sheet_names(), vec!["Hoja1"]);
        std::fs::remove_file(path).unwrap();
    }
}
