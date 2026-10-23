// Punto de entrada del núcleo en Rust de WEPO.
// Cada módulo atiende un tipo de documento; aquí solo se exponen sus
// funciones a la interfaz como comandos de Tauri.

mod files;
mod mac;
mod recovery;
mod windows;
mod sheet_format;
mod sheets;
mod xlsx_extras;

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Serialize;
use sheets::drawings::{ChartType, DrawingPatch};
use sheets::{ColumnFilter, FindMatch, ListSource, PasteMode, Rect, SelectionStats, SheetDocument, SheetView, SortKey};
use tauri::{Manager, State};

/// Libros abiertos: uno por ventana (la clave es la etiqueta de la ventana).
#[derive(Default)]
pub struct OpenSheet(pub Mutex<HashMap<String, SheetDocument>>);

const NO_SHEET: &str = "No hay ninguna hoja de cálculo abierta en esta ventana";

/// Ejecuta `action` sobre el libro de la ventana y devuelve la hoja `sheet` actualizada.
fn with_sheet(
    state: &State<OpenSheet>,
    window: &tauri::Window,
    sheet: u32,
    action: impl FnOnce(&mut SheetDocument) -> Result<(), String>,
) -> Result<SheetView, String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    let doc = guard.get_mut(window.label()).ok_or(NO_SHEET)?;
    action(doc)?;
    doc.view(sheet)
}

#[tauri::command]
fn sheet_new(window: tauri::Window, state: State<OpenSheet>) -> Result<SheetView, String> {
    let doc = SheetDocument::new_empty()?;
    let view = doc.view(0)?;
    state.0.lock().map_err(|e| e.to_string())?.insert(window.label().to_string(), doc);
    Ok(view)
}

#[tauri::command]
fn sheet_open(window: tauri::Window, state: State<OpenSheet>, path: String) -> Result<SheetView, String> {
    let doc = SheetDocument::open(&path)?;
    let view = doc.view(0)?;
    state.0.lock().map_err(|e| e.to_string())?.insert(window.label().to_string(), doc);
    Ok(view)
}

#[tauri::command]
fn sheet_view(window: tauri::Window, state: State<OpenSheet>, sheet: u32) -> Result<SheetView, String> {
    with_sheet(&state, &window, sheet, |_| Ok(()))
}

/// Contenido "crudo" de una celda: la fórmula si la tiene, o el valor.
#[tauri::command]
fn sheet_cell_input(window: tauri::Window, state: State<OpenSheet>, sheet: u32, row: i32, col: i32) -> Result<String, String> {
    let guard = state.0.lock().map_err(|e| e.to_string())?;
    let doc = guard.get(window.label()).ok_or(NO_SHEET)?;
    doc.cell_input(sheet, row, col)
}

#[tauri::command]
fn sheet_set_cell(
    window: tauri::Window, state: State<OpenSheet>,
    sheet: u32,
    row: i32,
    col: i32,
    input: String,
) -> Result<SheetView, String> {
    with_sheet(&state, &window, sheet, |doc| doc.set_cell(sheet, row, col, &input))
}

#[tauri::command]
fn sheet_clear(
    window: tauri::Window, state: State<OpenSheet>,
    sheet: u32,
    row1: i32,
    col1: i32,
    row2: i32,
    col2: i32,
) -> Result<SheetView, String> {
    let rect = Rect { row1, col1, row2, col2 };
    with_sheet(&state, &window, sheet, |doc| doc.clear_range(sheet, rect))
}

