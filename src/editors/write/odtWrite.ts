// Guardar en .odt (OpenDocument, el formato de LibreOffice Writer).
//
// Lo mismo que el editor: títulos, párrafos con su formato, listas, tablas
// (con celdas combinadas y relleno), imágenes, notas al pie y al final,
// columnas, saltos de página, encabezado y pie, y comentarios. Los cambios
// registrados (control de cambios) se guardan aceptados.

import JSZip from "jszip";
import type { JSONContent } from "@tiptap/react";
import type { HeaderFooterSet, PageSize } from "./docx";
import type { Comment } from "./review";

type Mark = { type: string; attrs?: Record<string, unknown> };

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const pt = (twips: number) => `${(twips / 20).toFixed(2)}pt`;

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Ancho y alto de un PNG, JPEG o GIF (para el tamaño de la imagen si no lo trae). */
function imageSize(b: Uint8Array): { width: number; height: number } | null {
  if (b[0] === 0x89 && b[1] === 0x50) return { width: (b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19], height: (b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23] };
  if (b[0] === 0x47 && b[1] === 0x49) return { width: b[6] | (b[7] << 8), height: b[8] | (b[9] << 8) };
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      const len = (b[i + 2] << 8) | b[i + 3];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: (b[i + 7] << 8) | b[i + 8], height: (b[i + 5] << 8) | b[i + 6] };
      i += 2 + len;
    }
  }
  return null;
}

function color(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const v = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(v)) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`.toLowerCase();
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(v);
  if (m) return `#${[m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("")}`;
  return null;
}

class OdtWriter {
  private textStyles = new Map<string, string>();
  private paraStyles = new Map<string, string>();
  private cellStyles = new Map<string, string>();
  private tableCount = 0;
  private sectionCount = 0;
  private autoStyles: string[] = [];
  private listStyles: string[] = [];
  media: { name: string; data: Uint8Array; mime: string }[] = [];
  private noteId = 0;
  private commentsById = new Map<string, Comment>();
  private openComments = new Set<string>();

  constructor(
    private page: PageSize,
    comments: Comment[],
  ) {
    for (const c of comments) this.commentsById.set(c.id, c);
  }

