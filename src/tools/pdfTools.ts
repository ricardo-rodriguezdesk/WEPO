// Herramientas de PDF de «WEPO Convertir»: todo pasa en la computadora, sin
// internet. pdf-lib escribe los PDF y pdf.js los dibuja cuando hace falta una imagen.

import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, StandardFonts, decodePDFRawStream, degrees } from "pdf-lib";
import type { PDFFont, PDFImage, PDFPage } from "pdf-lib";
import { dropOldEncryption, hexColor, isolateContent, latin, writeInvisibleText } from "../editors/pdf/pdfEdit";
import type { OcrText } from "../editors/pdf/pdfEdit";
import { loadPdf } from "../lib/pdf";
import type { PDFDocumentProxy } from "../lib/pdf";

/** Lo que sale de una herramienta. Con `write`, el archivo lo escribe otro (Rust o un editor) en la ruta que se elija. */
export type Output = { name: string; bytes: Uint8Array; write?: (path: string) => Promise<void> };

// ───────────── abrir ─────────────

/** Abre un PDF para cambiarlo. Los que solo tienen permisos (sin contraseña para abrir) también. */
export async function openPdf(bytes: Uint8Array, name = "El PDF"): Promise<PDFDocument> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (e) {
    if (!/encrypt/i.test(String((e as Error)?.name ?? e) + String((e as Error)?.message ?? ""))) throw e;
    try {
      doc = await PDFDocument.load(bytes, { updateMetadata: false, password: "" });
    } catch {
      throw new Error(`${name} tiene contraseña: quítasela primero en WEPO PDF (botón del candado) y vuelve a intentarlo`);
    }
  }
  dropOldEncryption(doc);
  return doc;
}

/** Abre un PDF con pdf.js (para dibujar sus páginas o leer su texto). */
export async function proxyOf(bytes: Uint8Array, name = "El PDF"): Promise<PDFDocumentProxy> {
  try {
    return await loadPdf(bytes);
  } catch (e) {
    if ((e as { name?: string })?.name === "PasswordException") throw new Error(`${name} tiene contraseña: quítasela primero en WEPO PDF y vuelve a intentarlo`);
    throw e;
  }
}

export const baseName = (name: string) => name.replace(/\.[^./\\]+$/, "") || "Documento";

// ───────────── páginas: tamaño a la vista y coordenadas ─────────────

/** Rectángulo visible de la página (CropBox) y su giro. */
function frame(page: PDFPage) {
  const box = page.getCropBox();
  const rotation = ((page.getRotation().angle % 360) + 360) % 360;
  const turned = rotation === 90 || rotation === 270;
  return { box, rotation, width: turned ? box.height : box.width, height: turned ? box.width : box.height };
}

/** Un punto de la página como se ve (desde arriba a la izquierda) en coordenadas del PDF. */
function fromView(page: PDFPage, vx: number, vy: number): { x: number; y: number; rotate: number } {
  const { box, rotation } = frame(page);
  const { x: x0, y: y0, width: W, height: H } = box;
  switch (rotation) {
    case 90:
      return { x: x0 + vy, y: y0 + vx, rotate: 90 };
    case 180:
      return { x: x0 + W - vx, y: y0 + vy, rotate: 180 };
    case 270:
      return { x: x0 + W - vy, y: y0 + H - vx, rotate: 270 };
    default:
      return { x: x0 + vx, y: y0 + H - vy, rotate: 0 };
  }
}

// ───────────── dividir ─────────────

export type SplitMode = { kind: "each" } | { kind: "every"; n: number } | { kind: "ranges"; text: string };

/** «1-3, 5, 8-» → [[1,3],[5,5],[8,total]]. Lanza un error con lo que está mal. */
export function parseRanges(text: string, total: number): [number, number][] {
  const out: [number, number][] = [];
  for (const raw of text.split(/[,;]/)) {
    const part = raw.trim();
    if (!part) continue;
    const m = /^(\d*)\s*[-–]\s*(\d*)$|^(\d+)$/.exec(part);
    if (!m) throw new Error(`«${part}» no es un rango (escribe, por ejemplo, 1-3, 5, 8-)`);
    const a = m[3] ? Number(m[3]) : m[1] ? Number(m[1]) : 1;
    const b = m[3] ? Number(m[3]) : m[2] ? Number(m[2]) : total;
    if (a < 1 || b < a || b > total) throw new Error(`«${part}»: el PDF tiene ${total} ${total === 1 ? "página" : "páginas"}`);
    out.push([a, b]);
  }
  if (!out.length) throw new Error("Escribe qué páginas van en cada archivo (por ejemplo, 1-3, 4-6)");
  return out;
}