/// Cambia una propiedad de formato (negrita, color, fuente…) en un rango.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn sheet_style(
    window: tauri::Window, state: State<OpenSheet>,
    sheet: u32,
    row1: i32,
    col1: i32,
    row2: i32,
    col2: i32,
    path: String,
    value: String,
) -> Result<SheetView, String> {
    let rect = Rect { row1, col1, row2, col2 };
    with_sheet(&state, &window, sheet, |doc| doc.set_style(sheet, rect, &path, &value))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn sheet_border(
    window: tauri::Window, state: State<OpenSheet>,
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
    with_sheet(&state, &window, sheet, |doc| doc.set_border(sheet, rect, &kind, &style, &color))
}

#[tauri::command]
fn sheet_column_width(window: tauri::Window, state: State<OpenSheet>, sheet: u32, col1: i32, col2: i32, width: f64) -> Result<SheetView, String> {
    with_sheet(&state, &window, sheet, |doc| doc.set_column_width(sheet, col1, col2, width))
}

#[tauri::command]
fn sheet_row_height(window: tauri::Window, state: State<OpenSheet>, sheet: u32, row1: i32, row2: i32, height: f64) -> Result<SheetView, String> {
    with_sheet(&state, &window, sheet, |doc| doc.set_row_height(sheet, row1, row2, height))
}

/// Copia o corta un rango y devuelve su texto para el portapapeles del sistema.
#[tauri::command]
fn sheet_copy(
    window: tauri::Window, state: State<OpenSheet>,
    sheet: u32,
    row1: i32,
    col1: i32,
    row2: i32,
    col2: i32,
    cut: bool,
) -> Result<String, String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    let doc = guard.get_mut(window.label()).ok_or(NO_SHEET)?;
    doc.copy(sheet, Rect { row1, col1, row2, col2 }, cut)
}

#[tauri::command]
fn sheet_paste(window: tauri::Window, state: State<OpenSheet>, sheet: u32, row: i32, col: i32, text: String) -> Result<SheetView, String> {
    with_sheet(&state, &window, sheet, |doc| doc.paste(sheet, row, col, &text))
}

// ───────────── filas, columnas y estructura ─────────────

#[tauri::command]
fn sheet_insert_rows(window: tauri::Window, state: State<OpenSheet>, sheet: u32, row: i32, count: i32) -> Result<SheetView, String> {
    with_sheet(&state, &window, sheet, |doc| doc.insert_rows(sheet, row, count))
}

#[tauri::command]
fn sheet_delete_rows(window: tauri::Window, state: State<OpenSheet>, sheet: u32, row: i32, count: i32) -> Result<SheetView, String> {
    with_sheet(&state, &window, sheet, |doc| doc.delete_rows(sheet, row, count))
}

#[tauri::command]
fn sheet_insert_columns(window: tauri::Window, state: State<OpenSheet>, sheet: u32, col: i32, count: i32) -> Result<SheetView, String> {
    with_sheet(&state, &window, sheet, |doc| doc.insert_columns(sheet, col, count))
}

#[tauri::command]
fn sheet_delete_columns(window: tauri::Window, state: State<OpenSheet>, sheet: u32, col: i32, count: i32) -> Result<SheetView, String> {
    with_sheet(&state, &window, sheet, |doc| doc.delete_columns(sheet, col, count))
}

#[tauri::command]
fn sheet_hide_rows(window: tauri::Window, state: State<OpenSheet>, sheet: u32, row1: i32, row2: i32, hidden: bool) -> Result<SheetView, String> {
    with_sheet(&state, &window, sheet, |doc| doc.set_rows_hidden(sheet, row1, row2, hidden))
}

#[tauri::command]
fn sheet_hide_columns(window: tauri::Window, state: State<OpenSheet>, sheet: u32, col1: i32, col2: i32, hidden: bool) -> Result<SheetView, String> {
    with_sheet(&state, &window, sheet, |doc| doc.set_columns_hidden(sheet, col1, col2, hidden))
}

#[tauri::command]
fn sheet_merge(window: tauri::Window, state: State<OpenSheet>, sheet: u32, row1: i32, col1: i32, row2: i32, col2: i32, merge: bool) -> Result<SheetView, String> {
    let rect = Rect { row1, col1, row2, col2 };
    with_sheet(&state, &window, sheet, |doc| if merge { doc.merge(sheet, rect) } else { doc.unmerge(sheet, rect) })
}

#[tauri::command]
fn sheet_freeze(window: tauri::Window, state: State<OpenSheet>, sheet: u32, rows: i32, cols: i32) -> Result<SheetView, String> {
    with_sheet(&state, &window, sheet, |doc| doc.freeze(sheet, rows, cols))
}

