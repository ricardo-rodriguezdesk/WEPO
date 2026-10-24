// De un PDF convertido (lib/pdfConvert.ts) a un documento de WEPO Write.

import type { JSONContent } from "@tiptap/react";
import type { Block, Cell, Converted, Run } from "../../lib/pdfConvert";
import type { WriteDocument } from "./docx";
import { NO_HEADER_FOOTER } from "./docx";

const PX_PER_PT = 96 / 72;

/** Colores casi negros se dejan como el color normal del texto. */
function keepColor(color: string | null): string | null {
  if (!color) return null;
  const h = color.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  if (Math.max(r, g, b) < 80 && Math.max(r, g, b) - Math.min(r, g, b) < 30) return null;
  return color;
}

function text(runs: Run[], body: number, opts: { sizes?: boolean; colors?: boolean; bold?: boolean } = {}): JSONContent[] {
  const { sizes = true, colors = true, bold = true } = opts;
  return runs
    .filter((r) => r.text)
    .map((r) => {
      const marks: JSONContent["marks"] = [];
      if (bold && r.bold) marks.push({ type: "bold" });
      if (r.italic) marks.push({ type: "italic" });
      const style: Record<string, string> = {};
      if (sizes && Math.abs(r.size - body) >= 0.6) style.fontSize = `${r.size}pt`;
      const color = colors ? keepColor(r.color) : null;
      if (color) style.color = color;
      if (r.mono) style.fontFamily = "Menlo, Consolas, monospace";
      else if (r.font) style.fontFamily = r.font;
      if (Object.keys(style).length) marks.push({ type: "textStyle", attrs: style });
      return marks.length ? { type: "text", text: r.text, marks } : { type: "text", text: r.text };
    });
}

function paragraph(content: JSONContent[], align: string | null = null): JSONContent {
  return { type: "paragraph", ...(align && align !== "left" ? { attrs: { textAlign: align } } : {}), ...(content.length ? { content } : {}) };
}

function cellNode(cell: Cell, header: boolean, widths: number[], col: number, body: number): JSONContent {
  const content = blocks(cell.blocks, body, true);
  const span = widths.slice(col, col + cell.colspan).map((w) => Math.round(w * PX_PER_PT));
  return {
    type: header ? "tableHeader" : "tableCell",
    attrs: {
      colspan: cell.colspan,
      rowspan: cell.rowspan,
      colwidth: span.length === cell.colspan ? span : null,
      backgroundColor: cell.fill,
    },
    content: content.length ? content : [{ type: "paragraph" }],
  };
}

function blocks(list: Block[], body: number, inCell = false): JSONContent[] {
  const out: JSONContent[] = [];
  for (const b of list) {
    if (b.kind === "paragraph") out.push(paragraph(text(b.runs, body), b.align));
    else if (b.kind === "heading") {
      if (inCell) out.push(paragraph(text(b.runs, body)));
      else out.push({ type: "heading", attrs: { level: b.level, ...(b.align !== "left" ? { textAlign: b.align } : {}) }, content: text(b.runs, body, { sizes: false, bold: false }) });
    } else if (b.kind === "list") {
      out.push({
        type: b.ordered ? "orderedList" : "bulletList",
        ...(b.ordered && b.start !== 1 ? { attrs: { start: b.start } } : {}),
        content: b.items.map((runs) => ({ type: "listItem", content: [paragraph(text(runs, body))] })),
      });
    } else if (b.kind === "quote") out.push({ type: "blockquote", content: blocks(b.blocks, body, true).filter((n) => n.type === "paragraph") });
    else if (b.kind === "code") out.push({ type: "codeBlock", content: b.text ? [{ type: "text", text: b.text }] : [] });
    else if (b.kind === "image") {
      out.push(paragraph([{ type: "image", attrs: { src: b.src, alt: null, width: Math.round(b.width * PX_PER_PT), height: Math.round(b.height * PX_PER_PT) } }], b.align));
    } else if (b.kind === "table") {
      const rows: JSONContent[] = b.rows.map((row, r) => {
        let col = 0;
        // La columna de cada celda: se salta lo que ocupan las celdas de arriba que bajan.
        return {
          type: "tableRow",
          content: row.map((cell) => {
            const node = cellNode(cell, b.header && r === 0, b.widths, col, body);
            col += cell.colspan;
            return node;
          }),
        };
      });
      out.push({ type: "table", content: rows });
      // Una tabla seguida de otra (o al final) se pegaría: un párrafo vacío las separa.
      const next = list[list.indexOf(b) + 1];
      if (!next || next.kind === "table") out.push({ type: "paragraph" });
    } else if (b.kind === "pageBreak") out.push({ type: "pageBreak" });
  }
  // Sin párrafos vacíos dobles.
  return out.filter((n, i) => !(n.type === "paragraph" && !n.content && out[i + 1]?.type === "paragraph" && !out[i + 1].content));
}

export function pdfToWrite(converted: Converted): WriteDocument {
  const body = converted.bodySize;
  const content = blocks(converted.blocks, body);
  const twips = (pt: number) => Math.round(pt * 20);
  const { page } = converted;
  // Carta, A4 u Oficio aunque el PDF mida unas décimas distinto (así Write los reconoce).
  const sizes = [
    [12240, 15840],
    [11906, 16838],
    [12240, 20160],
  ];
  const [w, h] = [twips(page.width), twips(page.height)];
  const known = sizes.find(([sw, sh]) => Math.abs(sw - w) <= 60 && Math.abs(sh - h) <= 60) ?? sizes.map(([a, b]) => [b, a]).find(([sw, sh]) => Math.abs(sw - w) <= 60 && Math.abs(sh - h) <= 60);
  const [width, height] = known ?? [w, h];
  const headerFooter = structuredClone(NO_HEADER_FOOTER);
  if (converted.header) headerFooter.header = { text: converted.header.text, align: converted.header.align };
  if (converted.footer) headerFooter.footer = { text: converted.footer.text, align: converted.footer.align };
  return {
    content: { type: "doc", content: content.length ? content : [{ type: "paragraph" }] },
    page: { width, height, top: twips(page.top), right: twips(page.right), bottom: twips(page.bottom), left: twips(page.left) },
    headerFooter,
    comments: [],
    unsupported: [],
  };
}
