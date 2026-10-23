// Punto de entrada del núcleo en Rust de WEPO.
// Cada módulo atiende un tipo de documento; aquí solo se exponen sus
// funciones a la interfaz como comandos de Tauri.

mod sheet_format;
mod sheets;
mod xlsx_extras;

use std::sync::Mutex;

use serde::Serialize;
use sheets::drawings::{ChartType, DrawingPatch};
use sheets::{FindMatch, ListSource, Rect, SheetDocument, SheetView, SortKey};
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

// ───────────── filas, columnas y estructura ─────────────

#[tauri::command]
fn sheet_insert_rows(state: State<OpenSheet>, sheet: u32, row: i32, count: i32) -> Result<SheetView, String> {
    with_sheet(&state, sheet, |doc| doc.insert_rows(sheet, row, count))
}

#[tauri::command]
fn sheet_delete_rows(state: State<OpenSheet>, sheet: u32, row: i32, count: i32) -> Result<SheetView, String> {
    with_sheet(&state, sheet, |doc| doc.delete_rows(sheet, row, count))
}

#[tauri::command]
fn sheet_insert_columns(state: State<OpenSheet>, sheet: u32, col: i32, count: i32) -> Result<SheetView, String> {
    with_sheet(&state, sheet, |doc| doc.insert_columns(sheet, col, count))
}

#[tauri::command]
fn sheet_delete_columns(state: State<OpenSheet>, sheet: u32, col: i32, count: i32) -> Result<SheetView, String> {
    with_sheet(&state, sheet, |doc| doc.delete_columns(sheet, col, count))
}

#[tauri::command]
fn sheet_hide_rows(state: State<OpenSheet>, sheet: u32, row1: i32, row2: i32, hidden: bool) -> Result<SheetView, String> {
    with_sheet(&state, sheet, |doc| doc.set_rows_hidden(sheet, row1, row2, hidden))
}

#[tauri::command]
fn sheet_hide_columns(state: State<OpenSheet>, sheet: u32, col1: i32, col2: i32, hidden: bool) -> Result<SheetView, String> {
    with_sheet(&state, sheet, |doc| doc.set_columns_hidden(sheet, col1, col2, hidden))
}

#[tauri::command]
fn sheet_merge(state: State<OpenSheet>, sheet: u32, row1: i32, col1: i32, row2: i32, col2: i32, merge: bool) -> Result<SheetView, String> {
    let rect = Rect { row1, col1, row2, col2 };
    with_sheet(&state, sheet, |doc| if merge { doc.merge(sheet, rect) } else { doc.unmerge(sheet, rect) })
}

#[tauri::command]
fn sheet_freeze(state: State<OpenSheet>, sheet: u32, rows: i32, cols: i32) -> Result<SheetView, String> {
    with_sheet(&state, sheet, |doc| doc.freeze(sheet, rows, cols))
}

/// Autollenado: `source` y `target` son [fila1, columna1, fila2, columna2].
#[tauri::command]
fn sheet_autofill(state: State<OpenSheet>, sheet: u32, source: [i32; 4], target: [i32; 4]) -> Result<SheetView, String> {
    let rect = |r: [i32; 4]| Rect { row1: r[0], col1: r[1], row2: r[2], col2: r[3] };
    with_sheet(&state, sheet, |doc| doc.auto_fill(sheet, rect(source), rect(target)))
}

// ───────────── pestañas ─────────────

#[tauri::command]
fn sheet_rename(state: State<OpenSheet>, sheet: u32, name: String) -> Result<SheetView, String> {
    with_sheet(&state, sheet, |doc| doc.rename_sheet(sheet, &name))
}

/// Elimina una hoja y devuelve la que queda a su izquierda.
#[tauri::command]
fn sheet_delete(state: State<OpenSheet>, sheet: u32) -> Result<SheetView, String> {
    with_sheet(&state, sheet.saturating_sub(1), |doc| doc.delete_sheet(sheet))
}

#[tauri::command]
fn sheet_duplicate(state: State<OpenSheet>, sheet: u32) -> Result<SheetView, String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    let doc = guard.as_mut().ok_or("No hay ninguna hoja de cálculo abierta")?;
    let copy = doc.duplicate_sheet(sheet)?;
    doc.view(copy)
}