/// Autollenado: `source` y `target` son [fila1, columna1, fila2, columna2].
#[tauri::command]
fn sheet_autofill(window: tauri::Window, state: State<OpenSheet>, sheet: u32, source: [i32; 4], target: [i32; 4]) -> Result<SheetView, String> {
    let rect = |r: [i32; 4]| Rect { row1: r[0], col1: r[1], row2: r[2], col2: r[3] };
    with_sheet(&state, &window, sheet, |doc| doc.auto_fill(sheet, rect(source), rect(target)))
}

// ───────────── pestañas ─────────────

#[tauri::command]
fn sheet_rename(window: tauri::Window, state: State<OpenSheet>, sheet: u32, name: String) -> Result<SheetView, String> {
    with_sheet(&state, &window, sheet, |doc| doc.rename_sheet(sheet, &name))
}

/// Elimina una hoja y devuelve la que queda a su izquierda.
#[tauri::command]
fn sheet_delete(window: tauri::Window, state: State<OpenSheet>, sheet: u32) -> Result<SheetView, String> {
    with_sheet(&state, &window, sheet.saturating_sub(1), |doc| doc.delete_sheet(sheet))
}

#[tauri::command]
fn sheet_duplicate(window: tauri::Window, state: State<OpenSheet>, sheet: u32) -> Result<SheetView, String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    let doc = guard.get_mut(window.label()).ok_or(NO_SHEET)?;
    let copy = doc.duplicate_sheet(sheet)?;
    doc.view(copy)
}

#[tauri::command]
fn sheet_move(window: tauri::Window, state: State<OpenSheet>, sheet: u32, to: u32) -> Result<SheetView, String> {
    with_sheet(&state, &window, to, |doc| doc.move_sheet(sheet, to))
}

// ───────────── datos ─────────────

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn sheet_sort(
    window: tauri::Window, state: State<OpenSheet>,
    sheet: u32,
    row1: i32,
    col1: i32,
    row2: i32,
    col2: i32,
    keys: Vec<SortKey>,
    header: bool,
) -> Result<SheetView, String> {
    let rect = Rect { row1, col1, row2, col2 };
    with_sheet(&state, &window, sheet, |doc| doc.sort(sheet, rect, &keys, header))
}

/// Filtra las filas debajo del encabezado: solo quedan visibles las que pasan
/// todos los filtros (uno por columna). Sin filtros, se muestran todas.
#[tauri::command]
fn sheet_filter(
    window: tauri::Window, state: State<OpenSheet>,
    sheet: u32,
    row1: i32,
    col1: i32,
    row2: i32,
    col2: i32,
    filters: Vec<ColumnFilter>,
) -> Result<SheetView, String> {
    let rect = Rect { row1, col1, row2, col2 };
    with_sheet(&state, &window, sheet, |doc| {
        if filters.is_empty() {
            doc.clear_filter(sheet, rect)
        } else {
            doc.filter(sheet, rect, &filters)
        }
    })
}

// ───────────── tablas, página y duplicados ─────────────

/// "Dar formato como tabla" (`style`: azul, verde, naranja…). Devuelve la hoja y el nombre de la tabla.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn sheet_table_create(
    window: tauri::Window, state: State<OpenSheet>,
    sheet: u32,
    row1: i32,
    col1: i32,
    row2: i32,
    col2: i32,
    style: String,
    banded: bool,
    totals: bool,
) -> Result<SheetView, String> {
    let rect = Rect { row1, col1, row2, col2 };
    with_sheet(&state, &window, sheet, |doc| doc.create_table(sheet, rect, &style, banded, totals).map(|_| ()))
}

/// Cambia una tabla; con `remove`, la convierte en un rango normal.
#[tauri::command]
fn sheet_table_update(
    window: tauri::Window, state: State<OpenSheet>,
    sheet: u32,
    name: String,
    style: String,
    banded: bool,
    totals: bool,
    remove: bool,
) -> Result<SheetView, String> {
    with_sheet(&state, &window, sheet, |doc| {
        if remove {
            doc.delete_table(sheet, &name)
        } else {
            doc.update_table(sheet, &name, &style, banded, totals)
        }
    })
}