export async function splitPdf(bytes: Uint8Array, name: string, mode: SplitMode): Promise<Output[]> {
  const src = await openPdf(bytes, name);
  const total = src.getPageCount();
  const groups: [number, number][] =
    mode.kind === "each"
      ? Array.from({ length: total }, (_, i) => [i + 1, i + 1])
      : mode.kind === "every"
        ? Array.from({ length: Math.ceil(total / Math.max(1, mode.n)) }, (_, i) => [i * mode.n + 1, Math.min(total, (i + 1) * mode.n)])
        : parseRanges(mode.text, total);
  const base = baseName(name);
  const outputs: Output[] = [];
  for (const [a, b] of groups) {
    const out = await PDFDocument.create();
    const pages = await out.copyPages(
      src,
      Array.from({ length: b - a + 1 }, (_, i) => a - 1 + i),
    );
    pages.forEach((p) => out.addPage(p));
    out.setTitle(src.getTitle() ?? base);
    out.setProducer("WEPO");
    outputs.push({ name: a === b ? `${base} - página ${a}.pdf` : `${base} - páginas ${a}-${b}.pdf`, bytes: await out.save() });
  }
  return outputs;
}

// ───────────── números de página ─────────────

export type NumberPosition = "top-left" | "top-center" | "top-right" | "bottom-left" | "bottom-center" | "bottom-right";
export type NumberFormat = "n" | "page-n" | "page-n-of" | "n-of";
export type NumberOptions = { position: NumberPosition; format: NumberFormat; start: number; from: number; size: number; margin: number; color: string };

export function numberText(format: NumberFormat, n: number, total: number): string {
  return format === "n" ? String(n) : format === "page-n" ? `Página ${n}` : format === "page-n-of" ? `Página ${n} de ${total}` : `${n} / ${total}`;
}

export async function addPageNumbers(bytes: Uint8Array, name: string, o: NumberOptions): Promise<Uint8Array> {
  const doc = await openPdf(bytes, name);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();
  // El total cuenta solo las páginas que llevan número.
  const numbered = pages.length - (o.from - 1);
  pages.forEach((page, i) => {
    if (i + 1 < o.from) return;
    const n = o.start + (i + 1 - o.from);
    const text = numberText(o.format, n, o.start + numbered - 1);
    const { width, height } = frame(page);
    const w = font.widthOfTextAtSize(text, o.size);
    const [vertical, horizontal] = o.position.split("-");
    const vx = horizontal === "left" ? o.margin : horizontal === "right" ? width - o.margin - w : (width - w) / 2;
    // La línea base: a `margin` de la orilla (arriba se cuenta hasta lo alto de las letras).
    const vy = vertical === "top" ? o.margin + o.size * 0.75 : height - o.margin;
    const at = fromView(page, vx, vy);
    isolateContent(page, doc);
    page.drawText(text, { x: at.x, y: at.y, size: o.size, font, color: hexColor(o.color), rotate: degrees(at.rotate) });
  });
  doc.setProducer("WEPO");
  return doc.save();
}

// ───────────── imágenes → PDF ─────────────

export type PageSize = "fit" | "letter" | "a4";
export type ImagesOptions = { size: PageSize; orientation: "auto" | "portrait" | "landscape"; margin: number; single: boolean };
const SIZES = { letter: [612, 792], a4: [595.28, 841.89] } as const;

function isJpeg(b: Uint8Array) {
  return b[0] === 0xff && b[1] === 0xd8;
}
function isPng(b: Uint8Array) {
  return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
}

