// Leer y escribir documentos de Word (.docx) para WEPO Write.
//
// Un .docx es un ZIP con XML adentro (Office Open XML). Aquí se convierte
// word/document.xml (con sus estilos, numeración de listas, vínculos e
// imágenes) al formato del editor (JSON de TipTap/ProseMirror) y de vuelta.
//
// Se conserva: párrafos, títulos, negrita, cursiva, subrayado, tachado,
// fuente, tamaño, color, resaltado, alineación, listas (con niveles),
// tablas, imágenes, vínculos, saltos de línea y de página, interlineado,
// espaciado y sangrías, encabezado y pie de página (texto con número de
// página), comentarios (con respuestas y si están resueltos), cambios
// registrados (insertado y borrado) y el tamaño y márgenes de la página. Lo
// demás (notas al pie, cuadros de texto…) se reporta en `unsupported` para no
// sobrescribir el original.

import JSZip from "jszip";
import type { JSONContent } from "@tiptap/react";
import type { HeaderFooter } from "./extensions";
import type { Comment } from "./review";

/** Tamaño y márgenes de la página, en twips (1/1440 de pulgada), como en Word. */
export type PageSize = { width: number; height: number; top: number; right: number; bottom: number; left: number };

/** Carta con márgenes de 2.5 cm, lo normal en México. */
export const LETTER: PageSize = { width: 12240, height: 15840, top: 1417, right: 1701, bottom: 1417, left: 1701 };

/** Encabezado y pie de página del documento (el mismo en todas las páginas). */
export type HeaderFooterSet = { header: HeaderFooter; footer: HeaderFooter; skipFirst: boolean };

export const NO_HEADER_FOOTER: HeaderFooterSet = { header: { text: "", align: "center" }, footer: { text: "", align: "center" }, skipFirst: false };

export type WriteDocument = {
  content: JSONContent;
  page: PageSize;
  headerFooter: HeaderFooterSet;
  /** Comentarios del documento (el texto comentado lleva la marca `comment` con su id). */
  comments: Comment[];
  /** Cosas del archivo que WEPO Write todavía no conserva. */
  unsupported: string[];
};

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const W14 = "http://schemas.microsoft.com/office/word/2010/wordml";
const W15 = "http://schemas.microsoft.com/office/word/2012/wordml";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const EMU_PER_PX = 9525;

// ───────────── utilidades de XML ─────────────

function parse(xml: string): Document {
  return new DOMParser().parseFromString(xml, "application/xml");
}

function kids(el: Element | null | undefined, name?: string): Element[] {
  if (!el) return [];
  return Array.from(el.children).filter((c) => !name || c.localName === name);
}

function child(el: Element | null | undefined, name: string): Element | undefined {
  return kids(el, name)[0];
}

/** Atributo con prefijo w: (o sin él). */
function attr(el: Element | null | undefined, name: string): string | null {
  if (!el) return null;
  return el.getAttributeNS(W, name) ?? el.getAttribute(`w:${name}`) ?? el.getAttribute(name);
}

/** <w:b/> o <w:b w:val="1"/> es verdadero; <w:b w:val="0"/> o "false", falso. */
function flag(el: Element | undefined): boolean {
  if (!el) return false;
  const v = attr(el, "val");
  return v === null || !["0", "false", "none", "off"].includes(v);
}

/** Identificador del párrafo de un comentario (8 cifras hexadecimales, como los de Word). */
function paraIdOf(n: number): string {
  return (0x10000000 + n).toString(16).toUpperCase();
}

function initialsOf(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join("") || "W"
  );
}

/** "#c00000", "rgb(192, 0, 0)" → "C00000" (como lo escribe Word). */
function colorHex(color: string): string {
  const rgb = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(color);
  if (rgb) return rgb.slice(1, 4).map((n) => Number(n).toString(16).padStart(2, "0")).join("").toUpperCase();
  return color.replace("#", "").slice(0, 6).toUpperCase();
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Ancho y alto (en píxeles) de una imagen PNG, JPEG o GIF, leídos de su cabecera. */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length > 24 && bytes[0] === 0x89 && bytes[1] === 0x50) return { width: view.getUint32(16), height: view.getUint32(20) };
  if (bytes.length > 10 && bytes[0] === 0x47 && bytes[1] === 0x49) return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) return null;
      const marker = bytes[i + 1];
      const length = view.getUint16(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: view.getUint16(i + 5), width: view.getUint16(i + 7) };
      }
      i += 2 + length;
    }
  }
  return null;
}

const HIGHLIGHT_COLORS: Record<string, string> = {
  yellow: "#FFFF00",
  green: "#00FF00",
  cyan: "#00FFFF",
  magenta: "#FF00FF",
  blue: "#0000FF",
  red: "#FF0000",
  darkBlue: "#000080",
  darkCyan: "#008080",
  darkGreen: "#008000",
  darkMagenta: "#800080",
  darkRed: "#800000",
  darkYellow: "#808000",
  darkGray: "#808080",
  lightGray: "#C0C0C0",
  black: "#000000",
  white: "#FFFFFF",
};

// ───────────── leer ─────────────

type StyleInfo = {
  name: string;
  basedOn: string | null;
  outline: number | null;
  rPr: Element | undefined;
  /** Numeración que trae el estilo (p. ej. "List Bullet"). */
  numPr: Element | undefined;
};
type ListInfo = { numId: string; level: number; ordered: boolean };

/** Marca temporal de un salto de página dentro de un párrafo (luego se parte el párrafo ahí). */
const PAGE_MARK = "__pageBreak";
const TWIPS_PER_PT = 20;

/** Interlineado, espaciado y sangrías de un párrafo (pPr) en el formato del editor. */
function paragraphFormat(pPr: Element | undefined, inList: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const spacing = child(pPr, "spacing");
  if (spacing) {
    const before = attr(spacing, "before");
    const after = attr(spacing, "after");
    const line = attr(spacing, "line");
    const rule = attr(spacing, "lineRule") ?? "auto";
    if (before !== null && attr(spacing, "beforeAutospacing") !== "1") out.spaceBefore = Number(before) / TWIPS_PER_PT;
    if (after !== null && attr(spacing, "afterAutospacing") !== "1") out.spaceAfter = Number(after) / TWIPS_PER_PT;
    if (line !== null && Number(line) > 0) out.lineHeight = rule === "auto" ? Math.round((Number(line) / 240) * 100) / 100 : `${Number(line) / TWIPS_PER_PT}pt`;
  }
  // En las listas la sangría la pone la numeración.
  const ind = child(pPr, "ind");
  if (ind && !inList) {
    const left = attr(ind, "left") ?? attr(ind, "start");
    const first = attr(ind, "firstLine");
    const hanging = attr(ind, "hanging");
    if (left !== null && Number(left)) out.indent = Number(left) / TWIPS_PER_PT;
    if (first !== null && Number(first)) out.firstLine = Number(first) / TWIPS_PER_PT;
    else if (hanging !== null && Number(hanging)) out.firstLine = -Number(hanging) / TWIPS_PER_PT;
  }
  return out;
}
type Mark = { type: string; attrs?: Record<string, unknown> };

class Reader {
  styles = new Map<string, StyleInfo>();
  /** numId → formato de cada nivel ("bullet", "decimal"…). */
  numbering = new Map<string, string[]>();
  rels = new Map<string, { target: string; external: boolean; type: string }>();
  unsupported = new Set<string>();
  comments: Comment[] = [];
  /** id del comentario en Word → id del comentario principal en WEPO (las respuestas apuntan al suyo). */
  commentIds = new Map<string, string>();
  /** Comentarios abiertos (entre commentRangeStart y commentRangeEnd) mientras se lee. */
  openComments = new Set<string>();
  constructor(private zip: JSZip) {}

