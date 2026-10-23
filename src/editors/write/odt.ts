// Leer documentos de LibreOffice / OpenDocument (.odt) para WEPO Write.
//
// Un .odt es un ZIP con content.xml (el texto) y styles.xml (estilos, página,
// encabezado y pie). Se convierte al mismo formato del editor que el .docx.
// WEPO no escribe .odt: al guardar se crea un .docx (el original no se toca).

import JSZip from "jszip";
import type { JSONContent } from "@tiptap/react";
import type { HeaderFooterSet, PageSize, WriteDocument } from "./docx";
import { LETTER, NO_HEADER_FOOTER } from "./docx";
import type { HeaderFooter } from "./extensions";

const NS = {
  office: "urn:oasis:names:tc:opendocument:xmlns:office:1.0",
  style: "urn:oasis:names:tc:opendocument:xmlns:style:1.0",
  text: "urn:oasis:names:tc:opendocument:xmlns:text:1.0",
  table: "urn:oasis:names:tc:opendocument:xmlns:table:1.0",
  draw: "urn:oasis:names:tc:opendocument:xmlns:drawing:1.0",
  fo: "urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0",
  xlink: "http://www.w3.org/1999/xlink",
  svg: "urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0",
};

type Mark = { type: string; attrs?: Record<string, unknown> };

function get(el: Element | null | undefined, ns: keyof typeof NS, name: string): string | null {
  return el?.getAttributeNS(NS[ns], name) ?? null;
}

function kids(el: Element | null | undefined, ns?: keyof typeof NS, name?: string): Element[] {
  if (!el) return [];
  return Array.from(el.children).filter((c) => (!ns || c.namespaceURI === NS[ns]) && (!name || c.localName === name));
}

function first(el: Element | null | undefined, ns: keyof typeof NS, name: string): Element | undefined {
  return kids(el, ns, name)[0];
}

/** "2cm", "0.5in", "12pt", "20mm" → puntos. */
export function toPt(value: string | null | undefined): number | null {
  const m = /^(-?[\d.]+)\s*(cm|mm|in|pt|pc|px)?$/.exec(value?.trim() ?? "");
  if (!m) return null;
  const n = Number(m[1]);
  const factor = { cm: 72 / 2.54, mm: 72 / 25.4, in: 72, pt: 1, pc: 12, px: 0.75 }[(m[2] ?? "pt") as "pt"];
  return Math.round(n * factor * 10) / 10;
}

type Style = { family: string; parent: string | null; text?: Element; paragraph?: Element; list?: Element };

class OdtReader {
  styles = new Map<string, Style>();
  /** Estilos de lista: nombre → ¿numerada? por nivel. */
  lists = new Map<string, boolean[]>();
  unsupported = new Set<string>();
  constructor(private zip: JSZip) {}

  collect(root: Element | null | undefined) {
    if (!root) return;
    for (const group of kids(root, "office")) {
      if (!["styles", "automatic-styles", "master-styles"].includes(group.localName)) continue;
      for (const s of kids(group, "style", "style")) {
        const name = get(s, "style", "name");
        if (!name) continue;
        this.styles.set(name, {
          family: get(s, "style", "family") ?? "",
          parent: get(s, "style", "parent-style-name"),
          text: first(s, "style", "text-properties"),
          paragraph: first(s, "style", "paragraph-properties"),
        });
      }
      for (const l of kids(group, "text", "list-style")) {
        const levels: boolean[] = [];
        for (const lvl of kids(l)) levels[Number(get(lvl, "text", "level") ?? 1) - 1] = lvl.localName === "list-level-style-number";
        this.lists.set(get(l, "style", "name") ?? "", levels);
      }
    }
  }

  /** Una propiedad siguiendo la cadena de estilos (el propio, luego sus padres). */
  prop(styleName: string | null, kind: "text" | "paragraph", ns: keyof typeof NS, name: string): string | null {
    for (let id = styleName, guard = 0; id && guard < 12; guard++) {
      const s = this.styles.get(id);
      if (!s) return null;
      const v = get(s[kind], ns, name);
      if (v !== null) return v;
      id = s.parent;
    }
    return null;
  }

