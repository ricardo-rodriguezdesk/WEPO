//! Reconocer texto en una imagen (OCR) con lo que ya trae cada sistema, para
//! que WEPO no cargue un motor propio:
//!
//! - macOS: Vision (VNRecognizeTextRequest), el mismo de Vista Previa y Fotos.
//! - Windows: Windows.Media.Ocr, con los idiomas instalados en Windows.
//! - Linux: tesseract, si está instalado (`sudo apt install tesseract-ocr tesseract-ocr-spa`).
//!
//! La interfaz manda la página dibujada como PNG (en base64) y recibe los
//! renglones con su caja, en fracciones de la imagen (0 a 1, desde arriba a la izquierda).

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct OcrLine {
    pub text: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// `langs`: idiomas en orden de preferencia, como "es" o "en".
#[tauri::command]
pub async fn ocr_image(image: String, langs: Vec<String>) -> Result<Vec<OcrLine>, String> {
    let bytes = crate::files::decode(&image)?;
    std::thread::spawn(move || recognize(&bytes, &langs))
        .join()
        .map_err(|_| "El reconocimiento de texto se detuvo de forma inesperada".to_string())?
}

/// Reconoce el texto de una imagen PNG o JPEG.
pub fn recognize(bytes: &[u8], langs: &[String]) -> Result<Vec<OcrLine>, String> {
    let mut lines = platform::recognize(bytes, langs)?;
    lines.retain(|l| !l.text.trim().is_empty() && l.w > 0.0 && l.h > 0.0);
    // De arriba abajo y de izquierda a derecha (así se lee y así se busca).
    lines.sort_by(|a, b| (a.y + a.h / 2.0).partial_cmp(&(b.y + b.h / 2.0)).unwrap_or(std::cmp::Ordering::Equal).then(a.x.partial_cmp(&b.x).unwrap_or(std::cmp::Ordering::Equal)));
    Ok(lines)
}

#[cfg(target_os = "macos")]
mod platform {
    use super::OcrLine;
    use objc2::AnyThread;
    use objc2::rc::Retained;
    use objc2_foundation::{NSArray, NSData, NSDictionary, NSString};
    use objc2_vision::{VNImageRequestHandler, VNRecognizeTextRequest, VNRequest, VNRequestTextRecognitionLevel};

    pub fn recognize(bytes: &[u8], langs: &[String]) -> Result<Vec<OcrLine>, String> {
        // Primero con los idiomas pedidos; si Vision no los tiene, con los suyos.
        match run(bytes, langs) {
            Ok(lines) => Ok(lines),
            Err(_) if !langs.is_empty() => run(bytes, &[]),
            Err(e) => Err(e),
        }
    }

    fn run(bytes: &[u8], langs: &[String]) -> Result<Vec<OcrLine>, String> {
        let data = NSData::with_bytes(bytes);
        let options = NSDictionary::new();
        let handler = VNImageRequestHandler::initWithData_options(VNImageRequestHandler::alloc(), &data, &options);
        let request = VNRecognizeTextRequest::new();
        request.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);
        request.setUsesLanguageCorrection(true);
        if !langs.is_empty() {
            let codes: Vec<Retained<NSString>> = langs.iter().map(|l| NSString::from_str(&vision_code(l))).collect();
            request.setRecognitionLanguages(&NSArray::from_retained_slice(&codes));
        }
        let as_request: &VNRequest = &request;
        let requests = NSArray::from_slice(&[as_request]);
        handler.performRequests_error(&requests).map_err(|e| format!("No se pudo reconocer el texto: {}", e.localizedDescription()))?;
        let mut out = Vec::new();
        if let Some(results) = request.results() {
            for obs in results.iter() {
                let Some(best) = obs.topCandidates(1).firstObject() else { continue };
                // Vision mide desde abajo a la izquierda.
                let b = unsafe { obs.boundingBox() };
                out.push(OcrLine {
                    text: best.string().to_string(),
                    x: b.origin.x,
                    y: 1.0 - b.origin.y - b.size.height,
                    w: b.size.width,
                    h: b.size.height,
                });
            }
        }
        Ok(out)
    }

    fn vision_code(lang: &str) -> String {
        match lang {
            "es" => "es-ES".into(),
            "en" => "en-US".into(),
            "fr" => "fr-FR".into(),
            "pt" => "pt-BR".into(),
            "de" => "de-DE".into(),
            "it" => "it-IT".into(),
            other => other.into(),
        }
    }
}