/** Orientación EXIF de un JPEG (1 = normal). Las fotos del teléfono suelen venir giradas así. */
export function jpegOrientation(b: Uint8Array): number {
  let i = 2;
  while (i + 4 < b.length && b[i] === 0xff) {
    const marker = b[i + 1];
    const len = (b[i + 2] << 8) | b[i + 3];
    if (marker === 0xe1 && b[i + 4] === 0x45 && b[i + 5] === 0x78 && b[i + 6] === 0x69 && b[i + 7] === 0x66) {
      const t = i + 10;
      const little = b[t] === 0x49;
      const u16 = (o: number) => (little ? b[t + o] | (b[t + o + 1] << 8) : (b[t + o] << 8) | b[t + o + 1]);
      const u32 = (o: number) => (little ? u16(o) | (u16(o + 2) << 16) : (u16(o) << 16) | u16(o + 2));
      const ifd = u32(4);
      const count = u16(ifd);
      for (let k = 0; k < count; k++) {
        const e = ifd + 2 + k * 12;
        if (u16(e) === 0x0112) return u16(e + 8);
      }
      return 1;
    }
    if (marker === 0xda) break;
    i += 2 + len;
  }
  return 1;
}

/** Cualquier imagen que el navegador abra, como JPEG o PNG para el PDF (y derecha, según su EXIF). */
async function embedAny(doc: PDFDocument, bytes: Uint8Array): Promise<PDFImage> {
  if (isPng(bytes)) return doc.embedPng(bytes);
  if (isJpeg(bytes) && jpegOrientation(bytes) === 1) return doc.embedJpg(bytes);
  const bitmap = await createImageBitmap(new Blob([bytes as BlobPart]), { imageOrientation: "from-image" });
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const g = canvas.getContext("2d")!;
  g.drawImage(bitmap, 0, 0);
  const jpeg = isJpeg(bytes);
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, jpeg ? "image/jpeg" : "image/png", 0.92));
  if (!blob) throw new Error("no se pudo leer la imagen");
  const data = new Uint8Array(await blob.arrayBuffer());
  return jpeg ? doc.embedJpg(data) : doc.embedPng(data);
}

export async function imagesToPdf(images: { name: string; bytes: Uint8Array }[], o: ImagesOptions): Promise<Output[]> {
  const outputs: Output[] = [];
  let doc = await PDFDocument.create();
  for (const [k, img] of images.entries()) {
    let image: PDFImage;
    try {
      image = await embedAny(doc, img.bytes);
    } catch {
      throw new Error(`${img.name} no es una imagen que WEPO pueda leer`);
    }
    // A 96 puntos por pulgada se ve del tamaño que tiene en pantalla.
    const iw = image.width * 0.75;
    const ih = image.height * 0.75;
    let pw: number, ph: number;
    if (o.size === "fit") {
      pw = iw + 2 * o.margin;
      ph = ih + 2 * o.margin;
    } else {
      const [a, b] = SIZES[o.size];
      const landscape = o.orientation === "landscape" || (o.orientation === "auto" && iw > ih);
      [pw, ph] = landscape ? [b, a] : [a, b];
    }
    const page = doc.addPage([pw, ph]);
    const k2 = Math.min((pw - 2 * o.margin) / iw, (ph - 2 * o.margin) / ih, o.size === "fit" ? 1 : Infinity);
    const w = iw * k2;
    const h = ih * k2;
    page.drawImage(image, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
    if (!o.single) {
      doc.setProducer("WEPO");
      outputs.push({ name: `${baseName(img.name)}.pdf`, bytes: await doc.save() });
      if (k < images.length - 1) doc = await PDFDocument.create();
    }
  }
  if (o.single) {
    doc.setProducer("WEPO");
    outputs.push({ name: `${baseName(images[0].name)}${images.length > 1 ? " y otras" : ""}.pdf`, bytes: await doc.save() });
  }
  return outputs;
}

// ───────────── PDF → imágenes ─────────────

export type ImageFormat = "jpg" | "png";

/** Dibuja una página a la escala dada (con fondo blanco). `noText` deja fuera las letras. */
export async function renderPage(doc: PDFDocumentProxy, index: number, scale: number, noText = false): Promise<HTMLCanvasElement> {
  const page = await doc.getPage(index + 1);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(viewport.width));
  canvas.height = Math.max(1, Math.round(viewport.height));
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (noText) {
    // pdf.js escribe las letras con fillText/strokeText: sin ellas queda solo el fondo, las figuras y las imágenes.
    ctx.fillText = () => {};
    ctx.strokeText = () => {};
  }
  await page.render({ canvasContext: ctx, viewport, canvas } as Parameters<typeof page.render>[0]).promise;
  return canvas;
}

export async function canvasBytes(canvas: HTMLCanvasElement, format: ImageFormat, quality = 0.9): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, format === "png" ? "image/png" : "image/jpeg", quality));
  if (!blob) throw new Error("no se pudo crear la imagen");
  return new Uint8Array(await blob.arrayBuffer());
}

