// Exportar como PDF: pregunta dónde guardar y le pide al sistema que escriba el
// PDF directo, sin el diálogo de impresión (ver src-tauri/src/pdf_export.rs).
// Lo que se guarda es la versión para imprimir que ya dibujó cada editor.

import { invoke } from "@tauri-apps/api/core";
import { PDFDocument, degrees } from "pdf-lib";
import { save } from "@tauri-apps/plugin-dialog";
import { fileNameOf } from "./documents";

/** Hoja y margen en puntos (72 por pulgada). La hoja va ya orientada. */
export type PdfPage = { width: number; height: number; margin: number };

export const LETTER = { width: 612, height: 792 };

/** Hoja carta vertical u horizontal con un margen dado (en puntos). */
export function letter(landscape: boolean, margin: number): PdfPage {
  return landscape ? { width: LETTER.height, height: LETTER.width, margin } : { ...LETTER, margin };
}

// WEPO Convertir abre los documentos sin mostrarlos y les pide el PDF: el nombre
// ya está decidido (no se pregunta) y avisa cuando el PDF quedó escrito.
let expected: { target: string; done: (error?: unknown) => void } | null = null;

/** El siguiente «Exportar como PDF» se guarda en `target` sin preguntar; se cumple cuando quedó escrito. */
export function expectPdf(target: string): Promise<void> {
  return new Promise((resolve, reject) => {
    expected = {
      target,
      done: (error) => {
        expected = null;
        if (error) reject(error instanceof Error ? error : new Error(String(error)));
        else resolve();
      },
    };
  });
}

/** Si el PDF esperado no se va a escribir (se canceló o falló antes). */
export function failExpectedPdf(error: unknown) {
  expected?.done(error ?? new Error("no se pudo exportar"));
}

/** Pide el nombre del PDF; propone el del documento, en la misma carpeta. */
export async function askPdfPath(path: string | null, fileName: string): Promise<string | null> {
  if (expected) return expected.target;
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
export async function writePdf(path: string, page: PdfPage, after?: () => Promise<void>): Promise<string> {
  const waiting = expected && expected.target === path ? expected : null;
  try {
    await invoke("export_pdf", { path, page });
    // Lo que se le hace al PDF ya escrito (enderezar hojas horizontales) cuenta como parte de escribirlo.
    if (after) await after();
  } catch (e) {
    waiting?.done(e);
    throw e;
  }
  waiting?.done();
  return fileNameOf(path);
}

/** Endereza las hojas horizontales de un PDF que se imprimió todo en vertical (se giran 90°). */
export async function turnPdfPages(path: string, indices: number[]): Promise<void> {
  if (!indices.length) return;

  const binary = atob(await invoke<string>("file_read", { path }));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const pages = doc.getPages();
  for (const i of indices) if (pages[i]) pages[i].setRotation(degrees((pages[i].getRotation().angle + 90) % 360));
  const out = await doc.save();
  let text = "";
  for (let i = 0; i < out.length; i += 0x8000) text += String.fromCharCode(...out.subarray(i, i + 0x8000));
  await invoke("file_write", { path, data: btoa(text) });
}
