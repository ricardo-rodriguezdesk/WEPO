// Notas al pie e índice de WEPO Write.
//
// - Footnote: la llamada de la nota (el número volado en el texto). El texto de
//   la nota va en el atributo `text`; la paginación lo dibuja al pie de la hoja
//   donde cae la llamada. En el .docx es <w:footnoteReference/> + footnotes.xml.
//   Con `kind: "end"` es una nota al final (i, ii, iii…): todas van juntas al
//   final del documento. En el .docx, <w:endnoteReference/> + endnotes.xml.
// - TableOfContents: el índice, armado con los títulos (1 a 3) y la página
//   donde cae cada uno. Se actualiza solo. En el .docx es el campo TOC de Word.

import { Node, mergeAttributes } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import type { EditorState } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import type { JSONContent } from "@tiptap/react";
import { pagesKey } from "./extensions";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    footnote: { insertFootnote: (text?: string, kind?: NoteKind) => ReturnType };
    tableOfContents: { insertTableOfContents: () => ReturnType };
  }
}

// ───────────── notas al pie y al final ─────────────

/** "foot": al pie de la hoja; "end": al final del documento. */
export type NoteKind = "foot" | "end";

const kindOf = (node: import("@tiptap/pm/model").Node): NoteKind => (node.attrs.kind === "end" ? "end" : "foot");

/** 1 → i, 4 → iv, 9 → ix (como numera Word las notas al final). */
export function roman(n: number): string {
  const table: [number, string][] = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
  let out = "";
  for (const [value, text] of table) {
    while (n >= value) {
      out += text;
      n -= value;
    }
  }
  return out;
}

export const Footnote = Node.create<{ onEdit: (pos: number) => void }>({
  name: "footnote",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addOptions: () => ({ onEdit: () => {} }),
  addAttributes: () => ({
    text: {
      default: "",
      parseHTML: (el) => el.getAttribute("data-text") ?? "",
      renderHTML: (attrs) => ({ "data-text": String(attrs.text ?? "") }),
    },
    kind: {
      default: "foot",
      parseHTML: (el) => (el.getAttribute("data-kind") === "end" ? "end" : "foot"),
      renderHTML: (attrs) => (attrs.kind === "end" ? { "data-kind": "end" } : {}),
    },
  }),
  parseHTML: () => [{ tag: "sup[data-footnote]" }],
  renderHTML: ({ node, HTMLAttributes }) => [
    "sup",
    mergeAttributes(HTMLAttributes, {
      "data-footnote": "",
      class: "write-fn-ref",
      title: String(node.attrs.text || (node.attrs.kind === "end" ? "Nota al final (clic para escribirla)" : "Nota al pie (clic para escribirla)")),
    }),
  ],
  addCommands() {
    return {
      insertFootnote:
        (text = "", kind = "foot") =>
        ({ state, chain }) => {
          const at = state.selection.to;
          const ok = chain().setTextSelection(at).insertContent({ type: "footnote", attrs: { text, kind } }).run();
          // Se abre después de que la nota ya está en el documento (el comando puede ir dentro de otra cadena).
          if (ok) setTimeout(() => this.options.onEdit(at), 0);
          return ok;
        },
    };
  },
  addProseMirrorPlugins() {
    const options = this.options;
    return [
      new Plugin({
        key: new PluginKey("wepo-footnote-click"),
        props: {
          handleClickOn(_view, _pos, node, nodePos) {
            if (node.type.name !== "footnote") return false;
            options.onEdit(nodePos);
            return true;
          },
        },
      }),
    ];
  },
});

export type Note = { n: number; text: string; kind?: NoteKind };

/** Las notas al pie de un bloque, numeradas a partir de `start`. */
export function notesIn(node: import("@tiptap/pm/model").Node, start: number): Note[] {
  const out: Note[] = [];
  node.descendants((child) => {
    if (child.type.name === "footnote" && kindOf(child) === "foot") out.push({ n: start + out.length, text: String(child.attrs.text ?? "") });
    return true;
  });
  return out;
}