export async function pdfToImages(bytes: Uint8Array, name: string, dpi: number, format: ImageFormat, onPage?: (done: number, total: number) => void): Promise<Output[]> {
  const doc = await proxyOf(bytes, name);
  const outputs: Output[] = [];
  const base = baseName(name);
  const width = String(doc.numPages).length;
  for (let i = 0; i < doc.numPages; i++) {
    const canvas = await renderPage(doc, i, dpi / 72);
    const n = doc.numPages === 1 ? "" : ` - ${String(i + 1).padStart(width, "0")}`;
    outputs.push({ name: `${base}${n}.${format}`, bytes: await canvasBytes(canvas, format) });
    canvas.width = canvas.height = 0;
    onPage?.(i + 1, doc.numPages);
  }
  return outputs;
}

// ───────────── comprimir ─────────────

export type CompressLevel = "low" | "recommended" | "extreme";
const LEVELS: Record<CompressLevel, { max: number; quality: number }> = {
  low: { max: 2600, quality: 0.85 },
  recommended: { max: 1800, quality: 0.72 },
  extreme: { max: 1100, quality: 0.5 },
};

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Números de una imagen del PDF (sus valores pueden venir como referencias). */
function numberOf(doc: PDFDocument, value: unknown): number | null {
  const v = value instanceof PDFRef ? doc.context.lookup(value) : value;
  return v instanceof PDFNumber ? v.asNumber() : null;
}

/** El espacio de color de una imagen, reducido a RGB, gris u otro (que no se toca). */
function colorKind(doc: PDFDocument, value: unknown): "rgb" | "gray" | "other" {
  let v = value instanceof PDFRef ? doc.context.lookup(value) : value;
  if (v instanceof PDFName) return v === PDFName.of("DeviceRGB") ? "rgb" : v === PDFName.of("DeviceGray") ? "gray" : "other";
  if (v instanceof PDFArray && v.get(0) === PDFName.of("ICCBased")) {
    v = doc.context.lookup(v.get(1));
    const n = v instanceof PDFStream ? numberOf(doc, v.dict.get(PDFName.of("N"))) : null;
    return n === 3 ? "rgb" : n === 1 ? "gray" : "other";
  }
  return "other";
}

/**
 * Reduce el PDF: las fotos se vuelven a guardar como JPEG más ligeros (y más
 * chicas si son enormes) y el archivo se escribe con flujos de objetos.
 * Lo que ya estaba bien comprimido se deja igual. Devuelve los bytes nuevos.
 */
