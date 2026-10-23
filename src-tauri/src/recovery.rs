//! Copia de recuperación: mientras hay cambios sin guardar, cada ventana
//! guarda cada poco una copia de su documento en la carpeta de datos de WEPO.
//! Si la app se cierra de golpe, al volver a abrirla ofrece recuperar esas
//! copias. Las hojas las escribe el motor (.xlsx); los documentos de WEPO
//! Write llegan ya convertidos a .docx desde la interfaz.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime, State, Window};

use crate::OpenSheet;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct RecoveryInfo {
    /// Nombre que tenía el documento ("Ventas.xlsx" o "Sin título").
    pub name: String,
    /// Ruta del archivo original, si ya estaba guardado.
    pub original: Option<String>,
    /// Segundos desde 1970 (UTC) de la última copia.
    pub time: u64,
    /// Dónde está la copia (.xlsx o .docx), para abrirla.
    pub path: String,
}

fn folder<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("recuperacion");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Nombre de archivo seguro a partir de la etiqueta de la ventana.
fn slot(label: &str) -> String {
    label.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' }).collect()
}

/// Formatos de las copias.
const KINDS: [&str; 3] = ["xlsx", "docx", "pptx"];

fn remove_copy(copy: &Path) {
    let _ = fs::remove_file(copy);
    let _ = fs::remove_file(copy.with_extension("json"));
}

fn write_info(copy: &Path, name: String, original: Option<String>) -> Result<(), String> {
    let time = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let info = RecoveryInfo { name, original, time, path: copy.to_string_lossy().into_owned() };
    let json = serde_json::to_string(&info).map_err(|e| e.to_string())?;
    fs::write(copy.with_extension("json"), json).map_err(|e| e.to_string())
}

/// Guarda (o actualiza) la copia de recuperación del libro de esta ventana.
#[tauri::command]
pub fn recovery_save<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    state: State<OpenSheet>,
    name: String,
    original: Option<String>,
) -> Result<(), String> {
    let copy = folder(&app)?.join(format!("{}.xlsx", slot(window.label())));
    let copy_path = copy.to_string_lossy().into_owned();
    {
        let guard = state.0.lock().map_err(|e| e.to_string())?;
        let Some(doc) = guard.get(window.label()) else { return Ok(()) };
        doc.save(&copy_path, 0)?;
    }
    write_info(&copy, name, original)
}

/// Guarda la copia de recuperación de un documento de WEPO Write (.docx) o una
/// presentación de WEPO Present (.pptx), que llegan ya armados en base64.
#[tauri::command]
pub fn recovery_save_file<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    name: String,
    original: Option<String>,
    data: String,
    ext: Option<String>,
) -> Result<(), String> {
    let ext = ext.unwrap_or_else(|| "docx".into());
    if ext == "xlsx" || !KINDS.contains(&ext.as_str()) {
        return Err("Tipo de copia no válido".into());
    }
    let copy = folder(&app)?.join(format!("{}.{ext}", slot(window.label())));
    let bytes = crate::files::decode(&data)?;
    let tmp = copy.with_extension(format!("{ext}.tmp"));
    fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &copy).map_err(|e| e.to_string())?;
    write_info(&copy, name, original)
}

/// Las copias que quedaron de la última vez (de cualquier ventana), la más reciente primero.
#[tauri::command]
pub fn recovery_info<R: Runtime>(app: AppHandle<R>) -> Vec<RecoveryInfo> {
    let Ok(dir) = folder(&app) else { return Vec::new() };
    let mut found: Vec<RecoveryInfo> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| serde_json::from_str::<RecoveryInfo>(&fs::read_to_string(e.path()).ok()?).ok())
        .filter(|info| Path::new(&info.path).is_file())
        .collect();
    found.sort_by_key(|info| std::cmp::Reverse(info.time));
    found
}

/// Borra la copia de esta ventana (al guardar o al descartar los cambios).
#[tauri::command]
pub fn recovery_clear<R: Runtime>(app: AppHandle<R>, window: Window<R>) -> Result<(), String> {
    let dir = folder(&app)?;
    for kind in KINDS {
        remove_copy(&dir.join(format!("{}.{kind}", slot(window.label()))));
    }
    Ok(())
}

/// Borra una copia concreta (la que el usuario recuperó o descartó en el inicio).
#[tauri::command]
pub fn recovery_discard<R: Runtime>(app: AppHandle<R>, path: String) -> Result<(), String> {
    let dir = folder(&app)?;
    let copy = PathBuf::from(&path);
    // Solo se borran archivos de la carpeta de recuperación.
    if copy.parent() == Some(dir.as_path()) {
        remove_copy(&copy);
    }
    Ok(())
}

/// Copia la recuperación a un nombre propio para esta ventana antes de abrirla,
/// así la ventana que la recupera no la pisa mientras trabaja.
#[tauri::command]
pub fn recovery_take<R: Runtime>(app: AppHandle<R>, path: String) -> Result<String, String> {
    let dir = folder(&app)?;
    let source = PathBuf::from(&path);
    if source.parent() != Some(dir.as_path()) {
        return Err("Copia de recuperación no válida".into());
    }
    let time = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let ext = source.extension().and_then(|e| e.to_str()).filter(|e| KINDS.contains(e)).unwrap_or("xlsx");
    let target = std::env::temp_dir().join(format!("wepo-recuperado-{time}.{ext}"));
    fs::copy(&source, &target).map_err(|e| e.to_string())?;
    remove_copy(&source);
    Ok(target.to_string_lossy().into_owned())
}
