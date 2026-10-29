// Extensiones de TipTap propias de WEPO Write:
//
// - PageBreak: salto de página (⌘↩), que en el .docx es <w:br w:type="page"/>.
// - Columns: un pedazo del documento a 2 o 3 columnas (como una sección continua
//   de Word con columnas). Las columnas se emparejan solas.
// - ParagraphFormat: interlineado, espacio antes y después, y sangrías.
// - Search: resalta lo que se busca y permite ir de uno en uno o reemplazar.
// - Pagination: corta el documento en páginas del tamaño real, con su
//   encabezado y pie, para verlo (e imprimirlo) igual que en Word.

import { Extension, Node, mergeAttributes } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { TableCell, TableHeader } from "@tiptap/extension-table";
import Strike from "@tiptap/extension-strike";
import type { EditorView } from "@tiptap/pm/view";
import { ENDNOTES_TOP, NoteMeasurer, endnotesBlock, endnotesOf, notesBlock, notesIn } from "./notes";
import type { Note } from "./notes";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    pageBreak: { setPageBreak: () => ReturnType };
    columns: { setColumns: (count: number) => ReturnType };
    paragraphFormat: { setParagraphFormat: (format: Partial<ParagraphFormat>) => ReturnType };
    search: {
      setSearch: (query: string, options?: SearchOptions) => ReturnType;
      clearSearch: () => ReturnType;
      goToMatch: (step: number) => ReturnType;
      replaceMatch: (replacement: string) => ReturnType;
      replaceAllMatches: (replacement: string) => ReturnType;
    };
    pagination: { refreshPages: () => ReturnType };
  }
}

// ───────────── columnas ─────────────

export const Columns = Node.create({
  name: "columns",
  group: "block",
  content: "block+",
  defining: true,
  addAttributes: () => ({
    count: {
      default: 2,
      parseHTML: (el) => Math.min(3, Math.max(2, Number(el.getAttribute("data-count")) || 2)),
      renderHTML: (attrs) => ({ "data-count": String(attrs.count), style: `column-count: ${attrs.count}` }),
    },
  }),
  parseHTML: () => [{ tag: "div[data-columns]" }],
  renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-columns": "", class: "write-columns" }), 0],
  addCommands() {
    return {
      /** 2 o 3: lo elegido (o el párrafo) va en columnas; 1: deja de estar en columnas. */
      setColumns:
        (count: number) =>
        ({ state, tr, dispatch }) => {
          const { $from, $to } = state.selection;
          // ¿Ya está dentro de un bloque de columnas?
          for (let d = $from.depth; d > 0; d--) {
            const node = $from.node(d);
            if (node.type.name !== "columns") continue;
            const pos = $from.before(d);
            if (!dispatch) return true;
            if (count <= 1) tr.replaceWith(pos, pos + node.nodeSize, node.content);
            else tr.setNodeMarkup(pos, undefined, { ...node.attrs, count });
            dispatch(tr);
            return true;
          }
          if (count <= 1) return false;
          // Los bloques de arriba que toca la selección.
          const from = $from.before(1);
          const to = $to.after(1);
          const blocks = state.doc.slice(from, to).content;
          if (!dispatch) return true;
          tr.replaceWith(from, to, state.schema.nodes.columns.create({ count }, blocks));
          tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(from + 2, tr.doc.content.size))));
          dispatch(tr.scrollIntoView());
          return true;
        },
    };
  },
});

/** Cuántas columnas tiene el bloque donde está el cursor (1 si no está en columnas). */
export function columnsAt(state: EditorState): number {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) if ($from.node(d).type.name === "columns") return Number($from.node(d).attrs.count) || 2;
  return 1;
}

// ───────────── salto de página ─────────────

export const PageBreak = Node.create({
  name: "pageBreak",
  // Antes que el salto de línea de TipTap, que también usa ⌘↩.
  priority: 1000,
  group: "block",
  atom: true,
  selectable: true,
  parseHTML: () => [{ tag: "div[data-page-break]" }],
  renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-page-break": "", class: "write-page-break" })],
  addCommands() {
    return {
      setPageBreak:
        () =>
        ({ chain }) =>
          chain().insertContent([{ type: "pageBreak" }, { type: "paragraph" }]).run(),
    };
  },
  addKeyboardShortcuts() {
    return { "Mod-Enter": () => this.editor.commands.setPageBreak() };
  },
});

// ───────────── tachado ─────────────

