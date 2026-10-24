// Convertir un PDF en algo editable: reconstruye títulos, párrafos, listas,
// tablas, recuadros, código e imágenes a partir de lo que dibuja cada página.
//
// Un PDF no guarda párrafos ni tablas, solo letras en posiciones fijas y líneas o
// rectángulos. Aquí se juntan las letras en renglones y los renglones en bloques,
// se reconocen las tablas por sus bordes, los títulos por su tamaño o por estar
// sobre una franja oscura, y las viñetas por el punto que va antes del renglón.
// El color de cada palabra se toma de la página dibujada.
//
// El resultado (`Converted`) es neutro: pdfToWrite lo pasa a un documento de
// WEPO Write y pdfTables saca solo sus tablas (para WEPO Sheets).

import { OPS, Util } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.mjs";

// ───────────── lo que sale ─────────────

export type Run = { text: string; bold: boolean; italic: boolean; size: number; mono: boolean; color: string | null; font: string | null };
export type Align = "left" | "center" | "right";
export type Cell = { blocks: Block[]; colspan: number; rowspan: number; fill: string | null; text: string };
export type Block =
  | { kind: "paragraph"; runs: Run[]; align: Align; size: number }
  | { kind: "heading"; level: 1 | 2 | 3; runs: Run[]; align: Align }
  | { kind: "list"; ordered: boolean; start: number; items: Run[][] }
  | { kind: "quote"; blocks: Block[]; fill: string }
  | { kind: "code"; text: string }
  | { kind: "table"; rows: Cell[][]; widths: number[]; header: boolean; boxes: boolean }
  | { kind: "image"; src: string; width: number; height: number; align: Align }
  | { kind: "pageBreak" };

export type Converted = {
  blocks: Block[];
  /** Tamaño de la hoja y márgenes, en puntos. */
  page: { width: number; height: number; top: number; right: number; bottom: number; left: number };
  header: { text: string; align: Align } | null;
  footer: { text: string; align: Align } | null;
  /** Tamaño de letra más común (el del texto normal). */
  bodySize: number;
  pages: number;
};

/** Qué páginas convertir: de qué PDF, cuál (desde 0) y con qué giro. */
export type PageInput = { doc: PDFDocumentProxy; index: number; rotation: number };

// ───────────── lo que se lee de cada página ─────────────

type Item = { text: string; x: number; base: number; w: number; size: number; bold: boolean; italic: boolean; mono: boolean; color: string | null; font: string | null };
type Rect = { x: number; y: number; w: number; h: number };
type Fill = Rect & { color: string };
type Seg = { x1: number; y1: number; x2: number; y2: number; horizontal: boolean };
type Img = Rect & { src: string };
type Line = {
  items: Item[];
  runs: Run[];
  text: string;
  x0: number;
  x1: number;
  base: number;
  size: number;
  bullet: boolean;
  band: Fill | null;
};
type PageData = { width: number; height: number; items: Item[]; fills: Fill[]; segs: Seg[]; dots: Fill[]; images: Img[] };

const WHITE = /^#f[a-f0-9]f[a-f0-9]f[a-f0-9]$/i;

function hexRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function luminance(hex: string): number {
  const [r, g, b] = hexRgb(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}
function toHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
}
const contains = (r: Rect, x: number, y: number, pad = 0) => x >= r.x - pad && x <= r.x + r.w + pad && y >= r.y - pad && y <= r.y + r.h + pad;