  marks(styleName: string | null): Mark[] {
    if (!styleName) return [];
    const p = (ns: keyof typeof NS, name: string) => this.prop(styleName, "text", ns, name);
    const marks: Mark[] = [];
    if (["bold", "600", "700", "800", "900"].includes(p("fo", "font-weight") ?? "")) marks.push({ type: "bold" });
    if (["italic", "oblique"].includes(p("fo", "font-style") ?? "")) marks.push({ type: "italic" });
    const underline = p("style", "text-underline-style");
    if (underline && underline !== "none") marks.push({ type: "underline" });
    const strike = p("style", "text-line-through-style");
    if (strike && strike !== "none") marks.push({ type: "strike" });
    const style: Record<string, string> = {};
    const color = p("fo", "color");
    if (color && color !== "#000000") style.color = color;
    const size = p("fo", "font-size");
    if (size && !size.endsWith("%")) style.fontSize = `${toPt(size)}pt`;
    const font = p("style", "font-name") ?? p("fo", "font-family");
    if (font) style.fontFamily = font.replace(/^['"]|['"]$/g, "");
    if (Object.keys(style).length) marks.push({ type: "textStyle", attrs: style });
    const bg = p("fo", "background-color");
    if (bg && bg !== "transparent" && bg.toLowerCase() !== "#ffffff") marks.push({ type: "highlight", attrs: { color: bg } });
    return marks;
  }

  async image(frame: Element): Promise<JSONContent | null> {
    const img = first(frame, "draw", "image");
    const href = get(img, "xlink", "href");
    if (!href) {
      if (first(frame, "draw", "text-box")) this.unsupported.add("cuadros de texto");
      return null;
    }
    const file = this.zip.file(href);
    if (!file) return null;
    const ext = href.split(".").pop()?.toLowerCase() ?? "";
    const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "gif" ? "image/gif" : ext === "png" ? "image/png" : null;
    if (!mime) {
      this.unsupported.add("imágenes en formatos que no son PNG, JPEG o GIF");
      return null;
    }
    const bytes = await file.async("base64");
    const width = toPt(get(frame, "svg", "width"));
    const height = toPt(get(frame, "svg", "height"));
    return {
      type: "image",
      attrs: { src: `data:${mime};base64,${bytes}`, alt: get(frame, "draw", "name"), width: width ? Math.round(width / 0.75) : null, height: height ? Math.round(height / 0.75) : null },
    };
  }

  async inline(el: Element, marks: Mark[], out: JSONContent[]) {
    const push = (text: string, m: Mark[]) => text && out.push({ type: "text", text, ...(m.length ? { marks: m } : {}) });
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === 3) {
        // En ODF los espacios repetidos van como <text:s/>; el resto se junta en uno.
        push((node.textContent ?? "").replace(/\s+/g, " "), marks);
        continue;
      }
      if (node.nodeType !== 1) continue;
      const e = node as Element;
      const name = e.localName;
      if (e.namespaceURI === NS.text) {
        if (name === "span") await this.inline(e, [...marks, ...this.marks(get(e, "text", "style-name"))], out);
        else if (name === "a") await this.inline(e, [...marks, { type: "link", attrs: { href: get(e, "xlink", "href") } }], out);
        else if (name === "s") push(" ".repeat(Number(get(e, "text", "c") ?? 1)), marks);
        else if (name === "tab") push("\t", marks);
        else if (name === "line-break") out.push({ type: "hardBreak" });
        else if (name === "note") this.unsupported.add("notas al pie");
        else if (name === "tracked-changes" || name === "change-start") this.unsupported.add("control de cambios");
        else if (["bookmark", "bookmark-start", "bookmark-end", "soft-page-break", "change-end", "change"].includes(name)) continue;
        else await this.inline(e, marks, out);
      } else if (e.namespaceURI === NS.draw && name === "frame") {
        const image = await this.image(e);
        if (image) out.push(image);
      } else if (e.namespaceURI === NS.office && name === "annotation") {
        this.unsupported.add("comentarios");
      } else if (e.namespaceURI === NS.draw) {
        this.unsupported.add("formas o dibujos");
      }
    }
  }