  private async part(type: string): Promise<Element | null> {
    const rel = [...this.rels.values()].find((r) => r.type.endsWith(`/${type}`));
    if (!rel) return null;
    const xml = await this.zip.file(rel.target.startsWith("/") ? rel.target.slice(1) : `word/${rel.target}`)?.async("string");
    return xml ? parse(xml).documentElement : null;
  }

  /** Comentarios (comments.xml) y si están resueltos o son respuestas (commentsExtended.xml). */
  async loadComments() {
    const root = await this.part("comments");
    if (!root) return;
    const extended = new Map<string, { done: boolean; parent: string | null }>();
    for (const ex of kids(await this.part("commentsExtended"))) {
      const paraId = ex.getAttributeNS(W15, "paraId") ?? ex.getAttribute("w15:paraId");
      if (paraId) extended.set(paraId, { done: (ex.getAttributeNS(W15, "done") ?? ex.getAttribute("w15:done")) === "1", parent: ex.getAttributeNS(W15, "paraIdParent") ?? ex.getAttribute("w15:paraIdParent") });
    }
    const byPara = new Map<string, Comment>();
    const all: { docxId: string; comment: Comment; paraId: string | null }[] = [];
    for (const c of kids(root, "comment")) {
      const paragraphs = kids(c, "p");
      const text = paragraphs.map((p) => Array.from(p.getElementsByTagNameNS(W, "t")).map((t) => t.textContent ?? "").join("")).join("\n").trim();
      const last = paragraphs[paragraphs.length - 1];
      const paraId = last ? (last.getAttributeNS(W14, "paraId") ?? last.getAttribute("w14:paraId")) : null;
      const docxId = attr(c, "id") ?? "";
      const comment: Comment = {
        id: `k${docxId}`,
        author: attr(c, "author") ?? "",
        initials: attr(c, "initials") ?? "",
        date: attr(c, "date") ?? "",
        text,
        done: paraId ? (extended.get(paraId)?.done ?? false) : false,
        replies: [],
      };
      all.push({ docxId, comment, paraId });
      if (paraId) byPara.set(paraId, comment);
    }
    for (const { docxId, comment, paraId } of all) {
      const parentPara = paraId ? extended.get(paraId)?.parent : null;
      const parent = parentPara ? byPara.get(parentPara) : undefined;
      if (parent && parent !== comment) {
        parent.replies.push(comment);
        this.commentIds.set(docxId, parent.id);
      } else {
        this.comments.push(comment);
        this.commentIds.set(docxId, comment.id);
      }
    }
  }

  /** Marcas de los comentarios abiertos en este punto del texto. */
  commentMarks(): Mark[] {
    return [...this.openComments].map((id) => ({ type: "comment", attrs: { id } }));
  }

  /** Inicio o fin del texto comentado (pueden venir dentro o fuera de un párrafo). */
  commentRange(el: Element): boolean {
    if (el.localName !== "commentRangeStart" && el.localName !== "commentRangeEnd") return false;
    const id = this.commentIds.get(attr(el, "id") ?? "");
    if (id) {
      if (el.localName === "commentRangeStart") this.openComments.add(id);
      else this.openComments.delete(id);
    }
    return true;
  }

  async load() {
    const styles = await this.zip.file("word/styles.xml")?.async("string");
    if (styles) {
      for (const s of kids(parse(styles).documentElement, "style")) {
        const id = attr(s, "styleId");
        if (!id) continue;
        const outline = attr(child(child(s, "pPr"), "outlineLvl"), "val");
        this.styles.set(id, {
          name: (attr(child(s, "name"), "val") ?? id).toLowerCase(),
          basedOn: attr(child(s, "basedOn"), "val"),
          outline: outline === null ? null : Number(outline),
          rPr: child(s, "rPr"),
          numPr: child(child(s, "pPr"), "numPr"),
        });
      }
    }
    const numbering = await this.zip.file("word/numbering.xml")?.async("string");
    if (numbering) {
      const root = parse(numbering).documentElement;
      const abstract = new Map<string, string[]>();
      for (const a of kids(root, "abstractNum")) {
        const levels: string[] = [];
        for (const lvl of kids(a, "lvl")) levels[Number(attr(lvl, "ilvl") ?? 0)] = attr(child(lvl, "numFmt"), "val") ?? "decimal";
        abstract.set(attr(a, "abstractNumId") ?? "", levels);
      }
      for (const n of kids(root, "num")) {
        this.numbering.set(attr(n, "numId") ?? "", abstract.get(attr(child(n, "abstractNumId"), "val") ?? "") ?? []);
      }
    }
    const rels = await this.zip.file("word/_rels/document.xml.rels")?.async("string");
    if (rels) {
      for (const r of kids(parse(rels).documentElement, "Relationship")) {
        this.rels.set(r.getAttribute("Id") ?? "", {
          target: r.getAttribute("Target") ?? "",
          external: r.getAttribute("TargetMode") === "External",
          type: r.getAttribute("Type") ?? "",
        });
      }
    }
  }

  /** Nivel de título de un estilo de párrafo (1 a 6), siguiendo sus estilos base. */
  headingLevel(styleId: string | null): number | null {
    for (let id = styleId, guard = 0; id && guard < 10; guard++) {
      const s = this.styles.get(id);
      if (!s) return null;
      const m = /^heading (\d)$/.exec(s.name);
      if (m) return Math.min(6, Number(m[1]));
      if (s.name === "title") return 1;
      if (s.name === "subtitle") return 2;
      if (s.outline !== null && s.outline < 6) return s.outline + 1;
      id = s.basedOn;
    }
    return null;
  }

  marks(rPr: Element | undefined): Mark[] {
    const marks: Mark[] = [];
    if (!rPr) return marks;
    if (flag(child(rPr, "b"))) marks.push({ type: "bold" });
    if (flag(child(rPr, "i"))) marks.push({ type: "italic" });
    const u = child(rPr, "u");
    if (u && attr(u, "val") !== "none") marks.push({ type: "underline" });
    if (flag(child(rPr, "strike")) || flag(child(rPr, "dstrike"))) marks.push({ type: "strike" });
    const style: Record<string, string> = {};
    const color = attr(child(rPr, "color"), "val");
    if (color && color !== "auto") style.color = `#${color}`;
    const size = attr(child(rPr, "sz"), "val");
    if (size) style.fontSize = `${Number(size) / 2}pt`;
    const fonts = child(rPr, "rFonts");
    const font = attr(fonts, "ascii") ?? attr(fonts, "hAnsi");
    if (font) style.fontFamily = font;
    if (Object.keys(style).length) marks.push({ type: "textStyle", attrs: style });
    const highlight = attr(child(rPr, "highlight"), "val");
    const shading = attr(child(rPr, "shd"), "fill");
    if (highlight && HIGHLIGHT_COLORS[highlight]) marks.push({ type: "highlight", attrs: { color: HIGHLIGHT_COLORS[highlight] } });
    else if (shading && shading !== "auto" && shading !== "FFFFFF") marks.push({ type: "highlight", attrs: { color: `#${shading}` } });
    return marks;
  }

