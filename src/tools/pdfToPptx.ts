// PDF a PowerPoint: una diapositiva por página. En modo «editable» el fondo es
// la página sin letras (formas, fotos y colores quedan igual) y cada bloque de
// texto es un cuadro de texto que se puede cambiar, con su letra, tamaño y color.

import type { Deck, Para, Run, ShapeElement, Slide } from "../editors/present/model";
import { newDeck, uid } from "../editors/present/model";
import { writePptx } from "../editors/present/pptxWrite";
import type { PDFDocumentProxy } from "../lib/pdf";
import { baseName, canvasBytes, proxyOf, renderPage } from "./pdfTools";

const PX = 96 / 72;
/** Escala del fondo (2 = el doble de puntos que la página: se ve nítido en pantalla). */
const SCALE = 2;

type Item = { text: string; x: number; base: number; w: number; size: number; font: string; bold: boolean; italic: boolean; color: string; angle: number };
type TLine = { items: Item[]; x0: number; x1: number; base: number; size: number };

const KNOWN: [RegExp, string][] = [
  [/times/i, "Times New Roman"],
  [/arial|helvetica|liberationsans|nimbussans/i, "Arial"],
  [/courier|mono/i, "Courier New"],
  [/calibri|carlito/i, "Calibri"],
  [/cambria|caladea/i, "Cambria"],
  [/georgia/i, "Georgia"],
  [/verdana/i, "Verdana"],
  [/garamond/i, "Garamond"],
  [/segoe/i, "Segoe UI"],
  [/roboto/i, "Roboto"],
  [/open ?sans/i, "Open Sans"],
  [/lato/i, "Lato"],
  [/montserrat/i, "Montserrat"],
  [/inter\b/i, "Inter"],
  [/sf ?pro|sfns|\.sf/i, "Helvetica Neue"],
  [/helveticaneue/i, "Helvetica Neue"],
];

