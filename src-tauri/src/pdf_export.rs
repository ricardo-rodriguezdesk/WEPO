//! Exportar como PDF: guarda directo en un archivo lo mismo que saldría impreso,
//! sin abrir el diálogo de impresión. Cada sistema usa su propio motor:
//!
//! - macOS: la impresión de WebKit con un trabajo "guardar en archivo".
//! - Windows: `PrintToPdf` de WebView2.
//! - Linux: la impresión de WebKitGTK hacia un archivo PDF.
//!
//! La interfaz dibuja antes la versión para imprimir (la misma de la vista previa)
//! y manda el tamaño de la hoja y el margen en puntos (72 por pulgada).

use std::sync::mpsc::{Receiver, Sender, channel};
use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::WebviewWindow;

#[derive(Deserialize, Clone, Copy, Debug)]
pub struct PdfPage {
    /// Ancho y alto de la hoja ya orientada (horizontal: más ancha que alta), en puntos.
    pub width: f64,
    pub height: f64,
    /// Margen igual en los cuatro lados, en puntos.
    pub margin: f64,
}

type Done = Sender<Result<(), String>>;

#[tauri::command]
pub async fn export_pdf(window: WebviewWindow, path: String, page: PdfPage) -> Result<(), String> {
    if !(page.width > 0.0 && page.height > 0.0 && page.margin >= 0.0) {
        return Err("Tamaño de hoja no válido".into());
    }
    // Se borra el anterior: así se sabe cuándo el nuevo quedó escrito.
    let _ = std::fs::remove_file(&path);
    let (tx, rx) = channel();
    let target = path.clone();
    window
        .with_webview(move |webview| {
            if let Err(e) = start(webview, &target, page, tx.clone()) {
                let _ = tx.send(Err(e));
            }
        })
        .map_err(|e| e.to_string())?;
    wait(rx, &path)
}

/// Espera a que el sistema termine de escribir el PDF (como máximo dos minutos).
fn wait(rx: Receiver<Result<(), String>>, path: &str) -> Result<(), String> {
    let started = Instant::now();
    let mut last_size = 0u64;
    let mut steady = 0;
    while started.elapsed() < Duration::from_secs(120) {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(Ok(())) => return settled(path),
            Ok(Err(e)) => return Err(e),
            Err(_) => {}
        }
        // macOS no avisa al terminar: el PDF está listo cuando deja de crecer.
        if cfg!(target_os = "macos") {
            let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
            if size > 0 && size == last_size {
                steady += 1;
                if steady >= 3 {
                    return Ok(());
                }
            } else {
                steady = 0;
            }
            last_size = size;
        }
    }
    Err("Se tardó demasiado en crear el PDF".into())
}

/// Después del aviso de "listo", se espera a que el archivo deje de crecer.
fn settled(path: &str) -> Result<(), String> {
    let started = Instant::now();
    let mut last = 0u64;
    while started.elapsed() < Duration::from_secs(10) {
        let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        if size > 0 && size == last {
            return Ok(());
        }
        last = size;
        std::thread::sleep(Duration::from_millis(150));
    }
    if last > 0 { Ok(()) } else { Err("El sistema no escribió el PDF".into()) }
}

#[cfg(target_os = "macos")]
fn start(webview: tauri::webview::PlatformWebview, path: &str, page: PdfPage, _done: Done) -> Result<(), String> {
    use objc2_app_kit::{NSPaperOrientation, NSPrintInfo, NSPrintJobSavingURL, NSPrintSaveJob};
    use objc2_foundation::{NSCopying, NSObjectProtocol, NSSize, NSString, NSURL};
    use objc2_web_kit::WKWebView;

    unsafe {
        let webview: &WKWebView = &*(webview.inner() as *const WKWebView);
        if !webview.respondsToSelector(objc2::sel!(printOperationWithPrintInfo:)) {
            return Err("Exportar como PDF necesita macOS 11 o más nuevo".into());
        }
        let info: objc2::rc::Retained<NSPrintInfo> = NSPrintInfo::sharedPrintInfo().copy();
        // AppKit guarda el papel vertical y aparte la orientación.
        let landscape = page.width > page.height;
        let (w, h) = if landscape { (page.height, page.width) } else { (page.width, page.height) };
        info.setPaperSize(NSSize::new(w, h));
        info.setOrientation(if landscape { NSPaperOrientation::Landscape } else { NSPaperOrientation::Portrait });
        info.setTopMargin(page.margin);
        info.setBottomMargin(page.margin);
        info.setLeftMargin(page.margin);
        info.setRightMargin(page.margin);
        info.setHorizontallyCentered(false);
        info.setVerticallyCentered(false);
        info.setScalingFactor(1.0);
        info.setJobDisposition(NSPrintSaveJob);
        let url = NSURL::fileURLWithPath(&NSString::from_str(path));
        info.dictionary().insert(NSPrintJobSavingURL, &*url);

        let operation = webview.printOperationWithPrintInfo(&info);
        operation.setShowsPrintPanel(false);
        operation.setShowsProgressPanel(false);
        operation.setCanSpawnSeparateThread(true);
        // Sin esto WebKit a veces imprime hojas en blanco: la vista de impresión mide lo que la ventana.
        if let Some(view) = operation.view() {
            view.setFrame(webview.frame());
        }
        let window = webview.window().ok_or("La ventana no está lista")?;
        operation.runOperationModalForWindow_delegate_didRunSelector_contextInfo(&window, None, None, std::ptr::null_mut());
    }
    Ok(())
}

