//! Integración con macOS: barra de menús en español, archivos abiertos desde
//! Finder (doble clic o "Abrir con…") e impresión.

use std::sync::Mutex;

use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, Runtime, State, WebviewWindow};

/// Archivos que macOS pidió abrir antes de que la interfaz estuviera lista.
#[derive(Default)]
pub struct OpenedFiles(pub Mutex<Vec<String>>);

/// Barra de menús de WEPO. Las opciones propias avisan a la interfaz con el
/// evento "menu" y su id; las de edición son las nativas de macOS.
pub fn menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let item = |id: &str, text: &str, accelerator: Option<&str>| {
        let builder = MenuItemBuilder::with_id(id, text);
        match accelerator {
            Some(a) => builder.accelerator(a).build(app),
            None => builder.build(app),
        }
    };

    let app_menu = SubmenuBuilder::new(app, "WEPO")
        .item(&PredefinedMenuItem::about(app, Some("Acerca de WEPO"), None)?)
        .separator()
        .item(&PredefinedMenuItem::hide(app, Some("Ocultar WEPO"))?)
        .item(&PredefinedMenuItem::hide_others(app, Some("Ocultar otros"))?)
        .item(&PredefinedMenuItem::show_all(app, Some("Mostrar todo"))?)
        .separator()
        // Salir propio (no el nativo) para avisar si hay cambios sin guardar.
        .item(&item("quit", "Salir de WEPO", Some("CmdOrCtrl+Q"))?)
        .build()?;

    let file = SubmenuBuilder::new(app, "Archivo")
        .item(&item("new-sheet", "Nueva hoja de cálculo", Some("CmdOrCtrl+N"))?)
        .item(&item("open", "Abrir…", Some("CmdOrCtrl+O"))?)
        .separator()
        .item(&item("save", "Guardar", Some("CmdOrCtrl+S"))?)
        .item(&item("save-as", "Guardar como…", Some("CmdOrCtrl+Shift+S"))?)
        .separator()
        .item(&item("print", "Imprimir o exportar a PDF…", Some("CmdOrCtrl+P"))?)
        .separator()
        .item(&item("home", "Ir al inicio", None)?)
        .item(&PredefinedMenuItem::close_window(app, Some("Cerrar ventana"))?)
        .build()?;

    let edit = SubmenuBuilder::new(app, "Edición")
        .item(&PredefinedMenuItem::undo(app, Some("Deshacer"))?)
        .item(&PredefinedMenuItem::redo(app, Some("Rehacer"))?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, Some("Cortar"))?)
        .item(&PredefinedMenuItem::copy(app, Some("Copiar"))?)
        .item(&PredefinedMenuItem::paste(app, Some("Pegar"))?)
        .item(&PredefinedMenuItem::select_all(app, Some("Seleccionar todo"))?)
        .separator()
        .item(&item("find", "Buscar y reemplazar…", Some("CmdOrCtrl+F"))?)
        .build()?;

    let view = SubmenuBuilder::new(app, "Visualización")
        .item(&item("zoom-in", "Acercar", Some("CmdOrCtrl+="))?)
        .item(&item("zoom-out", "Alejar", Some("CmdOrCtrl+-"))?)
        .item(&item("zoom-reset", "Tamaño real (100 %)", Some("CmdOrCtrl+0"))?)
        .build()?;

    let window = SubmenuBuilder::new(app, "Ventana")
        .item(&PredefinedMenuItem::minimize(app, Some("Minimizar"))?)
        .item(&PredefinedMenuItem::maximize(app, Some("Zoom"))?)
        .item(&PredefinedMenuItem::fullscreen(app, Some("Pantalla completa"))?)
        .build()?;

    MenuBuilder::new(app).items(&[&app_menu, &file, &edit, &view, &window]).build()
}

/// Una opción del menú: la interfaz decide qué hacer.
pub fn on_menu<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let _ = app.emit("menu", id);
}

/// macOS pidió abrir archivos (doble clic en Finder, "Abrir con…", arrastrar al Dock).
pub fn on_opened<R: Runtime>(app: &AppHandle<R>, paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }
    if let Some(state) = app.try_state::<OpenedFiles>() {
        if let Ok(mut pending) = state.0.lock() {
            pending.extend(paths.iter().cloned());
        }
    }
    // Si la interfaz ya está abierta, se entera de inmediato.
    let _ = app.emit("open-files", paths);
}

/// Archivos pendientes de abrir (la interfaz los pide al arrancar).
#[tauri::command]
pub fn take_opened_files(state: State<OpenedFiles>) -> Vec<String> {
    state.0.lock().map(|mut files| std::mem::take(&mut *files)).unwrap_or_default()
}

/// Abre el diálogo de impresión de macOS (que también permite guardar como PDF).
#[tauri::command]
pub fn print_window(window: WebviewWindow) -> Result<(), String> {
    window.print().map_err(|e| e.to_string())
}

/// Cierra WEPO (desde el menú, después de confirmar en la interfaz).
#[tauri::command]
pub fn quit_app<R: Runtime>(app: AppHandle<R>) {
    app.exit(0);
}