/** Nombre de la letra a partir del de la fuente del PDF ("ABCDEF+Arial-BoldMT" → Arial, negrita). */
export function fontInfo(raw: string, fallback: string): { font: string; bold: boolean; italic: boolean } {
  const name = raw.replace(/^[A-Z]{6}\+/, "");
  const bold = /bold|black|heavy|semibold|demi|,b\b/i.test(name);
  const italic = /italic|oblique|,i\b/i.test(name);
  for (const [re, font] of KNOWN) if (re.test(name)) return { font, bold, italic };
  const base = name
    .split(/[-,]/)[0]
    .replace(/(MT|PS|PSMT|Std|Pro|LT)$/g, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim();
  if (base && /^[A-Za-z ]{3,}$/.test(base)) return { font: base, bold, italic };
  return { font: /serif/i.test(fallback) && !/sans/i.test(fallback) ? "Times New Roman" : /mono/i.test(fallback) ? "Courier New" : "Arial", bold, italic };
}

const hex2 = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");

/** Color de unas letras: los puntos donde la página con letras y la sin letras no coinciden. */
function inkColor(full: ImageData, bare: ImageData, x: number, y: number, w: number, h: number): string {
  const W = full.width;
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(W, Math.ceil(x + w));
  const y1 = Math.min(full.height, Math.ceil(y + h));
  let r = 0,
    g = 0,
    b = 0,
    n = 0,
    best = 0;
  // Se toman los puntos más distintos (el centro de los trazos, no las orillas suavizadas).
  const samples: [number, number, number, number][] = [];
  for (let yy = y0; yy < y1; yy++) {
    for (let xx = x0; xx < x1; xx++) {
      const i = (yy * W + xx) * 4;
      const d = Math.abs(full.data[i] - bare.data[i]) + Math.abs(full.data[i + 1] - bare.data[i + 1]) + Math.abs(full.data[i + 2] - bare.data[i + 2]);
      if (d > 60) samples.push([d, full.data[i], full.data[i + 1], full.data[i + 2]]);
      if (d > best) best = d;
    }
  }
  for (const [d, rr, gg, bb] of samples) {
    if (d < best * 0.7) continue;
    r += rr;
    g += gg;
    b += bb;
    n++;
  }
  if (!n) return "#000000";
  return `#${hex2(r / n)}${hex2(g / n)}${hex2(b / n)}`.toUpperCase();
}

async function pageItems(doc: PDFDocumentProxy, index: number, full: ImageData, bare: ImageData): Promise<{ items: Item[]; width: number; height: number }> {
  const page = await doc.getPage(index + 1);
  const view = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const items: Item[] = [];
  for (const it of content.items) {
    if (!("str" in it) || !it.str.trim()) continue;
    const [a, b, c, d, e, f] = it.transform as number[];
    const size = Math.hypot(c, d);
    if (size < 1) continue;
    const [x, base] = view.convertToViewportPoint(e, f);
    // Ángulo como se ve (el giro de la página ya va en la vista).
    const [ex, ey] = view.convertToViewportPoint(e + a, f + b);
    const angle = Math.round((Math.atan2(ey - base, ex - x) * 180) / Math.PI);
    const style = content.styles[it.fontName] as { fontFamily?: string } | undefined;
    let raw = "";
    try {
      raw = (page.commonObjs.get(it.fontName) as { name?: string } | undefined)?.name ?? "";
    } catch {
      raw = "";
    }
    const info = fontInfo(raw, style?.fontFamily ?? "sans-serif");
    const color = inkColor(full, bare, x * SCALE, (base - size * 0.85) * SCALE, Math.max(1, it.width) * SCALE, size * SCALE);
    items.push({ text: it.str, x, base, w: it.width, size, font: info.font, bold: info.bold, italic: info.italic, color, angle });
  }
  return { items, width: view.width, height: view.height };
}

function linesOf(items: Item[]): TLine[] {
  const sorted = items.filter((i) => Math.abs(i.angle) < 2).sort((a, b) => a.base - b.base || a.x - b.x);
  const lines: TLine[] = [];
  for (const it of sorted) {
    const line = lines.find((l) => Math.abs(l.base - it.base) < Math.max(l.size, it.size) * 0.35 && it.x - l.x1 < Math.max(l.size, it.size) * 0.9 && it.x + it.w > l.x0 - 1);
    if (line) {
      line.items.push(it);
      line.x0 = Math.min(line.x0, it.x);
      line.x1 = Math.max(line.x1, it.x + it.w);
      line.size = Math.max(line.size, it.size);
    } else {
      lines.push({ items: [it], x0: it.x, x1: it.x + it.w, base: it.base, size: it.size });
    }
  }
  for (const l of lines) l.items.sort((a, b) => a.x - b.x);
  return lines.sort((a, b) => a.base - b.base || a.x0 - b.x0);
}

function runsOf(line: TLine, k: number): Run[] {
  const runs: Run[] = [];
  let prev: Item | null = null;
  for (const it of line.items) {
    let text = it.text;
    if (prev) {
      const gap = it.x - (prev.x + prev.w);
      if (gap > it.size * 0.15 && !/\s$/.test(prev.text) && !/^\s/.test(text)) text = " " + text;
    }
    const size = Math.round(it.size * k * 2) / 2;
    const last = runs[runs.length - 1];
    if (last && last.font === it.font && Boolean(last.bold) === it.bold && Boolean(last.italic) === it.italic && last.size === size && last.color === it.color) last.text += text;
    else runs.push({ text, font: it.font, size, color: it.color, ...(it.bold ? { bold: true } : {}), ...(it.italic ? { italic: true } : {}) });
    prev = it;
  }
  if (runs.length) runs[runs.length - 1].text = runs[runs.length - 1].text.replace(/\s+$/, "");
  return runs;
}

/** Junta renglones seguidos (misma orilla o mismo centro, poco espacio entre ellos) en cuadros de texto. */
function textBoxes(lines: TLine[], k: number): ShapeElement[] {
  type Group = { lines: TLine[] };
  const groups: Group[] = [];
  for (const line of lines) {
    const g = groups.find((gr) => {
      const last = gr.lines[gr.lines.length - 1];
      const gap = line.base - line.size * 0.8 - last.base;
      const sameSize = Math.max(line.size, last.size) / Math.min(line.size, last.size) < 1.3;
      const left = Math.abs(line.x0 - last.x0) < last.size * 1.2;
      const center = Math.abs((line.x0 + line.x1) / 2 - (last.x0 + last.x1) / 2) < last.size * 1.2;
      const overlap = line.x0 < last.x1 && line.x1 > last.x0;
      return gap > -last.size * 0.2 && gap < last.size * 0.9 && sameSize && overlap && (left || center);
    });
    if (g) g.lines.push(line);
    else groups.push({ lines: [line] });
  }
  return groups.map((g) => {
    const x0 = Math.min(...g.lines.map((l) => l.x0));
    const x1 = Math.max(...g.lines.map((l) => l.x1));
    const first = g.lines[0];
    const last = g.lines[g.lines.length - 1];
    const top = first.base - first.size * 0.95;
    const bottom = last.base + last.size * 0.3;
    const lefts = g.lines.map((l) => l.x0);
    const rights = g.lines.map((l) => l.x1);
    const centers = g.lines.map((l) => (l.x0 + l.x1) / 2);
    const spread = (v: number[]) => Math.max(...v) - Math.min(...v);
    const align: Para["align"] = g.lines.length > 1 && spread(lefts) > first.size && spread(centers) < first.size * 0.6 ? "center" : g.lines.length > 1 && spread(lefts) > first.size && spread(rights) < first.size * 0.6 ? "right" : undefined;
    // Interlineado: la distancia entre renglones contra la normal (1.2 veces la letra).
    const pitch = g.lines.length > 1 ? (last.base - first.base) / (g.lines.length - 1) : first.size * 1.2;
    const spacing = Math.max(0.8, Math.min(3, pitch / (first.size * 1.2)));
    const paras: Para[] = g.lines.map((l) => ({
      runs: runsOf(l, k),
      ...(align ? { align } : {}),
      ...(g.lines.length > 1 && Math.abs(spacing - 1) > 0.05 ? { lineSpacing: Math.round(spacing * 100) / 100 } : {}),
    }));
    const w = (x1 - x0) * 1.04 + first.size * 0.6;
    const pxX = (align === "center" ? (x0 + x1) / 2 - w / 2 : align === "right" ? x1 - w : x0) * PX * k;
    return {
      id: uid(),
      kind: "shape",
      geom: "rect",
      fill: null,
      line: null,
      x: pxX,
      y: top * PX * k,
      w: w * PX * k,
      h: (bottom - top) * PX * k,
      text: { paras, insets: [0, 0, 0, 0], anchor: "top" },
    } satisfies ShapeElement;
  });
}

/** Los textos girados van cada uno en su cuadro, girado igual. */
function rotatedBoxes(items: Item[], k: number): ShapeElement[] {
  return items
    .filter((i) => Math.abs(i.angle) >= 2 && i.text.trim())
    .map((it) => {
      const w = it.w + it.size * 0.6;
      const h = it.size * 1.25;
      const rad = (it.angle * Math.PI) / 180;
      // Centro del texto (desde la línea base, a lo largo del ángulo).
      const cx = it.x + Math.cos(rad) * (it.w / 2) + Math.sin(rad) * (it.size * 0.3);
      const cy = it.base + Math.sin(rad) * (it.w / 2) - Math.cos(rad) * (it.size * 0.3);
      return {
        id: uid(),
        kind: "shape",
        geom: "rect",
        fill: null,
        line: null,
        x: (cx - w / 2) * PX * k,
        y: (cy - h / 2) * PX * k,
        w: w * PX * k,
        h: h * PX * k,
        rot: ((it.angle % 360) + 360) % 360,
        text: { paras: [{ runs: [{ text: it.text, font: it.font, size: Math.round(it.size * k * 2) / 2, color: it.color, ...(it.bold ? { bold: true } : {}), ...(it.italic ? { italic: true } : {}) }], align: "center" }], insets: [0, 0, 0, 0], anchor: "middle" },
      } satisfies ShapeElement;
    });
}

async function dataUrl(canvas: HTMLCanvasElement): Promise<string> {
  const bytes = await canvasBytes(canvas, "jpg", 0.86);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:image/jpeg;base64,${btoa(binary)}`;
}

export async function pdfToDeck(bytes: Uint8Array, name: string, editable: boolean, onPage?: (done: number, total: number) => void): Promise<Deck> {
  const doc = await proxyOf(bytes, name);
  const deck = newDeck();
  deck.slides = [];
  const first = (await doc.getPage(1)).getViewport({ scale: 1 });
  deck.width = Math.round(first.width * PX);
  deck.height = Math.round(first.height * PX);
  for (let i = 0; i < doc.numPages; i++) {
    const full = await renderPage(doc, i, SCALE);
    const slide: Slide = { id: uid("s"), layout: "blank", background: "#FFFFFF", elements: [], notes: "" };
    const view = (await doc.getPage(i + 1)).getViewport({ scale: 1 });
    // Páginas de otro tamaño: se acomodan en la diapositiva (el ancho manda).
    const k = Math.min(deck.width / (view.width * PX), deck.height / (view.height * PX));
    if (editable) {
      const bare = await renderPage(doc, i, SCALE, true);
      const g1 = full.getContext("2d")!;
      const g2 = bare.getContext("2d")!;
      const { items } = await pageItems(doc, i, g1.getImageData(0, 0, full.width, full.height), g2.getImageData(0, 0, bare.width, bare.height));
      slide.backgroundImage = await dataUrl(bare);
      slide.elements = [...textBoxes(linesOf(items), k), ...rotatedBoxes(items, k)];
      bare.width = bare.height = 0;
    } else {
      slide.backgroundImage = await dataUrl(full);
    }
    full.width = full.height = 0;
    if (k < 0.999) {
      // La imagen de fondo cubre toda la diapositiva: la página va como imagen centrada.
      const bg = slide.backgroundImage!;
      slide.backgroundImage = null;
      const w = view.width * PX * k;
      const h = view.height * PX * k;
      const dx = (deck.width - w) / 2;
      const dy = (deck.height - h) / 2;
      slide.elements = [{ id: uid(), kind: "image", src: bg, x: dx, y: dy, w, h }, ...slide.elements.map((e) => ({ ...e, x: e.x + dx, y: e.y + dy }))];
    }
    deck.slides.push(slide);
    onPage?.(i + 1, doc.numPages);
  }
  return deck;
}

export async function pdfToPptx(bytes: Uint8Array, name: string, editable: boolean, onPage?: (done: number, total: number) => void): Promise<Uint8Array> {
  const deck = await pdfToDeck(bytes, name, editable, onPage);
  return writePptx(deck, baseName(name));
}