#[cfg(windows)]
fn start(webview: tauri::webview::PlatformWebview, path: &str, page: PdfPage, done: Done) -> Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT, ICoreWebView2_7, ICoreWebView2Environment6,
    };
    use webview2_com::PrintToPdfCompletedHandler;
    use windows_core::{HSTRING, Interface};

    let error = |e: windows_core::Error| e.message().to_string();
    unsafe {
        let core = webview.controller().CoreWebView2().map_err(error)?;
        let core7: ICoreWebView2_7 = core.cast().map_err(|_| "Esta versión de WebView2 no puede crear PDF; actualiza Microsoft Edge WebView2".to_string())?;
        let environment: ICoreWebView2Environment6 = webview.environment().cast().map_err(error)?;
        let settings = environment.CreatePrintSettings().map_err(error)?;
        // WebView2 mide en pulgadas. La hoja ya va orientada, así que se deja "vertical".
        settings.SetOrientation(COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT).map_err(error)?;
        settings.SetPageWidth(page.width / 72.0).map_err(error)?;
        settings.SetPageHeight(page.height / 72.0).map_err(error)?;
        let margin = page.margin / 72.0;
        settings.SetMarginTop(margin).map_err(error)?;
        settings.SetMarginBottom(margin).map_err(error)?;
        settings.SetMarginLeft(margin).map_err(error)?;
        settings.SetMarginRight(margin).map_err(error)?;
        settings.SetScaleFactor(1.0).map_err(error)?;
        settings.SetShouldPrintBackgrounds(true).map_err(error)?;
        settings.SetShouldPrintHeaderAndFooter(false).map_err(error)?;
        let handler = PrintToPdfCompletedHandler::create(Box::new(move |result, ok| {
            let _ = done.send(match result {
                Ok(()) if ok => Ok(()),
                Ok(()) => Err("WebView2 no pudo crear el PDF".into()),
                Err(e) => Err(e.message().to_string()),
            });
            Ok(())
        }));
        core7.PrintToPdf(&HSTRING::from(path), &settings, &handler).map_err(error)?;
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn start(webview: tauri::webview::PlatformWebview, path: &str, page: PdfPage, done: Done) -> Result<(), String> {
    use gtk::{PageOrientation, PageSetup, PaperSize, PrintSettings, Unit};
    use webkit2gtk::{PrintOperation, PrintOperationExt};

    let uri = gtk::glib::filename_to_uri(path, None).map_err(|e| e.to_string())?;
    let settings = PrintSettings::new();
    settings.set_printer("Print to File");
    settings.set(gtk::PRINT_SETTINGS_OUTPUT_URI, Some(uri.as_str()));
    settings.set(gtk::PRINT_SETTINGS_OUTPUT_FILE_FORMAT, Some("pdf"));
    let setup = PageSetup::new();
    let landscape = page.width > page.height;
    let (w, h) = if landscape { (page.height, page.width) } else { (page.width, page.height) };
    setup.set_paper_size(&PaperSize::new_custom("wepo", "WEPO", w, h, Unit::Points));
    setup.set_orientation(if landscape { PageOrientation::Landscape } else { PageOrientation::Portrait });
    setup.set_top_margin(page.margin, Unit::Points);
    setup.set_bottom_margin(page.margin, Unit::Points);
    setup.set_left_margin(page.margin, Unit::Points);
    setup.set_right_margin(page.margin, Unit::Points);

    let operation = PrintOperation::new(&webview.inner());
    operation.set_print_settings(&settings);
    operation.set_page_setup(&setup);
    let ok = done.clone();
    operation.connect_finished(move |_| {
        let _ = ok.send(Ok(()));
    });
    operation.connect_failed(move |_, error| {
        let _ = done.send(Err(error.to_string()));
    });
    operation.print();
    Ok(())
}

#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
fn start(_webview: tauri::webview::PlatformWebview, _path: &str, _page: PdfPage, _done: Done) -> Result<(), String> {
    Err("Exportar como PDF no está disponible en este sistema".into())
}