export async function compressPdf(bytes: Uint8Array, name: string, level: CompressLevel): Promise<Uint8Array> {
  const doc = await openPdf(bytes, name);
  const { max, quality } = LEVELS[level];
  const ctx = doc.context;
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const dict = obj.dict;
    if (dict.get(PDFName.of("Subtype")) !== PDFName.of("Image")) continue;
    if (dict.has(PDFName.of("Mask")) || dict.has(PDFName.of("Decode")) || dict.get(PDFName.of("ImageMask"))?.toString() === "true") continue;
    const width = numberOf(doc, dict.get(PDFName.of("Width")));
    const height = numberOf(doc, dict.get(PDFName.of("Height")));
    const bpc = numberOf(doc, dict.get(PDFName.of("BitsPerComponent")));
    if (!width || !height || bpc !== 8 || width * height < 64 * 64) continue;
    const color = colorKind(doc, dict.get(PDFName.of("ColorSpace")));
    if (color === "other") continue;
    const filter = dict.get(PDFName.of("Filter"));
    const filters = (filter instanceof PDFArray ? filter.asArray() : filter ? [filter] : []).map((f) => (f instanceof PDFName ? f.asString() : ""));
    const original = obj.contents;
    // Los filtros de texto (ASCII85, ASCIIHex) que van antes del de imagen se quitan primero.
    const unwrap = (count: number): Uint8Array => {
      if (!count) return original;
      const d = dict.clone(ctx);
      d.set(PDFName.of("Filter"), ctx.obj(filters.slice(0, count).map((f) => f.slice(1))));
      d.delete(PDFName.of("DecodeParms"));
      return decodePDFRawStream(PDFRawStream.of(d, original)).decode();
    };
    const last = filters[filters.length - 1];
    const textOnly = (list: string[]) => list.every((f) => f === "/ASCII85Decode" || f === "/ASCIIHexDecode");
    let source: CanvasImageSource;
    try {
      if (last === "/DCTDecode" && textOnly(filters.slice(0, -1))) {
        source = await createImageBitmap(new Blob([unwrap(filters.length - 1) as BlobPart], { type: "image/jpeg" }));
      } else if (last === "/FlateDecode" && textOnly(filters.slice(0, -1)) && !dict.has(PDFName.of("DecodeParms"))) {
        const raw = await inflate(unwrap(filters.length - 1));
        const channels = color === "rgb" ? 3 : 1;
        if (raw.length < width * height * channels) continue;
        const pixels = new ImageData(width, height);
        for (let i = 0, j = 0; i < width * height; i++, j += channels) {
          pixels.data[i * 4] = raw[j];
          pixels.data[i * 4 + 1] = raw[j + (channels === 3 ? 1 : 0)];
          pixels.data[i * 4 + 2] = raw[j + (channels === 3 ? 2 : 0)];
          pixels.data[i * 4 + 3] = 255;
        }
        source = await createImageBitmap(pixels);
      } else continue;
    } catch {
      continue;
    }
    const k = Math.min(1, max / Math.max(width, height));
    const w = Math.max(1, Math.round(width * k));
    const h = Math.max(1, Math.round(height * k));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const g = canvas.getContext("2d")!;
    g.imageSmoothingQuality = "high";
    g.drawImage(source, 0, 0, w, h);
    const jpeg = await canvasBytes(canvas, "jpg", quality);
    canvas.width = canvas.height = 0;
    // Solo si de verdad pesa menos.
    if (jpeg.length > original.length * 0.9) continue;
    const next = ctx.obj({
      Type: "XObject",
      Subtype: "Image",
      Width: w,
      Height: h,
      // El JPEG del navegador siempre sale en color (aunque la foto sea gris).
      ColorSpace: "DeviceRGB",
      BitsPerComponent: 8,
      Filter: "DCTDecode",
      Length: jpeg.length,
    }) as PDFDict;
    for (const key of ["SMask", "Interpolate", "Intent", "Metadata"]) {
      const value = dict.get(PDFName.of(key));
      if (value) next.set(PDFName.of(key), value);
    }
    ctx.assign(ref, PDFRawStream.of(next, jpeg));
  }
  // Lo que no se ve: miniaturas de página y datos privados de otros programas.
  for (const page of doc.getPages()) {
    page.node.delete(PDFName.of("Thumb"));
    page.node.delete(PDFName.of("PieceInfo"));
  }
  doc.catalog.delete(PDFName.of("PieceInfo"));
  doc.setProducer("WEPO");
  const out = await doc.save({ useObjectStreams: true });
  return out.length < bytes.length ? out : bytes;
}

// ───────────── recortar ─────────────

/** Márgenes a quitar, en puntos, como se ve la página. */
export type Margins = { top: number; right: number; bottom: number; left: number };

/** Recorta las páginas elegidas (cambia lo que se ve: la CropBox). `pages`: índices desde 0, o todas. */
export async function cropPdf(bytes: Uint8Array, name: string, margins: Margins | ((index: number) => Margins | null), pages?: number[]): Promise<Uint8Array> {
  const doc = await openPdf(bytes, name);
  const only = pages ? new Set(pages) : null;
  doc.getPages().forEach((page, i) => {
    if (only && !only.has(i)) return;
    const m = typeof margins === "function" ? margins(i) : margins;
    if (!m) return;
    const { box, rotation } = frame(page);
    // Los márgenes vistos, en las orillas del PDF según el giro.
    const [l, b, r, t] =
      rotation === 90 ? [m.top, m.left, m.bottom, m.right] : rotation === 180 ? [m.right, m.top, m.left, m.bottom] : rotation === 270 ? [m.bottom, m.right, m.top, m.left] : [m.left, m.bottom, m.right, m.top];
    const w = box.width - l - r;
    const h = box.height - b - t;
    if (w < 10 || h < 10) return;
    page.setCropBox(box.x + l, box.y + b, w, h);
    // Lo de fuera tampoco se imprime ni se ve en otros lectores.
    page.setTrimBox(box.x + l, box.y + b, w, h);
  });
  doc.setProducer("WEPO");
  return doc.save();
}

