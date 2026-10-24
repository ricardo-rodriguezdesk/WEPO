// Exportar como PDF: pregunta dónde guardar y le pide al sistema que escriba el
// PDF directo, sin el diálogo de impresión (ver src-tauri/src/pdf_export.rs).
// Lo que se guarda es la versión para imprimir que ya dibujó cada editor.

import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { fileNameOf } from "./documents";

/** Hoja y margen en puntos (72 por pulgada). La hoja va ya orientada. */
export type PdfPage = { width: number; height: number; margin: number };

export const LETTER = { width: 612, height: 792 };

/** Hoja carta vertical u horizontal con un margen dado (en puntos). */
export function letter(landscape: boolean, margin: number): PdfPage {
  return landscape ? { width: LETTER.height, height: LETTER.width, margin } : { ...LETTER, margin };
}

/** Pide el nombre del PDF; propone el del documento, en la misma carpeta. */
export async function askPdfPath(path: string | null, fileName: string): Promise<string | null> {
  const base = fileNameOf(path ?? fileName).replace(/\.[^.]+$/, "") || "Documento";
  const defaultPath = path ? path.replace(/[^/\\]+$/, `${base}.pdf`) : `${base}.pdf`;
  const target = await save({ title: "Exportar como PDF", defaultPath, filters: [{ name: "PDF", extensions: ["pdf"] }] });
  if (!target) return null;
  return /\.pdf$/i.test(target) ? target : `${target}.pdf`;
}

/** Espera a que la versión para imprimir esté dibujada: letras e imágenes cargadas. */
export async function printReady(): Promise<void> {
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  await document.fonts?.ready;
  const images = Array.from(document.querySelectorAll<HTMLImageElement>(".print-root img, .write-editor img"));
  await Promise.all(images.map((img) => (img.complete ? null : img.decode().catch(() => {}))));
  await new Promise((r) => setTimeout(r, 50));
}

/** Escribe el PDF. Devuelve el nombre del archivo guardado. */
export async function writePdf(path: string, page: PdfPage): Promise<string> {
  await invoke("export_pdf", { path, page });
  return fileNameOf(path);
}