/** El tachado de TipTap usa ⌘⇧S, que en WEPO es «Guardar como»: aquí va en ⌘⇧X, como en Google Docs. */
export const WepoStrike = Strike.extend({
  addKeyboardShortcuts() {
    return { "Mod-Shift-x": () => this.editor.commands.toggleStrike() };
  },
});

// ───────────── celdas con color ─────────────

const backgroundColor = {
  default: null,
  parseHTML: (el: HTMLElement) => el.style.backgroundColor || el.getAttribute("data-background") || null,
  renderHTML: (attrs: Record<string, unknown>) => (attrs.backgroundColor ? { style: `background-color: ${attrs.backgroundColor}` } : {}),
};

/** Celdas de tabla con color de fondo (en el .docx es el sombreado de la celda). */
export const ColoredCell = TableCell.extend({
  addAttributes() {
    return { ...this.parent?.(), backgroundColor };
  },
});

export const ColoredHeader = TableHeader.extend({
  addAttributes() {
    return { ...this.parent?.(), backgroundColor };
  },
});

// ───────────── formato de párrafo ─────────────

/** Formato de un párrafo. Las medidas van en puntos; el interlineado es un múltiplo (1.15) o "18pt" (exacto). */
export type ParagraphFormat = {
  lineHeight: number | string | null;
  spaceBefore: number | null;
  spaceAfter: number | null;
  indent: number | null;
  firstLine: number | null;
};

/** "Sencillo" en Word usa la altura de línea de la fuente (≈1.2 veces su tamaño). */
export const LINE_FACTOR = 1.2;

export function lineHeightCss(value: number | string): string {
  return typeof value === "number" ? String(Math.round(value * LINE_FACTOR * 1000) / 1000) : value;
}

function pt(style: string | null | undefined): number | null {
  if (!style) return null;
  const m = /^(-?[\d.]+)(pt|px)?$/.exec(style.trim());
  if (!m) return null;
  return Math.round((m[2] === "px" ? Number(m[1]) * 0.75 : Number(m[1])) * 10) / 10;
}

export const ParagraphFormatExtension = Extension.create({
  name: "paragraphFormat",
  addGlobalAttributes() {
    const attr = (css: string, read: (el: HTMLElement) => unknown, write: (v: never) => string) => ({
      default: null,
      parseHTML: read,
      renderHTML: (attrs: Record<string, unknown>) => (attrs[css] === null || attrs[css] === undefined ? {} : { style: write(attrs[css] as never) }),
    });
    return [
      {
        types: ["paragraph", "heading"],
        attributes: {
          lineHeight: {
            default: null,
            parseHTML: (el: HTMLElement) => {
              const v = el.dataset.lineHeight;
              if (!v) return null;
              return v.endsWith("pt") ? v : Number(v);
            },
            renderHTML: (attrs: Record<string, unknown>) => {
              const v = attrs.lineHeight as number | string | null;
              return v === null || v === undefined ? {} : { style: `line-height: ${lineHeightCss(v)}`, "data-line-height": String(v) };
            },
          },
          spaceBefore: attr("spaceBefore", (el) => pt(el.style.marginTop), (v: number) => `margin-top: ${v}pt`),
          spaceAfter: attr("spaceAfter", (el) => pt(el.style.marginBottom), (v: number) => `margin-bottom: ${v}pt`),
          indent: attr("indent", (el) => pt(el.style.marginLeft), (v: number) => `margin-left: ${v}pt`),
          firstLine: attr("firstLine", (el) => pt(el.style.textIndent), (v: number) => `text-indent: ${v}pt`),
        },
      },
    ];
  },
  addCommands() {
    return {
      setParagraphFormat:
        (format) =>
        ({ tr, state, dispatch }) => {
          const { from, to } = state.selection;
          state.doc.nodesBetween(from, to, (node, pos) => {
            if (node.type.name !== "paragraph" && node.type.name !== "heading") return true;
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...format });
            return false;
          });
          if (dispatch) dispatch(tr);
          return true;
        },
    };
  },
});

/** Formato del primer párrafo de la selección. */
export function currentParagraphFormat(editor: Editor): ParagraphFormat {
  const { $from } = editor.state.selection;
  for (let d = $from.depth; d >= 0; d--) {
    const node = $from.node(d);
    if (node.type.name === "paragraph" || node.type.name === "heading") {
      const a = node.attrs;
      return { lineHeight: a.lineHeight, spaceBefore: a.spaceBefore, spaceAfter: a.spaceAfter, indent: a.indent, firstLine: a.firstLine };
    }
  }
  return { lineHeight: null, spaceBefore: null, spaceAfter: null, indent: null, firstLine: null };
}

