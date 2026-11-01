// Más herramientas de «WEPO Convertir»: lo que ya hacían las apps (unir,
// girar, ordenar, contraseñas, reconocer texto, convertir), ahora para varios
// archivos de una vez y sin abrirlos uno por uno.

import { invoke } from "@tauri-apps/api/core";
import { PDFDocument, degrees } from "pdf-lib";
import { addOcrText, dropOldEncryption, pid } from "../editors/pdf/pdfEdit";
import { ocrPage } from "../editors/pdf/PdfViewer";
import { convertPdf } from "../lib/pdfConvert";
import { pdfToWrite } from "../editors/write/fromPdf";
import { writeDocx } from "../editors/write/docx";
import { pdfTables } from "../editors/sheets/fromPdf";
import { loadPdf } from "../lib/pdf";
import { baseName, openPdf, parseRanges, proxyOf } from "./pdfTools";
import type { Output } from "./pdfTools";

const permissions = { printing: "highResolution", modifying: true, copying: true, annotating: true, fillingForms: true, contentAccessibility: true, documentAssembly: true } as const;

/** Une varios PDF en uno, en el orden de la lista. */
export async function mergePdfs(files: { name: string; bytes: Uint8Array }[]): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  for (const f of files) {
    const src = await openPdf(f.bytes, f.name);
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((p) => out.addPage(p));
  }
  out.setTitle(baseName(files[0].name));
  out.setProducer("WEPO");
  return out.save();
}

/** Gira las páginas (todas o las de los rangos). */
export async function rotatePdf(bytes: Uint8Array, name: string, angle: number, pages: string): Promise<Uint8Array> {
  const doc = await openPdf(bytes, name);
  const all = doc.getPages();
  const chosen = pages.trim() ? new Set(parseRanges(pages, all.length).flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, i) => a - 1 + i))) : null;
  all.forEach((p, i) => {
    if (chosen && !chosen.has(i)) return;
    p.setRotation(degrees((((p.getRotation().angle + angle) % 360) + 360) % 360));
  });
  doc.setProducer("WEPO");
  return doc.save();
}

/** Una página del resultado de «Ordenar»: cuál era y cuánto se gira. */
export type PageOrder = { index: number; rotation: number };

/** El PDF con las páginas en otro orden, giradas o quitadas. */
export async function reorderPdf(bytes: Uint8Array, name: string, order: PageOrder[]): Promise<Uint8Array> {
  const src = await openPdf(bytes, name);
  const out = await PDFDocument.create();
  const pages = await out.copyPages(
    src,
    order.map((o) => o.index),
  );
  pages.forEach((p, k) => {
    const turn = order[k].rotation;
    if (turn) p.setRotation(degrees((((p.getRotation().angle + turn) % 360) + 360) % 360));
    out.addPage(p);
  });
  out.setTitle(src.getTitle() ?? baseName(name));
  out.setProducer("WEPO");
  return out.save();
}

/** Ponerle contraseña (AES de 256 bits). */
export async function protectPdf(bytes: Uint8Array, name: string, password: string): Promise<Uint8Array> {
  const doc = await openPdf(bytes, name);
  doc.encrypt({ userPassword: password, ownerPassword: password, permissions });
  doc.setProducer("WEPO");
  return doc.save();
}

/** Quitarle la contraseña (hay que saberla) o los permisos que no dejan imprimir o copiar. */
export async function unlockPdf(bytes: Uint8Array, name: string, password: string): Promise<{ bytes: Uint8Array; had: "password" | "permissions" | "none" }> {
  let doc: PDFDocument;
  let had: "password" | "permissions" | "none" = "none";
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (e) {
    if (!/encrypt/i.test(String((e as Error)?.name ?? e) + String((e as Error)?.message ?? ""))) throw e;
    try {
      doc = await PDFDocument.load(bytes, { updateMetadata: false, password: "" });
      had = "permissions";
    } catch {
      if (!password) throw new Error(`${name} tiene contraseña: escríbela para quitarla`);
      try {
        doc = await PDFDocument.load(bytes, { updateMetadata: false, password });
        had = "password";
      } catch {
        throw new Error(`La contraseña de ${name} no es correcta`);
      }
    }
  }
  // Lo que dejaba el cifrado se quita: el PDF guardado ya no pide nada.
  dropOldEncryption(doc);
  doc.setProducer("WEPO");
  return { bytes: await doc.save(), had };
}

/** Reconoce el texto de las páginas escaneadas (las que no tienen texto) con el OCR del sistema. */
export async function ocrPdf(bytes: Uint8Array, name: string, onPage?: (done: number, total: number) => void): Promise<{ bytes: Uint8Array; pages: number; found: number }> {
  const doc = await proxyOf(bytes, name);
  const todo: number[] = [];
  for (let i = 0; i < doc.numPages; i++) {
    const content = await (await doc.getPage(i + 1)).getTextContent();
    if (!content.items.some((it) => "str" in it && it.str.trim())) todo.push(i);
  }
  if (!todo.length) return { bytes, pages: 0, found: 0 };
  const source = { id: pid("s"), name, data: bytes, doc };
  const pages: { index: number; lines: Awaited<ReturnType<typeof ocrPage>> }[] = [];
  let found = 0;
  for (const [k, i] of todo.entries()) {
    onPage?.(k + 1, todo.length);
    const lines = await ocrPage(source, i);
    found += lines.length;
    pages.push({ index: i, lines });
  }
  if (!found) throw new Error(`No se encontró texto en las páginas escaneadas de ${name}`);
  return { bytes: await addOcrText(source, pages), pages: todo.length, found };
}

async function converted(bytes: Uint8Array, name: string, onPage?: (done: number, total: number) => void) {
  const doc = await loadPdf(bytes).catch((e) => {
    if ((e as { name?: string })?.name === "PasswordException") throw new Error(`${name} tiene contraseña: quítasela primero con «Desbloquear PDF»`);
    throw e;
  });
  const inputs = Array.from({ length: doc.numPages }, (_, index) => ({ doc, index, rotation: 0 }));
  const result = await convertPdf(inputs, onPage);
  if (!result.blocks.length) throw new Error(`${name} no tiene texto que se pueda convertir (parece un escaneo): primero usa «OCR PDF»`);
  return result;
}

/** PDF a Word (.docx): títulos, listas, tablas, imágenes, encabezado y pie. */
export async function pdfToDocx(bytes: Uint8Array, name: string, onPage?: (done: number, total: number) => void): Promise<Uint8Array> {
  const doc = pdfToWrite(await converted(bytes, name, onPage));
  return writeDocx(doc.content, doc.page, baseName(name), doc.headerFooter, doc.comments);
}

/** PDF a Excel (.xlsx): una hoja por tabla. Rust arma el libro y lo guarda donde se le diga. */
export async function pdfToXlsx(bytes: Uint8Array, name: string, onPage?: (done: number, total: number) => void): Promise<Output & { tables: number }> {
  const tables = pdfTables(await converted(bytes, name, onPage));
  if (!tables.length) throw new Error(`No se encontraron tablas con bordes en ${name}`);
  return {
    name: `${baseName(name)}.xlsx`,
    bytes: new Uint8Array(),
    tables: tables.length,
    write: async (path: string) => {
      await invoke("sheet_from_tables", { tables });
      await invoke("sheet_save", { path, sheet: 0 });
    },
  };
}