  async paragraph(p: Element, inList: boolean): Promise<JSONContent[]> {
    const styleName = get(p, "text", "style-name");
    const prop = (ns: keyof typeof NS, name: string) => this.prop(styleName, "paragraph", ns, name);
    const content: JSONContent[] = [];
    // Los títulos ya tienen su propio aspecto; solo los párrafos heredan la letra de su estilo.
    await this.inline(p, p.localName === "h" ? [] : this.marks(styleName), content);
    const attrs: Record<string, unknown> = {};
    const align = prop("fo", "text-align");
    if (align === "center") attrs.textAlign = "center";
    else if (align === "end" || align === "right") attrs.textAlign = "right";
    else if (align === "justify") attrs.textAlign = "justify";
    const before = toPt(prop("fo", "margin-top"));
    const after = toPt(prop("fo", "margin-bottom"));
    if (before !== null) attrs.spaceBefore = before;
    if (after !== null) attrs.spaceAfter = after;
    const line = prop("fo", "line-height");
    if (line?.endsWith("%")) attrs.lineHeight = Number(line.slice(0, -1)) / 100;
    else if (line && toPt(line)) attrs.lineHeight = `${toPt(line)}pt`;
    if (!inList) {
      const indent = toPt(prop("fo", "margin-left"));
      const firstLine = toPt(prop("fo", "text-indent"));
      if (indent) attrs.indent = indent;
      if (firstLine) attrs.firstLine = firstLine;
    }
    const level = p.localName === "h" ? Math.min(6, Number(get(p, "text", "outline-level") ?? 1)) : null;
    const node: JSONContent =
      level !== null
        ? { type: "heading", attrs: { ...attrs, level }, ...(content.length ? { content } : {}) }
        : { type: "paragraph", ...(Object.keys(attrs).length ? { attrs } : {}), ...(content.length ? { content } : {}) };
    const breakBefore = prop("fo", "break-before") === "page";
    const breakAfter = prop("fo", "break-after") === "page";
    return [...(breakBefore && !inList ? [{ type: "pageBreak" }] : []), node, ...(breakAfter && !inList ? [{ type: "pageBreak" }] : [])];
  }

  async list(l: Element, styleName: string | null, depth: number): Promise<JSONContent> {
    const style = get(l, "text", "style-name") ?? styleName;
    const ordered = this.lists.get(style ?? "")?.[depth] ?? false;
    const items: JSONContent[] = [];
    for (const item of kids(l, "text")) {
      if (item.localName !== "list-item" && item.localName !== "list-header") continue;
      const content: JSONContent[] = [];
      for (const c of kids(item)) {
        if (c.localName === "list") content.push(await this.list(c, style, depth + 1));
        else if (c.localName === "p" || c.localName === "h") content.push(...(await this.paragraph(c, true)).map((n) => (n.type === "heading" ? { ...n, type: "paragraph", attrs: undefined } : n)));
      }
      if (!content.length || content[0].type !== "paragraph") content.unshift({ type: "paragraph" });
      items.push({ type: "listItem", content });
    }
    return { type: ordered ? "orderedList" : "bulletList", content: items.length ? items : [{ type: "listItem", content: [{ type: "paragraph" }] }] };
  }

  async table(t: Element): Promise<JSONContent> {
    const rows: JSONContent[] = [];
    const collect = async (el: Element, header: boolean) => {
      for (const c of kids(el, "table")) {
        if (c.localName === "table-header-rows") await collect(c, true);
        else if (c.localName === "table-rows") await collect(c, header);
        else if (c.localName === "table-row") {
          const cells: JSONContent[] = [];
          for (const cell of kids(c, "table")) {
            if (cell.localName !== "table-cell") continue; // las celdas tapadas por una combinada no cuentan
            const content = await this.blocks(cell);
            cells.push({
              type: header ? "tableHeader" : "tableCell",
              attrs: { colspan: Number(get(cell, "table", "number-columns-spanned") ?? 1), rowspan: Number(get(cell, "table", "number-rows-spanned") ?? 1), colwidth: null },
              content: content.length ? content : [{ type: "paragraph" }],
            });
          }
          if (cells.length) rows.push({ type: "tableRow", content: cells });
        }
      }
    };
    await collect(t, false);
    return { type: "table", content: rows };
  }

  async blocks(container: Element): Promise<JSONContent[]> {
    const out: JSONContent[] = [];
    for (const el of kids(container)) {
      const name = el.localName;
      if (el.namespaceURI === NS.text && (name === "p" || name === "h")) out.push(...(await this.paragraph(el, false)));
      else if (el.namespaceURI === NS.text && name === "list") out.push(await this.list(el, null, 0));
      else if (el.namespaceURI === NS.text && name === "section") out.push(...(await this.blocks(el)));
      else if (el.namespaceURI === NS.table && name === "table") out.push(await this.table(el));
      else if (el.namespaceURI === NS.text && (name === "table-of-content" || name === "alphabetical-index" || name === "bibliography")) {
        this.unsupported.add("índices");
        const body = first(el, "text", "index-body");
        if (body) out.push(...(await this.blocks(body)));
      }
    }
    return out;
  }

