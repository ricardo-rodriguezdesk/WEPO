//! Núcleo de WEPO Sheets.
//!
//! El libro abierto vive aquí, en Rust, dentro de un modelo de IronCalc:
//! él guarda los valores y las fórmulas, recalcula, deshace/rehace y
//! exporta a .xlsx. La interfaz solo pide "fotos" de la hoja visible y
//! manda los cambios que hace el usuario.

use std::fs;
use std::io::BufWriter;
use std::path::Path;

use calamine::{open_workbook_auto, Data, Reader};
use ironcalc::base::types::CellType;
use ironcalc::base::{Model, UserModel};
use ironcalc::export::save_xlsx_to_writer;
use ironcalc::import::load_from_xlsx;
use serde::Serialize;

const LOCALE: &str = "en";
const TIMEZONE: &str = "UTC";
const LANGUAGE: &str = "en";

/// Libro abierto en el editor.
pub struct SheetDocument {
    model: UserModel<'static>,
}

/// Una celda tal como la ve la interfaz: texto ya formateado y si es número
/// (los números se alinean a la derecha).
#[derive(Serialize, Debug, PartialEq)]
pub struct CellView(pub String, pub bool);

/// "Foto" de una hoja: su contenido visible y los nombres de todas las hojas.
#[derive(Serialize, Debug)]
pub struct SheetView {
    pub sheet_names: Vec<String>,
    pub sheet: u32,
    /// Filas desde la 1. Cada fila llega hasta su última celda con contenido.
    pub rows: Vec<Vec<CellView>>,
}

fn extension(path: &str) -> String {
    Path::new(path)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default()
}

impl SheetDocument {
    /// Libro vacío con una hoja.
    pub fn new_empty() -> Result<Self, String> {
        let mut model = UserModel::new_empty("Libro", LOCALE, TIMEZONE, LANGUAGE)?;
        model.rename_sheet(0, "Hoja1")?;
        Ok(Self { model })
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
                Ok(Self { model: UserModel::from_model(model) })
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
        Ok(Self { model: UserModel::from_model(model) })
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
        Ok(Self { model: UserModel::from_model(model) })
    }

    /// Foto de una hoja para dibujarla en la interfaz.
    pub fn view(&self, sheet: u32) -> Result<SheetView, String> {
        let model = self.model.get_model();
        let worksheet = model.workbook.worksheet(sheet)?;

        let mut rows: Vec<Vec<CellView>> = Vec::new();
        // Recorremos solo las celdas que existen, no todo el rectángulo.
        let mut row_numbers = worksheet.sheet_data.rows();
        row_numbers.sort_unstable();
        for row in row_numbers {
            let mut cols = worksheet.sheet_data.columns_in_row(row);
            cols.sort_unstable();
            let Some(&last_col) = cols.last() else { continue };

            let mut cells: Vec<CellView> = (0..last_col).map(|_| CellView(String::new(), false)).collect();
            for col in cols {
                let text = model.get_formatted_cell_value(sheet, row, col)?;
                let numeric = !text.is_empty()
                    && matches!(model.get_cell_type(sheet, row, col)?, CellType::Number);
                cells[(col - 1) as usize] = CellView(text, numeric);
            }
            let index = (row - 1) as usize;
            if rows.len() <= index {
                rows.resize_with(index + 1, Vec::new);
            }
            rows[index] = cells;
        }

        Ok(SheetView {
            sheet_names: self.sheet_names(),
            sheet,
            rows,
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
            return self.clear_range(sheet, row, col, row, col);
        }
        self.model.set_user_input(sheet, row, col, input)
    }

    pub fn clear_range(
        &mut self,
        sheet: u32,
        row1: i32,
        col1: i32,
        row2: i32,
        col2: i32,
    ) -> Result<(), String> {
        let area = ironcalc::base::expressions::types::Area {
            sheet,
            row: row1.min(row2),
            column: col1.min(col2),
            width: (col2 - col1).abs() + 1,
            height: (row2 - row1).abs() + 1,
        };
        self.model.range_clear_contents(&area)
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

    #[test]
    fn edita_guarda_y_reabre_xlsx() {
        let mut doc = SheetDocument::new_empty().unwrap();
        doc.set_cell(0, 1, 1, "Precio").unwrap();
        doc.set_cell(0, 2, 1, "40").unwrap();
        doc.set_cell(0, 3, 1, "=A2*2").unwrap();
        assert_eq!(doc.view(0).unwrap().rows[2][0], CellView("80".into(), true));

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