#[tauri::command]
fn sheet_move(state: State<OpenSheet>, sheet: u32, to: u32) -> Result<SheetView, String> {
    with_sheet(&state, to, |doc| doc.move_sheet(sheet, to))
}

// ───────────── datos ─────────────

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn sheet_sort(
    state: State<OpenSheet>,
    sheet: u32,
    row1: i32,
    col1: i32,
    row2: i32,
    col2: i32,
    keys: Vec<SortKey>,
    header: bool,
) -> Result<SheetView, String> {
    let rect = Rect { row1, col1, row2, col2 };
    with_sheet(&state, sheet, |doc| doc.sort(sheet, rect, &keys, header))
}

/// Filtra las filas debajo del encabezado: solo quedan visibles las que en
/// `col` tienen alguno de los valores de `keep`. Sin `keep`, quita el filtro.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn sheet_filter(
    state: State<OpenSheet>,
    sheet: u32,
    row1: i32,
    col1: i32,
    row2: i32,
    col2: i32,
    col: i32,
    keep: Option<Vec<String>>,
) -> Result<SheetView, String> {
    let rect = Rect { row1, col1, row2, col2 };
    with_sheet(&state, sheet, |doc| match &keep {
        Some(keep) => doc.filter(sheet, rect, col, keep),
        None => doc.clear_filter(sheet, rect),
    })
}

/// `case`: distinguir mayúsculas; `whole`: celda completa; `all`: todas las hojas.
#[tauri::command]
fn sheet_find(
    state: State<OpenSheet>,
    sheet: u32,
    query: String,
    case: bool,
    whole: bool,
    all: bool,
) -> Result<Vec<FindMatch>, String> {
    let guard = state.0.lock().map_err(|e| e.to_string())?;
    let doc = guard.as_ref().ok_or("No hay ninguna hoja de cálculo abierta")?;
    doc.find(sheet, &query, case, whole, all)
}

#[derive(Serialize)]
struct ReplaceResult {
    count: usize,
    view: SheetView,
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn sheet_replace(
    state: State<OpenSheet>,
    sheet: u32,
    query: String,
    replacement: String,
    case: bool,
    whole: bool,
    all: bool,
) -> Result<ReplaceResult, String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    let doc = guard.as_mut().ok_or("No hay ninguna hoja de cálculo abierta")?;
    let count = doc.replace_all(sheet, &query, &replacement, case, whole, all)?;
    Ok(ReplaceResult { count, view: doc.view(sheet)? })
}

// ───────────── formato condicional y listas ─────────────

#[tauri::command]
fn sheet_cf_list(state: State<OpenSheet>, sheet: u32) -> Result<Vec<serde_json::Value>, String> {
    let guard = state.0.lock().map_err(|e| e.to_string())?;
    let doc = guard.as_ref().ok_or("No hay ninguna hoja de cálculo abierta")?;
    doc.conditional_formats(sheet)
}

/// Agrega una regla de formato condicional (`rule` en el formato de IronCalc).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn sheet_cf_add(
    state: State<OpenSheet>,
    sheet: u32,
    row1: i32,
    col1: i32,
    row2: i32,
    col2: i32,
    rule: serde_json::Value,
) -> Result<SheetView, String> {
    let rect = Rect { row1, col1, row2, col2 };
    with_sheet(&state, sheet, |doc| doc.add_conditional_format(sheet, rect, rule))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn sheet_cf_icons(
    state: State<OpenSheet>,
    sheet: u32,
    row1: i32,
    col1: i32,
    row2: i32,
    col2: i32,
    preset: String,
) -> Result<SheetView, String> {
    let rect = Rect { row1, col1, row2, col2 };
    with_sheet(&state, sheet, |doc| doc.add_icon_set(sheet, rect, &preset))
}

#[tauri::command]
fn sheet_cf_delete(state: State<OpenSheet>, sheet: u32, index: u32) -> Result<SheetView, String> {
    with_sheet(&state, sheet, |doc| doc.delete_conditional_format(sheet, index))
}

/// Pone (o quita, con `source` vacío) una lista desplegable en un rango.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn sheet_validation(
    state: State<OpenSheet>,
    sheet: u32,
    row1: i32,
    col1: i32,
    row2: i32,
    col2: i32,
    source: Option<ListSource>,
) -> Result<SheetView, String> {
    let rect = Rect { row1, col1, row2, col2 };
    with_sheet(&state, sheet, |doc| doc.set_validation(sheet, rect, source))
}

