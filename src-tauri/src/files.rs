//! Leer y escribir archivos completos para los editores que trabajan en la
//! interfaz (WEPO Write lee y arma el .docx en TypeScript). Los datos viajan
//! en base64 porque así pasan sin problemas entre Rust y la interfaz.

use std::fs;

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16) | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8) | u32::from(*chunk.get(2).unwrap_or(&0));
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { ALPHABET[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { ALPHABET[n as usize & 63] as char } else { '=' });
    }
    out
}

pub fn decode(text: &str) -> Result<Vec<u8>, String> {
    let mut value = [0u8; 256];
    for (i, c) in ALPHABET.iter().enumerate() {
        value[*c as usize] = i as u8 + 1;
    }
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0);
    for byte in text.bytes() {
        if byte == b'=' || byte.is_ascii_whitespace() {
            continue;
        }
        let v = value[byte as usize];
        if v == 0 {
            return Err("Datos dañados (base64 no válido)".into());
        }
        acc = (acc << 6) | u32::from(v - 1);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Ok(out)
}

/// Lee un archivo completo (en base64).
#[tauri::command]
pub fn file_read(path: String) -> Result<String, String> {
    fs::read(&path).map(|bytes| encode(&bytes)).map_err(|e| e.to_string())
}

/// Escribe un archivo completo. Primero en un temporal: si algo falla, el original queda intacto.
#[tauri::command]
pub fn file_write(path: String, data: String) -> Result<(), String> {
    let bytes = decode(&data)?;
    let tmp = format!("{path}.wepo-tmp");
    fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })
}

/// Nombre del usuario de la computadora (para firmar comentarios y cambios).
#[tauri::command]
pub fn user_name() -> String {
    // macOS y Linux usan USER; Windows, USERNAME.
    let raw = std::env::var("USER").or_else(|_| std::env::var("USERNAME")).unwrap_or_default();
    let mut chars = raw.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_ida_y_vuelta() {
        for sample in [&b""[..], b"a", b"ab", b"abc", b"Hola, WEPO \xF0\x9F\x98\x80", &[0u8, 255, 128, 7, 9]] {
            assert_eq!(decode(&encode(sample)).unwrap(), sample);
        }
        assert_eq!(encode(b"Man"), "TWFu");
        assert!(decode("no*válido").is_err());
    }
}
