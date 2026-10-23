// Edición de PDF en WEPO: qué páginas quedan, en qué orden y giradas cuánto,
// y lo que se dibuja encima (resaltados, texto, trazos, firmas, notas). Para ver
// se usa pdf.js; para guardar, pdf-lib, que escribe el PDF nuevo.

import {
  BlendMode,
  PDFArray,
  PDFCheckBox,
  PDFDocument,
  PDFDropdown,
  PDFName,
  PDFNumber,
  PDFOptionList,
  PDFRadioGroup,
  PDFHexString,
  PDFString,
  PDFTextField,
  StandardFonts,
  degrees,
  rgb,
} from "pdf-lib";
import type { PDFFont, PDFPage } from "pdf-lib";
import type { PDFDocumentProxy } from "../../lib/pdf";

/** Un PDF abierto: el original o uno que se insertó para combinar. */
export type Source = { id: string; name: string; data: Uint8Array; doc: PDFDocumentProxy };

/** Una página de la versión editada: de qué PDF viene, cuál es y cuánto se giró. */
export type PageRef = {
  id: string;
  source: string;
  /** Índice (desde 0) en su PDF de origen. */
  index: number;
  /** Giro que ya traía la página en el archivo. */
  baseRotation: number;
  /** Giro que se le agregó en WEPO (0, 90, 180 o 270). */
  rotation: number;
  /** Tamaño sin girar, en puntos, y dónde empieza la página (esquina inferior izquierda). */
  width: number;
  height: number;
  x0: number;
  y0: number;
};

// ───────────── anotaciones (lo que se dibuja encima) ─────────────
// Las coordenadas van en puntos del PDF (origen abajo a la izquierda, como en el archivo).

type Base = { id: string; page: string };
export type Highlight = Base & { kind: "highlight"; rects: [number, number, number, number][]; color: string };
export type TextNote = Base & { kind: "text"; x: number; y: number; text: string; size: number; color: string };
export type Ink = Base & { kind: "ink"; paths: [number, number][][]; color: string; width: number };
export type Sticky = Base & { kind: "note"; x: number; y: number; text: string };
export type Stamp = Base & { kind: "image"; x: number; y: number; w: number; h: number; src: string };
export type Annotation = Highlight | TextNote | Ink | Sticky | Stamp;

/** Valores escritos en los campos de un formulario del PDF (por nombre del campo). */
export type FormValues = Record<string, string | boolean>;