async function readPage(input: PageInput, sampleColors: boolean): Promise<PageData> {
  const page: PDFPageProxy = await input.doc.getPage(input.index + 1);
  const viewport = page.getViewport({ scale: 1, rotation: (page.rotate + input.rotation) % 360 });
  const ops = await page.getOperatorList();
  const content = await page.getTextContent();

  // Figuras: bordes (rectángulos muy delgados), fondos, puntos de viñeta e imágenes.
  const fills: Fill[] = [];
  const segs: Seg[] = [];
  const dots: Fill[] = [];
  const images: Img[] = [];
  let ctm = viewport.transform.slice();
  let fill = "#000000";
  let stroke = "#000000";
  const stack: [number[], string, string][] = [];
  const at = (x: number, y: number) => [x * ctm[0] + y * ctm[2] + ctm[4], x * ctm[1] + y * ctm[3] + ctm[5]];
  const box = (x0: number, y0: number, x1: number, y1: number): Rect => {
    const pts = [at(x0, y0), at(x1, y0), at(x0, y1), at(x1, y1)];
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  };
  const addSeg = (r: Rect) => {
    if (r.h <= 1.6 && r.w > 2) segs.push({ x1: r.x, x2: r.x + r.w, y1: r.y + r.h / 2, y2: r.y + r.h / 2, horizontal: true });
    else if (r.w <= 1.6 && r.h > 2) segs.push({ x1: r.x + r.w / 2, x2: r.x + r.w / 2, y1: r.y, y2: r.y + r.h, horizontal: false });
  };
  const imageJobs: Promise<void>[] = [];
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i] as unknown[];
    if (fn === OPS.save) stack.push([ctm.slice(), fill, stroke]);
    else if (fn === OPS.restore) {
      const prev = stack.pop();
      if (prev) [ctm, fill, stroke] = prev;
    } else if (fn === OPS.transform) ctm = Util.transform(ctm, args as number[]);
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push([ctm.slice(), fill, stroke]);
      if (Array.isArray(args[0])) ctm = Util.transform(ctm, args[0] as number[]);
    } else if (fn === OPS.paintFormXObjectEnd) {
      const prev = stack.pop();
      if (prev) [ctm, fill, stroke] = prev;
    } else if (fn === OPS.setFillRGBColor) fill = String(args[0]);
    else if (fn === OPS.setStrokeRGBColor) stroke = String(args[0]);
    else if (fn === OPS.constructPath) {
      const paint = args[0] as number;
      const mm = args[2] as number[] | null;
      if (!mm || paint === OPS.endPath) continue;
      const r = box(mm[0], mm[1], mm[2], mm[3]);
      const filled = paint === OPS.fill || paint === OPS.eoFill || paint === OPS.fillStroke || paint === OPS.eoFillStroke || paint === OPS.closeFillStroke || paint === OPS.closeEOFillStroke;
      const stroked = paint === OPS.stroke || paint === OPS.closeStroke || paint === OPS.fillStroke || paint === OPS.eoFillStroke || paint === OPS.closeFillStroke || paint === OPS.closeEOFillStroke;
      if (filled) {
        if (r.w <= 1.6 || r.h <= 1.6) addSeg(r);
        else if (r.w <= 6.5 && r.h <= 6.5 && Math.abs(r.w - r.h) < 2) dots.push({ ...r, color: fill });
        else if (!WHITE.test(fill)) fills.push({ ...r, color: fill });
      }
      if (stroked && !filled && r.w > 2 && r.h > 2 && !(r.w <= 1.6 || r.h <= 1.6)) {
        // Un rectángulo con borde: sus cuatro lados.
        addSeg({ x: r.x, y: r.y, w: r.w, h: 0 });
        addSeg({ x: r.x, y: r.y + r.h, w: r.w, h: 0 });
        addSeg({ x: r.x, y: r.y, w: 0, h: r.h });
        addSeg({ x: r.x + r.w, y: r.y, w: 0, h: r.h });
      } else if (stroked) addSeg(r);
      void stroke;
    } else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
      const r = box(0, 0, 1, 1);
      if (r.w < 12 || r.h < 12) continue;
      const source = fn === OPS.paintInlineImageXObject ? Promise.resolve(args[0]) : imageObject(page, String(args[0]));
      imageJobs.push(
        source
          .then((obj) => {
            const src = imageUrl(obj);
            if (src) images.push({ ...r, src });
          })
          .catch(() => {}),
      );
    }
  }
  await Promise.all(imageJobs);

  // Letras: posición, tamaño, si es negrita o cursiva (por el nombre de la fuente).
  const items: Item[] = [];
  for (const raw of content.items as { str?: string; transform: number[]; width: number; fontName: string }[]) {
    if (typeof raw.str !== "string" || !raw.str.trim()) continue;
    const t = Util.transform(viewport.transform, raw.transform);
    // Texto girado respecto de la página (sellos, marcas de agua): se deja fuera.
    if (Math.abs(t[1]) > Math.abs(t[0]) * 0.2 + 0.01) continue;
    const size = Math.hypot(t[2], t[3]);
    if (size < 2) continue;
    const font = fontInfo(page, raw.fontName, content.styles as Record<string, { fontFamily?: string }>);
    const text = raw.str.replace(/\s+/g, " ");
    items.push({ text, x: t[4], base: t[5], w: raw.width > 0 ? raw.width : size * 0.5 * text.length, size, ...font, color: null });
  }
  if (sampleColors && items.length) await sampleTextColors(page, viewport.rotation, items);
  page.cleanup();
  return { width: viewport.width, height: viewport.height, items, fills, segs, dots, images };
}

function fontInfo(page: PDFPageProxy, name: string, styles: Record<string, { fontFamily?: string }>) {
  let real = "";
  let flags: { bold?: boolean; black?: boolean; italic?: boolean } = {};
  try {
    if (page.commonObjs.has(name)) {
      const f = page.commonObjs.get(name) as { name?: string; bold?: boolean; black?: boolean; italic?: boolean };
      real = f?.name ?? "";
      flags = f ?? {};
    }
  } catch {
    // Fuente sin datos: se queda como normal.
  }
  const family = styles[name]?.fontFamily ?? "";
  return {
    font: familyName(real),
    bold: Boolean(flags.bold || flags.black) || /bold|black|heavy|semibold|demibold|extrabold/i.test(real),
    italic: Boolean(flags.italic) || /italic|oblique/i.test(real),
    mono: /mono|courier|consol|menlo|code/i.test(real) || family === "monospace",
  };
}