/** Todas las notas al final del documento, en orden. */
export function endnotesOf(doc: import("@tiptap/pm/model").Node): Note[] {
  const out: Note[] = [];
  doc.descendants((child) => {
    if (child.type.name === "footnote" && kindOf(child) === "end") out.push({ n: out.length + 1, text: String(child.attrs.text ?? ""), kind: "end" });
    return true;
  });
  return out;
}

/** La nota que está en la posición `pos`, su número (contando solo las de su tipo) y su tipo. */
export function footnoteAt(state: EditorState, pos: number): { text: string; n: number; kind: NoteKind } | null {
  const node = state.doc.nodeAt(pos);
  if (!node || node.type.name !== "footnote") return null;
  const kind = kindOf(node);
  let n = 0;
  state.doc.nodesBetween(0, pos + 1, (child, at) => {
    if (child.type.name === "footnote" && kindOf(child) === kind && at <= pos) n++;
    return true;
  });
  return { text: String(node.attrs.text ?? ""), n, kind };
}

/** Posición de la nota número `n` (desde 1) de ese tipo. */
export function footnotePos(state: EditorState, n: number, kind: NoteKind = "foot"): number | null {
  let found: number | null = null;
  let i = 0;
  state.doc.descendants((child, pos) => {
    if (found !== null) return false;
    if (child.type.name === "footnote" && kindOf(child) === kind && ++i === n) found = pos;
    return true;
  });
  return found;
}

/** Bloque de notas al pie de una hoja: una raya y cada nota con su número. */
export function notesBlock(notes: Note[], height: number): HTMLElement {
  const el = document.createElement("div");
  el.className = "write-footnotes";
  el.style.height = `${height}px`;
  for (const note of notes) el.appendChild(noteLine(note));
  return el;
}

/** Las notas al final: después del texto, con su título y su raya. */
export function endnotesBlock(notes: Note[]): HTMLElement {
  const el = document.createElement("div");
  el.className = "write-footnotes write-endnotes";
  el.setAttribute("role", "region");
  el.setAttribute("aria-label", "Notas al final");
  for (const note of notes) el.appendChild(noteLine(note));
  return el;
}

function noteLine(note: Note): HTMLElement {
  const line = document.createElement("div");
  line.className = "write-footnote";
  line.dataset.note = String(note.n);
  if (note.kind === "end") line.dataset.kind = "end";
  const sup = document.createElement("sup");
  sup.textContent = note.kind === "end" ? roman(note.n) : String(note.n);
  line.appendChild(sup);
  line.appendChild(document.createTextNode(` ${note.text || " "}`));
  return line;
}

/** Espacio arriba de las notas (con la raya que las separa del texto). */
export const NOTES_TOP = 14;
/** Lo que las notas al final dejan arriba, además de su raya (separación del texto). */
export const ENDNOTES_TOP = 16;

/**
 * Mide cuánto ocupan las notas con el ancho del texto. Se usa un bloque
 * invisible con los mismos estilos que el pie de la hoja.
 */
export class NoteMeasurer {
  private box: HTMLElement | null = null;
  private cache = new Map<string, number>();
  private width = 0;

  height(host: HTMLElement, width: number, zoom: number, notes: Note[]): number {
    if (!notes.length) return 0;
    if (!this.box || !this.box.isConnected) {
      this.box = document.createElement("div");
      this.box.className = "write-footnotes write-footnotes-measure";
      this.box.setAttribute("aria-hidden", "true");
      host.appendChild(this.box);
    }
    if (Math.abs(width - this.width) > 0.5) {
      this.cache.clear();
      this.width = width;
      this.box.style.width = `${width}px`;
    }
    let total = NOTES_TOP;
    for (const note of notes) {
      const key = `${note.kind ?? "foot"}|${note.n}|${note.text}`;
      let h = this.cache.get(key);
      if (h === undefined) {
        this.box.replaceChildren(noteLine(note));
        h = this.box.firstElementChild!.getBoundingClientRect().height / (zoom || 1);
        this.cache.set(key, h);
      }
      total += h;
    }
    return Math.ceil(total);
  }

