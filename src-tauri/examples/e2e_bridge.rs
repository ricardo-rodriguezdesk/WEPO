//! Puente para las pruebas de la interfaz (carpeta e2e/ y playwright.config.ts).
//!
//! La interfaz de WEPO corre en un navegador normal durante las pruebas; los
//! comandos que en la app van a Rust llegan aquí por HTTP (127.0.0.1:5199) y se
//! atienden con el mismo código de la app: el motor de hojas de cálculo y la
//! lectura y escritura de archivos. Así las pruebas usan lo de verdad.
//!
//!   cargo run --example e2e_bridge
//!
//! Las copias de recuperación se guardan en WEPO_E2E_DIR (o en la carpeta temporal).

use std::path::PathBuf;

use serde_json::{Value, json};
use wepo_lib::files;
use wepo_lib::sheets::{ColumnFilter, ListSource, PasteMode, Rect, SheetDocument, SortKey, TableSheet};

fn work_dir() -> PathBuf {
    let dir = std::env::var("WEPO_E2E_DIR").map(PathBuf::from).unwrap_or_else(|_| std::env::temp_dir().join("wepo-e2e"));
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// Copia de recuperación de un tipo (xlsx, docx o pptx): el archivo y sus datos.
fn recovery(ext: &str) -> (PathBuf, PathBuf) {
    let file = work_dir().join(format!("recovery.{ext}"));
    let info = work_dir().join(format!("recovery.{ext}.json"));
    (file, info)
}

fn existing_recovery() -> Option<&'static str> {
    ["xlsx", "docx", "pptx"].into_iter().find(|e| recovery(e).0.exists())
}