/** Nombre de la familia a partir del de la fuente del PDF ("ABCDEF+Arial-BoldMT" → "Arial"). */
const SAME_AS: Record<string, string> = {
  LiberationSans: "Arial",
  LiberationSerif: "Times New Roman",
  LiberationMono: "Courier New",
  ArialMT: "Arial",
  TimesNewRomanPSMT: "Times New Roman",
  TimesNewRoman: "Times New Roman",
  CourierNewPSMT: "Courier New",
  Helvetica: "Helvetica",
  Times: "Times New Roman",
  DejaVuSans: "DejaVu Sans",
  DejaVuSerif: "DejaVu Serif",
  DejaVuSansMono: "DejaVu Sans Mono",
};
function familyName(real: string): string | null {
  const base = real.replace(/^[A-Z]{6}\+/, "").split(/[-,]/)[0].replace(/(PSMT|MT|PS)$/, "");
  if (!base || /^(T3|Type3|F\d+)$/i.test(base)) return null;
  return SAME_AS[base] ?? SAME_AS[base.replace(/(Bold|Italic|Regular)+$/, "")] ?? base.replace(/(Bold|Italic|Oblique|Regular)+$/, "").replace(/([a-z])([A-Z])/g, "$1 $2");
}

function imageObject(page: PDFPageProxy, id: string): Promise<unknown> {
  const store = id.startsWith("g_") ? page.commonObjs : page.objs;
  return new Promise((resolve) => {
    try {
      store.get(id, resolve);
    } catch {
      resolve(null);
    }
  });
}

/** Una imagen de pdf.js como data URL (PNG, o JPEG si es grande). */
function imageUrl(obj: unknown): string | null {
  const img = obj as { bitmap?: ImageBitmap; width?: number; height?: number; data?: Uint8ClampedArray; kind?: number } | null;
  if (!img) return null;
  const width = img.bitmap?.width ?? img.width ?? 0;
  const height = img.bitmap?.height ?? img.height ?? 0;
  if (!width || !height || width * height > 25_000_000) return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  if (img.bitmap) ctx.drawImage(img.bitmap, 0, 0);
  else if (img.data) {
    const out = ctx.createImageData(width, height);
    const src = img.data;
    const n = width * height;
    if (img.kind === 3 || src.length === n * 4) out.data.set(src.subarray(0, n * 4));
    else if (img.kind === 2 || src.length === n * 3) for (let i = 0, j = 0; i < n; i++, j += 3) out.data.set([src[j], src[j + 1], src[j + 2], 255], i * 4);
    else if (img.kind === 1) {
      // 1 bit por píxel, filas alineadas a byte.
      const row = Math.ceil(width / 8);
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const v = (src[y * row + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0;
          out.data.set([v, v, v, 255], (y * width + x) * 4);
        }
    } else return null;
    ctx.putImageData(out, 0, 0);
  } else return null;
  return width * height > 1_000_000 ? canvas.toDataURL("image/jpeg", 0.9) : canvas.toDataURL("image/png");
}

/** El color de cada palabra: el píxel más distinto del fondo dentro de su recuadro. */
async function sampleTextColors(page: PDFPageProxy, rotation: number, items: Item[]) {
  const S = 2;
  const viewport = page.getViewport({ scale: S, rotation });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return;
  try {
    await page.render({ canvas, viewport }).promise;
  } catch {
    return;
  }
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  for (const it of items) {
    const x0 = Math.max(0, Math.floor(it.x * S));
    const x1 = Math.min(width - 1, Math.ceil((it.x + it.w) * S));
    const y0 = Math.max(0, Math.floor((it.base - it.size * 0.8) * S));
    const y1 = Math.min(height - 1, Math.ceil((it.base + it.size * 0.1) * S));
    if (x1 <= x0 || y1 <= y0) continue;
    // Fondo: el color más común en el recuadro.
    const counts = new Map<number, number>();
    const step = Math.max(1, Math.floor(((x1 - x0) * (y1 - y0)) / 4000));
    for (let y = y0, k = 0; y <= y1; y++)
      for (let x = x0; x <= x1; x++, k++) {
        if (k % step) continue;
        const o = (y * width + x) * 4;
        const key = ((data[o] >> 3) << 10) | ((data[o + 1] >> 3) << 5) | (data[o + 2] >> 3);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    let bgKey = 0;
    let best = -1;
    for (const [k, c] of counts) if (c > best) [bgKey, best] = [k, c];
    const bg = [((bgKey >> 10) & 31) * 8 + 4, ((bgKey >> 5) & 31) * 8 + 4, (bgKey & 31) * 8 + 4];
    let far = 0;
    let color: [number, number, number] | null = null;
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const o = (y * width + x) * 4;
        const d = Math.abs(data[o] - bg[0]) + Math.abs(data[o + 1] - bg[1]) + Math.abs(data[o + 2] - bg[2]);
        if (d > far) [far, color] = [d, [data[o], data[o + 1], data[o + 2]]];
      }
    if (color && far > 60) it.color = toHex(...color);
  }
}

// ───────────── renglones ─────────────

function makeLines(items: Item[]): Line[] {
  const sorted = [...items].sort((a, b) => a.base - b.base || a.x - b.x);
  const lines: Item[][] = [];
  for (const it of sorted) {
    const line = lines[lines.length - 1];
    const ref = line?.[0];
    if (line && Math.abs(it.base - ref.base) <= 0.35 * Math.min(it.size, ref.size) + 0.5) line.push(it);
    else lines.push([it]);
  }
  return lines.map((items) => lineFrom(items.sort((a, b) => a.x - b.x)));
}

function lineFrom(items: Item[]): Line {
  const runs: Run[] = [];
  let prev: Item | null = null;
  for (const it of items) {
    let text = it.text;
    if (prev) {
      const gap = it.x - (prev.x + prev.w);
      const last = runs[runs.length - 1];
      if (gap > 0.15 * Math.min(it.size, prev.size) && !last.text.endsWith(" ") && !text.startsWith(" ")) last.text += " ";
    }
    const style = { bold: it.bold, italic: it.italic, size: Math.round(it.size * 2) / 2, mono: it.mono, color: it.color, font: it.font };
    const last = runs[runs.length - 1];
    if (last && sameStyle(last, style)) last.text += text;
    else runs.push({ text, ...style });
    prev = it;
    text = "";
  }
  if (runs.length) {
    runs[0].text = runs[0].text.replace(/^\s+/, "");
    runs[runs.length - 1].text = runs[runs.length - 1].text.replace(/\s+$/, "");
  }
  const size = Math.max(...items.map((i) => i.size));
  return {
    items,
    runs: runs.filter((r) => r.text),
    text: runs.map((r) => r.text).join(""),
    x0: Math.min(...items.map((i) => i.x)),
    x1: Math.max(...items.map((i) => i.x + i.w)),
    base: items.reduce((s, i) => s + i.base * i.size, 0) / items.reduce((s, i) => s + i.size, 0),
    size,
    bullet: false,
    band: null,
  };
}

// ───────────── tablas (por sus bordes) ─────────────

type TableArea = Rect & { xs: number[]; ys: number[]; segs: Seg[] };

function cluster(values: number[], tolerance: number): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const out: number[][] = [];
  for (const v of sorted) {
    const last = out[out.length - 1];
    if (last && v - last[last.length - 1] <= tolerance) last.push(v);
    else out.push([v]);
  }
  return out.map((g) => g.reduce((s, v) => s + v, 0) / g.length);
}