  destroy() {
    this.box?.remove();
    this.box = null;
  }
}

// ───────────── índice ─────────────

export type TocEntry = { level: number; text: string; page: number; pos: number };

/** Títulos 1 a 3 del documento con la página donde cae cada uno. */
export function tocEntries(state: EditorState): TocEntry[] {
  const breaks = pagesKey.getState(state)?.breaks ?? [];
  const out: TocEntry[] = [];
  state.doc.descendants((node, pos) => {
    if (node.type.name === "heading") {
      const level = Number(node.attrs.level ?? 1);
      const text = node.textContent.trim();
      if (level <= 3 && text) out.push({ level, text, pos, page: 1 + breaks.filter((b) => b.pos <= pos).length });
      return false;
    }
    return node.type.name !== "tableOfContents";
  });
  return out;
}

/** El documento con las entradas del índice guardadas (para escribirlas en el .docx con sus páginas). */
export function withTocCache(json: JSONContent, state: EditorState): JSONContent {
  if (!json.content?.some((b) => b.type === "tableOfContents")) return json;
  const entries = tocEntries(state).map(({ level, text, page }) => ({ level, text, page }));
  return { ...json, content: json.content.map((b) => (b.type === "tableOfContents" ? { ...b, attrs: { ...b.attrs, cache: entries } } : b)) };
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderToc(dom: HTMLElement, state: EditorState) {
  const entries = tocEntries(state);
  const body = entries.length
    ? entries
        .map(
          (e) =>
            `<a class="write-toc-entry lvl-${e.level}" data-pos="${e.pos}" href="#"><span class="write-toc-text">${escapeHtml(e.text)}</span><span class="write-toc-dots"></span><span class="write-toc-page">${e.page}</span></a>`,
        )
        .join("")
    : `<div class="write-toc-empty">El índice se arma solo con los títulos del documento (Título 1, 2 y 3). Pon títulos y aparecerán aquí con su página.</div>`;
  const html = `<div class="write-toc-title">Índice</div>${body}`;
  if (dom.dataset.html !== html) {
    dom.dataset.html = html;
    dom.innerHTML = html;
  }
}

export const TableOfContents = Node.create({
  name: "tableOfContents",
  group: "block",
  atom: true,
  selectable: true,
  addAttributes: () => ({
    // Entradas con su página al guardar (solo para escribir el .docx; en pantalla se calculan).
    cache: { default: null, rendered: false },
  }),
  parseHTML: () => [{ tag: "div[data-toc]" }],
  renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-toc": "", class: "write-toc" })],
  addNodeView() {
    return ({ editor }: { editor: Editor }) => {
      const dom = document.createElement("div");
      dom.className = "write-toc";
      dom.dataset.toc = "";
      dom.contentEditable = "false";
      dom.addEventListener("mousedown", (e) => {
        const entry = (e.target as HTMLElement).closest<HTMLElement>(".write-toc-entry");
        if (!entry) return;
        e.preventDefault();
        e.stopPropagation();
        const pos = Number(entry.dataset.pos);
        const view = editor.view;
        const at = Math.min(pos + 1, view.state.doc.content.size);
        view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(at))).scrollIntoView());
        view.focus();
        (view.nodeDOM(pos) as HTMLElement | null)?.scrollIntoView?.({ block: "center" });
      });
      dom.addEventListener("click", (e) => e.preventDefault());
      renderToc(dom, editor.state);
      return { dom, ignoreMutation: () => true, stopEvent: (e: Event) => e.type === "mousedown" && Boolean((e.target as HTMLElement).closest(".write-toc-entry")) };
    };
  },
  addCommands() {
    return {
      insertTableOfContents:
        () =>
        ({ chain }) =>
          chain().insertContent([{ type: "tableOfContents" }, { type: "paragraph" }]).run(),
    };
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("wepo-toc"),
        view: () => ({
          update(view: EditorView) {
            view.dom.querySelectorAll<HTMLElement>(".write-toc").forEach((dom) => renderToc(dom, view.state));
          },
        }),
      }),
    ];
  },
});
