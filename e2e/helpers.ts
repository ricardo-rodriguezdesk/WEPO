// Ayudas para las pruebas: abrir archivos de ejemplo, "elegir" dónde guardar,
// exportar a PDF con el motor de Chromium y leer los archivos que salen.

import { copyFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { PDFDocument } from "pdf-lib";

export const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));
export const fixture = (name: string) => join(FIXTURES, name);

/** Carpeta para lo que guardan las pruebas. */
export function outDir(): string {
  const dir = join(tmpdir(), "wepo-e2e", "salida");
  mkdirSync(dir, { recursive: true });
  return dir;
}
export const outFile = (name: string) => join(outDir(), name);

/** Inicio de WEPO, limpio (sin recientes ni opciones guardadas). */
export async function home(page: Page) {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.goto("/");
  await page.waitForSelector(".home-card");
}

/**
 * Abre un archivo de ejemplo con «Abrir archivo…». Se abre una copia, para que
 * guardar no cambie los ejemplos del repositorio. Devuelve la ruta de la copia.
 */
export async function openFile(page: Page, name: string): Promise<string> {
  const dir = join(outDir(), "abiertos");
  mkdirSync(dir, { recursive: true });
  const copy = join(dir, name);
  copyFileSync(fixture(name), copy);
  await home(page);
  await page.evaluate((p) => ((window as unknown as Record<string, unknown>).__openPath = p), copy);
  await page.getByText("Abrir archivo…").click();
  return copy;
}

/** La próxima vez que la app pida dónde guardar, se elige este archivo. */
export async function saveAs(page: Page, path: string) {
  await page.evaluate((p) => ((window as unknown as Record<string, unknown>).__savePath = p), path);
}

/**
 * Exportar como PDF: la app pide el PDF al sistema (en las pruebas, a esta
 * función), y aquí se crea con el motor de impresión de Chromium tal como
 * lo haría WebView2 en Windows, con el tamaño de hoja que pidió la app.
 */
export async function finishExport(page: Page, path: string) {
  await page.waitForFunction(() => (window as unknown as Record<string, unknown>).__exported, null, { timeout: 20_000 });
  const asked = (await page.evaluate(() => (window as unknown as Record<string, unknown>).__exported)) as { page: { width: number; height: number; margin: number } };
  await page.evaluate(() => ((window as unknown as Record<string, unknown>).__exported = null));
  const { width, height, margin } = asked.page;
  const m = `${margin / 72}in`;
  await page.emulateMedia({ media: "print" });
  await page.pdf({ path, width: `${width / 72}in`, height: `${height / 72}in`, margin: { top: m, bottom: m, left: m, right: m }, printBackground: true });
  await page.emulateMedia({ media: "screen" });
  await page.evaluate(() => ((window as unknown as Record<string, unknown>).__exportRelease = true));
  return asked.page;
}

/** Hojas de un PDF: cuántas, su tamaño en puntos y su giro. */
export async function pdfInfo(path: string, password?: string) {
  const { readFileSync } = await import("node:fs");
  const doc = await PDFDocument.load(readFileSync(path), password !== undefined ? { password } : {});
  return doc.getPages().map((p) => ({ width: Math.round(p.getWidth()), height: Math.round(p.getHeight()), rotation: p.getRotation().angle }));
}

/** Texto de cada hoja de un PDF (con pdf.js, el mismo de la app). */
export async function pdfText(path: string, password?: string): Promise<string[]> {
  const { readFileSync } = await import("node:fs");
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await getDocument({ data: new Uint8Array(readFileSync(path)), password }).promise;
  const out: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    out.push(
      content.items
        .map((it) => ("str" in it ? it.str : ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim(),
    );
  }
  return out;
}

/** Abre un .xlsx en el puente y devuelve sus hojas (lo que guardó la app, leído por Rust). */
export async function readSheets(path: string): Promise<{ names: string[]; cell: (sheet: number, ref: string) => Promise<{ text: string; number: boolean }> }> {
  const call = async (cmd: string, args: unknown) => {
    const res = await fetch(`http://127.0.0.1:5199/${cmd}`, { method: "POST", body: JSON.stringify(args) });
    return res.json();
  };
  const first = await call("sheet_open", { path });
  return {
    names: first.sheet_names,
    cell: async (sheet, ref) => {
      const view = await call("sheet_view", { sheet });
      const col = ref.replace(/\d+/g, "").split("").reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
      const row = Number(ref.replace(/[A-Z]+/g, "")) - 1;
      const c = view.rows[row]?.[col] ?? ["", false];
      return { text: c[0], number: c[1] };
    },
  };
}

/** Errores de la página (se revisa al final de cada prueba que no haya). */
export function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    // El navegador completo pide el icono de la pestaña (favicon.ico), que la app no tiene en Vite.
    if (m.type() === "error" && !m.location().url.endsWith("/favicon.ico")) errors.push(m.text());
  });
  return errors;
}

/** Centro de una celda de la cuadrícula de Sheets ("B3"), en la pantalla. */
export async function cellPoint(page: Page, ref: string) {
  await page.waitForSelector(".grid-scroll .col-header");
  return page.evaluate((r) => {
    const col = r.replace(/[0-9]/g, "");
    const row = r.replace(/[A-Z]/g, "");
    const ch = [...document.querySelectorAll<HTMLElement>(".col-header")].find((h) => h.firstChild?.textContent === col)!;
    const rh = [...document.querySelectorAll<HTMLElement>(".row-header")].find((h) => h.firstChild?.textContent === row)!;
    const g = document.querySelector(".grid-scroll")!.getBoundingClientRect();
    return { x: g.left + parseFloat(ch.style.left) + 12, y: g.top + parseFloat(rh.style.top) + 8 };
  }, ref);
}

/** Lo que tiene la hoja abierta, según el motor (fila y columna desde 0). */
export async function sheetCell(page: Page, ref: string, sheet = 0): Promise<{ text: string; number: boolean }> {
  return page.evaluate(
    async ({ ref, sheet }) => {
      const res = await fetch("http://127.0.0.1:5199/sheet_view", { method: "POST", body: JSON.stringify({ sheet }) });
      const view = await res.json();
      const col = ref.replace(/\d+/g, "").split("").reduce((n: number, ch: string) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
      const row = Number(ref.replace(/[A-Z]+/g, "")) - 1;
      const c = view.rows[row]?.[col] ?? ["", false];
      return { text: c[0], number: c[1] };
    },
    { ref, sheet },
  );
}