// ───────────── gráficas e imágenes ─────────────

/// Inserta una gráfica con los datos del rango y devuelve la hoja con el id de la gráfica.
#[derive(Serialize)]
struct Inserted {
    id: u32,
    view: SheetView,
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn sheet_chart_add(
    state: State<OpenSheet>,
    sheet: u32,
    row1: i32,
    col1: i32,
    row2: i32,
    col2: i32,
    kind: ChartType,
) -> Result<Inserted, String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    let doc = guard.as_mut().ok_or("No hay ninguna hoja de cálculo abierta")?;
    let id = doc.add_chart(sheet, Rect { row1, col1, row2, col2 }, kind)?;
    Ok(Inserted { id, view: doc.view(sheet)? })
}

#[tauri::command]
fn sheet_image_add(state: State<OpenSheet>, sheet: u32, path: String, x: f64, y: f64) -> Result<Inserted, String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    let doc = guard.as_mut().ok_or("No hay ninguna hoja de cálculo abierta")?;
    let id = doc.add_image(sheet, &path, x, y)?;
    Ok(Inserted { id, view: doc.view(sheet)? })
}

/// Mueve, redimensiona o cambia una gráfica (tipo, título, leyenda, datos).
#[tauri::command]
fn sheet_drawing_update(state: State<OpenSheet>, sheet: u32, id: u32, patch: DrawingPatch) -> Result<SheetView, String> {
    with_sheet(&state, sheet, |doc| doc.update_drawing(sheet, id, patch))
}

#[tauri::command]
fn sheet_drawing_delete(state: State<OpenSheet>, sheet: u32, id: u32) -> Result<SheetView, String> {
    with_sheet(&state, sheet, |doc| doc.delete_drawing(id))
}

/// Una imagen como data URL, para mostrarla.
#[tauri::command]
fn sheet_image_data(state: State<OpenSheet>, id: u32) -> Result<String, String> {
    let guard = state.0.lock().map_err(|e| e.to_string())?;
    let doc = guard.as_ref().ok_or("No hay ninguna hoja de cálculo abierta")?;
    doc.image_data(id)
}

// ───────────── fórmulas ─────────────

/// Cambia el idioma de las funciones: "es" (SUMA, BUSCARV…) o "en" (SUM, VLOOKUP…).
#[tauri::command]
fn sheet_language(state: State<OpenSheet>, sheet: u32, language: String) -> Result<SheetView, String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    let doc = guard.as_mut().ok_or("No hay ninguna hoja de cálculo abierta")?;
    doc.set_language(&language)?;
    doc.view(sheet)
}

/// Qué espera la fórmula en la posición del cursor (para el autocompletado).
#[tauri::command]
fn sheet_complete(
    state: State<OpenSheet>,
    sheet: u32,
    row: i32,
    col: i32,
    formula: String,
    cursor: usize,
) -> Result<serde_json::Value, String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    let doc = guard.as_mut().ok_or("No hay ninguna hoja de cálculo abierta")?;
    let context = doc.complete(sheet, row, col, &formula, cursor)?;
    serde_json::to_value(context).map_err(|e| e.to_string())
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
            sheet_insert_rows,
            sheet_delete_rows,
            sheet_insert_columns,
            sheet_delete_columns,
            sheet_hide_rows,
            sheet_hide_columns,
            sheet_merge,
            sheet_freeze,
            sheet_autofill,
            sheet_rename,
            sheet_delete,
            sheet_duplicate,
            sheet_move,
            sheet_sort,
            sheet_filter,
            sheet_find,
            sheet_replace,
            sheet_cf_list,
            sheet_cf_add,
            sheet_cf_icons,
            sheet_cf_delete,
            sheet_validation,
            sheet_chart_add,
            sheet_image_add,
            sheet_drawing_update,
            sheet_drawing_delete,
            sheet_image_data,
            sheet_language,
            sheet_complete,
            sheet_undo,
            sheet_redo,
            sheet_add,
            sheet_save,
        ])
        .run(tauri::generate_context!())
        .expect("error al iniciar WEPO");
}