/// Encabezado, pie, filas que se repiten ("1:2") y área de impresión ("A1:F20") de la hoja.
#[tauri::command]
fn sheet_page_setup(
    window: tauri::Window, state: State<OpenSheet>,
    sheet: u32,
    header: String,
    footer: String,
    repeat_rows: String,
    print_area: String,
) -> Result<SheetView, String> {
    with_sheet(&state, &window, sheet, |doc| doc.set_page_setup(sheet, &header, &footer, &repeat_rows, &print_area))
}

#[derive(Serialize)]
struct Deduplicated {
    removed: usize,
    view: SheetView,
}

/// Quita filas repetidas según las columnas `cols` (desde 1).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn sheet_remove_duplicates(
    window: tauri::Window, state: State<OpenSheet>,
    sheet: u32,
    row1: i32,
    col1: i32,
    row2: i32,
    col2: i32,
    cols: Vec<i32>,
    header: bool,
) -> Result<Deduplicated, String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    let doc = guard.get_mut(window.label()).ok_or(NO_SHEET)?;
    let removed = doc.remove_duplicates(sheet, Rect { row1, col1, row2, col2 }, &cols, header)?;
    Ok(Deduplicated { removed, view: doc.view(sheet)? })
}

// ───────────── notas, vínculos y pegado especial ─────────────

/// Escribe la nota de una celda; con texto vacío, la borra.
#[tauri::command]
fn sheet_note(window: tauri::Window, state: State<OpenSheet>, sheet: u32, row: i32, col: i32, text: String) -> Result<SheetView, String> {
    with_sheet(&state, &window, sheet, |doc| doc.set_note(sheet, row, col, &text))
}

/// Pone un vínculo en la celda (sin `target`, lo quita).
#[tauri::command]
fn sheet_link(
    window: tauri::Window, state: State<OpenSheet>,
    sheet: u32,
    row: i32,
    col: i32,
    target: Option<String>,
    label: Option<String>,
) -> Result<SheetView, String> {
    with_sheet(&state, &window, sheet, |doc| match &target {
        Some(target) => doc.set_link(sheet, row, col, target, label.as_deref()),
        None => doc.delete_link(sheet, row, col),
    })
}

/// Suma, promedio y recuento de la selección (para la barra de estado).
#[tauri::command]
fn sheet_stats(window: tauri::Window, state: State<OpenSheet>, sheet: u32, row1: i32, col1: i32, row2: i32, col2: i32) -> Result<SelectionStats, String> {
    let guard = state.0.lock().map_err(|e| e.to_string())?;
    let doc = guard.get(window.label()).ok_or(NO_SHEET)?;
    doc.stats(sheet, Rect { row1, col1, row2, col2 })
}

#[tauri::command]
fn sheet_paste_special(window: tauri::Window, state: State<OpenSheet>, sheet: u32, row: i32, col: i32, mode: PasteMode) -> Result<SheetView, String> {
    with_sheet(&state, &window, sheet, |doc| doc.paste_special(sheet, row, col, mode))
}

/// Copiar formato (la brocha): el formato de `source` pasa a `target`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn sheet_paste_format(
    window: tauri::Window, state: State<OpenSheet>,
    sheet: u32,
    row1: i32,
    col1: i32,
    row2: i32,
    col2: i32,
    to_row1: i32,
    to_col1: i32,
    to_row2: i32,
    to_col2: i32,
) -> Result<SheetView, String> {
    let source = Rect { row1, col1, row2, col2 };
    let target = Rect { row1: to_row1, col1: to_col1, row2: to_row2, col2: to_col2 };
    with_sheet(&state, &window, sheet, |doc| doc.paste_styles_from(sheet, source, target))
}

/// `case`: distinguir mayúsculas; `whole`: celda completa; `all`: todas las hojas.
#[tauri::command]
fn sheet_find(
    window: tauri::Window, state: State<OpenSheet>,
    sheet: u32,
    query: String,
    case: bool,
    whole: bool,
    all: bool,
) -> Result<Vec<FindMatch>, String> {
    let guard = state.0.lock().map_err(|e| e.to_string())?;
    let doc = guard.get(window.label()).ok_or(NO_SHEET)?;
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
    window: tauri::Window, state: State<OpenSheet>,
    sheet: u32,
    query: String,
    replacement: String,
    case: bool,
    whole: bool,
    all: bool,
) -> Result<ReplaceResult, String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    let doc = guard.get_mut(window.label()).ok_or(NO_SHEET)?;
    let count = doc.replace_all(sheet, &query, &replacement, case, whole, all)?;
    Ok(ReplaceResult { count, view: doc.view(sheet)? })
}