/** Lo que no es blanco de una página dibujada: márgenes en blanco en puntos (como se ve). */
export async function blankMargins(doc: PDFDocumentProxy, index: number): Promise<Margins> {
  const scale = 1;
  const canvas = await renderPage(doc, index, scale);
  const { width, height } = canvas;
  const data = canvas.getContext("2d")!.getImageData(0, 0, width, height).data;
  let top = height,
    bottom = -1,
    left = width,
    right = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (data[i] < 245 || data[i + 1] < 245 || data[i + 2] < 245) {
        if (y < top) top = y;
        if (y > bottom) bottom = y;
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
  }
  canvas.width = canvas.height = 0;
  if (bottom < 0) return { top: 0, right: 0, bottom: 0, left: 0 };
  // Un poco de aire alrededor de lo que hay.
  const pad = 8;
  return {
    top: Math.max(0, top / scale - pad),
    left: Math.max(0, left / scale - pad),
    bottom: Math.max(0, (height - 1 - bottom) / scale - pad),
    right: Math.max(0, (width - 1 - right) / scale - pad),
  };
}

// ───────────── marca de agua (texto o imagen) ─────────────

export type MarkPosition = "center" | "top-left" | "top-center" | "top-right" | "middle-left" | "middle-right" | "bottom-left" | "bottom-center" | "bottom-right" | "tile";
export type MarkOptions = {
  kind: "text" | "image";
  text: string;
  color: string;
  image: Uint8Array | null;
  /** Ancho de la marca respecto al de la página (0.05 a 1). */
  scale: number;
  opacity: number;
  /** Grados (en sentido contrario al reloj, como se ve). */
  rotation: number;
  position: MarkPosition;
  /** Debajo del contenido (como sello de agua de papel) o encima. */
  layer: "over" | "under";
  /** «1-3, 5» o vacío para todas. */
  pages: string;
};

export async function watermarkPdf(bytes: Uint8Array, name: string, o: MarkOptions): Promise<Uint8Array> {
  const doc = await openPdf(bytes, name);
  const pages = doc.getPages();
  const chosen = o.pages.trim() ? new Set(parseRanges(o.pages, pages.length).flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, i) => a - 1 + i))) : null;
  let image: PDFImage | null = null;
  let font: PDFFont | null = null;
  if (o.kind === "image") {
    if (!o.image) throw new Error("Elige la imagen de la marca de agua");
    image = await embedAny(doc, o.image);
  } else {
    if (!o.text.trim()) throw new Error("Escribe el texto de la marca de agua");
    font = await doc.embedFont(StandardFonts.HelveticaBold);
  }
  const text = latin(o.text.trim().replace(/\s+/g, " "));
  const gs = doc.context.obj({ Type: "ExtGState", ca: o.opacity, CA: o.opacity });
  const gsRef = doc.context.register(gs);
  for (const [i, page] of pages.entries()) {
    if (chosen && !chosen.has(i)) continue;
    const { width, height, rotation } = frame(page);
    // Tamaño de la marca (como se ve).
    const mw = Math.max(8, width * o.scale);
    const mh = image ? (mw * image.height) / image.width : (mw / Math.max(1, font!.widthOfTextAtSize(text, 1))) * font!.heightAtSize(1, { descender: false });
    const size = font ? mw / Math.max(1, font.widthOfTextAtSize(text, 1)) : 0;
    const pad = Math.min(width, height) * 0.05;
    const centers: [number, number][] = [];
    if (o.position === "tile") {
      const stepX = mw * 1.6;
      const stepY = Math.max(mh * 3, mw * 0.8);
      for (let y = stepY / 2, row = 0; y < height + stepY; y += stepY, row++) for (let x = (row % 2 ? stepX / 2 : 0) + mw / 2; x < width + stepX; x += stepX) centers.push([x, y]);
    } else {
      const [v, h] = o.position === "center" ? ["middle", "center"] : o.position.split("-");
      const cx = h === "left" ? pad + mw / 2 : h === "right" ? width - pad - mw / 2 : width / 2;
      const cy = v === "top" ? pad + mh / 2 : v === "bottom" ? height - pad - mh / 2 : height / 2;
      centers.push([cx, cy]);
    }
    const ops: string[] = ["q", `/WepoMark gs`];
    page.node.normalize();
    const resources = page.node.Resources()!;
    let ext = resources.lookup(PDFName.of("ExtGState"));
    if (!(ext instanceof PDFDict)) {
      ext = doc.context.obj({});
      resources.set(PDFName.of("ExtGState"), ext as PDFDict);
    }
    (ext as PDFDict).set(PDFName.of("WepoMark"), gsRef);
    let xname = "";
    let fname = "";
    if (image) xname = page.node.newXObject("WepoMarkImg", image.ref).toString();
    if (font) fname = page.node.newFontDictionary("WepoMarkFont", font.ref).toString();
    const angle = ((o.rotation + rotation) * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    for (const [cx, cy] of centers) {
      const c = fromView(page, cx, cy);
      if (image) {
        // Matriz: girar alrededor del centro y estirar la imagen (que mide 1 × 1).
        const a = cos * mw,
          b = sin * mw,
          cc = -sin * mh,
          d = cos * mh;
        const e = c.x - (a + cc) / 2;
        const f = c.y - (b + d) / 2;
        ops.push(`q ${a.toFixed(4)} ${b.toFixed(4)} ${cc.toFixed(4)} ${d.toFixed(4)} ${e.toFixed(3)} ${f.toFixed(3)} cm ${xname} Do Q`);
      } else {
        const w = font!.widthOfTextAtSize(text, size);
        const dy = size * 0.35;
        const x = c.x - ((w / 2) * cos - dy * sin);
        const y = c.y - ((w / 2) * sin + dy * cos);
        const [r, g, bl] = rgbOf(o.color);
        ops.push(`BT ${r} ${g} ${bl} rg ${fname} ${size.toFixed(2)} Tf ${cos.toFixed(5)} ${sin.toFixed(5)} ${(-sin).toFixed(5)} ${cos.toFixed(5)} ${x.toFixed(3)} ${y.toFixed(3)} Tm <${hexText(font!, text)}> Tj ET`);
      }
    }
    ops.push("Q");
    const stream = doc.context.register(doc.context.flateStream(ops.join("\n")));
    const contents = page.node.Contents();
    if (o.layer === "under") {
      const list = contents instanceof PDFArray ? contents : null;
      const arr = doc.context.obj([stream]) as PDFArray;
      if (list) for (let k = 0; k < list.size(); k++) arr.push(list.get(k));
      page.node.set(PDFName.of("Contents"), arr);
    } else {
      isolateContent(page, doc);
      page.node.addContentStream(stream);
    }
  }
  doc.setProducer("WEPO");
  return doc.save();
}