  async image(drawing: Element): Promise<JSONContent | null> {
    const blip = drawing.getElementsByTagNameNS("http://schemas.openxmlformats.org/drawingml/2006/main", "blip")[0];
    const id = blip?.getAttributeNS(R, "embed") ?? blip?.getAttribute("r:embed");
    const rel = id ? this.rels.get(id) : undefined;
    if (!rel) return null;
    const path = rel.target.startsWith("/") ? rel.target.slice(1) : `word/${rel.target}`;
    const file = this.zip.file(path);
    if (!file) return null;
    const ext = path.split(".").pop()?.toLowerCase() ?? "png";
    const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "gif" ? "image/gif" : ext === "png" ? "image/png" : null;
    if (!mime) {
      this.unsupported.add("imágenes en formatos que no son PNG, JPEG o GIF");
      return null;
    }
    const bytes = await file.async("uint8array");
    const extent = drawing.getElementsByTagNameNS("http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing", "extent")[0];
    const width = extent ? Math.round(Number(extent.getAttribute("cx")) / EMU_PER_PX) : null;
    const height = extent ? Math.round(Number(extent.getAttribute("cy")) / EMU_PER_PX) : null;
    const name = drawing.getElementsByTagNameNS("http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing", "docPr")[0];
    return { type: "image", attrs: { src: `data:${mime};base64,${toBase64(bytes)}`, alt: name?.getAttribute("descr") || name?.getAttribute("name") || null, width, height } };
  }

  /** Contenido en línea de un párrafo: texto con formato, saltos, imágenes y vínculos. */
  async inline(el: Element, marks: Mark[], out: JSONContent[]) {
    for (const node of kids(el)) {
      switch (node.localName) {
        case "r": {
          const rPr = child(node, "rPr");
          const styled = this.marks(rPr);
          const charStyle = attr(child(rPr, "rStyle"), "val");
          const fromStyle = charStyle ? this.marks(this.styles.get(charStyle)?.rPr) : [];
          if (child(rPr, "rPrChange")) this.unsupported.add("cambios de formato registrados");
          const all = [...marks, ...fromStyle.filter((m) => !styled.some((s) => s.type === m.type)), ...styled, ...this.commentMarks()];
          for (const part of kids(node)) {
            if (part.localName === "t" || part.localName === "delText") {
              const text = part.textContent ?? "";
              if (text) out.push({ type: "text", text, ...(all.length ? { marks: all } : {}) });
            } else if (part.localName === "tab") {
              out.push({ type: "text", text: "\t", ...(all.length ? { marks: all } : {}) });
            } else if (part.localName === "br" && attr(part, "type") === "page") {
              out.push({ type: PAGE_MARK });
            } else if (part.localName === "br" && attr(part, "type") === "column") {
              // Las columnas no existen en WEPO: el salto de columna se ignora.
            } else if (part.localName === "br" || part.localName === "cr") {
              out.push({ type: "hardBreak" });
            } else if (part.localName === "drawing") {
              const image = await this.image(part);
              if (image) out.push(image);
            } else if (part.localName === "footnoteReference" || part.localName === "endnoteReference") {
              this.unsupported.add("notas al pie");
            } else if (part.localName === "commentReference" || part.localName === "annotationRef") {
              // La marca del comentario ya va sobre el texto.
            } else if (part.localName === "pict" || part.localName === "object") {
              this.unsupported.add("formas u objetos incrustados");
            } else if (part.localName === "AlternateContent") {
              this.unsupported.add("cuadros de texto o formas");
            }
          }
          break;
        }
        case "hyperlink": {
          const id = node.getAttributeNS(R, "id") ?? node.getAttribute("r:id");
          const anchor = attr(node, "anchor");
          const rel = id ? this.rels.get(id) : undefined;
          const href = rel?.target ?? (anchor ? `#${anchor}` : null);
          await this.inline(node, href ? [...marks, { type: "link", attrs: { href } }] : marks, out);
          break;
        }
        // Control de cambios: lo insertado y lo borrado quedan marcados para aceptarlos o rechazarlos.
        case "ins":
        case "moveTo":
        case "del":
        case "moveFrom": {
          const kind = node.localName === "ins" || node.localName === "moveTo" ? "insertion" : "deletion";
          const change = { type: kind, attrs: { id: `w${attr(node, "id") ?? ""}`, author: attr(node, "author") ?? "", date: attr(node, "date") ?? "" } };
          await this.inline(node, [...marks, change], out);
          break;
        }
        case "commentRangeStart":
        case "commentRangeEnd":
          this.commentRange(node);
          break;
        case "smartTag":
        case "fldSimple":
          await this.inline(node, marks, out);
          break;
        case "sdt":
          await this.inline(child(node, "sdtContent") ?? node, marks, out);
          break;
      }
    }
  }

  async paragraph(p: Element): Promise<{ node: JSONContent; list: ListInfo | null }> {
    const pPr = child(p, "pPr");
    const jc = attr(child(pPr, "jc"), "val");
    const textAlign = jc === "center" ? "center" : jc === "right" || jc === "end" ? "right" : jc === "both" || jc === "distribute" ? "justify" : null;
    const styleId = attr(child(pPr, "pStyle"), "val");
    if (child(pPr, "pPrChange")) this.unsupported.add("cambios de formato registrados");
    const level = this.headingLevel(styleId);
    const content: JSONContent[] = [];
    // El formato de letra del estilo del párrafo (p. ej. "Cita" en cursiva) se aplica a su texto.
    const styleMarks = styleId && level === null ? this.marks(this.styles.get(styleId)?.rPr) : [];
    await this.inline(p, styleMarks, content);
    const attrs: Record<string, unknown> = {};
    if (textAlign) attrs.textAlign = textAlign;
    if (flag(child(pPr, "pageBreakBefore"))) content.unshift({ type: PAGE_MARK });
    const inList = Boolean(child(pPr, "numPr"));
    Object.assign(attrs, paragraphFormat(pPr, inList));
    const node: JSONContent =
      level !== null
        ? { type: "heading", attrs: { ...attrs, level }, ...(content.length ? { content } : {}) }
        : { type: "paragraph", ...(Object.keys(attrs).length ? { attrs } : {}), ...(content.length ? { content } : {}) };

    // La numeración puede venir en el párrafo o en su estilo (o en el estilo base).
    let numPr = child(pPr, "numPr");
    for (let id = styleId, guard = 0; !numPr && id && guard < 10; guard++) {
      const style = this.styles.get(id);
      numPr = style?.numPr;
      id = style?.basedOn ?? null;
    }
    const numId = attr(child(numPr, "numId"), "val");
    if (numPr && numId && numId !== "0") {
      // Sin nivel en el párrafo, "List Bullet 2" y similares indican el nivel en su nombre.
      const styleLevel = /list (?:bullet|number) (\d)$/.exec(this.styles.get(styleId ?? "")?.name ?? "");
      const lvl = Number(attr(child(numPr, "ilvl"), "val") ?? (styleLevel ? Number(styleLevel[1]) - 1 : 0));
      const format = this.numbering.get(numId)?.[lvl] ?? "decimal";
      const item = node.type === "heading" ? { ...node, type: "paragraph", attrs: undefined } : node;
      // En una lista no se parten párrafos por saltos de página.
      if (item.content) item.content = item.content.filter((c) => c.type !== PAGE_MARK);
      return { node: item, list: { numId, level: lvl, ordered: format !== "bullet" } };
    }
    return { node, list: null };
  }

