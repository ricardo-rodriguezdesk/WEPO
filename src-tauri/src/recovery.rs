//! Copia de recuperación: mientras hay cambios sin guardar, WEPO guarda cada
//! poco una copia del libro en su carpeta de datos. Si la app se cierra de
//! golpe, al volver a abrirla ofrece recuperar esa copia.

use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime, State};

use crate::OpenSheet;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct RecoveryInfo {
    /// Nombre que tenía el documento ("Ventas.xlsx" o "Sin título").
    pub name: String,
    /// Ruta del archivo original, si ya estaba guardado.
    pub original: Option<String>,
    /// Segundos desde 1970 (UTC) de la última copia.
    pub time: u64,
    /// Dónde está la copia (.xlsx), para abrirla.
    pub path: String,
}

fn folder<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("recuperacion");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Guarda (o actualiza) la copia de recuperación del libro abierto.
#[tauri::command]
pub fn recovery_save<R: Runtime>(
    app: AppHandle<R>,
    state: State<OpenSheet>,
    name: String,
    original: Option<String>,
) -> Result<(), String> {
    let dir = folder(&app)?;
    let copy = dir.join("documento.xlsx");
    let copy_path = copy.to_string_lossy().into_owned();
    {
        let guard = state.0.lock().map_err(|e| e.to_string())?;
        let Some(doc) = guard.as_ref() else { return Ok(()) };
        doc.save(&copy_path, 0)?;
    }
    let time = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let info = RecoveryInfo { name, original, time, path: copy_path };
    let json = serde_json::to_string(&info).map_err(|e| e.to_string())?;
    fs::write(dir.join("documento.json"), json).map_err(|e| e.to_string())
}

/// La copia que quedó de la última vez, si la hay.
#[tauri::command]
pub fn recovery_info<R: Runtime>(app: AppHandle<R>) -> Option<RecoveryInfo> {
    let dir = folder(&app).ok()?;
    let info: RecoveryInfo = serde_json::from_str(&fs::read_to_string(dir.join("documento.json")).ok()?).ok()?;
    PathBuf::from(&info.path).is_file().then_some(info)
}

/// Borra la copia (al guardar, al descartar los cambios o al recuperarla y guardarla).
#[tauri::command]
pub fn recovery_clear<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let dir = folder(&app)?;
    for name in ["documento.json", "documento.xlsx"] {
        let _ = fs::remove_file(dir.join(name));
    }
    Ok(())
}