  private textStyle(marks: Mark[] = []): string | null {
    const has = (t: string) => marks.find((m) => m.type === t);
    const props: string[] = [];
    if (has("bold")) props.push('fo:font-weight="bold" style:font-weight-asian="bold" style:font-weight-complex="bold"');
    if (has("italic")) props.push('fo:font-style="italic" style:font-style-asian="italic"');
    if (has("underline") || has("link")) props.push('style:text-underline-style="solid" style:text-underline-width="auto" style:text-underline-color="font-color"');
    if (has("strike")) props.push('style:text-line-through-style="solid"');
    if (has("code")) props.push('style:font-name="Courier New" fo:font-family="\'Courier New\'"');
    const ts = has("textStyle")?.attrs as Record<string, string> | undefined;
    const c = color(ts?.color);
    if (c) props.push(`fo:color="${c}"`);
    else if (has("link")) props.push('fo:color="#1155cc"');
    if (ts?.fontFamily) {
      const font = esc(ts.fontFamily.split(",")[0].replace(/["']/g, "").trim());
      props.push(`style:font-name="${font}" fo:font-family="'${font}'"`);
    }
    if (ts?.fontSize) {
      const m = /([\d.]+)\s*(pt|px)?/.exec(ts.fontSize);
      if (m) props.push(`fo:font-size="${m[2] === "px" ? Number(m[1]) * 0.75 : Number(m[1])}pt"`);
    }
    const hl = has("highlight")?.attrs as { color?: string } | undefined;
    if (hl) props.push(`fo:background-color="${color(hl.color) ?? "#ffff00"}"`);
    if (!props.length) return null;
    const key = props.join(" ");
    let name = this.textStyles.get(key);
    if (!name) {
      name = `T${this.textStyles.size + 1}`;
      this.textStyles.set(key, name);
      this.autoStyles.push(`<style:style style:name="${name}" style:family="text"><style:text-properties ${key}/></style:style>`);
    }
    return name;
  }

  private paraStyle(node: JSONContent, parent = "Standard", extra = ""): string {
    const a = node.attrs ?? {};
    const props: string[] = [];
    const align = a.textAlign as string | undefined;
    if (align && align !== "left") props.push(`fo:text-align="${align === "right" ? "end" : align === "center" ? "center" : "justify"}"`);
    if (a.spaceBefore !== null && a.spaceBefore !== undefined) props.push(`fo:margin-top="${Number(a.spaceBefore)}pt"`);
    if (a.spaceAfter !== null && a.spaceAfter !== undefined) props.push(`fo:margin-bottom="${Number(a.spaceAfter)}pt"`);
    if (typeof a.lineHeight === "number") props.push(`fo:line-height="${Math.round(a.lineHeight * 100)}%"`);
    else if (typeof a.lineHeight === "string" && /^[\d.]+pt$/.test(a.lineHeight)) props.push(`fo:line-height="${a.lineHeight}"`);
    if (a.indent) props.push(`fo:margin-left="${Number(a.indent)}pt"`);
    if (a.firstLine) props.push(`fo:text-indent="${Number(a.firstLine)}pt"`);
    if (extra) props.push(extra);
    if (!props.length) return parent;
    const key = `${parent}|${props.join(" ")}`;
    let name = this.paraStyles.get(key);
    if (!name) {
      name = `P${this.paraStyles.size + 1}`;
      this.paraStyles.set(key, name);
      this.autoStyles.push(`<style:style style:name="${name}" style:family="paragraph" style:parent-style-name="${parent}"><style:paragraph-properties ${props.join(" ")}/></style:style>`);
    }
    return name;
  }

  private image(node: JSONContent): string {
    const src = String(node.attrs?.src ?? "");
    const m = /^data:(image\/(png|jpeg|gif));base64,(.*)$/.exec(src);
    if (!m) return "";
    const bytes = fromBase64(m[3]);
    const name = `Pictures/imagen${this.media.length + 1}.${m[2] === "jpeg" ? "jpg" : m[2]}`;
    this.media.push({ name, data: bytes, mime: m[1] });
    const natural = imageSize(bytes) ?? { width: 300, height: 200 };
    const maxWidth = ((this.page.width - this.page.left - this.page.right) / 1440) * 96;
    let width = Number(node.attrs?.width) || natural.width;
    let height = Number(node.attrs?.height) || (natural.height * width) / natural.width;
    if (width > maxWidth) {
      height = (height * maxWidth) / width;
      width = maxWidth;
    }
    const w = `${((width * 72) / 96).toFixed(2)}pt`;
    const h = `${((height * 72) / 96).toFixed(2)}pt`;
    return `<draw:frame draw:name="Imagen${this.media.length}" text:anchor-type="as-char" svg:width="${w}" svg:height="${h}" draw:z-index="0"><draw:image xlink:href="${name}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/><svg:desc>${esc(String(node.attrs?.alt ?? ""))}</svg:desc></draw:frame>`;
  }

  private comment(id: string): string {
    const c = this.commentsById.get(id);
    if (!c) return "";
    const body = [c, ...c.replies]
      .map((x, i) => (i ? `${x.author || "WEPO"}: ` : "") + x.text)
      .flatMap((t) => t.split("\n"))
      .map((line) => `<text:p>${esc(line)}</text:p>`)
      .join("");
    return `<office:annotation office:name="${esc(id)}"><dc:creator>${esc(c.author || "WEPO")}</dc:creator>${c.date ? `<dc:date>${esc(c.date.replace(/Z$/, ""))}</dc:date>` : ""}${body}</office:annotation>`;
  }

  inline(nodes: JSONContent[] = []): string {
    let out = "";
    const active = new Set<string>();
    for (const n of nodes) {
      const marks = (n.marks ?? []) as Mark[];
      // Lo borrado con el control de cambios no va (se guarda como si se aceptara).
      if (marks.some((m) => m.type === "deletion")) continue;
      // Comentarios: el principio del texto comentado lleva la nota; el final, su cierre.
      const ids = new Set(marks.filter((m) => m.type === "comment").map((m) => String(m.attrs?.id ?? "")));
      for (const id of [...active]) {
        if (!ids.has(id)) {
          out += `<office:annotation-end office:name="${esc(id)}"/>`;
          active.delete(id);
        }
      }
      for (const id of ids) {
        if (!active.has(id) && !this.openComments.has(id)) {
          out += this.comment(id);
          active.add(id);
          this.openComments.add(id);
        }
      }
      let piece = "";
      if (n.type === "text") {
        const text = esc(n.text ?? "")
          .replace(/\t/g, "<text:tab/>")
          .replace(/ {2,}/g, (s) => ` <text:s text:c="${s.length - 1}"/>`);
        const style = this.textStyle(marks);
        piece = style ? `<text:span text:style-name="${style}">${text}</text:span>` : text;
        const link = marks.find((m) => m.type === "link")?.attrs as { href?: string } | undefined;
        if (link?.href) piece = `<text:a xlink:type="simple" xlink:href="${esc(link.href)}">${piece}</text:a>`;
      } else if (n.type === "hardBreak") piece = "<text:line-break/>";
      else if (n.type === "image") piece = this.image(n);
      else if (n.type === "footnote") {
        const kind = n.attrs?.kind === "end" ? "endnote" : "footnote";
        const id = ++this.noteId;
        const body = String(n.attrs?.text ?? "")
          .split("\n")
          .map((l) => `<text:p text:style-name="${kind === "endnote" ? "Endnote" : "Footnote"}">${esc(l)}</text:p>`)
          .join("");
        piece = `<text:note text:id="ftn${id}" text:note-class="${kind}"><text:note-citation>${id}</text:note-citation><text:note-body>${body}</text:note-body></text:note>`;
      }
      out += piece;
    }
    for (const id of active) out += `<office:annotation-end office:name="${esc(id)}"/>`;
    return out;
  }

  paragraph(node: JSONContent, parent?: string, extra = ""): string {
    if (node.type === "heading") {
      const level = Number(node.attrs?.level ?? 1);
      const style = this.paraStyle(node, `Heading_20_${level}`, extra);
      return `<text:h text:style-name="${style}" text:outline-level="${level}">${this.inline(node.content)}</text:h>`;
    }
    const style = this.paraStyle(node, parent ?? "Standard", extra);
    return `<text:p text:style-name="${style}">${this.inline(node.content)}</text:p>`;
  }

  private list(node: JSONContent, styleName: string | null): string {
    const ordered = node.type === "orderedList";
    let name = styleName;
    if (!name) {
      name = `L${this.listStyles.length + 1}`;
      const levels = Array.from({ length: 9 }, (_, l) => {
        const indent = `<style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab" text:list-tab-stop-position="${0.5 * (l + 1)}in" fo:text-indent="-0.25in" fo:margin-left="${0.5 * (l + 1)}in"/></style:list-level-properties>`;
        return ordered
          ? `<text:list-level-style-number text:level="${l + 1}" style:num-suffix="." style:num-format="${["1", "a", "i"][l % 3]}">${indent}</text:list-level-style-number>`
          : `<text:list-level-style-bullet text:level="${l + 1}" text:bullet-char="${["•", "◦", "▪"][l % 3]}">${indent}</text:list-level-style-bullet>`;
      }).join("");
      this.listStyles.push(`<text:list-style style:name="${name}">${levels}</text:list-style>`);
    }
    const items = (node.content ?? [])
      .map((item) => {
        const inner = (item.content ?? [])
          .map((c) => (c.type === "bulletList" || c.type === "orderedList" ? this.list(c, null) : c.type === "paragraph" || c.type === "heading" ? this.paragraph(c) : this.block(c)))
          .join("");
        return `<text:list-item>${inner}</text:list-item>`;
      })
      .join("");
    return `<text:list text:style-name="${name}">${items}</text:list>`;
  }

  private table(node: JSONContent): string {
    const rows = node.content ?? [];
    const columns = Math.max(1, ...rows.map((r) => (r.content ?? []).reduce((n, c) => n + Number(c.attrs?.colspan ?? 1), 0)));
    const usable = (this.page.width - this.page.left - this.page.right) / 20;
    const name = `Tabla${++this.tableCount}`;
    this.autoStyles.push(`<style:style style:name="${name}" style:family="table"><style:table-properties style:width="${usable.toFixed(2)}pt" table:align="margins"/></style:style>`);
    // Celdas tapadas por una combinada hacia abajo: en ODT van como covered-table-cell.
    const covered = new Map<string, boolean>();
    const body = rows
      .map((row, r) => {
        const header = (row.content ?? []).every((c) => c.type === "tableHeader");
        let col = 0;
        let cells = "";
        const queue = [...(row.content ?? [])];
        while (col < columns) {
          if (covered.get(`${r},${col}`)) {
            cells += "<table:covered-table-cell/>";
            col++;
            continue;
          }
          const cell = queue.shift();
          if (!cell) {
            cells += "<table:table-cell/>";
            col++;
            continue;
          }
          const span = Number(cell.attrs?.colspan ?? 1);
          const rowspan = Number(cell.attrs?.rowspan ?? 1);
          for (let dr = 0; dr < rowspan; dr++) for (let dc = 0; dc < span; dc++) if (dr || dc) covered.set(`${r + dr},${col + dc}`, true);
          const fill = color(cell.attrs?.backgroundColor) ?? (header ? "#eeeeee" : null);
          const key = fill ?? "none";
          let style = this.cellStyles.get(key);
          if (!style) {
            style = `C${this.cellStyles.size + 1}`;
            this.cellStyles.set(key, style);
            this.autoStyles.push(`<style:style style:name="${style}" style:family="table-cell"><style:table-cell-properties fo:padding="0.04in" fo:border="0.5pt solid #000000"${fill ? ` fo:background-color="${fill}"` : ""}/></style:style>`);
          }
          const spans = `${span > 1 ? ` table:number-columns-spanned="${span}"` : ""}${rowspan > 1 ? ` table:number-rows-spanned="${rowspan}"` : ""}`;
          const inner = (cell.content ?? []).map((b) => this.block(b)).join("") || "<text:p/>";
          cells += `<table:table-cell table:style-name="${style}" office:value-type="string"${spans}>${inner}</table:table-cell>`;
          for (let dc = 1; dc < span; dc++) cells += "<table:covered-table-cell/>";
          col += span;
        }
        const tr = `<table:table-row>${cells}</table:table-row>`;
        return header && r === 0 ? `<table:table-header-rows>${tr}</table:table-header-rows>` : tr;
      })
      .join("");
    return `<table:table table:name="${name}" table:style-name="${name}"><table:table-column table:number-columns-repeated="${columns}"/>${body}</table:table>`;
  }

  block(node: JSONContent): string {
    switch (node.type) {
      case "paragraph":
      case "heading":
        return this.paragraph(node);
      case "bulletList":
      case "orderedList":
        return this.list(node, null);
      case "table":
        return this.table(node);
      case "image":
        return `<text:p text:style-name="Standard">${this.image(node)}</text:p>`;
      case "blockquote":
        return (node.content ?? []).map((c) => this.paragraph(c, "Quotations")).join("");
      case "pageBreak":
        return `<text:p text:style-name="${this.paraStyle({ type: "paragraph" }, "Standard", 'fo:break-before="page"')}"/>`;
      case "columns": {
        const n = Math.min(3, Math.max(2, Number(node.attrs?.count) || 2));
        const name = `Sect${++this.sectionCount}`;
        this.autoStyles.push(`<style:style style:name="${name}" style:family="section"><style:section-properties text:dont-balance-text-columns="false"><style:columns fo:column-count="${n}" fo:column-gap="0.25in"/></style:section-properties></style:style>`);
        return `<text:section text:style-name="${name}" text:name="Columnas${this.sectionCount}">${(node.content ?? []).map((b) => this.block(b)).join("")}</text:section>`;
      }
      case "sectionBreak": {
        // Hoja nueva con la otra orientación: un párrafo con la página maestra «Girada» (o la normal).
        const base = this.page.width > this.page.height ? "landscape" : "portrait";
        const master = (node.attrs?.orientation === "portrait" ? "portrait" : "landscape") === base ? "Standard" : "Girada";
        const name = `PSec${master}`;
        if (!this.paraStyles.has(name)) {
          this.paraStyles.set(name, name);
          this.autoStyles.push(`<style:style style:name="${name}" style:family="paragraph" style:parent-style-name="Standard" style:master-page-name="${master}"><style:paragraph-properties fo:margin-bottom="0pt" fo:line-height="1pt"/></style:style>`);
        }
        return `<text:p text:style-name="${name}"/>`;
      }
      case "tableOfContents": {
        const cache = (node.attrs?.cache ?? []) as { level: number; text: string; page: number }[];
        const entries = cache.map((e) => `<text:p text:style-name="Contents_20_${Math.min(3, Math.max(1, e.level))}">${esc(e.text)}<text:tab/>${e.page}</text:p>`).join("");
        return `<text:table-of-content text:name="Índice"><text:table-of-content-source text:outline-level="3"><text:index-title-template>Índice</text:index-title-template></text:table-of-content-source><text:index-body><text:index-title text:name="Índice_título"><text:p text:style-name="Contents_20_Heading">Índice</text:p></text:index-title>${entries}</text:index-body></text:table-of-content>`;
      }
      case "horizontalRule":
        return `<text:p text:style-name="${this.paraStyle({ type: "paragraph" }, "Standard", 'fo:border-bottom="0.75pt solid #000000" fo:padding-bottom="2pt"')}"/>`;
      case "codeBlock":
        return (node.content ?? [])
          .map((t) => t.text ?? "")
          .join("")
          .split("\n")
          .map((line) => `<text:p text:style-name="Preformatted_20_Text">${esc(line).replace(/ {2,}/g, (s) => ` <text:s text:c="${s.length - 1}"/>`)}</text:p>`)
          .join("");
      default:
        return "";
    }
  }

  automaticStyles(): string {
    return this.listStyles.join("") + this.autoStyles.join("");
  }
}

const NS = [
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"',
  'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"',
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"',
  'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"',
  'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"',
  'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"',
  'xmlns:xlink="http://www.w3.org/1999/xlink"',
  'xmlns:dc="http://purl.org/dc/elements/1.1/"',
  'xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0"',
  'xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"',
].join(" ");

/** Encabezado o pie con sus campos: [Página], [Páginas], [Fecha], [Archivo]. */
function hfText(text: string, title: string): string {
  return esc(text)
    .replace(/\[Página\]/g, '<text:page-number text:select-page="current">1</text:page-number>')
    .replace(/\[Páginas\]/g, "<text:page-count>1</text:page-count>")
    .replace(/\[Fecha\]/g, `<text:date>${new Date().toLocaleDateString("es-MX")}</text:date>`)
    .replace(/\[Archivo\]/g, `<text:file-name text:display="name-and-extension">${esc(title)}</text:file-name>`);
}

export async function writeOdt(content: JSONContent, page: PageSize, title = "", hf?: HeaderFooterSet, comments: Comment[] = []): Promise<Uint8Array> {
  const w = new OdtWriter(page, comments);
  const body = (content.content ?? []).map((b) => w.block(b)).join("") || "<text:p/>";
  const align = (a: string) => (a === "left" ? "start" : a === "right" ? "end" : "center");
  const header = hf?.header.text ? `<style:header><text:p text:style-name="${hf.header.align === "left" ? "HFLeft" : hf.header.align === "right" ? "HFRight" : "HFCenter"}">${hfText(hf.header.text, title)}</text:p></style:header>` : "";
  const footer = hf?.footer.text ? `<style:footer><text:p text:style-name="${hf.footer.align === "left" ? "HFLeft" : hf.footer.align === "right" ? "HFRight" : "HFCenter"}">${hfText(hf.footer.text, title)}</text:p></style:footer>` : "";
  // La portada sin encabezado ni pie: una página «First Page» con sus propios (vacíos).
  const skipFirst = Boolean(hf?.skipFirst && (header || footer));
  const content_xml = `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${NS} office:version="1.3"><office:automatic-styles>${skipFirst ? '<style:style style:name="PFirst" style:family="paragraph" style:parent-style-name="Standard" style:master-page-name="First_20_Page"/>' : ""}${w.automaticStyles()}</office:automatic-styles><office:body><office:text>${skipFirst ? body.replace(/^<text:(p|h) text:style-name="[^"]*"/, '<text:$1 text:style-name="PFirst"') : body}</office:text></office:body></office:document-content>`;
  const layout = (name: string, turned = false) =>
    `<style:page-layout style:name="${name}"><style:page-layout-properties fo:page-width="${pt(turned ? page.height : page.width)}" fo:page-height="${pt(turned ? page.width : page.height)}" style:print-orientation="${(page.width > page.height) !== turned ? "landscape" : "portrait"}" fo:margin-top="${pt(page.top)}" fo:margin-bottom="${pt(page.bottom)}" fo:margin-left="${pt(page.left)}" fo:margin-right="${pt(page.right)}"/><style:header-style><style:header-footer-properties fo:min-height="0in" fo:margin-bottom="0.2in"/></style:header-style><style:footer-style><style:header-footer-properties fo:min-height="0in" fo:margin-top="0.2in"/></style:footer-style></style:page-layout>`;
  const heading = (l: number, size: number) =>
    `<style:style style:name="Heading_20_${l}" style:display-name="Heading ${l}" style:family="paragraph" style:parent-style-name="Heading" style:next-style-name="Standard" style:default-outline-level="${l}"><style:text-properties fo:font-size="${size}pt" fo:font-weight="bold" style:font-weight-asian="bold" fo:color="#1f3864"/></style:style>`;
  const styles_xml = `<?xml version="1.0" encoding="UTF-8"?><office:document-styles ${NS} office:version="1.3"><office:styles><style:default-style style:family="paragraph"><style:paragraph-properties fo:margin-bottom="6pt"/><style:text-properties style:font-name="Calibri" fo:font-family="Calibri" fo:font-size="11pt" fo:language="es" fo:country="MX"/></style:default-style><style:style style:name="Standard" style:family="paragraph" style:class="text"/><style:style style:name="Heading" style:family="paragraph" style:parent-style-name="Standard" style:class="text"><style:paragraph-properties fo:margin-top="12pt" fo:margin-bottom="6pt" fo:keep-with-next="always"/></style:style>${heading(1, 20)}${heading(2, 16)}${heading(3, 13)}${heading(4, 12)}${heading(5, 11)}${heading(6, 11)}<style:style style:name="Quotations" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:margin-left="0.4in" fo:margin-right="0.4in"/><style:text-properties fo:font-style="italic" fo:color="#555555"/></style:style><style:style style:name="Preformatted_20_Text" style:display-name="Preformatted Text" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:margin-bottom="0pt"/><style:text-properties style:font-name="Courier New" fo:font-family="'Courier New'" fo:font-size="10pt"/></style:style><style:style style:name="Footnote" style:family="paragraph" style:parent-style-name="Standard"><style:text-properties fo:font-size="9pt"/></style:style><style:style style:name="Endnote" style:family="paragraph" style:parent-style-name="Standard"><style:text-properties fo:font-size="9pt"/></style:style>${[1, 2, 3].map((l) => `<style:style style:name="Contents_20_${l}" style:display-name="Contents ${l}" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:margin-left="${(l - 1) * 0.2}in"><style:tab-stops><style:tab-stop style:position="${((page.width - page.left - page.right) / 1440 - (l - 1) * 0.2).toFixed(2)}in" style:type="right" style:leader-style="dotted" style:leader-text="."/></style:tab-stops></style:paragraph-properties></style:style>`).join("")}<style:style style:name="Contents_20_Heading" style:display-name="Contents Heading" style:family="paragraph" style:parent-style-name="Heading"><style:text-properties fo:font-size="16pt" fo:font-weight="bold"/></style:style><style:style style:name="HFLeft" style:family="paragraph"><style:paragraph-properties fo:text-align="${align("left")}"/><style:text-properties fo:font-size="9pt" fo:color="#666666"/></style:style><style:style style:name="HFCenter" style:family="paragraph"><style:paragraph-properties fo:text-align="center"/><style:text-properties fo:font-size="9pt" fo:color="#666666"/></style:style><style:style style:name="HFRight" style:family="paragraph"><style:paragraph-properties fo:text-align="${align("right")}"/><style:text-properties fo:font-size="9pt" fo:color="#666666"/></style:style></office:styles><office:automatic-styles>${layout("pm1")}${layout("pm2", true)}</office:automatic-styles><office:master-styles><style:master-page style:name="Standard" style:page-layout-name="pm1">${header}${footer}</style:master-page><style:master-page style:name="Girada" style:page-layout-name="pm2">${header}${footer}</style:master-page>${skipFirst ? '<style:master-page style:name="First_20_Page" style:display-name="First Page" style:page-layout-name="pm1" style:next-style-name="Standard"/>' : ""}</office:master-styles></office:document-styles>`;
  const meta_xml = `<?xml version="1.0" encoding="UTF-8"?><office:document-meta ${NS} office:version="1.3"><office:meta><meta:generator>WEPO</meta:generator>${title ? `<dc:title>${esc(title)}</dc:title>` : ""}<meta:creation-date>${new Date().toISOString().replace(/\.\d+Z$/, "")}</meta:creation-date></office:meta></office:document-meta>`;
  const manifest = `<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3"><manifest:file-entry manifest:full-path="/" manifest:version="1.3" manifest:media-type="application/vnd.oasis.opendocument.text"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/>${w.media.map((m) => `<manifest:file-entry manifest:full-path="${m.name}" manifest:media-type="${m.mime}"/>`).join("")}</manifest:manifest>`;
  const zip = new JSZip();
  // «mimetype» primero y sin comprimir (así lo reconocen los programas).
  zip.file("mimetype", "application/vnd.oasis.opendocument.text", { compression: "STORE" });
  zip.file("content.xml", content_xml);
  zip.file("styles.xml", styles_xml);
  zip.file("meta.xml", meta_xml);
  zip.file("META-INF/manifest.xml", manifest);
  for (const m of w.media) zip.file(m.name, m.data);
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE", mimeType: "application/vnd.oasis.opendocument.text" });
}