  async table(tbl: Element): Promise<JSONContent> {
    const rows: JSONContent[] = [];
    // Ancho de cada columna (twips → píxeles).
    const grid = kids(child(tbl, "tblGrid"), "gridCol").map((g) => Math.round(Number(attr(g, "w") ?? 0) / 15) || null);
    // Celdas combinadas hacia abajo que siguen abiertas, por columna.
    const open = new Map<number, JSONContent>();
    for (const tr of kids(tbl, "tr")) {
      const header = Boolean(child(child(tr, "trPr"), "tblHeader"));
      const cells: JSONContent[] = [];
      let col = Number(attr(child(child(tr, "trPr"), "gridBefore"), "val") ?? 0);
      for (const tc of kids(tr, "tc")) {
        const tcPr = child(tc, "tcPr");
        const span = Number(attr(child(tcPr, "gridSpan"), "val") ?? 1);
        const vMerge = child(tcPr, "vMerge");
        const merge = vMerge ? (attr(vMerge, "val") ?? "continue") : null;
        if (merge === "continue" && open.has(col)) {
          // Es la continuación de la celda de arriba: esa celda crece una fila.
          const above = open.get(col)!;
          above.attrs!.rowspan = Number(above.attrs!.rowspan) + 1;
          col += span;
          continue;
        }
        const content = await this.blocks(tc);
        const fill = attr(child(tcPr, "shd"), "fill");
        const widths = grid.slice(col, col + span);
        const cell: JSONContent = {
          type: header ? "tableHeader" : "tableCell",
          attrs: {
            colspan: span,
            rowspan: 1,
            colwidth: widths.length === span && widths.every((w) => w) ? widths : null,
            backgroundColor: fill && fill !== "auto" ? `#${fill}` : null,
          },
          content: content.length ? content : [{ type: "paragraph" }],
        };
        for (let c = col; c < col + span; c++) open.delete(c);
        if (merge === "restart") open.set(col, cell);
        cells.push(cell);
        col += span;
      }
      if (cells.length) rows.push({ type: "tableRow", content: cells });
    }
    return { type: "table", content: rows };
  }

  /** Bloques de un contenedor (el cuerpo o una celda): párrafos, listas y tablas. */
  async blocks(container: Element): Promise<JSONContent[]> {
    const out: JSONContent[] = [];
    // Listas abiertas, de la de afuera hacia adentro.
    let stack: { list: JSONContent; ordered: boolean }[] = [];
    const closeLists = () => {
      stack = [];
    };
    for (const el of kids(container)) {
      if (el.localName === "p") {
        const { node, list } = await this.paragraph(el);
        if (!list) {
          closeLists();
          out.push(...splitAtPageBreaks(node));
          continue;
        }
        // Un elemento de lista: se acomoda en el nivel que le toca.
        while (stack.length > list.level + 1) stack.pop();
        if (stack.length && stack.length === list.level + 1 && stack[stack.length - 1].ordered !== list.ordered) stack.pop();
        while (stack.length < list.level + 1) {
          const fresh: JSONContent = { type: list.ordered ? "orderedList" : "bulletList", content: [] };
          if (!stack.length) out.push(fresh);
          else {
            const parent = stack[stack.length - 1].list;
            const lastItem = parent.content![parent.content!.length - 1];
            if (lastItem) lastItem.content!.push(fresh);
            else parent.content!.push({ type: "listItem", content: [{ type: "paragraph" }, fresh] });
          }
          stack.push({ list: fresh, ordered: list.ordered });
        }
        stack[stack.length - 1].list.content!.push({ type: "listItem", content: [node] });
      } else if (el.localName === "tbl") {
        closeLists();
        out.push(await this.table(el));
      } else if (el.localName === "sdt") {
        closeLists();
        out.push(...(await this.blocks(child(el, "sdtContent") ?? el)));
      } else if (el.localName === "AlternateContent") {
        this.unsupported.add("cuadros de texto o formas");
      } else this.commentRange(el);
    }
    return out;
  }
}

/** Parte un párrafo en sus saltos de página: texto, salto, texto. */
function splitAtPageBreaks(node: JSONContent): JSONContent[] {
  const content = node.content ?? [];
  if (!content.some((c) => c.type === PAGE_MARK)) return [node];
  const out: JSONContent[] = [];
  let part: JSONContent[] = [];
  const { content: _content, ...shell } = node;
  const flush = () => {
    if (part.length) out.push({ ...shell, content: part });
    part = [];
  };
  for (const c of content) {
    if (c.type === PAGE_MARK) {
      flush();
      out.push({ type: "pageBreak" });
    } else part.push(c);
  }
  flush();
  return out;
}

/** Texto de un encabezado o pie: los campos de número de página se vuelven [Página] y [Páginas]. */
function headerFooterText(root: Element, unsupported: Set<string>): HeaderFooter {
  const parts: string[] = [];
  let align: HeaderFooter["align"] = "left";
  const field = (instr: string) => {
    const name = instr.trim().split(/\s+/)[0]?.toUpperCase();
    return name === "PAGE" ? "[Página]" : name === "NUMPAGES" || name === "SECTIONPAGES" ? "[Páginas]" : name === "DATE" || name === "TIME" ? "[Fecha]" : name === "FILENAME" ? "[Archivo]" : null;
  };
  const paragraphs = Array.from(root.getElementsByTagNameNS(W, "p"));
  paragraphs.forEach((p, i) => {
    const jc = attr(child(child(p, "pPr"), "jc"), "val");
    if (i === 0 || (!parts.join("").trim() && jc)) align = jc === "center" ? "center" : jc === "right" || jc === "end" ? "right" : "left";
    let text = "";
    let instr: string | null = null;
    let inResult = false;
    const walk = (el: Element) => {
      for (const node of kids(el)) {
        const name = node.localName;
        if (name === "fldSimple") {
          text += field(attr(node, "instr") ?? "") ?? node.textContent ?? "";
        } else if (name === "fldChar") {
          const type = attr(node, "fldCharType");
          if (type === "begin") (instr = ""), (inResult = false);
          else if (type === "separate") inResult = true;
          else if (type === "end") {
            if (instr !== null) text += field(instr) ?? "";
            instr = null;
            inResult = false;
          }
        } else if (name === "instrText") {
          if (instr !== null) instr += node.textContent ?? "";
        } else if (name === "t") {
          if (instr === null && !inResult) text += node.textContent ?? "";
          else if (instr !== null && inResult && !field(instr)) text += node.textContent ?? "";
        } else if (name === "tab") {
          if (instr === null) text += "   ";
        } else if (name === "drawing" || name === "pict" || name === "tbl" || name === "AlternateContent") {
          unsupported.add("imágenes o tablas en el encabezado o el pie");
        } else if (name !== "pPr" && name !== "rPr") walk(node);
      }
    };
    walk(p);
    if (text.trim()) parts.push(text.trim());
  });
  return { text: parts.join(" · "), align };
}

async function readHeaderFooter(zip: JSZip, reader: Reader, sectPr: Element | undefined): Promise<HeaderFooterSet> {
  const result: HeaderFooterSet = structuredClone(NO_HEADER_FOOTER);
  const load = async (ref: Element | undefined): Promise<HeaderFooter | null> => {
    const id = ref?.getAttributeNS(R, "id") ?? ref?.getAttribute("r:id");
    const rel = id ? reader.rels.get(id) : undefined;
    if (!rel) return null;
    const xml = await zip.file(rel.target.startsWith("/") ? rel.target.slice(1) : `word/${rel.target}`)?.async("string");
    return xml ? headerFooterText(parse(xml).documentElement, reader.unsupported) : null;
  };
  for (const kind of ["header", "footer"] as const) {
    const refs = kids(sectPr, `${kind}Reference`);
    const byType = (type: string) => refs.find((r) => (attr(r, "type") ?? "default") === type);
    const main = await load(byType("default"));
    if (main) result[kind] = main;
    if (flag(child(sectPr, "titlePg"))) {
      const first = await load(byType("first"));
      if (!first || !first.text) result.skipFirst = Boolean(result.header.text || result.footer.text || result.skipFirst || main?.text);
      else if (first.text !== main?.text) reader.unsupported.add("encabezado o pie distinto en la primera página");
    }
    if (byType("even")) {
      const even = await load(byType("even"));
      if (even?.text && even.text !== main?.text) reader.unsupported.add("encabezados distintos en páginas pares");
    }
  }
  return result;
}

