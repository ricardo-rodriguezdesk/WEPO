// Núcleo en Rust: lectura de hojas de cálculo.
// Soporta .csv (crate `csv`) y .xlsx / .xlsm / .xlsb / .xls / .ods (crate `calamine`).

use calamine::{open_workbook_auto, Reader};
use serde::Serialize;
use std::path::Path;

#[derive(Serialize)]
pub struct Sheet {
    name: String,
    rows: Vec<Vec<String>>,
}

#[derive(Serialize)]
pub struct Workbook {
    sheets: Vec<Sheet>,
}

fn read_csv(path: &str) -> Result<Workbook, String> {
    let mut reader = csv::ReaderBuilder::new()
        .has_headers(false) // la primera fila es una fila más, como en Excel
        .flexible(true) // permite filas con distinto número de columnas
        .from_path(path)
        .map_err(|e| e.to_string())?;

    let rows = reader
        .records()
        .map(|rec| rec.map(|r| r.iter().map(String::from).collect()))
        .collect::<Result<Vec<Vec<String>>, _>>()
        .map_err(|e| e.to_string())?;

    let name = Path::new(path)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Hoja1".into());

    Ok(Workbook { sheets: vec![Sheet { name, rows }] })
}

fn read_spreadsheet(path: &str) -> Result<Workbook, String> {
    let mut wb = open_workbook_auto(path).map_err(|e| e.to_string())?;
    let mut sheets = Vec::new();

    for name in wb.sheet_names().to_owned() {
        let range = wb.worksheet_range(&name).map_err(|e| e.to_string())?;

        // Si los datos empiezan en, por ejemplo, C5, rellenamos con celdas
        // vacías para que cada valor quede en su posición real.
        let (row0, col0) = range.start().unwrap_or((0, 0));
        let mut rows: Vec<Vec<String>> = vec![Vec::new(); row0 as usize];

        for r in range.rows() {
            let mut row = vec![String::new(); col0 as usize];
            row.extend(r.iter().map(|cell| cell.to_string()));
            rows.push(row);
        }

        sheets.push(Sheet { name, rows });
    }

    Ok(Workbook { sheets })
}

/// Abre cualquier hoja de cálculo soportada y la devuelve como texto por celda.
#[tauri::command]
fn open_spreadsheet(path: String) -> Result<Workbook, String> {
    if path.to_lowercase().ends_with(".csv") {
        read_csv(&path)
    } else {
        read_spreadsheet(&path)
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![open_spreadsheet])
        .run(tauri::generate_context!())
        .expect("error al iniciar la aplicación");
}