fn main() {
    let server = tiny_http::Server::http("127.0.0.1:5199").expect("el puerto 5199 está ocupado");
    println!("Puente de pruebas de WEPO en http://127.0.0.1:5199");
    let mut doc: Option<SheetDocument> = None;
    for mut req in server.incoming_requests() {
        let cmd = req.url().trim_start_matches('/').to_string();
        let mut body = String::new();
        let _ = req.as_reader().read_to_string(&mut body);
        let a: Value = serde_json::from_str(&body).unwrap_or(json!({}));
        let i = |k: &str| a[k].as_i64().unwrap_or(0) as i32;
        let u = |k: &str| a[k].as_u64().unwrap_or(0) as u32;
        let st = |k: &str| a[k].as_str().unwrap_or("").to_string();
        let rect = Rect { row1: i("row1"), col1: i("col1"), row2: i("row2"), col2: i("col2") };
        let sheet = u("sheet");
        let res: Result<Value, String> = (|| {
            let view = |d: &SheetDocument, s: u32| d.view(s).map(|v| serde_json::to_value(v).unwrap());
            match cmd.as_str() {
                "" => Ok(json!("WEPO")),
                "sheet_new" => {
                    let d = SheetDocument::new_empty()?;
                    let v = view(&d, 0);
                    doc = Some(d);
                    v
                }
                "sheet_open" => {
                    let d = SheetDocument::open(&st("path"))?;
                    let v = view(&d, 0);
                    doc = Some(d);
                    v
                }
                "sheet_from_tables" => {
                    let tables: Vec<TableSheet> = serde_json::from_value(a["tables"].clone()).map_err(|e| e.to_string())?;
                    let d = SheetDocument::from_tables(&tables)?;
                    let v = view(&d, 0);
                    doc = Some(d);
                    v
                }
                "user_name" => Ok(json!("Prueba")),
                "file_read" => files::file_read(st("path")).map(Value::from),
                "file_write" => files::file_write(st("path"), st("data")).map(|_| Value::Null),
                "ocr_image" => {
                    let langs: Vec<String> = serde_json::from_value(a["langs"].clone()).unwrap_or_default();
                    wepo_lib::ocr::recognize(&files::decode(&st("image"))?, &langs).map(|lines| json!(lines))
                }
                "recovery_save_file" => {
                    let ext = a["ext"].as_str().unwrap_or("docx").to_string();
                    let (file, info) = recovery(&ext);
                    files::file_write(file.to_string_lossy().into(), st("data"))?;
                    std::fs::write(&info, json!({"name": st("name"), "original": a["original"], "time": 1761200000u64, "path": file}).to_string()).map_err(|e| e.to_string())?;
                    Ok(Value::Null)
                }
                "recovery_info" => Ok(existing_recovery()
                    .and_then(|e| std::fs::read_to_string(recovery(e).1).ok())
                    .and_then(|t| serde_json::from_str::<Value>(&t).ok())
                    .map(|v| json!([v]))
                    .unwrap_or(json!([]))),
                "recovery_take" => {
                    let ext = existing_recovery().ok_or("no hay copia")?;
                    let (file, info) = recovery(ext);
                    let target = work_dir().join(format!("recuperado.{ext}"));
                    std::fs::copy(&file, &target).map_err(|e| e.to_string())?;
                    let _ = std::fs::remove_file(file);
                    let _ = std::fs::remove_file(info);
                    Ok(json!(target))
                }
                "recovery_discard" | "recovery_clear" => {
                    for ext in ["xlsx", "docx", "pptx"] {
                        let (file, info) = recovery(ext);
                        let _ = std::fs::remove_file(file);
                        let _ = std::fs::remove_file(info);
                    }
                    Ok(Value::Null)
                }
                _ => {
                    let d = doc.as_mut().ok_or("no hay hoja abierta")?;
                    match cmd.as_str() {
                        "sheet_view" => view(d, sheet),
                        "sheet_cell_input" => d.cell_input(sheet, i("row"), i("col")).map(Value::from),
                        "sheet_set_cell" => {
                            d.set_cell(sheet, i("row"), i("col"), &st("input"))?;
                            view(d, sheet)
                        }
                        "sheet_clear" => {
                            d.clear_range(sheet, rect)?;
                            view(d, sheet)
                        }
                        "sheet_style" => {
                            d.set_style(sheet, rect, &st("path"), &st("value"))?;
                            view(d, sheet)
                        }
                        "sheet_border" => {
                            d.set_border(sheet, rect, &st("kind"), &st("style"), &st("color"))?;
                            view(d, sheet)
                        }
                        "sheet_column_width" => {
                            d.set_column_width(sheet, i("col1"), i("col2"), a["width"].as_f64().unwrap_or(80.0))?;
                            view(d, sheet)
                        }
                        "sheet_row_height" => {
                            d.set_row_height(sheet, i("row1"), i("row2"), a["height"].as_f64().unwrap_or(20.0))?;
                            view(d, sheet)
                        }
                        "sheet_copy" => d.copy(sheet, rect, a["cut"].as_bool().unwrap_or(false)).map(Value::from),
                        "sheet_paste" => {
                            d.paste(sheet, i("row"), i("col"), &st("text"))?;
                            view(d, sheet)
                        }
                        "sheet_insert_rows" => {
                            d.insert_rows(sheet, i("row"), i("count"))?;
                            view(d, sheet)
                        }
                        "sheet_delete_rows" => {
                            d.delete_rows(sheet, i("row"), i("count"))?;
                            view(d, sheet)
                        }
                        "sheet_insert_columns" => {
                            d.insert_columns(sheet, i("col"), i("count"))?;
                            view(d, sheet)
                        }
                        "sheet_delete_columns" => {
                            d.delete_columns(sheet, i("col"), i("count"))?;
                            view(d, sheet)
                        }
                        "sheet_hide_rows" => {
                            d.set_rows_hidden(sheet, i("row1"), i("row2"), a["hidden"].as_bool().unwrap_or(true))?;
                            view(d, sheet)
                        }
                        "sheet_hide_columns" => {
                            d.set_columns_hidden(sheet, i("col1"), i("col2"), a["hidden"].as_bool().unwrap_or(true))?;
                            view(d, sheet)
                        }
                        "sheet_merge" => {
                            if a["merge"].as_bool().unwrap_or(true) {
                                d.merge(sheet, rect)?
                            } else {
                                d.unmerge(sheet, rect)?
                            };
                            view(d, sheet)
                        }
                        "sheet_freeze" => {
                            d.freeze(sheet, i("rows"), i("cols"))?;
                            view(d, sheet)
                        }
                        "sheet_autofill" => {
                            let r = |k: &str| {
                                let v: Vec<i32> = serde_json::from_value(a[k].clone()).unwrap_or_default();
                                Rect { row1: v[0], col1: v[1], row2: v[2], col2: v[3] }
                            };
                            d.auto_fill(sheet, r("source"), r("target"))?;
                            view(d, sheet)
                        }
                        "sheet_rename" => {
                            d.rename_sheet(sheet, &st("name"))?;
                            view(d, sheet)
                        }
                        "sheet_delete" => {
                            d.delete_sheet(sheet)?;
                            view(d, sheet.saturating_sub(1))
                        }
                        "sheet_duplicate" => {
                            let n = d.duplicate_sheet(sheet)?;
                            view(d, n)
                        }
                        "sheet_move" => {
                            d.move_sheet(sheet, u("to"))?;
                            view(d, u("to"))
                        }
                        "sheet_sort" => {
                            let keys: Vec<SortKey> = serde_json::from_value(a["keys"].clone()).map_err(|e| e.to_string())?;
                            d.sort(sheet, rect, &keys, a["header"].as_bool().unwrap_or(false))?;
                            view(d, sheet)
                        }
                        "sheet_filter" => {
                            let f: Vec<ColumnFilter> = serde_json::from_value(a["filters"].clone()).map_err(|e| e.to_string())?;
                            if f.is_empty() {
                                d.clear_filter(sheet, rect)?
                            } else {
                                d.filter(sheet, rect, &f)?
                            };
                            view(d, sheet)
                        }
                        "sheet_note" => {
                            d.set_note(sheet, i("row"), i("col"), &st("text"))?;
                            view(d, sheet)
                        }
                        "sheet_link" => {
                            match a["target"].as_str() {
                                Some(t) => d.set_link(sheet, i("row"), i("col"), t, a["label"].as_str())?,
                                None => d.delete_link(sheet, i("row"), i("col"))?,
                            };
                            view(d, sheet)
                        }
                        "sheet_stats" => d.stats(sheet, rect).map(|s| serde_json::to_value(s).unwrap()),
                        "sheet_paste_special" => {
                            let m: PasteMode = serde_json::from_value(a["mode"].clone()).map_err(|e| e.to_string())?;
                            d.paste_special(sheet, i("row"), i("col"), m)?;
                            view(d, sheet)
                        }
                        "sheet_paste_format" => {
                            let t = Rect { row1: i("toRow1"), col1: i("toCol1"), row2: i("toRow2"), col2: i("toCol2") };
                            d.paste_styles_from(sheet, rect, t)?;
                            view(d, sheet)
                        }
                        "recovery_save" => {
                            let (file, info) = recovery("xlsx");
                            d.save(&file.to_string_lossy(), 0)?;
                            std::fs::write(&info, json!({"name": st("name"), "original": a["original"], "time": 1761200000u64, "path": file}).to_string()).map_err(|e| e.to_string())?;
                            Ok(Value::Null)
                        }
                        "sheet_find" => d
                            .find(sheet, &st("query"), a["case"].as_bool().unwrap_or(false), a["whole"].as_bool().unwrap_or(false), a["all"].as_bool().unwrap_or(false))
                            .map(|f| serde_json::to_value(f).unwrap()),
                        "sheet_replace" => {
                            let n = d.replace_all(sheet, &st("query"), &st("replacement"), a["case"].as_bool().unwrap_or(false), a["whole"].as_bool().unwrap_or(false), a["all"].as_bool().unwrap_or(false))?;
                            Ok(json!({"count": n, "view": view(d, sheet)?}))
                        }
                        "sheet_cf_list" => d.conditional_formats(sheet).map(|l| serde_json::to_value(l).unwrap()),
                        "sheet_cf_add" => {
                            d.add_conditional_format(sheet, rect, a["rule"].clone())?;
                            view(d, sheet)
                        }
                        "sheet_cf_icons" => {
                            d.add_icon_set(sheet, rect, &st("preset"))?;
                            view(d, sheet)
                        }
                        "sheet_cf_delete" => {
                            d.delete_conditional_format(sheet, u("index"))?;
                            view(d, sheet)
                        }
                        "sheet_validation" => {
                            let src: Option<ListSource> = serde_json::from_value(a["source"].clone()).map_err(|e| e.to_string())?;
                            d.set_validation(sheet, rect, src, a["message"].as_str().map(String::from))?;
                            view(d, sheet)
                        }
                        "sheet_table_create" => {
                            d.create_table(sheet, rect, &st("style"), a["banded"].as_bool().unwrap_or(true), a["totals"].as_bool().unwrap_or(false))?;
                            view(d, sheet)
                        }
                        "sheet_table_update" => {
                            if a["remove"].as_bool().unwrap_or(false) {
                                d.delete_table(sheet, &st("name"))?
                            } else {
                                d.update_table(sheet, &st("name"), &st("style"), a["banded"].as_bool().unwrap_or(true), a["totals"].as_bool().unwrap_or(false))?
                            };
                            view(d, sheet)
                        }
                        "sheet_page_setup" => {
                            d.set_page_setup(sheet, &st("header"), &st("footer"), &st("repeatRows"), &st("printArea"))?;
                            view(d, sheet)
                        }
                        "sheet_remove_duplicates" => {
                            let cols: Vec<i32> = serde_json::from_value(a["cols"].clone()).map_err(|e| e.to_string())?;
                            let n = d.remove_duplicates(sheet, rect, &cols, a["header"].as_bool().unwrap_or(true))?;
                            Ok(json!({"removed": n, "view": view(d, sheet)?}))
                        }
                        "sheet_chart_add" => {
                            let kind = serde_json::from_value(a["kind"].clone()).map_err(|e| e.to_string())?;
                            let id = d.add_chart(sheet, rect, kind)?;
                            Ok(json!({"id": id, "view": view(d, sheet)?}))
                        }
                        "sheet_image_add" => {
                            let id = d.add_image(sheet, &st("path"), a["x"].as_f64().unwrap_or(0.0), a["y"].as_f64().unwrap_or(0.0))?;
                            Ok(json!({"id": id, "view": view(d, sheet)?}))
                        }
                        "sheet_drawing_update" => {
                            let patch = serde_json::from_value(a["patch"].clone()).map_err(|e| e.to_string())?;
                            d.update_drawing(sheet, u("id"), patch)?;
                            view(d, sheet)
                        }
                        "sheet_drawing_delete" => {
                            d.delete_drawing(u("id"))?;
                            view(d, sheet)
                        }
                        "sheet_image_data" => d.image_data(u("id")).map(Value::from),
                        "sheet_language" => {
                            d.set_language(&st("language"))?;
                            view(d, sheet)
                        }
                        "sheet_complete" => d
                            .complete(sheet, i("row"), i("col"), &st("formula"), a["cursor"].as_u64().unwrap_or(0) as usize)
                            .map(|c| serde_json::to_value(c).unwrap()),
                        "sheet_undo" => {
                            d.undo()?;
                            view(d, sheet)
                        }
                        "sheet_redo" => {
                            d.redo()?;
                            view(d, sheet)
                        }
                        "sheet_add" => {
                            let n = d.add_sheet()?;
                            view(d, n)
                        }
                        "sheet_save" => {
                            d.save(&st("path"), sheet)?;
                            Ok(Value::Null)
                        }
                        other => Err(format!("comando desconocido: {other}")),
                    }
                }
            }
        })();
        if let Err(e) = &res {
            eprintln!("error en {cmd}: {e}");
        }
        let (code, out) = match res {
            Ok(v) => (200, v.to_string()),
            Err(e) => (500, json!(e).to_string()),
        };
        let header = "Access-Control-Allow-Origin: *".parse::<tiny_http::Header>().unwrap();
        let _ = req.respond(tiny_http::Response::from_string(out).with_status_code(code).with_header(header));
    }
}