// ───────────── buscar y reemplazar ─────────────

export type SearchOptions = { caseSensitive?: boolean; wholeWord?: boolean };
type Match = { from: number; to: number };
type SearchState = { query: string; options: SearchOptions; matches: Match[]; index: number; decorations: DecorationSet };

export const searchKey = new PluginKey<SearchState>("wepo-search");

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Busca en cada bloque de texto. Las posiciones coinciden con los caracteres porque cada nodo en línea que no es texto mide 1. */
export function findMatches(doc: PMNode, query: string, options: SearchOptions): Match[] {
  if (!query) return [];
  const source = escapeRegExp(query);
  const pattern = new RegExp(options.wholeWord ? `(?<![\\p{L}\\p{N}_])${source}(?![\\p{L}\\p{N}_])` : source, options.caseSensitive ? "gu" : "giu");
  const matches: Match[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    let text = "";
    node.forEach((child) => {
      text += child.isText ? child.text : "￼";
    });
    for (const m of text.matchAll(pattern)) {
      if (!m[0].length) continue;
      matches.push({ from: pos + 1 + m.index!, to: pos + 1 + m.index! + m[0].length });
    }
    return false;
  });
  return matches;
}

function searchDecorations(doc: PMNode, matches: Match[], index: number) {
  return DecorationSet.create(
    doc,
    matches.map((m, i) => Decoration.inline(m.from, m.to, { class: i === index ? "write-match current" : "write-match" })),
  );
}

export const Search = Extension.create({
  name: "search",
  addProseMirrorPlugins() {
    return [
      new Plugin<SearchState>({
        key: searchKey,
        state: {
          init: () => ({ query: "", options: {}, matches: [], index: -1, decorations: DecorationSet.empty }),
          apply(tr, prev) {
            const meta = tr.getMeta(searchKey) as Partial<SearchState> | undefined;
            if (!meta && !tr.docChanged) return prev;
            const query = meta?.query ?? prev.query;
            const options = meta?.options ?? prev.options;
            const matches = findMatches(tr.doc, query, options);
            let index = meta?.index ?? prev.index;
            if (index >= matches.length) index = matches.length ? 0 : -1;
            return { query, options, matches, index, decorations: searchDecorations(tr.doc, matches, index) };
          },
        },
        props: { decorations: (state) => searchKey.getState(state)?.decorations },
      }),
    ];
  },
  addCommands() {
    const select = (tr: Transaction, match: Match | undefined) => {
      if (match) tr.setSelection(TextSelection.create(tr.doc, match.from, match.to)).scrollIntoView();
      return tr;
    };
    return {
      setSearch:
        (query, options = {}) =>
        ({ tr, dispatch }) => {
          if (dispatch) dispatch(tr.setMeta(searchKey, { query, options, index: -1 }));
          return true;
        },
      clearSearch:
        () =>
        ({ tr, dispatch }) => {
          if (dispatch) dispatch(tr.setMeta(searchKey, { query: "", index: -1 }));
          return true;
        },
      goToMatch:
        (step) =>
        ({ state, tr, dispatch }) => {
          const s = searchKey.getState(state);
          if (!s?.matches.length) return false;
          let index: number;
          if (s.index === -1) {
            // El primero después del cursor (o el último antes, hacia atrás).
            const at = state.selection.from;
            index = step > 0 ? s.matches.findIndex((m) => m.from >= at) : s.matches.map((m) => m.from < at).lastIndexOf(true);
            if (index === -1) index = step > 0 ? 0 : s.matches.length - 1;
          } else index = (s.index + step + s.matches.length) % s.matches.length;
          if (dispatch) dispatch(select(tr.setMeta(searchKey, { index }), s.matches[index]));
          return true;
        },
      replaceMatch:
        (replacement) =>
        ({ state, tr, dispatch }) => {
          const s = searchKey.getState(state);
          if (!s?.matches.length) return false;
          const index = s.index === -1 ? 0 : s.index;
          const m = s.matches[index];
          if (dispatch) {
            if (replacement) tr.insertText(replacement, m.from, m.to);
            else tr.delete(m.from, m.to);
            // Sigue en el resultado que ahora ocupa ese lugar.
            const next = findMatches(tr.doc, s.query, s.options);
            const nextIndex = next.length ? Math.max(0, next.findIndex((x) => x.from >= m.from + replacement.length)) : -1;
            tr.setMeta(searchKey, { index: nextIndex });
            dispatch(select(tr, next[nextIndex]));
          }
          return true;
        },
      replaceAllMatches:
        (replacement) =>
        ({ state, tr, dispatch }) => {
          const s = searchKey.getState(state);
          if (!s?.matches.length) return false;
          if (dispatch) {
            for (const m of [...s.matches].reverse()) {
              if (replacement) tr.insertText(replacement, m.from, m.to);
              else tr.delete(m.from, m.to);
            }
            dispatch(tr.setMeta(searchKey, { index: -1 }));
          }
          return true;
        },
    };
  },
});