  /** Texto de un encabezado o pie de la página maestra, con número de página como campo. */
  headerFooter(el: Element | undefined): HeaderFooter | null {
    if (!el) return null;
    const parts: string[] = [];
    let align: HeaderFooter["align"] = "left";
    const ps = Array.from(el.getElementsByTagNameNS(NS.text, "p"));
    ps.forEach((p, i) => {
      if (i === 0) {
        const a = this.prop(get(p, "text", "style-name"), "paragraph", "fo", "text-align");
        align = a === "center" ? "center" : a === "end" || a === "right" ? "right" : "left";
      }
      let text = "";
      const walk = (node: Node) => {
        for (const c of Array.from(node.childNodes)) {
          if (c.nodeType === 3) text += c.textContent ?? "";
          else if (c.nodeType === 1) {
            const e = c as Element;
            if (e.localName === "page-number") text += "[Página]";
            else if (e.localName === "page-count") text += "[Páginas]";
            else if (e.localName === "date") text += "[Fecha]";
            else if (e.localName === "file-name") text += "[Archivo]";
            else if (e.localName === "s") text += " ";
            else if (e.localName === "tab") text += "   ";
            else if (e.localName === "frame") this.unsupported.add("imágenes en el encabezado o el pie");
            else walk(e);
          }
        }
      };
      walk(p);
      if (text.trim()) parts.push(text.trim());
    });
    return { text: parts.join(" · "), align };
  }
}

export async function readOdt(data: Uint8Array): Promise<WriteDocument> {
  const zip = await JSZip.loadAsync(data);
  const content = await zip.file("content.xml")?.async("string");
  if (!content) throw new Error("El archivo no parece un documento de OpenDocument (no tiene content.xml)");
  const parse = (xml: string) => new DOMParser().parseFromString(xml, "application/xml").documentElement;
  const reader = new OdtReader(zip);
  const stylesXml = await zip.file("styles.xml")?.async("string");
  const stylesRoot = stylesXml ? parse(stylesXml) : null;
  reader.collect(stylesRoot);
  const root = parse(content);
  reader.collect(root);
  const text = first(first(root, "office", "body"), "office", "text");
  if (!text) throw new Error("El archivo no es un documento de texto");
  const blocks = await reader.blocks(text);

  // Página y encabezado/pie de la primera página maestra ("Standard").
  let page: PageSize = { ...LETTER };
  const headerFooter: HeaderFooterSet = structuredClone(NO_HEADER_FOOTER);
  const master = first(first(stylesRoot, "office", "master-styles"), "style", "master-page");
  if (master) {
    const layoutName = get(master, "style", "page-layout-name");
    const layouts = kids(first(stylesRoot, "office", "automatic-styles"), "style", "page-layout");
    const props = first(layouts.find((l) => get(l, "style", "name") === layoutName), "style", "page-layout-properties");
    const twips = (v: string | null, fallback: number) => {
      const pt = toPt(v);
      return pt ? Math.round(pt * 20) : fallback;
    };
    if (props) {
      page = {
        width: twips(get(props, "fo", "page-width"), LETTER.width),
        height: twips(get(props, "fo", "page-height"), LETTER.height),
        top: twips(get(props, "fo", "margin-top"), LETTER.top),
        right: twips(get(props, "fo", "margin-right"), LETTER.right),
        bottom: twips(get(props, "fo", "margin-bottom"), LETTER.bottom),
        left: twips(get(props, "fo", "margin-left"), LETTER.left),
      };
    }
    const header = reader.headerFooter(first(master, "style", "header"));
    const footer = reader.headerFooter(first(master, "style", "footer"));
    if (header) headerFooter.header = header;
    if (footer) headerFooter.footer = footer;
    // En LibreOffice el encabezado va dentro del margen superior; se suma su espacio.
    for (const [kind, key] of [["header", "top"], ["footer", "bottom"]] as const) {
      const style = first(layouts.find((l) => get(l, "style", "name") === layoutName), "style", `${kind}-style`);
      const min = toPt(get(first(style, "style", "header-footer-properties"), "fo", "min-height"));
      const gap = toPt(get(first(style, "style", "header-footer-properties"), "fo", kind === "header" ? "margin-bottom" : "margin-top"));
      if (headerFooter[kind].text && min) page[key] += Math.round((min + (gap ?? 0)) * 20);
    }
  }
  return { content: { type: "doc", content: blocks.length ? blocks : [{ type: "paragraph" }] }, page, headerFooter, comments: [], unsupported: [...reader.unsupported] };
}