// ───────────── formato condicional y listas ─────────────

#[tauri::command]
fn sheet_cf_list(window: tauri::Window, state: State<OpenSheet>, sheet: u32) -> Result<Vec<serde_json::Value>, String> {
    let guard = state.0.lock().map_err(|e| e.to_string())?;
    let doc = guard.get(window.label()).ok_or(NO_SHEET)?;
    doc.conditional_formats(sheet)
}

/// Agrega una regla de formato condicional (`rule` en el formato de IronCalc).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn sheet_cf_add(
    window: tauri::Window, state: State<OpenSheet>,
    sheet: u32,
    row1: i32,
    col1: i32,
    row2: i32,
    col2: i32,
    rule: serde_json::Value,
) -> Result<SheetView, String> {
    let rect = Rect { row1, col1, row2, col2 };
    with_sheet(&state, &window, sheet, |doc| doc.add_conditional_format(sheet, rect, rule))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn sheet_cf_icons(
    window: tauri::Window, state: State<OpenSheet>,
    sheet: u32,
    row1: i32,
    col1: i32,
    row2: i32,
    col2: i32,
    preset: String,
) -> Result<SheetView, String> {
    let rect = Rect { row1, col1, row2, col2 };
    with_sheet(&state, &window, sheet, |doc| doc.add_icon_set(sheet, rect, &preset))
}

#[tauri::command]
fn sheet_cf_delete(window: tauri::Window, state: State<OpenSheet>, sheet: u32, index: u32) -> Result<SheetView, String> {
    with_sheet(&state, &window, sheet, |doc| doc.delete_conditional_format(sheet, index))
}

/// Pone (o quita, con `source` vacío) una lista desplegable en un rango.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn sheet_validation(
    window: tauri::Window, state: State<OpenSheet>,
    sheet: u32,
    row1: i32,
    col1: i32,
    row2: i32,
    col2: i32,
    source: Option<ListSource>,
    message: Option<String>,
) -> Result<SheetView, String> {
    let rect = Rect { row1, col1, row2, col2 };
    with_sheet(&state, &window, sheet, |doc| doc.set_validation(sheet, rect, source, message))
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
    window: tauri::Window, state: State<OpenSheet>,
    sheet: u32,
    row1: i32,
    col1: i32,
    row2: i32,
    col2: i32,
    kind: ChartType,
) -> Result<Inserted, String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    let doc = guard.get_mut(window.label()).ok_or(NO_SHEET)?;
    let id = doc.add_chart(sheet, Rect { row1, col1, row2, col2 }, kind)?;
    Ok(Inserted { id, view: doc.view(sheet)? })
}

#[tauri::command]
fn sheet_image_add(window: tauri::Window, state: State<OpenSheet>, sheet: u32, path: String, x: f64, y: f64) -> Result<Inserted, String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    let doc = guard.get_mut(window.label()).ok_or(NO_SHEET)?;
    let id = doc.add_image(sheet, &path, x, y)?;
    Ok(Inserted { id, view: doc.view(sheet)? })
}

/// Mueve, redimensiona o cambia una gráfica (tipo, título, leyenda, datos).
#[tauri::command]
fn sheet_drawing_update(window: tauri::Window, state: State<OpenSheet>, sheet: u32, id: u32, patch: DrawingPatch) -> Result<SheetView, String> {
    with_sheet(&state, &window, sheet, |doc| doc.update_drawing(sheet, id, patch))
}

#[tauri::command]
fn sheet_drawing_delete(window: tauri::Window, state: State<OpenSheet>, sheet: u32, id: u32) -> Result<SheetView, String> {
    with_sheet(&state, &window, sheet, |doc| doc.delete_drawing(id))
}

/// Una imagen como data URL, para mostrarla.
#[tauri::command]
fn sheet_image_data(window: tauri::Window, state: State<OpenSheet>, id: u32) -> Result<String, String> {
    let guard = state.0.lock().map_err(|e| e.to_string())?;
    let doc = guard.get(window.label()).ok_or(NO_SHEET)?;
    doc.image_data(id)
}