function pageFrom(sectPr: Element | undefined): PageSize {
  const size = child(sectPr, "pgSz");
  const margin = child(sectPr, "pgMar");
  const n = (el: Element | undefined, name: string, fallback: number) => {
    const v = Number(attr(el, name));
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  return {
    width: n(size, "w", LETTER.width),
    height: n(size, "h", LETTER.height),
    top: n(margin, "top", LETTER.top),
    right: n(margin, "right", LETTER.right),
    bottom: n(margin, "bottom", LETTER.bottom),
    left: n(margin, "left", LETTER.left),
  };
}

export async function readDocx(data: Uint8Array): Promise<WriteDocument> {
  const zip = await JSZip.loadAsync(data);
  const xml = await zip.file("word/document.xml")?.async("string");
  if (!xml) throw new Error("El archivo no parece un documento de Word (no tiene word/document.xml)");
  const reader = new Reader(zip);
  await reader.load();
  await reader.loadComments();
  const body = child(parse(xml).documentElement, "body");
  if (!body) throw new Error("El documento está vacío o dañado");
  const content = await reader.blocks(body);
  const sectPr = child(body, "sectPr");
  if (kids(body, "p").some((p) => child(child(p, "pPr"), "sectPr"))) reader.unsupported.add("varias secciones");
  const headerFooter = await readHeaderFooter(zip, reader, sectPr);
  return {
    content: { type: "doc", content: content.length ? content : [{ type: "paragraph" }] },
    page: pageFrom(sectPr),
    headerFooter,
    comments: reader.comments,
    unsupported: [...reader.unsupported],
  };
}

// ───────────── escribir ─────────────

type ListLevels = { ordered: boolean[] };

class Writer {
  media: { name: string; data: Uint8Array; mime: string }[] = [];
  rels: string[] = [];
  /** Una numeración por cada lista de primer nivel (para que cada lista numerada empiece en 1). */
  lists: ListLevels[] = [];
  private relId = 10;
  private changeId = 1000;
  /** Dónde empieza y termina cada comentario (el primer y el último pedazo de texto comentado). */
  private starts = new Map<JSONContent, string[]>();
  private ends = new Map<JSONContent, string[]>();
  /** id de WEPO → número de comentario en Word (las respuestas tienen el suyo). */
  commentNumbers = new Map<string, number>();
  /** Comentarios que sí tienen texto comentado en el documento. */
  liveComments: Comment[] = [];

  constructor(
    private page: PageSize,
    comments: Comment[] = [],
    content?: JSONContent,
  ) {
    if (!content || !comments.length) return;
    const first = new Map<string, JSONContent>();
    const last = new Map<string, JSONContent>();
    const walk = (node: JSONContent) => {
      if (node.type === "text" || node.type === "image" || node.type === "hardBreak") {
        for (const m of (node.marks ?? []) as Mark[]) {
          if (m.type !== "comment") continue;
          const id = String(m.attrs?.id);
          if (!first.has(id)) first.set(id, node);
          last.set(id, node);
        }
        return;
      }
      node.content?.forEach(walk);
    };
    walk(content);
    let n = 0;
    for (const c of comments) {
      if (!first.has(c.id)) continue;
      this.liveComments.push(c);
      this.commentNumbers.set(c.id, n++);
      for (const r of c.replies) this.commentNumbers.set(r.id, n++);
      const add = (map: Map<JSONContent, string[]>, node: JSONContent) => map.set(node, [...(map.get(node) ?? []), c.id]);
      add(this.starts, first.get(c.id)!);
      add(this.ends, last.get(c.id)!);
    }
  }

  /** Números de Word del comentario y sus respuestas (todos marcan el mismo texto). */
  private numbers(id: string): number[] {
    const c = this.liveComments.find((x) => x.id === id);
    return c ? [c, ...c.replies].map((x) => this.commentNumbers.get(x.id)!) : [];
  }

  private commentMarkers(node: JSONContent): { before: string; after: string } {
    const before = (this.starts.get(node) ?? []).flatMap((id) => this.numbers(id)).map((n) => `<w:commentRangeStart w:id="${n}"/>`).join("");
    const after = (this.ends.get(node) ?? [])
      .flatMap((id) => this.numbers(id))
      .map((n) => `<w:commentRangeEnd w:id="${n}"/><w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="${n}"/></w:r>`)
      .join("");
    return { before, after };
  }

  /** <w:ins> o <w:del> alrededor de un pedazo de texto registrado con el control de cambios. */
  private tracked(xml: string, marks: Mark[] = []): string {
    for (const kind of ["insertion", "deletion"] as const) {
      const m = marks.find((x) => x.type === kind);
      if (!m) continue;
      const a = (m.attrs ?? {}) as { author?: string; date?: string };
      const tag = kind === "insertion" ? "w:ins" : "w:del";
      const date = a.date ? ` w:date="${escapeXml(a.date)}"` : "";
      return `<${tag} w:id="${this.changeId++}" w:author="${escapeXml(a.author || "WEPO")}"${date}>${xml}</${tag}>`;
    }
    return xml;
  }

  rel(type: string, target: string, external = false): string {
    const id = `rId${this.relId++}`;
    this.rels.push(
      `<Relationship Id="${id}" Type="${REL}/${type}" Target="${escapeXml(target)}"${external ? ' TargetMode="External"' : ""}/>`,
    );
    return id;
  }

  runProps(marks: Mark[] = []): string {
    let props = "";
    const has = (t: string) => marks.find((m) => m.type === t);
    const style = has("textStyle")?.attrs as Record<string, string> | undefined;
    if (has("link")) props += '<w:rStyle w:val="Hyperlink"/>';
    if (style?.fontFamily) {
      const font = escapeXml(style.fontFamily.split(",")[0].replace(/["']/g, "").trim());
      props += `<w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:cs="${font}"/>`;
    }
    if (has("bold")) props += "<w:b/>";
    if (has("italic")) props += "<w:i/>";
    if (has("strike")) props += "<w:strike/>";
    if (style?.color) props += `<w:color w:val="${colorHex(style.color)}"/>`;
    if (style?.fontSize) {
      const m = /([\d.]+)\s*(pt|px)?/.exec(style.fontSize);
      if (m) props += `<w:sz w:val="${Math.round((m[2] === "px" ? Number(m[1]) * 0.75 : Number(m[1])) * 2)}"/>`;
    }
    const highlight = has("highlight")?.attrs as { color?: string } | undefined;
    if (highlight) props += `<w:shd w:val="clear" w:color="auto" w:fill="${colorHex(highlight.color ?? "#FFFF00")}"/>`;
    if (has("underline")) props += '<w:u w:val="single"/>';
    return props ? `<w:rPr>${props}</w:rPr>` : "";
  }

  text(node: JSONContent): string {
    const props = this.runProps(node.marks as Mark[]);
    // Los tabuladores son su propio elemento en Word.
    const parts = (node.text ?? "").split("\t");
    // Lo borrado con el control de cambios va en <w:delText>.
    const textTag = (node.marks as Mark[] | undefined)?.some((m) => m.type === "deletion") ? "w:delText" : "w:t";
    const runs = parts
      .map((part, i) => (i ? "<w:tab/>" : "") + (part ? `<${textTag} xml:space="preserve">${escapeXml(part)}</${textTag}>` : ""))
      .join("");
    const run = this.tracked(`<w:r>${props}${runs}</w:r>`, node.marks as Mark[]);
    const link = (node.marks as Mark[] | undefined)?.find((m) => m.type === "link")?.attrs as { href?: string } | undefined;
    if (!link?.href) return run;
    if (link.href.startsWith("#")) return `<w:hyperlink w:anchor="${escapeXml(link.href.slice(1))}">${run}</w:hyperlink>`;
    return `<w:hyperlink r:id="${this.rel("hyperlink", link.href, true)}">${run}</w:hyperlink>`;
  }

  image(node: JSONContent): string {
    const src = String(node.attrs?.src ?? "");
    const m = /^data:(image\/(png|jpeg|gif));base64,(.*)$/.exec(src);
    if (!m) return "";
    const bytes = fromBase64(m[3]);
    const ext = m[2] === "jpeg" ? "jpeg" : m[2];
    const name = `image${this.media.length + 1}.${ext}`;
    this.media.push({ name, data: bytes, mime: m[1] });
    const id = this.rel("image", `media/${name}`);
    const natural = imageSize(bytes) ?? { width: 300, height: 200 };
    // Sin tamaño propio, la imagen se ve a su tamaño, sin pasarse del ancho útil de la página.
    const maxWidth = ((this.page.width - this.page.left - this.page.right) / 1440) * 96;
    let width = Number(node.attrs?.width) || natural.width;
    let height = Number(node.attrs?.height) || (natural.height * width) / natural.width;
    if (width > maxWidth) {
      height = (height * maxWidth) / width;
      width = maxWidth;
    }
    const cx = Math.round(width * EMU_PER_PX);
    const cy = Math.round(height * EMU_PER_PX);
    const n = this.media.length;
    const alt = escapeXml(String(node.attrs?.alt ?? name));
    return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${n}" name="Imagen ${n}" descr="${alt}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${n}" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
  }

  inline(nodes: JSONContent[] = []): string {
    return nodes
      .map((n) => {
        const body =
          n.type === "text" ? this.text(n) : n.type === "hardBreak" ? "<w:r><w:br/></w:r>" : n.type === "image" ? this.tracked(this.image(n), n.marks as Mark[]) : "";
        const { before, after } = this.commentMarkers(n);
        return before + body + after;
      })
      .join("");
  }

  /** word/comments.xml: cada comentario y cada respuesta es un <w:comment>. */
  commentsXml(): string {
    const one = (c: Comment) => {
      const n = this.commentNumbers.get(c.id)!;
      const lines = c.text.split("\n");
      const paragraphs = lines
        .map((line, i) => {
          const paraId = i === lines.length - 1 ? ` w14:paraId="${paraIdOf(n)}"` : "";
          const ref = i === 0 ? '<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:annotationRef/></w:r>' : "";
          return `<w:p${paraId}><w:pPr><w:pStyle w:val="CommentText"/></w:pPr>${ref}<w:r><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r></w:p>`;
        })
        .join("");
      const date = c.date ? ` w:date="${escapeXml(c.date)}"` : "";
      return `<w:comment w:id="${n}" w:author="${escapeXml(c.author || "WEPO")}"${date} w:initials="${escapeXml(c.initials || initialsOf(c.author))}">${paragraphs}</w:comment>`;
    };
    const body = this.liveComments.flatMap((c) => [c, ...c.replies]).map(one).join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments xmlns:w="${W}" xmlns:w14="${W14}">${body}</w:comments>`;
  }

  /** word/commentsExtended.xml: qué comentarios están resueltos y cuáles son respuestas. */
  commentsExtendedXml(): string {
    const rows = this.liveComments
      .flatMap((c) => [
        `<w15:commentEx w15:paraId="${paraIdOf(this.commentNumbers.get(c.id)!)}" w15:done="${c.done ? 1 : 0}"/>`,
        ...c.replies.map(
          (r) => `<w15:commentEx w15:paraId="${paraIdOf(this.commentNumbers.get(r.id)!)}" w15:paraIdParent="${paraIdOf(this.commentNumbers.get(c.id)!)}" w15:done="${c.done ? 1 : 0}"/>`,
        ),
      ])
      .join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w15:commentsEx xmlns:w15="${W15}">${rows}</w15:commentsEx>`;
  }

  paragraph(node: JSONContent, extra = ""): string {
    let props = extra;
    if (node.type === "heading") props = `<w:pStyle w:val="Heading${node.attrs?.level ?? 1}"/>` + props;
    const a = node.attrs ?? {};
    const twips = (v: unknown) => Math.round(Number(v) * 20);
    const spacing: string[] = [];
    if (a.spaceBefore !== null && a.spaceBefore !== undefined) spacing.push(`w:before="${twips(a.spaceBefore)}"`);
    if (a.spaceAfter !== null && a.spaceAfter !== undefined) spacing.push(`w:after="${twips(a.spaceAfter)}"`);
    if (typeof a.lineHeight === "number") spacing.push(`w:line="${Math.round(a.lineHeight * 240)}" w:lineRule="auto"`);
    else if (typeof a.lineHeight === "string" && /^[\d.]+pt$/.test(a.lineHeight)) spacing.push(`w:line="${twips(parseFloat(a.lineHeight))}" w:lineRule="exact"`);
    if (spacing.length) props += `<w:spacing ${spacing.join(" ")}/>`;
    const ind: string[] = [];
    if (a.indent) ind.push(`w:left="${twips(a.indent)}"`);
    if (a.firstLine) ind.push(Number(a.firstLine) > 0 ? `w:firstLine="${twips(a.firstLine)}"` : `w:hanging="${twips(-Number(a.firstLine))}"`);
    if (ind.length && !extra.includes("<w:numPr>")) props += `<w:ind ${ind.join(" ")}/>`;
    const align = node.attrs?.textAlign as string | undefined;
    if (align && align !== "left") props += `<w:jc w:val="${align === "justify" ? "both" : align}"/>`;
    const pPr = props ? `<w:pPr>${props}</w:pPr>` : "";
    return `<w:p>${pPr}${this.inline(node.content)}</w:p>`;
  }

  /** Tipos de lista por nivel (para armar su numeración). */
  private levels(list: JSONContent, depth: number, out: boolean[]) {
    if (out[depth] === undefined) out[depth] = list.type === "orderedList";
    for (const item of list.content ?? []) {
      for (const c of item.content ?? []) if (c.type === "bulletList" || c.type === "orderedList") this.levels(c, depth + 1, out);
    }
  }

  list(list: JSONContent, depth: number, numId: number): string {
    let xml = "";
    for (const item of list.content ?? []) {
      for (const c of item.content ?? []) {
        if (c.type === "bulletList" || c.type === "orderedList") xml += this.list(c, depth + 1, numId);
        else if (c.type === "paragraph" || c.type === "heading") {
          xml += this.paragraph(c, `<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="${depth}"/><w:numId w:val="${numId}"/></w:numPr>`);
        } else xml += this.block(c);
      }
    }
    return xml;
  }

  table(table: JSONContent): string {
    const rows = table.content ?? [];
    // Columnas: lo que mide la primera fila más lo que ocupan las celdas combinadas de arriba.
    const columns = Math.max(1, ...rows.map((r) => (r.content ?? []).reduce((n, c) => n + Number(c.attrs?.colspan ?? 1), 0)));
    const usable = this.page.width - this.page.left - this.page.right;
    // Anchos guardados (en píxeles) si la tabla se ajustó a mano; si no, columnas iguales.
    const widths: (number | null)[] = Array(columns).fill(null);
    for (const row of rows) {
      let c = 0;
      for (const cell of row.content ?? []) {
        const span = Number(cell.attrs?.colspan ?? 1);
        const cw = cell.attrs?.colwidth as (number | null)[] | null;
        cw?.forEach((w, i) => w && widths[c + i] === null && (widths[c + i] = w * 15));
        c += span;
      }
    }
    const known = widths.filter((w): w is number => w !== null);
    const rest = columns - known.length;
    const fallback = rest ? Math.max(600, Math.floor((usable - known.reduce((a, b) => a + b, 0)) / rest)) : 0;
    const colW = widths.map((w) => Math.round(w ?? fallback));
    const grid = colW.map((w) => `<w:gridCol w:w="${w}"/>`).join("");
    const width = (col: number, span: number) => colW.slice(col, col + span).reduce((a, b) => a + b, 0);
    const cellProps = (cell: JSONContent | null, col: number, span: number, merge: "restart" | "continue" | null) => {
      const fill = cell?.attrs?.backgroundColor as string | null | undefined;
      const shd = fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${colorHex(fill)}"/>` : "";
      return `<w:tcPr><w:tcW w:w="${width(col, span)}" w:type="dxa"/>${span > 1 ? `<w:gridSpan w:val="${span}"/>` : ""}${merge ? `<w:vMerge${merge === "restart" ? ' w:val="restart"' : ""}/>` : ""}${shd}</w:tcPr>`;
    };
    // Celdas combinadas hacia abajo: en Word cada fila lleva su pedazo (vMerge).
    const pending = new Map<number, { left: number; span: number; cell: JSONContent }>();
    const body = rows
      .map((row) => {
        const header = (row.content ?? []).every((c) => c.type === "tableHeader");
        const queue = [...(row.content ?? [])];
        let cells = "";
        let col = 0;
        while (col < columns && (queue.length || [...pending.keys()].some((k) => k >= col))) {
          const below = pending.get(col);
          if (below) {
            cells += `<w:tc>${cellProps(below.cell, col, below.span, "continue")}<w:p/></w:tc>`;
            if (--below.left === 0) pending.delete(col);
            col += below.span;
            continue;
          }
          const cell = queue.shift();
          if (!cell) {
            col++;
            continue;
          }
          const span = Number(cell.attrs?.colspan ?? 1);
          const rowspan = Number(cell.attrs?.rowspan ?? 1);
          if (rowspan > 1) pending.set(col, { left: rowspan - 1, span, cell });
          const inner = (cell.content ?? []).map((b) => this.block(b)).join("") || "<w:p/>";
          // En Word una celda debe terminar en párrafo.
          cells += `<w:tc>${cellProps(cell, col, span, rowspan > 1 ? "restart" : null)}${inner.endsWith("</w:p>") || inner.endsWith("<w:p/>") ? inner : inner + "<w:p/>"}</w:tc>`;
          col += span;
        }
        return `<w:tr>${header ? "<w:trPr><w:tblHeader/></w:trPr>" : ""}${cells}</w:tr>`;
      })
      .join("");
    return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/><w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${body}</w:tbl>`;
  }

  block(node: JSONContent): string {
    switch (node.type) {
      case "paragraph":
      case "heading":
        return this.paragraph(node);
      case "bulletList":
      case "orderedList": {
        const ordered: boolean[] = [];
        this.levels(node, 0, ordered);
        this.lists.push({ ordered });
        return this.list(node, 0, this.lists.length);
      }
      case "table":
        return this.table(node);
      case "image":
        return `<w:p>${this.image(node)}</w:p>`;
      case "blockquote":
        return (node.content ?? []).map((c) => this.paragraph(c, '<w:pStyle w:val="Quote"/>')).join("");
      case "pageBreak":
        return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
      case "horizontalRule":
        return '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr></w:pPr></w:p>';
      case "codeBlock":
        return (node.content ?? [])
          .map((t) => t.text ?? "")
          .join("")
          .split("\n")
          .map((line) => `<w:p><w:pPr><w:pStyle w:val="Code"/></w:pPr><w:r><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r></w:p>`)
          .join("");
      default:
        return "";
    }
  }

  numbering(): string {
    const bullets = ["•", "◦", "▪"];
    const formats = ["decimal", "lowerLetter", "lowerRoman"];
    const abstract = this.lists
      .map((list, i) => {
        const levels = Array.from({ length: 9 }, (_, l) => {
          const ordered = list.ordered[l] ?? list.ordered[list.ordered.length - 1] ?? false;
          const indent = 720 * (l + 1);
          const format = ordered ? formats[l % 3] : "bullet";
          const text = ordered ? `%${l + 1}.` : bullets[l % 3];
          const font = ordered ? "" : '<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:hint="default"/></w:rPr>';
          return `<w:lvl w:ilvl="${l}"><w:start w:val="1"/><w:numFmt w:val="${format}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${indent}" w:hanging="360"/></w:pPr>${font}</w:lvl>`;
        }).join("");
        return `<w:abstractNum w:abstractNumId="${i}"><w:multiLevelType w:val="hybridMultilevel"/>${levels}</w:abstractNum>`;
      })
      .join("");
    const nums = this.lists.map((_, i) => `<w:num w:numId="${i + 1}"><w:abstractNumId w:val="${i}"/></w:num>`).join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="${W}">${abstract}${nums}</w:numbering>`;
  }
}

/** Párrafo de un encabezado o pie, con los campos de página como campos de Word. */
function headerFooterXml(kind: "hdr" | "ftr", hf: HeaderFooter | null): string {
  let runs = "";
  if (hf?.text) {
    for (const part of hf.text.split(/(\[Página\]|\[Páginas\]|\[Fecha\]|\[Archivo\])/)) {
      if (!part) continue;
      const instr = part === "[Página]" ? "PAGE" : part === "[Páginas]" ? "NUMPAGES" : part === "[Fecha]" ? 'DATE \\@ "dd/MM/yyyy"' : part === "[Archivo]" ? "FILENAME" : null;
      runs += instr
        ? `<w:fldSimple w:instr=" ${escapeXml(instr)} "><w:r><w:t>1</w:t></w:r></w:fldSimple>`
        : `<w:r><w:t xml:space="preserve">${escapeXml(part)}</w:t></w:r>`;
    }
  }
  const jc = hf && hf.align !== "left" ? `<w:jc w:val="${hf.align}"/>` : "";
  const style = kind === "hdr" ? "Header" : "Footer";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:${kind} xmlns:w="${W}" xmlns:r="${R}"><w:p><w:pPr><w:pStyle w:val="${style}"/>${jc}</w:pPr>${runs}</w:p></w:${kind}>`;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="es-MX"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
${[1, 2, 3, 4, 5, 6]
  .map(
    (n) =>
      `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="${n === 1 ? 360 : 240}" w:after="80"/><w:outlineLvl w:val="${n - 1}"/></w:pPr><w:rPr><w:b/><w:color w:val="${n <= 2 ? "1F3864" : "2F5496"}"/><w:sz w:val="${[40, 32, 28, 24, 22, 22][n - 1]}"/></w:rPr></w:style>`,
  )
  .join("")}
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="60"/><w:contextualSpacing/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="720" w:right="720"/></w:pPr><w:rPr><w:i/><w:color w:val="404040"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="20"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Header"><w:name w:val="header"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:color w:val="595959"/><w:sz w:val="18"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Footer"><w:name w:val="footer"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:color w:val="595959"/><w:sz w:val="18"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="CommentText"><w:name w:val="annotation text"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="20"/></w:rPr></w:style>
<w:style w:type="character" w:styleId="CommentReference"><w:name w:val="annotation reference"/><w:rPr><w:sz w:val="16"/></w:rPr></w:style>
<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders><w:tblCellMar><w:left w:w="108" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
</w:styles>`;

export async function writeDocx(
  content: JSONContent,
  page: PageSize,
  title = "",
  hf: HeaderFooterSet = NO_HEADER_FOOTER,
  comments: Comment[] = [],
): Promise<Uint8Array> {
  const writer = new Writer(page, comments, content);
  let body = (content.content ?? []).map((b) => writer.block(b)).join("");
  // Encabezado y pie: header1/footer1 para todas las páginas; header2/footer2 vacíos para la portada.
  const parts: { name: string; kind: "hdr" | "ftr"; xml: string }[] = [];
  let refs = "";
  if (hf.header.text || hf.footer.text) {
    const add = (kind: "hdr" | "ftr", type: "default" | "first", value: HeaderFooter | null) => {
      const base = kind === "hdr" ? "header" : "footer";
      const name = `${base}${parts.filter((p) => p.kind === kind).length + 1}.xml`;
      parts.push({ name, kind, xml: headerFooterXml(kind, value) });
      refs += `<w:${base}Reference w:type="${type}" r:id="${writer.rel(base, name)}"/>`;
    };
    add("hdr", "default", hf.header);
    if (hf.skipFirst) add("hdr", "first", null);
    add("ftr", "default", hf.footer);
    if (hf.skipFirst) add("ftr", "first", null);
  }
  body += `<w:sectPr>${refs}<w:pgSz w:w="${page.width}" w:h="${page.height}"/><w:pgMar w:top="${page.top}" w:right="${page.right}" w:bottom="${page.bottom}" w:left="${page.left}" w:header="708" w:footer="708" w:gutter="0"/>${hf.skipFirst && refs ? "<w:titlePg/>" : ""}</w:sectPr>`;
  // Comentarios: comments.xml y commentsExtended.xml (resueltos y respuestas).
  const hasComments = writer.liveComments.length > 0;
  if (hasComments) {
    writer.rel("comments", "comments.xml");
    writer.rels.push(`<Relationship Id="rIdCx" Type="http://schemas.microsoft.com/office/2011/relationships/commentsExtended" Target="commentsExtended.xml"/>`);
  }
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}" xmlns:r="${R}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><w:body>${body}</w:body></w:document>`;

  const zip = new JSZip();
  const put = (name: string, data: string | Uint8Array) => zip.file(name, data, { createFolders: false });
  const images = [...new Set(writer.media.map((m) => m.name.split(".").pop()))]
    .map((ext) => `<Default Extension="${ext}" ContentType="image/${ext === "jpg" ? "jpeg" : ext}"/>`)
    .join("");
  put(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${images}<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>${hasComments ? '<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/><Override PartName="/word/commentsExtended.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtended+xml"/>' : ""}${parts.map((p) => `<Override PartName="/word/${p.name}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${p.kind === "hdr" ? "header" : "footer"}+xml"/>`).join("")}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`,
  );
  put(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="${REL}/extended-properties" Target="docProps/app.xml"/></Relationships>`,
  );
  put("word/document.xml", document);
  put("word/styles.xml", STYLES);
  put("word/numbering.xml", writer.numbering());
  put(
    "word/_rels/document.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/styles" Target="styles.xml"/><Relationship Id="rId2" Type="${REL}/numbering" Target="numbering.xml"/>${writer.rels.join("")}</Relationships>`,
  );
  for (const m of writer.media) put(`word/media/${m.name}`, m.data);
  for (const p of parts) put(`word/${p.name}`, p.xml);
  if (hasComments) {
    put("word/comments.xml", writer.commentsXml());
    put("word/commentsExtended.xml", writer.commentsExtendedXml());
  }
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  put(
    "docProps/core.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${escapeXml(title)}</dc:title><dc:creator>WEPO Write</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`,
  );
  put(
    "docProps/app.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>WEPO Write</Application></Properties>`,
  );
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

// ───────────── texto y Markdown ─────────────

/** Texto plano: un párrafo por línea. */
export function readText(text: string): JSONContent {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  return { type: "doc", content: lines.map((line) => (line ? { type: "paragraph", content: [{ type: "text", text: line }] } : { type: "paragraph" })) };
}

/** Marcas en línea de Markdown: **negrita**, *cursiva*, ~~tachado~~, `código` y [vínculos](url). */
function markdownInline(text: string): JSONContent[] {
  const out: JSONContent[] = [];
  const pattern = /(\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|_([^_]+)_|~~([^~]+)~~|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\))/g;
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    if (m.index! > last) out.push({ type: "text", text: text.slice(last, m.index) });
    const [, , bold1, bold2, it1, it2, strike, code, label, href] = m;
    if (bold1 || bold2) out.push({ type: "text", text: bold1 ?? bold2, marks: [{ type: "bold" }] });
    else if (it1 || it2) out.push({ type: "text", text: it1 ?? it2, marks: [{ type: "italic" }] });
    else if (strike) out.push({ type: "text", text: strike, marks: [{ type: "strike" }] });
    else if (code) out.push({ type: "text", text: code, marks: [{ type: "code" }] });
    else if (label) out.push({ type: "text", text: label, marks: [{ type: "link", attrs: { href } }] });
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push({ type: "text", text: text.slice(last) });
  return out;
}

export function readMarkdown(text: string): JSONContent {
  const blocks: JSONContent[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let list: JSONContent | null = null;
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || ordered) {
      const type = bullet ? "bulletList" : "orderedList";
      if (!list || list.type !== type) {
        list = { type, content: [] };
        blocks.push(list);
      }
      list.content!.push({ type: "listItem", content: [{ type: "paragraph", content: markdownInline((bullet ?? ordered)![1]) }] });
      continue;
    }
    list = null;
    if (heading) blocks.push({ type: "heading", attrs: { level: heading[1].length }, content: markdownInline(heading[2]) });
    else if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) blocks.push({ type: "horizontalRule" });
    else if (line.startsWith("> ")) blocks.push({ type: "blockquote", content: [{ type: "paragraph", content: markdownInline(line.slice(2)) }] });
    else if (line.trim()) blocks.push({ type: "paragraph", content: markdownInline(line) });
  }
  return { type: "doc", content: blocks.length ? blocks : [{ type: "paragraph" }] };
}

function markdownText(nodes: JSONContent[] = []): string {
  return nodes
    .map((n) => {
      if (n.type === "hardBreak") return "  \n";
      if (n.type === "image") return `![${n.attrs?.alt ?? ""}](imagen)`;
      let text = n.text ?? "";
      const marks = (n.marks ?? []) as Mark[];
      if (marks.some((m) => m.type === "code")) text = `\`${text}\``;
      if (marks.some((m) => m.type === "bold")) text = `**${text}**`;
      if (marks.some((m) => m.type === "italic")) text = `*${text}*`;
      if (marks.some((m) => m.type === "strike")) text = `~~${text}~~`;
      const link = marks.find((m) => m.type === "link")?.attrs as { href?: string } | undefined;
      if (link?.href) text = `[${text}](${link.href})`;
      return text;
    })
    .join("");
}

export function writeMarkdown(doc: JSONContent): string {
  const lines: string[] = [];
  const list = (node: JSONContent, depth: number) => {
    (node.content ?? []).forEach((item, i) => {
      for (const c of item.content ?? []) {
        if (c.type === "bulletList" || c.type === "orderedList") list(c, depth + 1);
        else lines.push(`${"  ".repeat(depth)}${node.type === "orderedList" ? `${i + 1}.` : "-"} ${markdownText(c.content)}`);
      }
    });
  };
  for (const block of doc.content ?? []) {
    if (block.type === "heading") lines.push(`${"#".repeat(Number(block.attrs?.level ?? 1))} ${markdownText(block.content)}`, "");
    else if (block.type === "paragraph") lines.push(markdownText(block.content), "");
    else if (block.type === "bulletList" || block.type === "orderedList") {
      list(block, 0);
      lines.push("");
    } else if (block.type === "blockquote") lines.push(...(block.content ?? []).map((p) => `> ${markdownText(p.content)}`), "");
    else if (block.type === "horizontalRule") lines.push("---", "");
    else if (block.type === "table") {
      const rows = (block.content ?? []).map((r) => (r.content ?? []).map((c) => (c.content ?? []).map((p) => markdownText(p.content)).join(" ")));
      if (rows.length) {
        lines.push(`| ${rows[0].join(" | ")} |`, `| ${rows[0].map(() => "---").join(" | ")} |`, ...rows.slice(1).map((r) => `| ${r.join(" | ")} |`), "");
      }
    }
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}