function findTables(segs: Seg[]): TableArea[] {
  // Bordes que se tocan forman un grupo; un grupo con 2+ horizontales y 2+ verticales es una tabla.
  const parent = segs.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const touch = (a: Seg, b: Seg) => {
    const pad = 2;
    return Math.min(a.x1, a.x2) - pad <= Math.max(b.x1, b.x2) && Math.min(b.x1, b.x2) - pad <= Math.max(a.x1, a.x2) && Math.min(a.y1, a.y2) - pad <= Math.max(b.y1, b.y2) && Math.min(b.y1, b.y2) - pad <= Math.max(a.y1, a.y2);
  };
  for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) if (touch(segs[i], segs[j])) parent[find(i)] = find(j);
  const groups = new Map<number, Seg[]>();
  segs.forEach((s, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), s]));
  const out: TableArea[] = [];
  for (const g of groups.values()) {
    const hs = g.filter((s) => s.horizontal);
    const vs = g.filter((s) => !s.horizontal);
    if (hs.length < 2 || vs.length < 2) continue;
    const xs = cluster(vs.map((s) => s.x1), 2.5);
    const ys = cluster(hs.map((s) => s.y1), 2.5);
    if (xs.length < 2 || ys.length < 2) continue;
    const x = Math.min(...g.map((s) => Math.min(s.x1, s.x2)));
    const y = Math.min(...g.map((s) => Math.min(s.y1, s.y2)));
    const w = Math.max(...g.map((s) => Math.max(s.x1, s.x2))) - x;
    const h = Math.max(...g.map((s) => Math.max(s.y1, s.y2))) - y;
    if (w < 30 || h < 10) continue;
    out.push({ x, y, w, h, xs, ys, segs: g });
  }
  return out;
}

/** ¿Hay borde entre dos celdas? (vertical en x entre y1–y2, u horizontal en y entre x1–x2) */
function hasBorder(segs: Seg[], horizontal: boolean, at: number, from: number, to: number): boolean {
  const mid = (from + to) / 2;
  return segs.some((s) =>
    horizontal
      ? s.horizontal && Math.abs(s.y1 - at) <= 2.5 && Math.min(s.x1, s.x2) - 2 <= mid && Math.max(s.x1, s.x2) + 2 >= mid
      : !s.horizontal && Math.abs(s.x1 - at) <= 2.5 && Math.min(s.y1, s.y2) - 2 <= mid && Math.max(s.y1, s.y2) + 2 >= mid,
  );
}

// ───────────── armar los bloques ─────────────

type Ctx = { body: number; headingSizes: number[] };

const BULLET = /^[•●▪■◦‣∙·○◆►▸–—-]\s+/;
const ORDERED = /^(\d{1,3})[.)]\s+/;

function sameStyle(a: Omit<Run, "text">, b: Omit<Run, "text">): boolean {
  return a.bold === b.bold && a.italic === b.italic && Math.abs(a.size - b.size) < 0.6 && a.mono === b.mono && a.color === b.color && a.font === b.font;
}