function rgbOf(hex: string): [string, string, string] {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => (parseInt(h.slice(i, i + 2), 16) / 255).toFixed(3)) as [string, string, string];
}

function hexText(font: PDFFont, text: string): string {
  return font
    .encodeText(text)
    .toString()
    .replace(/^<|>$/g, "");
}

// ───────────── reparar ─────────────

export type RepairResult = { bytes: Uint8Array; how: "rewritten" | "rebuilt"; pages: number; lost: number };

/**
 * Repara un PDF dañado. Primero se reescribe con pdf-lib (que lee los objetos
 * aunque la tabla del final esté rota); si no se puede, o pierde páginas, se
 * rehace desde lo que pdf.js alcanza a dibujar: cada página como imagen con su
 * texto (para buscar y copiar).
 */
export async function repairPdf(bytes: Uint8Array, name: string): Promise<RepairResult> {
  // Basura antes de %PDF (correos, descargas cortadas): se quita.
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 4096));
  const start = head.indexOf("%PDF");
  if (start < 0) throw new Error(`${name} no parece un PDF (no empieza con %PDF)`);
  const data = start > 0 ? bytes.subarray(start) : bytes;
  let expected = 0;
  let proxy: PDFDocumentProxy | null = null;
  try {
    proxy = await loadPdf(data);
    expected = proxy.numPages;
  } catch (e) {
    if ((e as { name?: string })?.name === "PasswordException") throw new Error(`${name} tiene contraseña: quítasela primero en WEPO PDF`);
    proxy = null;
  }
  try {
    const doc = await PDFDocument.load(data, { updateMetadata: false, ignoreEncryption: false, throwOnInvalidObject: false } as Parameters<typeof PDFDocument.load>[1]);
    const count = doc.getPageCount();
    if (count > 0 && count >= expected) {
      // Copiar las páginas a un PDF limpio: sin objetos sueltos ni tablas rotas.
      const out = await PDFDocument.create();
      const pages = await out.copyPages(doc, doc.getPageIndices());
      pages.forEach((p) => out.addPage(p));
      out.setTitle(doc.getTitle() ?? baseName(name));
      out.setProducer("WEPO");
      return { bytes: await out.save(), how: "rewritten", pages: count, lost: 0 };
    }
  } catch {
    // Se intenta con lo que dibuja pdf.js.
  }
  if (!proxy || !expected) throw new Error(`${name} está demasiado dañado: no se pudo leer ninguna página`);
  const out = await PDFDocument.create();
  let lost = 0;
  for (let i = 0; i < expected; i++) {
    try {
      await addPageAsImage(out, proxy, i);
    } catch {
      lost++;
    }
  }
  if (lost === expected) throw new Error(`${name} está demasiado dañado: no se pudo leer ninguna página`);
  out.setTitle(baseName(name));
  out.setProducer("WEPO");
  return { bytes: await out.save(), how: "rebuilt", pages: expected - lost, lost };
}