#[cfg(windows)]
mod platform {
    use super::OcrLine;
    use windows::Globalization::Language;
    use windows::Graphics::Imaging::{BitmapAlphaMode, BitmapDecoder, BitmapPixelFormat, SoftwareBitmap};
    use windows::Media::Ocr::OcrEngine;
    use windows::Storage::Streams::{DataWriter, InMemoryRandomAccessStream};
    use windows::Win32::System::WinRT::{RO_INIT_MULTITHREADED, RoInitialize};
    use windows_core::{HSTRING, Interface};
    use windows_future::IAsyncOperation;

    fn err(e: windows_core::Error) -> String {
        format!("No se pudo reconocer el texto: {}", e.message())
    }

    pub fn recognize(bytes: &[u8], langs: &[String]) -> Result<Vec<OcrLine>, String> {
        // Este hilo es nuevo: necesita Windows Runtime (si ya estaba, no pasa nada).
        let _ = unsafe { RoInitialize(RO_INIT_MULTITHREADED) };
        let stream = InMemoryRandomAccessStream::new().map_err(err)?;
        let writer = DataWriter::CreateDataWriter(&stream).map_err(err)?;
        writer.WriteBytes(bytes).map_err(err)?;
        writer.StoreAsync().and_then(|op| op.cast::<IAsyncOperation<u32>>()).and_then(|op| op.join()).map_err(err)?;
        writer.DetachStream().map_err(err)?;
        stream.Seek(0).map_err(err)?;
        let decoder = BitmapDecoder::CreateAsync(&stream).and_then(|op| op.join()).map_err(err)?;
        let bitmap = decoder.GetSoftwareBitmapAsync().and_then(|op| op.join()).map_err(err)?;
        let bitmap = SoftwareBitmap::ConvertWithAlpha(&bitmap, BitmapPixelFormat::Bgra8, BitmapAlphaMode::Premultiplied).map_err(err)?;
        let width = f64::from(bitmap.PixelWidth().map_err(err)?.max(1));
        let height = f64::from(bitmap.PixelHeight().map_err(err)?.max(1));

        // El primer idioma pedido que tenga Windows; si ninguno, los del usuario.
        let engine = langs
            .iter()
            .filter_map(|l| Language::CreateLanguage(&HSTRING::from(l.as_str())).ok())
            .find(|lang| OcrEngine::IsLanguageSupported(lang).unwrap_or(false))
            .and_then(|lang| OcrEngine::TryCreateFromLanguage(&lang).ok())
            .or_else(|| OcrEngine::TryCreateFromUserProfileLanguages().ok())
            .ok_or_else(|| "Windows no tiene instalado un idioma para reconocer texto (Configuración → Hora e idioma → Idioma).".to_string())?;
        let result = engine.RecognizeAsync(&bitmap).and_then(|op| op.join()).map_err(err)?;
        let mut out = Vec::new();
        for line in result.Lines().map_err(err)? {
            let text = line.Text().map_err(err)?.to_string();
            let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
            for word in line.Words().map_err(err)? {
                let r = word.BoundingRect().map_err(err)?;
                x0 = x0.min(f64::from(r.X));
                y0 = y0.min(f64::from(r.Y));
                x1 = x1.max(f64::from(r.X + r.Width));
                y1 = y1.max(f64::from(r.Y + r.Height));
            }
            if x1 <= x0 || y1 <= y0 {
                continue;
            }
            out.push(OcrLine { text, x: x0 / width, y: y0 / height, w: (x1 - x0) / width, h: (y1 - y0) / height });
        }
        Ok(out)
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod platform {
    use super::OcrLine;
    use std::collections::BTreeMap;
    use std::io::Write;
    use std::process::{Command, Stdio};

    const MISSING: &str = "Para reconocer texto en Linux hace falta tesseract: sudo apt install tesseract-ocr tesseract-ocr-spa";

    pub fn recognize(bytes: &[u8], langs: &[String]) -> Result<Vec<OcrLine>, String> {
        // Los idiomas que tenga instalados tesseract ("spa", "eng"…).
        let installed = Command::new("tesseract").arg("--list-langs").output().map_err(|_| MISSING.to_string())?;
        let installed = String::from_utf8_lossy(&installed.stdout).to_string() + &String::from_utf8_lossy(&installed.stderr);
        let wanted: Vec<&str> = langs
            .iter()
            .map(|l| match l.as_str() {
                "es" => "spa",
                "en" => "eng",
                "fr" => "fra",
                "pt" => "por",
                "de" => "deu",
                "it" => "ita",
                other => other,
            })
            .filter(|code| installed.lines().any(|l| l.trim() == *code))
            .collect();
        let mut cmd = Command::new("tesseract");
        cmd.args(["stdin", "stdout"]);
        if !wanted.is_empty() {
            cmd.args(["-l", &wanted.join("+")]);
        }
        cmd.arg("tsv").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = cmd.spawn().map_err(|_| MISSING.to_string())?;
        child.stdin.take().ok_or("No se pudo hablar con tesseract")?.write_all(bytes).map_err(|e| e.to_string())?;
        let output = child.wait_with_output().map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err(format!("tesseract no pudo leer la imagen: {}", String::from_utf8_lossy(&output.stderr).trim()));
        }
        Ok(parse_tsv(&String::from_utf8_lossy(&output.stdout)))
    }

    /// TSV de tesseract: una fila por palabra (nivel 5); se juntan por renglón.
    pub fn parse_tsv(tsv: &str) -> Vec<OcrLine> {
        let (mut width, mut height) = (1.0f64, 1.0f64);
        let mut lines: BTreeMap<(u32, u32, u32, u32), (Vec<String>, f64, f64, f64, f64)> = BTreeMap::new();
        for row in tsv.lines().skip(1) {
            let cols: Vec<&str> = row.split('\t').collect();
            if cols.len() < 12 {
                continue;
            }
            let n = |i: usize| cols[i].trim().parse::<f64>().unwrap_or(0.0);
            let level = n(0) as u32;
            if level == 1 {
                width = n(8).max(1.0);
                height = n(9).max(1.0);
            }
            let text = cols[11].trim();
            if level != 5 || text.is_empty() || n(10) < 0.0 {
                continue;
            }
            let key = (n(1) as u32, n(2) as u32, n(3) as u32, n(4) as u32);
            let (l, t, w, h) = (n(6), n(7), n(8), n(9));
            let entry = lines.entry(key).or_insert((Vec::new(), f64::MAX, f64::MAX, f64::MIN, f64::MIN));
            entry.0.push(text.to_string());
            entry.1 = entry.1.min(l);
            entry.2 = entry.2.min(t);
            entry.3 = entry.3.max(l + w);
            entry.4 = entry.4.max(t + h);
        }
        lines
            .into_values()
            .map(|(words, x0, y0, x1, y1)| OcrLine { text: words.join(" "), x: x0 / width, y: y0 / height, w: (x1 - x0) / width, h: (y1 - y0) / height })
            .collect()
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn juntar_palabras_por_renglon() {
            let tsv = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n\
                1\t1\t0\t0\t0\t0\t0\t0\t1000\t500\t-1\t\n\
                5\t1\t1\t1\t1\t1\t100\t50\t80\t20\t95\tHola\n\
                5\t1\t1\t1\t1\t2\t200\t52\t90\t20\t94\tmundo\n\
                5\t1\t1\t1\t2\t1\t100\t100\t60\t20\t90\tAdiós\n";
            let lines = parse_tsv(tsv);
            assert_eq!(lines.len(), 2);
            assert_eq!(lines[0].text, "Hola mundo");
            assert!((lines[0].x - 0.1).abs() < 1e-9 && (lines[0].w - 0.19).abs() < 1e-9);
            assert!((lines[0].y - 0.1).abs() < 1e-9 && (lines[0].h - 0.044).abs() < 1e-9);
            assert_eq!(lines[1].text, "Adiós");
        }
    }
}