function stripPrefix(runs: Run[], pattern: RegExp): Run[] {
  const out = runs.map((r) => ({ ...r }));
  if (out.length) out[0].text = out[0].text.replace(pattern, "");
  return out.filter((r) => r.text);
}

function joinRuns(a: Run[], b: Run[]): Run[] {
  const out = a.map((r) => ({ ...r }));
  const last = out[out.length - 1];
  // Un guion al final del renglón se conserva (en estos PDF casi nunca es una palabra partida).
  if (last && !/[\s/-]$/.test(last.text)) last.text += " ";
  for (const r of b) {
    const tail = out[out.length - 1];
    if (tail && sameStyle(tail, r)) tail.text += r.text;
    else out.push({ ...r });
  }
  return out;
}

function alignOf(lines: Line[], left: number, right: number): Align {
  const width = right - left;
  if (width <= 0) return "left";
  const centered =
    lines.every((l) => centeredIn(l, left, right)) && (lines.some((l) => l.x0 - left > width * 0.12) || lines.length > 1);
  if (centered) return "center";
  if (lines.every((l) => l.x0 - left > width * 0.35 && right - l.x1 < Math.max(6, width * 0.03))) return "right";
  return "left";
}

/** ¿El renglón está centrado en el espacio que lo contiene? */
function centeredIn(line: Line, left: number, right: number): boolean {
  const width = right - left;
  return width > 0 && Math.abs((line.x0 + line.x1) / 2 - (left + right) / 2) < Math.max(4, width * 0.05) && line.x0 - left > 3;
}

function headingLevel(size: number, ctx: Ctx): 1 | 2 | 3 {
  const i = ctx.headingSizes.findIndex((s) => Math.abs(s - size) < 0.8);
  return (Math.min(3, (i < 0 ? ctx.headingSizes.length : i) + 1) as 1 | 2 | 3) || 1;
}

/** Bloques a partir de renglones (de la página, de una celda o de un recuadro). */
function buildBlocks(lines: Line[], left: number, right: number, ctx: Ctx, allowHeadings = true): Block[] {
  const out: Block[] = [];
  const sorted = [...lines].sort((a, b) => a.base - b.base || a.x0 - b.x0);
  type Para = { lines: Line[]; runs: Run[]; x0: number; size: number };
  let para: Para | null = null;
  let list: { block: Extract<Block, { kind: "list" }>; textX: number; last: Line; size: number } | null = null;
  const flushPara = () => {
    if (para && para.runs.length) out.push({ kind: "paragraph", runs: para.runs, align: alignOf(para.lines, left, right), size: para.size });
    para = null;
  };
  const flushList = () => {
    if (list) out.push(list.block);
    list = null;
  };

  for (let i = 0; i < sorted.length; i++) {
    const line = sorted[i];
    // Franjas: oscura con letra de código → bloque de código; oscura → título; clara → cita.
    if (line.band) {
      const band = line.band;
      const group = [line];
      while (i + 1 < sorted.length && sorted[i + 1].band === band) group.push(sorted[++i]);
      flushPara();
      flushList();
      const dark = luminance(band.color) < 0.45;
      if (group.every((l) => l.runs.every((r) => r.mono))) {
        const minX = Math.min(...group.map((l) => l.x0));
        const charW = group[0].size * 0.6;
        out.push({ kind: "code", text: group.map((l) => " ".repeat(Math.max(0, Math.round((l.x0 - minX) / charW))) + l.text).join("\n") });
      } else if (dark && allowHeadings) {
        const runs = group.slice(1).reduce((acc, l) => joinRuns(acc, l.runs), group[0].runs).map((r) => ({ ...r, color: null }));
        out.push({ kind: "heading", level: 2, runs, align: alignOf(group, band.x, band.x + band.w) });
      } else {
        out.push({ kind: "quote", fill: band.color, blocks: buildBlocks(group.map((l) => ({ ...l, band: null })), band.x, band.x + band.w, ctx, false) });
      }
      continue;
    }
    const big = allowHeadings && line.size >= ctx.body * 1.3;
    const ordered = ORDERED.exec(line.text);
    const textBullet = BULLET.test(line.text);
    const isItem = line.bullet || textBullet || Boolean(ordered && (list?.block.ordered || !para || line.x0 < (para as Para).x0 - 1 || line.base - (para as Para).lines[(para as Para).lines.length - 1].base > line.size * 1.75));

    if (big) {
      flushPara();
      flushList();
      const prev = out[out.length - 1];
      // Un título de varios renglones del mismo tamaño se junta.
      const prevLine = sorted[i - 1];
      if (prev?.kind === "heading" && prevLine && !prevLine.band && Math.abs(prevLine.size - line.size) < 0.6 && line.base - prevLine.base < line.size * 1.8) {
        prev.runs = joinRuns(prev.runs, line.runs);
      } else out.push({ kind: "heading", level: headingLevel(line.size, ctx), runs: line.runs, align: alignOf([line], left, right) });
      continue;
    }

    if (isItem) {
      flushPara();
      const isOrdered = !line.bullet && !textBullet && Boolean(ordered);
      const runs = isOrdered ? stripPrefix(line.runs, ORDERED) : textBullet ? stripPrefix(line.runs, BULLET) : line.runs;
      const textX = line.bullet || !runs.length ? line.x0 : line.x0 + (line.x1 - line.x0) * ((line.text.length - runs.map((r) => r.text).join("").length) / Math.max(1, line.text.length));
      if (!list || list.block.ordered !== isOrdered || line.base - list.last.base > line.size * 3.2) {
        flushList();
        list = { block: { kind: "list", ordered: isOrdered, start: isOrdered ? Number(ordered![1]) : 1, items: [] }, textX, last: line, size: line.size };
      }
      list.block.items.push(runs);
      list.textX = textX;
      list.last = line;
      continue;
    }

    // ¿Sigue el renglón anterior de la lista?
    if (list && Math.abs(line.x0 - list.textX) < Math.max(4, line.size * 0.9) && line.base - list.last.base < line.size * 1.75 && Math.abs(line.size - list.size) < 0.6) {
      const items = list.block.items;
      items[items.length - 1] = joinRuns(items[items.length - 1], line.runs);
      list.last = line;
      continue;
    }
    flushList();

    const p = para as Para | null;
    const lastLine = p?.lines[p.lines.length - 1];
    const continues =
      p &&
      lastLine &&
      Math.abs(line.size - p.size) < 0.6 &&
      line.base - lastLine.base > 0 &&
      line.base - lastLine.base < p.size * 1.75 &&
      (Math.abs(line.x0 - p.x0) < Math.max(3, p.size * 0.6) || (p.lines.length === 1 && lastLine.x0 > line.x0 && lastLine.x0 - line.x0 < p.size * 4) || (centeredIn(lastLine, left, right) && centeredIn(line, left, right)));
    if (continues && p) {
      p.runs = joinRuns(p.runs, line.runs);
      p.lines.push(line);
      if (p.lines.length === 2) p.x0 = line.x0;
    } else {
      flushPara();
      para = { lines: [line], runs: line.runs, x0: line.x0, size: line.size };
    }
  }
  flushPara();
  flushList();
  return out;
}

