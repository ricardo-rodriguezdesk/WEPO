// Leer y escribir documentos de Word (.docx) para WEPO Write.
//
// Un .docx es un ZIP con XML adentro (Office Open XML). Aquí se convierte
// word/document.xml (con sus estilos, numeración de listas, vínculos e
// imágenes) al formato del editor (JSON de TipTap/ProseMirror) y de vuelta.
//
// Se conserva: párrafos, títulos, negrita, cursiva, subrayado, tachado,
// fuente, tamaño, color, resaltado, alineación, listas (con niveles),
// tablas, imágenes, vínculos, saltos de línea y el tamaño y márgenes de la
// página. Lo demás (encabezados y pies, notas al pie, comentarios, cuadros
// de texto…) se reporta en `unsupported` para no sobrescribir el original.

import JSZip from "jszip";
import type { JSONContent } from "@tiptap/react";

/** Tamaño y márgenes de la página, en twips (1/1440 de pulgada), como en Word. */
export type PageSize = { width: number; height: number; top: number; right: number; bottom: number; left: number };

/** Carta con márgenes de 2.5 cm, lo normal en México. */
export const LETTER: PageSize = { width: 12240, height: 15840, top: 1417, right: 1701, bottom: 1417, left: 1701 };

export type WriteDocument = {
  content: JSONContent;
  page: PageSize;
  /** Cosas del archivo que WEPO Write todavía no conserva. */
  unsupported: string[];
};

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
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
type Mark = { type: string; attrs?: Record<string, unknown> };