let counter = 0;
export function pid(prefix = "p"): string {
  counter++;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}`;
}

export async function pagesOf(source: Source): Promise<PageRef[]> {
  const out: PageRef[] = [];
  for (let i = 0; i < source.doc.numPages; i++) {
    const page = await source.doc.getPage(i + 1);
    const view = page.view; // [x1, y1, x2, y2]
    out.push({ id: pid(), source: source.id, index: i, baseRotation: page.rotate, rotation: 0, width: view[2] - view[0], height: view[3] - view[1], x0: view[0], y0: view[1] });
  }
  return out;
}

/** Tamaño con que se ve la página (girada). */
export function shownSize(p: PageRef): { width: number; height: number } {
  const turn = (p.baseRotation + p.rotation) % 180 !== 0;
  return turn ? { width: p.height, height: p.width } : { width: p.width, height: p.height };
}

function hexColor(hex: string) {
  const h = hex.replace("#", "");
  return rgb(parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255);
}

function dataUrlBytes(src: string): { bytes: Uint8Array; png: boolean } | null {
  const m = /^data:image\/(png|jpeg|jpg);base64,(.*)$/.exec(src);
  if (!m) return null;
  const binary = atob(m[2]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { bytes, png: m[1] === "png" };
}

/** Texto de una nota: con acentos y ñ se escribe en Unicode (si no, se verían mal en otros lectores). */
function PDFText(text: string) {
  return /^[\x20-\x7e\n\r\t]*$/.test(text) ? PDFString.of(text) : PDFHexString.fromText(text);
}

/** Las fuentes estándar de PDF solo traen el alfabeto latino: lo demás se cambia por "?". */
function latin(text: string): string {
  return text.replace(/[^ -~ -ÿ\n]/g, "?");
}

/**
 * Encierra lo que ya dibuja la página entre q…Q. Así lo que se agrega encima no
 * hereda transformaciones que el contenido original deja sin cerrar (pasa con
 * PDFs de algunos programas) y los resaltados quedan justo sobre el texto.
 */
function isolateContent(page: PDFPage, out: PDFDocument) {
  page.node.normalize();
  const start = out.context.register(out.context.stream("q\n"));
  const end = out.context.register(out.context.stream("\nQ\n"));
  page.node.wrapContentStreams(start, end);
}

/** Dibujo del ícono de nota (un globo amarillo de 20 × 20) para que todo lector la muestre igual. */
const NOTE_ICON = [
  "1 0.824 0.2 rg 0.54 0.43 0 RG 1 w 1 j",
  "2 19 m 18 19 l 18 7 l 9 7 l 3.5 2 l 4.5 7 l 2 7 l h B",
  "0.54 0.43 0 RG 0.8 w 5 15 m 15 15 l S 5 11.5 m 12 11.5 l S",
].join("\n");

async function drawAnnotations(page: PDFPage, list: Annotation[], out: PDFDocument, font: () => Promise<PDFFont>, rotation: number) {
  if (list.some((a) => a.kind !== "note")) isolateContent(page, out);
  for (const a of list) {
    if (a.kind === "highlight") {
      for (const [x, y, w, h] of mergeLines(a.rects)) {
        page.drawRectangle({ x, y, width: w, height: h, color: hexColor(a.color), opacity: 0.4, blendMode: BlendMode.Multiply });
      }
    } else if (a.kind === "text") {
      const f = await font();
      const lines = latin(a.text).split("\n");
      lines.forEach((line, i) => {
        // El texto se escribe derecho tal como se ve, aunque la página esté girada.
        // (x, y) es la esquina de arriba a la izquierda del texto; cada línea baja 1.2 veces el tamaño.
        const dy = (i * 1.2 + 0.95) * a.size;
        const [ox, oy] = rotation === 90 ? [dy, 0] : rotation === 180 ? [0, dy] : rotation === 270 ? [-dy, 0] : [0, -dy];
        page.drawText(line, { x: a.x + ox, y: a.y + oy, size: a.size, font: f, color: hexColor(a.color), rotate: degrees(rotation) });
      });
    } else if (a.kind === "ink") {
      for (const path of a.paths) {
        for (let i = 1; i < path.length; i++) {
          page.drawLine({ start: { x: path[i - 1][0], y: path[i - 1][1] }, end: { x: path[i][0], y: path[i][1] }, thickness: a.width, color: hexColor(a.color), lineCap: 1 });
        }
      }
    } else if (a.kind === "image") {
      const data = dataUrlBytes(a.src);
      if (!data) continue;
      const image = data.png ? await out.embedPng(data.bytes) : await out.embedJpg(data.bytes);
      page.drawImage(image, { x: a.x, y: a.y, width: a.w, height: a.h });
    } else if (a.kind === "note") {
      // Nota adhesiva de verdad (anotación de texto): se abre en cualquier lector de PDF.
      const icon = out.context.register(out.context.stream(NOTE_ICON, { Type: "XObject", Subtype: "Form", BBox: [0, 0, 20, 20] }));
      const annot = out.context.obj({
        Type: "Annot",
        Subtype: "Text",
        Rect: [a.x, a.y - 20, a.x + 20, a.y],
        Contents: PDFText(a.text),
        Name: "Comment",
        Open: false,
        C: [1, 0.82, 0.2],
        // Imprimir (4) y sin girar con la página (16): el ícono queda derecho.
        F: PDFNumber.of(20),
        AP: { N: icon },
        M: PDFString.fromDate(new Date()),
      });
      const ref = out.context.register(annot);
      const annots = page.node.lookup(PDFName.of("Annots"));
      if (annots instanceof PDFArray) annots.push(ref);
      else page.node.set(PDFName.of("Annots"), out.context.obj([ref]));
    }
  }
}

type Rect = [number, number, number, number];

/**
 * Junta los rectángulos de un resaltado en una franja por renglón. El texto viene
 * en trozos (palabras, espacios) que se enciman un poco: dibujados por separado,
 * donde se tocan el color sale doble y se ven manchas más oscuras.
 */
export function mergeLines(rects: Rect[]): Rect[] {
  const out: Rect[] = [];
  for (const r of [...rects].sort((a, b) => b[1] + b[3] - (a[1] + a[3]) || a[0] - b[0])) {
    const [x, y, w, h] = r;
    const line = out.find(([lx, ly, lw, lh]) => {
      const overlap = Math.min(ly + lh, y + h) - Math.max(ly, y);
      const gap = Math.max(lx, x) - Math.min(lx + lw, x + w);
      return overlap >= 0.6 * Math.min(lh, h) && gap <= 0.8 * Math.max(lh, h);
    });
    if (!line) {
      out.push([x, y, w, h]);
      continue;
    }
    const left = Math.min(line[0], x);
    const bottom = Math.min(line[1], y);
    const right = Math.max(line[0] + line[2], x + w);
    const top = Math.max(line[1] + line[3], y + h);
    line[0] = left;
    line[1] = bottom;
    line[2] = right - left;
    line[3] = top - bottom;
  }
  // Dos renglones que se enciman apenas (interlineado justo) no se pintan doble.
  out.sort((a, b) => b[1] - a[1]);
  for (let i = 1; i < out.length; i++) {
    const above = out[i - 1];
    const r = out[i];
    const overlap = r[1] + r[3] - above[1];
    const sideBySide = Math.min(above[0] + above[2], r[0] + r[2]) > Math.max(above[0], r[0]);
    if (overlap > 0 && overlap < 0.6 * Math.min(r[3], above[3]) && sideBySide) r[3] -= overlap;
  }
  return out;
}

/** ¿Las páginas siguen siendo las del original, en su orden? (solo giradas o algunas quitadas) */
function sameDocument(pages: PageRef[], original: string): boolean {
  let last = -1;
  for (const p of pages) {
    if (p.source !== original || p.index <= last) return false;
    last = p.index;
  }
  return true;
}

/**
 * Escribe el PDF editado. Si solo se giraron o quitaron páginas del original, se
 * modifica el original (así conserva índice, formularios y datos); si se
 * reordenaron o combinaron, se arma un PDF nuevo con las páginas copiadas.
 */
export async function savePdf(sources: Source[], pages: PageRef[], annotations: Annotation[], form: FormValues = {}): Promise<Uint8Array> {
  const original = sources[0];
  const loaded = new Map<string, PDFDocument>();
  const load = async (id: string) => {
    const known = loaded.get(id);
    if (known) return known;
    const src = sources.find((s) => s.id === id)!;
    const doc = await PDFDocument.load(src.data, { updateMetadata: false });
    loaded.set(id, doc);
    return doc;
  };

  let out: PDFDocument;
  let outPages: PDFPage[];
  if (sameDocument(pages, original.id)) {
    out = await load(original.id);
    // Primero los campos del formulario (antes de quitar páginas).
    fillForm(out, form);
    const keep = new Set(pages.map((p) => p.index));
    for (let i = out.getPageCount() - 1; i >= 0; i--) if (!keep.has(i)) out.removePage(i);
    outPages = out.getPages();
  } else {
    out = await PDFDocument.create();
    const first = await load(original.id);
    fillForm(first, form);
    out.setTitle(first.getTitle() ?? "");
    outPages = [];
    for (const p of pages) {
      const src = await load(p.source);
      const [copy] = await out.copyPages(src, [p.index]);
      outPages.push(out.addPage(copy));
    }
  }
  let font: PDFFont | null = null;
  const getFont = async () => (font ??= await out.embedFont(StandardFonts.Helvetica));
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    const page = outPages[i];
    const total = (p.baseRotation + p.rotation) % 360;
    page.setRotation(degrees(total));
    await drawAnnotations(page, annotations.filter((a) => a.page === p.id), out, getFont, total);
  }
  out.setProducer("WEPO PDF");
  out.setModificationDate(new Date());
  return out.save();
}

function fillForm(doc: PDFDocument, values: FormValues) {
  const names = Object.keys(values);
  if (!names.length) return;
  const form = doc.getForm();
  for (const name of names) {
    const value = values[name];
    try {
      const field = form.getField(name);
      if (field instanceof PDFTextField) field.setText(String(value));
      else if (field instanceof PDFCheckBox) (value ? field.check() : field.uncheck());
      else if (field instanceof PDFDropdown) field.select(String(value));
      else if (field instanceof PDFRadioGroup) field.select(String(value));
      else if (field instanceof PDFOptionList) field.select(String(value));
    } catch {
      // Un campo que pdf-lib no reconoce se deja como estaba.
    }
  }
  try {
    form.updateFieldAppearances();
  } catch {
    // Sin fuentes para dibujar los valores, el lector de PDF los dibuja al abrir.
  }
}

// ───────────── coordenadas: PDF ↔ pantalla ─────────────
// En el PDF el origen está abajo a la izquierda y la página puede estar girada;
// en la pantalla, arriba a la izquierda. `s` son píxeles por punto.

export function toView(p: PageRef, s: number, x: number, y: number): [number, number] {
  const x1 = p.x0;
  const y1 = p.y0;
  const x2 = p.x0 + p.width;
  const y2 = p.y0 + p.height;
  switch ((p.baseRotation + p.rotation) % 360) {
    case 90:
      return [s * (y - y1), s * (x - x1)];
    case 180:
      return [s * (x2 - x), s * (y - y1)];
    case 270:
      return [s * (y2 - y), s * (x2 - x)];
    default:
      return [s * (x - x1), s * (y2 - y)];
  }
}

export function toPdf(p: PageRef, s: number, vx: number, vy: number): [number, number] {
  const x1 = p.x0;
  const y1 = p.y0;
  const x2 = p.x0 + p.width;
  const y2 = p.y0 + p.height;
  switch ((p.baseRotation + p.rotation) % 360) {
    case 90:
      return [vy / s + x1, vx / s + y1];
    case 180:
      return [x2 - vx / s, vy / s + y1];
    case 270:
      return [x2 - vy / s, y2 - vx / s];
    default:
      return [vx / s + x1, y2 - vy / s];
  }
}

/** Un rectángulo de la pantalla (x, y, ancho, alto) en puntos del PDF: [x, y, ancho, alto] con y abajo. */
export function rectToPdf(p: PageRef, s: number, vx: number, vy: number, vw: number, vh: number): [number, number, number, number] {
  const [ax, ay] = toPdf(p, s, vx, vy);
  const [bx, by] = toPdf(p, s, vx + vw, vy + vh);
  return [Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay)];
}

export function rectToView(p: PageRef, s: number, [x, y, w, h]: [number, number, number, number]): { left: number; top: number; width: number; height: number } {
  const [ax, ay] = toView(p, s, x, y);
  const [bx, by] = toView(p, s, x + w, y + h);
  return { left: Math.min(ax, bx), top: Math.min(ay, by), width: Math.abs(bx - ax), height: Math.abs(by - ay) };
}
