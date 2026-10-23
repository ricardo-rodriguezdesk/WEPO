//! Varias ventanas: cada documento abierto vive en su propia ventana, como
//! en Excel o Word. La primera se llama "main"; las demás, "doc-1", "doc-2"…

use std::sync::atomic::{AtomicUsize, Ordering};

use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

static NEXT: AtomicUsize = AtomicUsize::new(1);

/// Codifica un texto para ponerlo en la dirección de la ventana (?open=…).
fn encode(text: &str) -> String {
    text.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// Abre una ventana nueva. Con `path`, abre ese archivo; con `kind`, un documento nuevo de ese tipo.
#[tauri::command]
pub fn open_window<R: Runtime>(app: AppHandle<R>, path: Option<String>, kind: Option<String>) -> Result<(), String> {
    let label = format!("doc-{}", NEXT.fetch_add(1, Ordering::Relaxed));
    let mut query = Vec::new();
    if let Some(path) = &path {
        query.push(format!("open={}", encode(path)));
    }
    if let Some(kind) = &kind {
        query.push(format!("new={}", encode(kind)));
    }
    let url = if query.is_empty() { "index.html".to_string() } else { format!("index.html?{}", query.join("&")) };
    WebviewWindowBuilder::new(&app, label, WebviewUrl::App(url.into()))
        .title("WEPO")
        .inner_size(1200.0, 800.0)
        .min_inner_size(720.0, 480.0)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// La ventana activa (o la principal si ninguna tiene el foco), para mandarle
/// las órdenes del menú o los archivos abiertos desde Finder.
pub fn focused<R: Runtime>(app: &AppHandle<R>) -> Option<tauri::WebviewWindow<R>> {
    let windows = app.webview_windows();
    windows
        .values()
        .find(|w| w.is_focused().unwrap_or(false))
        .or_else(|| windows.get("main"))
        .or_else(|| windows.values().next())
        .cloned()
}

pub fn emit_to_focused<R: Runtime, S: serde::Serialize + Clone>(app: &AppHandle<R>, event: &str, payload: S) {
    if let Some(window) = focused(app) {
        let _ = window.emit(event, payload);
    }
}

/// Salir: se piden cerrar todas las ventanas. Cada una pregunta si tiene
/// cambios sin guardar; cuando se cierra la última, WEPO termina.
#[tauri::command]
pub fn quit_app<R: Runtime>(app: AppHandle<R>) {
    for window in app.webview_windows().values() {
        let _ = window.close();
    }
}