// ───────────── fórmulas ─────────────

/// Cambia el idioma de las funciones: "es" (SUMA, BUSCARV…) o "en" (SUM, VLOOKUP…).
#[tauri::command]
fn sheet_language(window: tauri::Window, state: State<OpenSheet>, sheet: u32, language: String) -> Result<SheetView, String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    let doc = guard.get_mut(window.label()).ok_or(NO_SHEET)?;
    doc.set_language(&language)?;
    doc.view(sheet)
}

/// Qué espera la fórmula en la posición del cursor (para el autocompletado).
#[tauri::command]
fn sheet_complete(
    window: tauri::Window, state: State<OpenSheet>,
    sheet: u32,
    row: i32,
    col: i32,
    formula: String,
    cursor: usize,
) -> Result<serde_json::Value, String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    let doc = guard.get_mut(window.label()).ok_or(NO_SHEET)?;
    let context = doc.complete(sheet, row, col, &formula, cursor)?;
    serde_json::to_value(context).map_err(|e| e.to_string())
}

#[tauri::command]
fn sheet_undo(window: tauri::Window, state: State<OpenSheet>, sheet: u32) -> Result<SheetView, String> {
    with_sheet(&state, &window, sheet, |doc| doc.undo())
}

#[tauri::command]
fn sheet_redo(window: tauri::Window, state: State<OpenSheet>, sheet: u32) -> Result<SheetView, String> {
    with_sheet(&state, &window, sheet, |doc| doc.redo())
}

/// Agrega una hoja nueva y devuelve su vista.
#[tauri::command]
fn sheet_add(window: tauri::Window, state: State<OpenSheet>) -> Result<SheetView, String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    let doc = guard.get_mut(window.label()).ok_or(NO_SHEET)?;
    let index = doc.add_sheet()?;
    doc.view(index)
}

/// Guarda en .xlsx (libro completo) o .csv (solo la hoja `sheet`).
#[tauri::command]
fn sheet_save(window: tauri::Window, state: State<OpenSheet>, path: String, sheet: u32) -> Result<(), String> {
    let guard = state.0.lock().map_err(|e| e.to_string())?;
    let doc = guard.get(window.label()).ok_or(NO_SHEET)?;
    doc.save(&path, sheet)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(OpenSheet::default())
        .manage(mac::OpenedFiles::default())
        .menu(|app| mac::menu(app))
        .on_menu_event(|app, event| mac::on_menu(app, event.id().as_ref()))
        // Al cerrar una ventana, su libro deja de ocupar memoria.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(state) = window.try_state::<OpenSheet>() {
                    if let Ok(mut docs) = state.0.lock() {
                        docs.remove(window.label());
                    }
                }
            }
        })
        .setup(|app| {
            // En Windows y Linux, "Abrir con…" pasa los archivos como argumentos.
            let args: Vec<String> = std::env::args()
                .skip(1)
                .filter(|a| !a.starts_with('-') && std::path::Path::new(a).is_file())
                .collect();
            mac::on_opened(app.handle(), args);
            Ok(())
        })
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
            mac::take_opened_files,
            mac::print_window,
            windows::quit_app,
            files::file_read,
            files::file_write,
            windows::open_window,
            sheet_note,
            sheet_table_create,
            sheet_table_update,
            sheet_page_setup,
            sheet_remove_duplicates,
            sheet_link,
            sheet_stats,
            sheet_paste_special,
            sheet_paste_format,
            recovery::recovery_save,
            recovery::recovery_save_file,
            recovery::recovery_info,
            recovery::recovery_clear,
            recovery::recovery_discard,
            recovery::recovery_take,
        ])
        .build(tauri::generate_context!())
        .expect("error al iniciar WEPO")
        .run(|_app, _event| {
            // macOS: doble clic en Finder, "Abrir con…" o arrastrar al ícono del Dock.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = _event {
                let paths = urls
                    .iter()
                    .filter_map(|url| url.to_file_path().ok())
                    .map(|path| path.to_string_lossy().into_owned())
                    .collect();
                mac::on_opened(_app, paths);
            }
        });
}