export function searchState(state: EditorState) {
  return searchKey.getState(state);
}

// ───────────── páginas ─────────────

export type HeaderFooter = { text: string; align: "left" | "center" | "right" };

/** Lo que necesita la paginación, en píxeles CSS (96 por pulgada). */
export type PageLayout = {
  width: number;
  height: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
  header: HeaderFooter;
  footer: HeaderFooter;
  /** Sin encabezado ni pie en la primera página (portada). */
  skipFirst: boolean;
  fileName: string;
  zoom: number;
};

/** Dónde empieza una página, cuánto espacio queda libre al pie de la anterior y sus notas al pie. */
type Break = { pos: number; fill: number; notes: Note[]; notesHeight: number };
type PageEnd = { fill: number; notes: Note[]; notesHeight: number; endnotes?: Note[] };
type PageState = { breaks: Break[]; end: PageEnd; pages: number; decorations: DecorationSet; stamp: string };

export const pagesKey = new PluginKey<PageState>("wepo-pages");

/** Espacio gris entre hojas en la pantalla (al imprimir no existe). */
export const PAGE_GAP = 24;
/** Un poco menos que la hoja: así un redondeo nunca empuja contenido a una página en blanco al imprimir. */
const SAFETY = 3;

export function fillFields(text: string, page: number, pages: number, fileName: string): string {
  return text
    .replace(/\[Página\]/g, String(page))
    .replace(/\[Páginas\]/g, String(pages))
    .replace(/\[Fecha\]/g, new Date().toLocaleDateString("es-MX"))
    .replace(/\[Archivo\]/g, fileName);
}

function band(kind: "header" | "footer", hf: HeaderFooter, height: number, page: number, pages: number, layout: PageLayout, hidden: boolean) {
  const el = document.createElement("div");
  el.className = `write-hf write-hf-${kind}`;
  el.dataset.hf = kind;
  el.style.height = `${height}px`;
  el.style.justifyContent = hf.align === "left" ? "flex-start" : hf.align === "right" ? "flex-end" : "center";
  const text = document.createElement("span");
  text.textContent = hidden ? "" : fillFields(hf.text, page, pages, layout.fileName);
  el.appendChild(text);
  return el;
}

export function headerBand(layout: PageLayout, page: number, pages: number) {
  return band("header", layout.header, layout.top, page, pages, layout, layout.skipFirst && page === 1);
}

function gapWidget(end: PageEnd, page: number, pages: number, layout: PageLayout, last: boolean) {
  const el = document.createElement("div");
  el.className = last ? "write-gap write-gap-end" : "write-gap";
  el.contentEditable = "false";
  // Las notas al final van justo después del texto de la última hoja.
  if (last && end.endnotes?.length) el.appendChild(endnotesBlock(end.endnotes));
  const space = document.createElement("div");
  space.className = "write-gap-fill";
  space.style.height = `${end.fill}px`;
  el.appendChild(space);
  // Las notas al pie de esta hoja, justo arriba del pie de página.
  if (end.notes.length) el.appendChild(notesBlock(end.notes, end.notesHeight));
  el.appendChild(band("footer", layout.footer, layout.bottom, page, pages, layout, layout.skipFirst && page === 1));
  if (!last) {
    const between = document.createElement("div");
    between.className = "write-gap-band";
    between.style.marginLeft = `${-layout.left}px`;
    between.style.marginRight = `${-layout.right}px`;
    between.innerHTML = `<span>Página ${page + 1}</span>`;
    el.appendChild(between);
    el.appendChild(band("header", layout.header, layout.top, page + 1, pages, layout, false));
  }
  return el;
}