// ───────────── páginas como imagen (con su texto, para buscar y copiar) ─────────────

/** El texto de una página, en las coordenadas de la página tal como se ve (derecha y desde abajo). */
export async function pageTextLines(proxy: PDFDocumentProxy, index: number): Promise<OcrText[]> {
  const page = await proxy.getPage(index + 1);
  const view = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const lines: OcrText[] = [];
  for (const item of content.items) {
    if (!("str" in item) || !item.str.trim()) continue;
    const [a, b, c, d, e, f] = item.transform as number[];
    const len = Math.hypot(a, b) || 1;
    const [x0, y0] = view.convertToViewportPoint(e, f);
    const [x1, y1] = view.convertToViewportPoint(e + (a / len) * item.width, f + (b / len) * item.width);
    lines.push({ text: item.str, x0, y0: view.height - y0, x1, y1: view.height - y1, height: Math.hypot(c, d) });
  }
  return lines;
}

/** Agrega al PDF una página que es la imagen de otra (dibujada por pdf.js), con su texto invisible encima. */
export async function addPageAsImage(out: PDFDocument, proxy: PDFDocumentProxy, index: number, scale = 2): Promise<PDFPage> {
  const pdfPage = await proxy.getPage(index + 1);
  const view = pdfPage.getViewport({ scale: 1 });
  const canvas = await renderPage(proxy, index, scale);
  const jpg = await canvasBytes(canvas, "jpg", 0.88);
  canvas.width = canvas.height = 0;
  const image = await out.embedJpg(jpg);
  const page = out.addPage([view.width, view.height]);
  page.drawImage(image, { x: 0, y: 0, width: view.width, height: view.height });
  const lines = await pageTextLines(proxy, index);
  if (lines.length) await writeInvisibleText(out, page, await textFont(out), lines);
  return page;
}

/**
 * Cambia una página del mismo PDF por su imagen (con el texto invisible encima).
 * La página queda derecha y del tamaño en que se ve; sus anotaciones se quedan.
 */
export async function rasterizeInPlace(doc: PDFDocument, page: PDFPage, proxy: PDFDocumentProxy, index: number, scale = 2): Promise<void> {
  const pdfPage = await proxy.getPage(index + 1);
  const view = pdfPage.getViewport({ scale: 1 });
  const canvas = await renderPage(proxy, index, scale);
  const jpg = await canvasBytes(canvas, "jpg", 0.9);
  canvas.width = canvas.height = 0;
  const image = await doc.embedJpg(jpg);
  const lines = await pageTextLines(proxy, index);
  const turned = page.getRotation().angle % 360 !== 0;
  for (const key of ["CropBox", "BleedBox", "TrimBox", "ArtBox"]) page.node.delete(PDFName.of(key));
  if (turned) page.node.delete(PDFName.of("Annots"));
  page.setRotation(degrees(0));
  page.setMediaBox(0, 0, view.width, view.height);
  page.node.set(PDFName.of("Resources"), doc.context.obj({}));
  page.node.set(PDFName.of("Contents"), doc.context.obj([]));
  page.drawImage(image, { x: 0, y: 0, width: view.width, height: view.height });
  if (lines.length) await writeInvisibleText(doc, page, await textFont(doc), lines);
}

const fonts = new WeakMap<PDFDocument, Promise<PDFFont>>();
function textFont(doc: PDFDocument): Promise<PDFFont> {
  let f = fonts.get(doc);
  if (!f) fonts.set(doc, (f = doc.embedFont(StandardFonts.Helvetica)));
  return f;
}
