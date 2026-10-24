// Abrir PDF para WEPO PDF. El archivo se lee entero desde Rust (src-tauri/src/files.rs)
// y lo dibuja pdf.js (ver editors/pdf/PdfViewer.tsx).

import { invoke } from "@tauri-apps/api/core";
import { GlobalWorkerOptions, getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
// La versión "legacy" funciona también en WebKit más viejos (como el de algunos Linux).
// Vite empaqueta el worker como .js (un .mjs podría no servirse como JavaScript dentro de la app).
import PdfWorker from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?worker";

let worker: Worker | null = null;
function ensureWorker() {
  if (!worker) {
    worker = new PdfWorker();
    GlobalWorkerOptions.workerPort = worker;
  }
}

export type { PDFDocumentProxy };

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Lee el PDF del disco (sin abrirlo todavía con pdf.js). */
export async function readPdf(path: string): Promise<Uint8Array> {
  const bytes = fromBase64(await invoke<string>("file_read", { path }));
  // Un PDF empieza con "%PDF" (a veces con algo de basura antes).
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  if (!head.includes("%PDF")) throw new Error("El archivo no parece un PDF");
  return bytes;
}

/** Abre el PDF con pdf.js. Se pasa una copia: pdf.js se queda con los bytes que recibe. */
export function loadPdf(data: Uint8Array, password?: string): Promise<PDFDocumentProxy> {
  ensureWorker();
  // fontExtraProperties: el nombre real de cada fuente (para saber qué es negrita o cursiva al convertir).
  return getDocument({ data: data.slice(), password, fontExtraProperties: true }).promise;
}