class Reader {
  styles = new Map<string, StyleInfo>();
  /** numId → formato de cada nivel ("bullet", "decimal"…). */
  numbering = new Map<string, string[]>();
  rels = new Map<string, { target: string; external: boolean }>();
  unsupported = new Set<string>();
  constructor(private zip: JSZip) {}

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
          const all = [...marks, ...fromStyle.filter((m) => !styled.some((s) => s.type === m.type)), ...styled];
          for (const part of kids(node)) {
            if (part.localName === "t") {
              const text = part.textContent ?? "";
              if (text) out.push({ type: "text", text, ...(all.length ? { marks: all } : {}) });
            } else if (part.localName === "tab") {
              out.push({ type: "text", text: "\t", ...(all.length ? { marks: all } : {}) });
            } else if (part.localName === "br" || part.localName === "cr") {
              out.push({ type: "hardBreak" });
            } else if (part.localName === "drawing") {
              const image = await this.image(part);
              if (image) out.push(image);
            } else if (part.localName === "footnoteReference" || part.localName === "endnoteReference") {
              this.unsupported.add("notas al pie");
            } else if (part.localName === "commentReference") {
              this.unsupported.add("comentarios");
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
        // Cambios con control de cambios: lo insertado se queda, lo borrado no.
        case "ins":
        case "smartTag":
        case "fldSimple":
          await this.inline(node, marks, out);
          break;
        case "sdt":
          await this.inline(child(node, "sdtContent") ?? node, marks, out);
          break;
        case "del":
          this.unsupported.add("control de cambios");
          break;
      }
    }
  }

  async paragraph(p: Element): Promise<{ node: JSONContent; list: ListInfo | null }> {
    const pPr = child(p, "pPr");
    const jc = attr(child(pPr, "jc"), "val");
    const textAlign = jc === "center" ? "center" : jc === "right" || jc === "end" ? "right" : jc === "both" || jc === "distribute" ? "justify" : null;
    const styleId = attr(child(pPr, "pStyle"), "val");
    const level = this.headingLevel(styleId);
    const content: JSONContent[] = [];
    // El formato de letra del estilo del párrafo (p. ej. "Cita" en cursiva) se aplica a su texto.
    const styleMarks = styleId && level === null ? this.marks(this.styles.get(styleId)?.rPr) : [];
    await this.inline(p, styleMarks, content);
    const attrs: Record<string, unknown> = {};
    if (textAlign) attrs.textAlign = textAlign;
    const node: JSONContent =
      level !== null
        ? { type: "heading", attrs: { ...attrs, level }, ...(content.length ? { content } : {}) }
        : { type: "paragraph", ...(textAlign ? { attrs } : {}), ...(content.length ? { content } : {}) };

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
      return { node: node.type === "heading" ? { ...node, type: "paragraph", attrs: undefined } : node, list: { numId, level: lvl, ordered: format !== "bullet" } };
    }
    return { node, list: null };
  }

  async table(tbl: Element): Promise<JSONContent> {
    const rows: JSONContent[] = [];
    for (const tr of kids(tbl, "tr")) {
      const header = Boolean(child(child(tr, "trPr"), "tblHeader"));
      const cells: JSONContent[] = [];
      for (const tc of kids(tr, "tc")) {
        const tcPr = child(tc, "tcPr");
        const span = Number(attr(child(tcPr, "gridSpan"), "val") ?? 1);
        const content = await this.blocks(tc);
        cells.push({
          type: header ? "tableHeader" : "tableCell",
          attrs: { colspan: span, rowspan: 1, colwidth: null },
          content: content.length ? content : [{ type: "paragraph" }],
        });
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
          out.push(node);
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
      }
    }
    return out;
  }
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
  const body = child(parse(xml).documentElement, "body");
  if (!body) throw new Error("El documento está vacío o dañado");
  const content = await reader.blocks(body);
  const sectPr = child(body, "sectPr");
  if (child(sectPr, "headerReference") || child(sectPr, "footerReference")) reader.unsupported.add("encabezados y pies de página");
  if (kids(body, "p").some((p) => child(child(p, "pPr"), "sectPr"))) reader.unsupported.add("varias secciones");
  return {
    content: { type: "doc", content: content.length ? content : [{ type: "paragraph" }] },
    page: pageFrom(sectPr),
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
  constructor(private page: PageSize) {}

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
    if (style?.color) props += `<w:color w:val="${style.color.replace("#", "").slice(0, 6).toUpperCase()}"/>`;
    if (style?.fontSize) {
      const m = /([\d.]+)\s*(pt|px)?/.exec(style.fontSize);
      if (m) props += `<w:sz w:val="${Math.round((m[2] === "px" ? Number(m[1]) * 0.75 : Number(m[1])) * 2)}"/>`;
    }
    const highlight = has("highlight")?.attrs as { color?: string } | undefined;
    if (highlight) props += `<w:shd w:val="clear" w:color="auto" w:fill="${(highlight.color ?? "#FFFF00").replace("#", "").toUpperCase()}"/>`;
    if (has("underline")) props += '<w:u w:val="single"/>';
    return props ? `<w:rPr>${props}</w:rPr>` : "";
  }

  text(node: JSONContent): string {
    const props = this.runProps(node.marks as Mark[]);
    // Los tabuladores son su propio elemento en Word.
    const parts = (node.text ?? "").split("\t");
    const runs = parts
      .map((part, i) => (i ? "<w:tab/>" : "") + (part ? `<w:t xml:space="preserve">${escapeXml(part)}</w:t>` : ""))
      .join("");
    const run = `<w:r>${props}${runs}</w:r>`;
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
      .map((n) => (n.type === "text" ? this.text(n) : n.type === "hardBreak" ? "<w:r><w:br/></w:r>" : n.type === "image" ? this.image(n) : ""))
      .join("");
  }

  paragraph(node: JSONContent, extra = ""): string {
    let props = extra;
    if (node.type === "heading") props = `<w:pStyle w:val="Heading${node.attrs?.level ?? 1}"/>` + props;
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
    const columns = Math.max(1, ...rows.map((r) => (r.content ?? []).reduce((n, c) => n + Number(c.attrs?.colspan ?? 1), 0)));
    const usable = this.page.width - this.page.left - this.page.right;
    const col = Math.floor(usable / columns);
    const grid = Array.from({ length: columns }, () => `<w:gridCol w:w="${col}"/>`).join("");
    const body = rows
      .map((row) => {
        const header = (row.content ?? []).every((c) => c.type === "tableHeader");
        const cells = (row.content ?? [])
          .map((cell) => {
            const span = Number(cell.attrs?.colspan ?? 1);
            const props = `<w:tcPr><w:tcW w:w="${col * span}" w:type="dxa"/>${span > 1 ? `<w:gridSpan w:val="${span}"/>` : ""}</w:tcPr>`;
            const inner = (cell.content ?? []).map((b) => this.block(b)).join("") || "<w:p/>";
            // En Word una celda debe terminar en párrafo.
            return `<w:tc>${props}${inner.endsWith("</w:p>") || inner.endsWith("<w:p/>") ? inner : inner + "<w:p/>"}</w:tc>`;
          })
          .join("");
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
<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders><w:tblCellMar><w:left w:w="108" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
</w:styles>`;

export async function writeDocx(content: JSONContent, page: PageSize, title = ""): Promise<Uint8Array> {
  const writer = new Writer(page);
  let body = (content.content ?? []).map((b) => writer.block(b)).join("");
  body += `<w:sectPr><w:pgSz w:w="${page.width}" w:h="${page.height}"/><w:pgMar w:top="${page.top}" w:right="${page.right}" w:bottom="${page.bottom}" w:left="${page.left}" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>`;
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}" xmlns:r="${R}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><w:body>${body}</w:body></w:document>`;

  const zip = new JSZip();
  const put = (name: string, data: string | Uint8Array) => zip.file(name, data, { createFolders: false });
  const images = [...new Set(writer.media.map((m) => m.name.split(".").pop()))]
    .map((ext) => `<Default Extension="${ext}" ContentType="image/${ext === "jpg" ? "jpeg" : ext}"/>`)
    .join("");
  put(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${images}<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`,
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
