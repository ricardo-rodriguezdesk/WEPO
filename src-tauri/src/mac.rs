//! Integración con el sistema: barra de menús en español, archivos abiertos
//! desde Finder o el Explorador de Windows (doble clic o "Abrir con…") e impresión.

use std::sync::Mutex;

use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{AppHandle, Manager, Runtime, State, WebviewWindow};

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

    let file = SubmenuBuilder::new(app, "Archivo")
        .item(&item("new-sheet", "Nueva hoja de cálculo", Some("CmdOrCtrl+N"))?)
        .item(&item("new-document", "Nuevo documento", Some("CmdOrCtrl+Shift+N"))?)
        .item(&item("open", "Abrir…", Some("CmdOrCtrl+O"))?)
        .separator()
        .item(&item("save", "Guardar", Some("CmdOrCtrl+S"))?)
        .item(&item("save-as", "Guardar como…", Some("CmdOrCtrl+Shift+S"))?)
        .separator()
        .item(&item("print", "Imprimir o exportar a PDF…", Some("CmdOrCtrl+P"))?)
        .separator()
        .item(&item("home", "Ir al inicio", None)?);

    let view = SubmenuBuilder::new(app, "Visualización")
        .item(&item("zoom-in", "Acercar", Some("CmdOrCtrl+="))?)
        .item(&item("zoom-out", "Alejar", Some("CmdOrCtrl+-"))?)
        .item(&item("zoom-reset", "Tamaño real (100 %)", Some("CmdOrCtrl+0"))?)
        .build()?;

    // En Mac: menú de la app, edición nativa y menú Ventana, como cualquier app de macOS.
    #[cfg(target_os = "macos")]
    {
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
        let file = file
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
        let window = SubmenuBuilder::new(app, "Ventana")
            .item(&PredefinedMenuItem::minimize(app, Some("Minimizar"))?)
            .item(&PredefinedMenuItem::maximize(app, Some("Zoom"))?)
            .item(&PredefinedMenuItem::fullscreen(app, Some("Pantalla completa"))?)
            .build()?;
        MenuBuilder::new(app).items(&[&app_menu, &file, &edit, &view, &window]).build()
    }

    // En Windows y Linux: menú dentro de la ventana. Copiar, pegar y deshacer los
    // atiende la propia hoja (Ctrl+C, Ctrl+V, Ctrl+Z), así que no se repiten aquí.
    #[cfg(not(target_os = "macos"))]
    {
        let file = file
            .separator()
            .item(&item("quit", "Salir", Some("Ctrl+Q"))?)
            .build()?;
        let edit = SubmenuBuilder::new(app, "Edición")
            .item(&item("find", "Buscar y reemplazar…", Some("Ctrl+F"))?)
            .build()?;
        let help = SubmenuBuilder::new(app, "Ayuda")
            .item(&PredefinedMenuItem::about(app, Some("Acerca de WEPO"), None)?)
            .build()?;
        MenuBuilder::new(app).items(&[&file, &edit, &view, &help]).build()
    }
}

/// Una opción del menú: la ventana activa decide qué hacer.
pub fn on_menu<R: Runtime>(app: &AppHandle<R>, id: &str) {
    crate::windows::emit_to_focused(app, "menu", id.to_string());
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
    // Si la interfaz ya está abierta, la ventana activa se entera de inmediato.
    crate::windows::emit_to_focused(app, "open-files", paths);
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