function hash(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function notesKey(notes: Note[]): string {
  return notes.length ? hash(JSON.stringify(notes)) : "";
}

function buildDecorations(doc: PMNode, breaks: Break[], end: PageEnd, layout: PageLayout, stamp: string): DecorationSet {
  const pages = breaks.length + 1;
  const v = hash(stamp);
  const decos = breaks.map((b, i) =>
    Decoration.widget(b.pos, () => gapWidget(b, i + 1, pages, layout, false), { side: -1, ignoreSelection: true, key: `gap-${i}-${b.fill}-${pages}-${v}-${notesKey(b.notes)}` }),
  );
  decos.push(
    Decoration.widget(doc.content.size, () => gapWidget(end, pages, pages, layout, true), {
      side: 1,
      ignoreSelection: true,
      key: `end-${end.fill}-${pages}-${v}-${notesKey(end.notes)}-${notesKey(end.endnotes ?? [])}`,
    }),
  );
  return DecorationSet.create(doc, decos);
}

/** Dónde cortar las páginas, midiendo los bloques tal como se ven (sin contar los cortes que ya hay). */
function measure(view: EditorView, layout: PageLayout, measurer: NoteMeasurer): { breaks: Break[]; end: PageEnd } {
  const root = view.dom as HTMLElement;
  const zoom = layout.zoom || 1;
  const rootTop = root.getBoundingClientRect().top;
  const contentHeight = layout.height - layout.top - layout.bottom;
  const textWidth = layout.width - layout.left - layout.right;
  const notesHeight = (notes: Note[]) => measurer.height(root.parentElement ?? root, textWidth, zoom, notes);
  // Notas al pie de la hoja que se está llenando.
  let pageNotes: Note[] = [];
  let noteCount = 0;
  // Cuánto miden los cortes que hay antes de cada elemento.
  const before = new Map<Element, number>();
  let gaps = 0;
  for (const el of Array.from(root.children)) {
    if (el.classList.contains("write-gap")) gaps += el.getBoundingClientRect().height / zoom;
    else before.set(el, gaps);
  }
  const breaks: Break[] = [];
  let pageStart = 0;
  let cursor = 0; // donde termina el bloque anterior (con su margen inferior)
  let forced = false;
  let index = 0;
  view.state.doc.forEach((node, offset) => {
    const dom = view.nodeDOM(offset) as HTMLElement | null;
    if (!dom || !(dom instanceof HTMLElement)) return;
    const shift = before.get(dom) ?? 0;
    const rect = dom.getBoundingClientRect();
    const top = (rect.top - rootTop) / zoom - shift;
    const bottom = (rect.bottom - rootTop) / zoom - shift;
    // Las notas de este bloque van al pie de la misma hoja: le quitan espacio al texto.
    const blockNotes = notesIn(node, noteCount + 1);
    noteCount += blockNotes.length;
    const overflows = bottom - pageStart > contentHeight - notesHeight([...pageNotes, ...blockNotes]) + 0.5;
    if (index > 0 && (forced || (overflows && cursor > pageStart + 1))) {
      const h = notesHeight(pageNotes);
      breaks.push({ pos: offset, fill: Math.max(0, Math.round(pageStart + contentHeight - cursor - SAFETY - h)), notes: pageNotes, notesHeight: h });
      pageStart = cursor;
      pageNotes = [];
    }
    pageNotes = [...pageNotes, ...blockNotes];
    forced = node.type.name === "pageBreak";
    const margin = parseFloat(getComputedStyle(dom).marginBottom) || 0;
    cursor = Math.max(bottom + margin, top);
    // Un bloque más alto que una hoja (una tabla enorme) sigue de largo. Se mide con el
    // borde del bloque, sin su margen de abajo: ese margen no cabe al pie de la hoja y se pierde,
    // y contarlo hacía avanzar la hoja sin poner el corte (todo lo que seguía quedaba encimado).
    while (bottom - pageStart > contentHeight + 0.5) pageStart += contentHeight;
    index++;
  });
  // Las notas al final: si no caben en lo que queda de la última hoja, empiezan en una hoja nueva.
  const endnotes = endnotesOf(view.state.doc);
  const endHeight = endnotes.length ? measurer.height(root.parentElement ?? root, textWidth, zoom, endnotes) + ENDNOTES_TOP : 0;
  if (endHeight && cursor + endHeight > pageStart + contentHeight - notesHeight(pageNotes) + 0.5 && cursor > pageStart + 1) {
    const h = notesHeight(pageNotes);
    breaks.push({ pos: view.state.doc.content.size, fill: Math.max(0, Math.round(pageStart + contentHeight - cursor - SAFETY - h)), notes: pageNotes, notesHeight: h });
    pageStart = cursor;
    pageNotes = [];
  }
  const h = notesHeight(pageNotes);
  return { breaks, end: { fill: Math.max(0, Math.round(pageStart + contentHeight - cursor - SAFETY - h - endHeight)), notes: pageNotes, notesHeight: h, endnotes } };
}

export const Pagination = Extension.create<{ layout: () => PageLayout; onPages: (pages: number) => void }>({
  name: "pagination",
  addOptions: () => ({ layout: () => ({}) as PageLayout, onPages: () => {} }),
  addCommands() {
    return {
      refreshPages:
        () =>
        ({ tr, dispatch }) => {
          if (dispatch) dispatch(tr.setMeta(pagesKey, { refresh: true }).setMeta("addToHistory", false));
          return true;
        },
    };
  },
  addProseMirrorPlugins() {
    const options = this.options;
    return [
      new Plugin<PageState>({
        key: pagesKey,
        state: {
          init: (_, state) => ({ breaks: [], end: { fill: 0, notes: [], notesHeight: 0, endnotes: [] }, pages: 1, decorations: DecorationSet.create(state.doc, []), stamp: "" }),
          apply(tr, prev) {
            const meta = tr.getMeta(pagesKey) as { breaks?: Break[]; end?: PageEnd; stamp?: string; refresh?: boolean } | undefined;
            if (meta?.refresh) return { ...prev, stamp: "" };
            if (meta?.breaks) {
              const layout = options.layout();
              const end = meta.end ?? prev.end;
              return { breaks: meta.breaks, end, pages: meta.breaks.length + 1, stamp: meta.stamp ?? "", decorations: buildDecorations(tr.doc, meta.breaks, end, layout, meta.stamp ?? "") };
            }
            if (!tr.docChanged) return prev;
            // Mientras se vuelve a medir, los cortes se mueven con el texto.
            const breaks = prev.breaks.map((b) => ({ ...b, pos: tr.mapping.map(b.pos, -1) }));
            return { ...prev, breaks, decorations: prev.decorations.map(tr.mapping, tr.doc) };
          },
        },
        props: { decorations: (state) => pagesKey.getState(state)?.decorations },
        view(view) {
          let frame = 0;
          let rounds = 0;
          const measurer = new NoteMeasurer();
          const schedule = () => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(run);
          };
          const run = () => {
            if (!view.dom.isConnected) return;
            // Al imprimir se usan los cortes de la pantalla tal cual (medir otra vez los movería).
            if (window.matchMedia?.("print").matches) return;
            const layout = options.layout();
            if (!layout.height) return;
            const { breaks, end } = measure(view, layout, measurer);
            const prev = pagesKey.getState(view.state)!;
            const stamp = JSON.stringify([layout.header, layout.footer, layout.skipFirst, layout.fileName, layout.width, layout.height, layout.top, layout.bottom, layout.left, layout.right]);
            const sameNotes = (a: Note[], b: Note[]) => notesKey(a) === notesKey(b);
            const same =
              stamp === prev.stamp &&
              breaks.length === prev.breaks.length &&
              Math.abs(end.fill - prev.end.fill) < 2 &&
              sameNotes(end.notes, prev.end.notes) &&
              sameNotes(end.endnotes ?? [], prev.end.endnotes ?? []) &&
              breaks.every((b, i) => b.pos === prev.breaks[i].pos && Math.abs(b.fill - prev.breaks[i].fill) < 2 && sameNotes(b.notes, prev.breaks[i].notes));
            if (same || rounds > 6) return;
            rounds++;
            view.dispatch(view.state.tr.setMeta(pagesKey, { breaks, end, stamp }).setMeta("addToHistory", false));
            options.onPages(breaks.length + 1);
            // Con los cortes puestos, se mide otra vez para afinar.
            schedule();
          };
          const observer = new ResizeObserver(schedule);
          observer.observe(view.dom);
          view.dom.addEventListener("load", schedule, true);
          document.fonts?.ready.then(schedule);
          schedule();
          return {
            update(v, prevState) {
              if (v.state.doc !== prevState.doc || (pagesKey.getState(v.state) !== pagesKey.getState(prevState) && !pagesKey.getState(v.state)?.stamp)) {
                rounds = 0;
                schedule();
              }
            },
            destroy() {
              cancelAnimationFrame(frame);
              measurer.destroy();
              observer.disconnect();
              view.dom.removeEventListener("load", schedule, true);
            },
          };
        },
      }),
    ];
  },
});