// ───────────── encabezado y pie ─────────────

const norm = (s: string) => s.replace(/\d+/g, "#").replace(/\s+/g, " ").trim().toLowerCase();
const PAGE_NUMBER = /^(p[aá]gina|page|p\.)?\s*\d+(\s*(de|of|\/)\s*\d+)?$/i;

function pageField(text: string): string {
  const m = /^(.*?)(\d+)(\s*(?:de|of|\/)\s*)(\d+)(.*)$/i.exec(text);
  if (m) return `${m[1]}[Página]${m[3]}[Páginas]${m[5]}`;
  return text.replace(/\d+/, "[Página]");
}

// ───────────── todo junto ─────────────

export async function convertPdf(inputs: PageInput[], onProgress?: (done: number, total: number) => void): Promise<Converted> {
  const pages: PageData[] = [];
  for (let i = 0; i < inputs.length; i++) {
    pages.push(await readPage(inputs[i], i < 60));
    onProgress?.(i + 1, inputs.length);
  }
  if (!pages.length) throw new Error("El PDF no tiene páginas");

  // Encabezado y pie: renglones que se repiten arriba o abajo en las páginas (o el número de página).
  const pageLines = pages.map((p) => makeLines(p.items));
  const repeated = new Map<string, number>();
  pageLines.forEach((lines, i) => {
    const seen = new Set<string>();
    for (const l of lines) {
      const zone = l.base < pages[i].height * 0.09 ? "top" : l.base > pages[i].height * 0.91 ? "bottom" : null;
      if (zone) seen.add(`${zone}|${norm(l.text)}`);
    }
    seen.forEach((k) => repeated.set(k, (repeated.get(k) ?? 0) + 1));
  });
  let header: Converted["header"] = null;
  let footer: Converted["footer"] = null;
  const dropped = new Set<Item>();
  pageLines.forEach((lines, i) => {
    const { width, height } = pages[i];
    for (const l of lines) {
      const zone = l.base < height * 0.09 ? "top" : l.base > height * 0.91 ? "bottom" : null;
      if (!zone) continue;
      const count = repeated.get(`${zone}|${norm(l.text)}`) ?? 0;
      const isNumber = PAGE_NUMBER.test(l.text.trim());
      if (!(isNumber || (pages.length > 1 && count >= Math.max(2, Math.ceil(pages.length / 2))))) continue;
      l.items.forEach((it) => dropped.add(it));
      const mid = (l.x0 + l.x1) / 2;
      const align: Align = Math.abs(mid - width / 2) < width * 0.1 ? "center" : mid > width / 2 ? "right" : "left";
      const entry = { text: /\d/.test(l.text) && (isNumber || /p[aá]gina|page/i.test(l.text)) ? pageField(l.text) : l.text, align };
      if (zone === "top") header ??= entry;
      else footer ??= entry;
    }
  });

  // Letra normal: la más usada (por cantidad de letras).
  const sizes = new Map<number, number>();
  for (const p of pages) for (const it of p.items) if (!dropped.has(it)) sizes.set(Math.round(it.size * 2) / 2, (sizes.get(Math.round(it.size * 2) / 2) ?? 0) + it.text.length);
  const body = [...sizes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 11;
  const headingSizes = cluster(
    [...sizes.keys()].filter((s) => s >= body * 1.3),
    0.8,
  ).sort((a, b) => b - a);
  const ctx: Ctx = { body, headingSizes };

  const blocks: Block[] = [];
  let minLeft = Infinity;
  let maxRight = 0;
  let minTop = Infinity;
  let maxBottom = 0;

  pages.forEach((page, pi) => {
    const items = page.items.filter((it) => !dropped.has(it));
    const pageBlocks: { top: number; block: Block }[] = [];
    const used = new Set<Item>();
    for (const it of items) {
      minLeft = Math.min(minLeft, it.x);
      maxRight = Math.max(maxRight, it.x + it.w);
      minTop = Math.min(minTop, it.base - it.size);
      maxBottom = Math.max(maxBottom, it.base + it.size * 0.3);
    }
    const contentLeft = Number.isFinite(minLeft) ? Math.min(minLeft, page.width * 0.2) : 36;
    const contentRight = maxRight > 0 ? Math.max(maxRight, page.width * 0.8) : page.width - 36;

    // 1. Tablas con bordes.
    const tables = findTables(page.segs);
    for (const t of tables) {
      const inside = items.filter((it) => !used.has(it) && contains(t, it.x + Math.min(it.w, 4), it.base - it.size * 0.3, 1));
      if (!inside.length) continue;
      const nr = t.ys.length - 1;
      const nc = t.xs.length - 1;
      const owner: (Cell | null)[][] = Array.from({ length: nr }, () => Array(nc).fill(null));
      const rows: Cell[][] = Array.from({ length: nr }, () => []);
      for (let r = 0; r < nr; r++)
        for (let c = 0; c < nc; c++) {
          if (owner[r][c]) continue;
          let cs = 1;
          while (c + cs < nc && !hasBorder(t.segs, false, t.xs[c + cs], t.ys[r], t.ys[r + 1])) cs++;
          let rs = 1;
          while (r + rs < nr && [...Array(cs).keys()].every((k) => !hasBorder(t.segs, true, t.ys[r + rs], t.xs[c + k], t.xs[c + k + 1]))) rs++;
          const cellRect = { x: t.xs[c], y: t.ys[r], w: t.xs[c + cs] - t.xs[c], h: t.ys[r + rs] - t.ys[r] };
          const mine = inside.filter((it) => !used.has(it) && contains(cellRect, it.x + Math.min(it.w, 4), it.base - it.size * 0.3));
          mine.forEach((it) => used.add(it));
          const lines = attachBullets(makeLines(mine), page.dots);
          const fillRect = page.fills.find((f) => contains(f, cellRect.x + cellRect.w / 2, cellRect.y + cellRect.h / 2) && f.w <= cellRect.w + 3 && f.h <= cellRect.h + 3);
          const cell: Cell = {
            blocks: buildBlocks(lines, cellRect.x + 2, cellRect.x + cellRect.w - 2, ctx, false),
            colspan: cs,
            rowspan: rs,
            fill: fillRect?.color ?? null,
            text: lines.map((l) => l.text).join("\n"),
          };
          for (let rr = r; rr < r + rs; rr++) for (let cc = c; cc < c + cs; cc++) owner[rr][cc] = cell;
          rows[r].push(cell);
        }
      const filled = rows.filter((r) => r.length);
      const first = filled[0] ?? [];
      const header = filled.length > 1 && first.length > 0 && first.every((c) => c.fill && c.fill === first[0].fill) && !filled.slice(1).every((row) => row.every((c) => c.fill === first[0].fill));
      const widths = t.xs.slice(1).map((x, i) => x - t.xs[i]);
      pageBlocks.push({ top: t.y, block: { kind: "table", rows: filled, widths, header, boxes: false } });
    }

    // 2. Franjas de ancho completo (títulos oscuros, citas claras, código) y recuadros sueltos.
    const tableRects: Rect[] = tables;
    const freeFills = page.fills.filter((f) => !tableRects.some((t) => contains(t, f.x + f.w / 2, f.y + f.h / 2, 1)) && f.w * f.h < page.width * page.height * 0.8);
    const bandWidth = (contentRight - contentLeft) * 0.75;
    const bands = freeFills.filter((f) => f.w >= bandWidth && f.h >= 8);
    const boxes = freeFills
      .filter((f) => f.w < bandWidth && f.w > 24 && f.h > 14)
      .filter((f) => items.some((it) => !used.has(it) && contains(f, it.x + 1, it.base - it.size * 0.3)));
    // Recuadros en fila (2 o más a la misma altura): una tabla de una fila.
    const rowsOfBoxes: Fill[][] = [];
    for (const b of [...boxes].sort((a, c) => a.x - c.x)) {
      const row = rowsOfBoxes.find((r) => Math.min(r[0].y + r[0].h, b.y + b.h) - Math.max(r[0].y, b.y) > Math.min(r[0].h, b.h) * 0.6);
      if (row) row.push(b);
      else rowsOfBoxes.push([b]);
    }
    for (const row of rowsOfBoxes.filter((r) => r.length >= 2)) {
      const cells: Cell[] = row.map((b) => {
        const mine = items.filter((it) => !used.has(it) && contains(b, it.x + Math.min(it.w, 4), it.base - it.size * 0.3, 1));
        mine.forEach((it) => used.add(it));
        const lines = makeLines(mine);
        return { blocks: buildBlocks(lines, b.x + 2, b.x + b.w - 2, ctx, false), colspan: 1, rowspan: 1, fill: b.color, text: lines.map((l) => l.text).join("\n") };
      });
      // Las flechas entre los recuadros sobran (la tabla ya los pone en orden).
      const top = Math.min(...row.map((b) => b.y));
      const bottom = Math.max(...row.map((b) => b.y + b.h));
      items.filter((it) => !used.has(it) && it.base > top && it.base - it.size < bottom && /^[\s→←↔⇒➜➝►▶>–-]+$/.test(it.text)).forEach((it) => used.add(it));
      const widths = row.map((b) => b.w);
      pageBlocks.push({ top, block: { kind: "table", rows: [cells], widths, header: false, boxes: true } });
    }

    // 3. Imágenes.
    for (const img of page.images) {
      const mid = img.x + img.w / 2;
      const align: Align = Math.abs(mid - (contentLeft + contentRight) / 2) < (contentRight - contentLeft) * 0.08 ? "center" : "left";
      pageBlocks.push({ top: img.y, block: { kind: "image", src: img.src, width: img.w, height: img.h, align } });
    }

    // 4. El resto del texto, en orden de lectura.
    const flow = attachBullets(
      makeLines(items.filter((it) => !used.has(it))),
      page.dots,
    );
    for (const l of flow) l.band = bands.find((b) => contains(b, (l.x0 + l.x1) / 2, l.base - l.size * 0.3, 1)) ?? null;
    // Se arman bloques por tramos, entre tablas e imágenes, para que queden en su lugar.
    const anchors = pageBlocks.map((b) => b.top).sort((a, b) => a - b);
    const segments: Line[][] = Array.from({ length: anchors.length + 1 }, () => []);
    for (const l of flow) segments[anchors.filter((a) => a < l.base - l.size).length].push(l);
    const ordered: Block[] = [];
    const sortedAnchors = [...pageBlocks].sort((a, b) => a.top - b.top);
    segments.forEach((segLines, i) => {
      ordered.push(...buildBlocks(segLines, contentLeft, contentRight, ctx));
      if (i < sortedAnchors.length) ordered.push(sortedAnchors[i].block);
    });

    // Un párrafo o lista que sigue de la página anterior se junta.
    const prev = blocks[blocks.length - 1];
    const next = ordered[0];
    if (pi > 0 && prev && next) {
      if (prev.kind === "paragraph" && next.kind === "paragraph" && Math.abs(prev.size - next.size) < 0.6 && !/[.:;!?)»"]\s*$/.test(prev.runs.map((r) => r.text).join(""))) {
        prev.runs = joinRuns(prev.runs, next.runs);
        ordered.shift();
      } else if (prev.kind === "list" && next.kind === "list" && prev.ordered === next.ordered) {
        prev.items.push(...next.items);
        ordered.shift();
      } else if (prev.kind === "table" && next.kind === "table" && !prev.boxes && !next.boxes && sameColumns(prev.widths, next.widths)) {
        // Una tabla que sigue en la página siguiente es la misma tabla (si repite el encabezado, se quita).
        const repeatsHeader = prev.header && JSON.stringify(next.rows[0]?.map((c) => c.text)) === JSON.stringify(prev.rows[0]?.map((c) => c.text));
        prev.rows.push(...next.rows.slice(repeatsHeader ? 1 : 0));
        ordered.shift();
      }
    }
    blocks.push(...ordered);
  });

  const first = pages[0];
  const clampMargin = (v: number) => Math.round(Math.max(28, Math.min(110, Number.isFinite(v) ? v : 72)));
  return {
    blocks,
    page: {
      width: first.width,
      height: first.height,
      left: clampMargin(minLeft),
      right: clampMargin(first.width - maxRight),
      top: clampMargin(minTop),
      bottom: clampMargin(first.height - maxBottom),
    },
    header,
    footer,
    bodySize: body,
    pages: pages.length,
  };
}

function sameColumns(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((w, i) => Math.abs(w - b[i]) < 3);
}

/** Las viñetas dibujadas (un punto antes del renglón) marcan ese renglón como de lista. */
function attachBullets(lines: Line[], dots: Fill[]): Line[] {
  for (const d of dots) {
    const cy = d.y + d.h / 2;
    const line = lines.find((l) => Math.abs(l.base - l.size * 0.32 - cy) < l.size * 0.5 && l.x0 - (d.x + d.w) > 1 && l.x0 - (d.x + d.w) < 26);
    if (line) line.bullet = true;
  }
  return lines;
}
