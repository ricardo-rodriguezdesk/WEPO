// Punto de entrada del núcleo en Rust de WEPO.
// Cada módulo atiende un tipo de documento; aquí solo se exponen sus
// funciones a la interfaz como comandos de Tauri.

mod sheet_format;
mod sheets;

use std::sync::Mutex;

use sheets::{Rect, SheetDocument, SheetView};
use tauri::State;

/// Hoja de cálculo abierta actualmente (WEPO abre un documento a la vez).
#[derive(Default)]
struct OpenSheet(Mutex<Option<SheetDocument>>);

/// Ejecuta `action` sobre el libro abierto y devuelve la hoja `sheet` actualizada.
fn with_sheet(
    state: &State<OpenSheet>,
    sheet: u32,
    action: impl FnOnce(&mut SheetDocument) -> Result<(), String>,
) -> Result<SheetView, String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    let doc = guard.as_mut().ok_or("No hay ninguna hoja de cálculo abierta")?;
    action(doc)?;
    doc.view(sheet)
}

#[tauri::command]
fn sheet_new(state: State<OpenSheet>) -> Result<SheetView, String> {
    let doc = SheetDocument::new_empty()?;
    let view = doc.view(0)?;
    *state.0.lock().map_err(|e| e.to_string())? = Some(doc);
    Ok(view)
}

#[tauri::command]
fn sheet_open(state: State<OpenSheet>, path: String) -> Result<SheetView, String> {
    let doc = SheetDocument::open(&path)?;
    let view = doc.view(0)?;
    *state.0.lock().map_err(|e| e.to_string())? = Some(doc);
    Ok(view)
}

#[tauri::command]
fn sheet_view(state: State<OpenSheet>, sheet: u32) -> Result<SheetView, String> {
    with_sheet(&state, sheet, |_| Ok(()))
}

/// Contenido "crudo" de una celda: la fórmula si la tiene, o el valor.
#[tauri::command]
fn sheet_cell_input(state: State<OpenSheet>, sheet: u32, row: i32, col: i32) -> Result<String, String> {
    let guard = state.0.lock().map_err(|e| e.to_string())?;
    let doc = guard.as_ref().ok_or("No hay ninguna hoja de cálculo abierta")?;
    doc.cell_input(sheet, row, col)
}

#[tauri::command]
fn sheet_set_cell(
    state: State<OpenSheet>,
    sheet: u32,
    row: i32,
    col: i32,
    input: String,
) -> Result<SheetView, String> {
    with_sheet(&state, sheet, |doc| doc.set_cell(sheet, row, col, &input))
}

#[tauri::command]
fn sheet_clear(
    state: State<OpenSheet>,
    sheet: u32,
    row1: i32,
    col1: i32,
    row2: i32,
    col2: i32,
) -> Result<SheetView, String> {
    let rect = Rect { row1, col1, row2, col2 };
    with_sheet(&state, sheet, |doc| doc.clear_range(sheet, rect))
}

/// Cambia una propiedad de formato (negrita, color, fuente…) en un rango.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn sheet_style(
    state: State<OpenSheet>,
    sheet: u32,
    row1: i32,
    col1: i32,
    row2: i32,
    col2: i32,
    path: String,
    value: String,
) -> Result<SheetView, String> {
    let rect = Rect { row1, col1, row2, col2 };
    with_sheet(&state, sheet, |doc| doc.set_style(sheet, rect, &path, &value))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn sheet_border(
    state: State<OpenSheet>,
    sheet: u32,
    row1: i32,
    col1: i32,
    row2: i32,
    col2: i32,
    kind: String,
    style: String,
    color: String,
) -> Result<SheetView, String> {
    let rect = Rect { row1, col1, row2, col2 };
    with_sheet(&state, sheet, |doc| doc.set_border(sheet, rect, &kind, &style, &color))
}

#[tauri::command]
fn sheet_column_width(state: State<OpenSheet>, sheet: u32, col1: i32, col2: i32, width: f64) -> Result<SheetView, String> {
    with_sheet(&state, sheet, |doc| doc.set_column_width(sheet, col1, col2, width))
}

#[tauri::command]
fn sheet_row_height(state: State<OpenSheet>, sheet: u32, row1: i32, row2: i32, height: f64) -> Result<SheetView, String> {
    with_sheet(&state, sheet, |doc| doc.set_row_height(sheet, row1, row2, height))
}

/// Copia o corta un rango y devuelve su texto para el portapapeles del sistema.
#[tauri::command]
fn sheet_copy(
    state: State<OpenSheet>,
    sheet: u32,
    row1: i32,
    col1: i32,
    row2: i32,
    col2: i32,
    cut: bool,
) -> Result<String, String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    let doc = guard.as_mut().ok_or("No hay ninguna hoja de cálculo abierta")?;
    doc.copy(sheet, Rect { row1, col1, row2, col2 }, cut)
}

#[tauri::command]
fn sheet_paste(state: State<OpenSheet>, sheet: u32, row: i32, col: i32, text: String) -> Result<SheetView, String> {
    with_sheet(&state, sheet, |doc| doc.paste(sheet, row, col, &text))
}

#[tauri::command]
fn sheet_undo(state: State<OpenSheet>, sheet: u32) -> Result<SheetView, String> {
    with_sheet(&state, sheet, |doc| doc.undo())
}

#[tauri::command]
fn sheet_redo(state: State<OpenSheet>, sheet: u32) -> Result<SheetView, String> {
    with_sheet(&state, sheet, |doc| doc.redo())
}

/// Agrega una hoja nueva y devuelve su vista.
#[tauri::command]
fn sheet_add(state: State<OpenSheet>) -> Result<SheetView, String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    let doc = guard.as_mut().ok_or("No hay ninguna hoja de cálculo abierta")?;
    let index = doc.add_sheet()?;
    doc.view(index)
}

/// Guarda en .xlsx (libro completo) o .csv (solo la hoja `sheet`).
#[tauri::command]
fn sheet_save(state: State<OpenSheet>, path: String, sheet: u32) -> Result<(), String> {
    let guard = state.0.lock().map_err(|e| e.to_string())?;
    let doc = guard.as_ref().ok_or("No hay ninguna hoja de cálculo abierta")?;
    doc.save(&path, sheet)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(OpenSheet::default())
        .invoke_handler(tauri::generate_handler![
            sheet_new,
            sheet_open,
            sheet_view,
            sheet_cell_input,
            sheet_set_cell,
            sheet_clear,
            sheet_style,
            sheet_border,
            sheet_column_width,
            sheet_row_height,
            sheet_copy,
            sheet_paste,
            sheet_undo,
            sheet_redo,
            sheet_add,
            sheet_save,
        ])
        .run(tauri::generate_context!())
        .expect("error al iniciar WEPO");
}
