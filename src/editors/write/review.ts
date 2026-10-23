// Revisión en WEPO Write: comentarios y control de cambios, como en Word.
//
// - Comentarios: una marca `comment` (con el id del comentario) sobre el texto
//   comentado; el texto del comentario, su autor, respuestas y si está resuelto
//   viven aparte (WriteDocument.comments) y se guardan en word/comments.xml.
// - Control de cambios: marcas `insertion` y `deletion` (autor y fecha). Con el
//   modo encendido, lo que se escribe queda como insertado y lo que se borra
//   queda tachado en vez de desaparecer, hasta aceptarlo o rechazarlo.

import { Extension, Mark } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    review: {
      addComment: (id: string) => ReturnType;
      removeComment: (id: string) => ReturnType;
      acceptChange: (id: string) => ReturnType;
      rejectChange: (id: string) => ReturnType;
      acceptAllChanges: () => ReturnType;
      rejectAllChanges: () => ReturnType;
      setTracking: (on: boolean) => ReturnType;
    };
  }
}

export type Comment = {
  id: string;
  author: string;
  initials: string;
  /** Fecha ISO (como la guarda Word). */
  date: string;
  text: string;
  done: boolean;
  replies: Comment[];
};

export type ChangeAttrs = { id: string; author: string; date: string };

let counter = 0;
export function newId(prefix: string): string {
  counter++;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}`;
}

export function initialsOf(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join("") || "?"
  );
}

// ───────────── marcas ─────────────

export const CommentMark = Mark.create({
  name: "comment",
  inclusive: false,
  // Varios comentarios pueden cubrir el mismo texto.
  excludes: "",
  addAttributes: () => ({ id: { default: null } }),
  parseHTML: () => [{ tag: "span[data-comment]", getAttrs: (el) => ({ id: (el as HTMLElement).dataset.comment }) }],
  renderHTML: ({ HTMLAttributes }) => ["span", { "data-comment": HTMLAttributes.id, class: "write-comment" }, 0],
});

const changeAttrs = () => ({
  id: { default: null },
  author: { default: "" },
  date: { default: "" },
});

export const InsertionMark = Mark.create({
  name: "insertion",
  inclusive: false,
  excludes: "deletion",
  addAttributes: changeAttrs,
  parseHTML: () => [{ tag: "ins[data-change]" }],
  renderHTML: ({ HTMLAttributes }) => ["ins", { "data-change": HTMLAttributes.id, class: "write-ins", title: `${HTMLAttributes.author} insertó` }, 0],
});

export const DeletionMark = Mark.create({
  name: "deletion",
  inclusive: false,
  excludes: "insertion",
  addAttributes: changeAttrs,
  parseHTML: () => [{ tag: "del[data-change]" }],
  renderHTML: ({ HTMLAttributes }) => ["del", { "data-change": HTMLAttributes.id, class: "write-del", title: `${HTMLAttributes.author} borró` }, 0],
});

// ───────────── utilidades ─────────────

type Range = { from: number; to: number };

/** Rangos del documento con una marca de cierto id (pueden ser varios pedazos). */
export function markRanges(doc: PMNode, type: string, id: string): Range[] {
  const out: Range[] = [];
  doc.descendants((node, pos) => {
    if (!node.isInline) return true;
    if (node.marks.some((m) => m.type.name === type && m.attrs.id === id)) {
      const last = out[out.length - 1];
      if (last && last.to === pos) last.to = pos + node.nodeSize;
      else out.push({ from: pos, to: pos + node.nodeSize });
    }
    return false;
  });
  return out;
}

export type ChangeInfo = { id: string; kind: "insertion" | "deletion"; author: string; date: string; text: string; from: number };

/** Los cambios del documento, en orden, con el texto que tocan. */
export function listChanges(doc: PMNode): ChangeInfo[] {
  const byId = new Map<string, ChangeInfo>();
  doc.descendants((node, pos) => {
    if (!node.isInline) return true;
    for (const m of node.marks) {
      if (m.type.name !== "insertion" && m.type.name !== "deletion") continue;
      const key = `${m.type.name}:${m.attrs.id}`;
      const piece = node.isText ? node.text! : "▣";
      const found = byId.get(key);
      if (found) found.text += piece;
      else byId.set(key, { id: m.attrs.id, kind: m.type.name as ChangeInfo["kind"], author: m.attrs.author, date: m.attrs.date, text: piece, from: pos });
    }
    return false;
  });
  return [...byId.values()].sort((a, b) => a.from - b.from);
}

/** Dónde empieza cada comentario en el documento (para ordenarlos y saber cuáles siguen vivos). */
export function commentPositions(doc: PMNode): Map<string, number> {
  const out = new Map<string, number>();
  doc.descendants((node, pos) => {
    if (!node.isInline) return true;
    for (const m of node.marks) if (m.type.name === "comment" && !out.has(m.attrs.id)) out.set(m.attrs.id, pos);
    return false;
  });
  return out;
}

/** Aplica o deshace un cambio: `keep` dice si el texto se queda. */
function resolveChange(tr: Transaction, kind: "insertion" | "deletion", id: string | null, keep: (kind: "insertion" | "deletion") => boolean) {
  const type = tr.doc.type.schema.marks[kind];
  const ranges: (Range & { id: string })[] = [];
  tr.doc.descendants((node, pos) => {
    if (!node.isInline) return true;
    const mark = node.marks.find((m) => m.type === type && (id === null || m.attrs.id === id));
    if (mark) ranges.push({ from: pos, to: pos + node.nodeSize, id: mark.attrs.id });
    return false;
  });
  // De atrás hacia adelante para que las posiciones no se muevan.
  for (const r of ranges.reverse()) {
    if (keep(kind)) tr.removeMark(r.from, r.to, type);
    else tr.delete(r.from, r.to);
  }
}

// ───────────── control de cambios ─────────────

export const reviewKey = new PluginKey<{ tracking: boolean }>("wepo-review");
/** Las transacciones con esta marca no se registran como cambios (aceptar, rechazar, abrir…). */
export const NO_TRACK = "wepoNoTrack";

function changeMark(state: EditorState, kind: "insertion" | "deletion", author: string, id = newId("c")) {
  return state.schema.marks[kind].create({ id, author, date: new Date().toISOString().replace(/\.\d+Z$/, "Z") });
}

/** Un cambio del mismo autor justo al lado: así escribir o borrar letra por letra forma un solo cambio. */
function neighbor(doc: PMNode, from: number, to: number, kind: "insertion" | "deletion", author: string) {
  const near = [doc.resolve(from).nodeBefore, doc.resolve(to).nodeAfter];
  for (const node of near) {
    const mark = node?.marks.find((m) => m.type.name === kind && m.attrs.author === author);
    if (mark) return mark;
  }
  return null;
}

/**
 * Borrar con el control de cambios: lo que ya era una inserción propia se borra de verdad;
 * lo demás queda tachado (marca de borrado).
 */
function markDeletion(tr: Transaction, from: number, to: number, author: string) {
  const del = tr.doc.type.schema.marks.deletion;
  const ins = tr.doc.type.schema.marks.insertion;
  const pieces: { from: number; to: number; inserted: boolean; deleted: boolean }[] = [];
  tr.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isInline) return true;
    const a = Math.max(from, pos);
    const b = Math.min(to, pos + node.nodeSize);
    if (a < b) pieces.push({ from: a, to: b, inserted: Boolean(ins.isInSet(node.marks)), deleted: Boolean(del.isInSet(node.marks)) });
    return false;
  });
  const mark = neighbor(tr.doc, from, to, "deletion", author) ?? changeMark({ schema: tr.doc.type.schema } as EditorState, "deletion", author);
  for (const p of pieces.reverse()) {
    if (p.inserted) tr.delete(p.from, p.to);
    else if (!p.deleted) tr.addMark(p.from, p.to, mark);
  }
}

/** ¿El carácter entre `pos - 1` y `pos` ya está tachado? */
function deletedAt(doc: PMNode, pos: number): boolean {
  const $pos = doc.resolve(pos);
  const node = $pos.nodeBefore;
  return Boolean(node && node.marks.some((m) => m.type.name === "deletion"));
}

function handleDelete(view: EditorView, author: string, backward: boolean): boolean {
  const { state } = view;
  const { selection } = state;
  const tr = state.tr;
  if (selection.empty) {
    const $pos = selection.$from;
    let pos = $pos.pos;
    // Salta lo que ya está tachado.
    if (backward) {
      while (pos > $pos.start() && deletedAt(state.doc, pos)) pos--;
      if (pos <= $pos.start()) return pos !== $pos.pos ? (view.dispatch(tr.setSelection(TextSelection.create(tr.doc, pos))), true) : false;
      const before = tr.doc.resolve(pos).nodeBefore;
      const size = before?.isText ? 1 : (before?.nodeSize ?? 1);
      markDeletion(tr, pos - size, pos, author);
      const target = tr.mapping.map(pos - size, -1);
      tr.setSelection(TextSelection.create(tr.doc, target));
    } else {
      while (pos < $pos.end() && tr.doc.resolve(pos).nodeAfter?.marks.some((m) => m.type.name === "deletion")) pos++;
      if (pos >= $pos.end()) return pos !== $pos.pos ? (view.dispatch(tr.setSelection(TextSelection.create(tr.doc, pos))), true) : false;
      const after = tr.doc.resolve(pos).nodeAfter;
      const size = after?.isText ? 1 : (after?.nodeSize ?? 1);
      markDeletion(tr, pos, pos + size, author);
      tr.setSelection(TextSelection.create(tr.doc, tr.mapping.map(pos + size, 1)));
    }
  } else {
    const { from, to } = selection;
    markDeletion(tr, from, to, author);
    const at = backward ? tr.mapping.map(from, -1) : tr.mapping.map(to, 1);
    tr.setSelection(TextSelection.create(tr.doc, at));
  }
  view.dispatch(tr.setMeta(NO_TRACK, true).scrollIntoView());
  return true;
}

export const Review = Extension.create<{ author: () => string }>({
  name: "review",
  addOptions: () => ({ author: () => "WEPO" }),

  addCommands() {
    const done = (tr: Transaction) => tr.setMeta(NO_TRACK, true);
    return {
      addComment:
        (id) =>
        ({ tr, state, dispatch }) => {
          const { from, to, empty } = state.selection;
          if (empty) return false;
          if (dispatch) dispatch(done(tr.addMark(from, to, state.schema.marks.comment.create({ id }))));
          return true;
        },
      removeComment:
        (id) =>
        ({ tr, state, dispatch }) => {
          const type = state.schema.marks.comment;
          for (const r of markRanges(state.doc, "comment", id)) tr.removeMark(r.from, r.to, type.create({ id }));
          if (dispatch) dispatch(done(tr));
          return true;
        },
      acceptChange:
        (id) =>
        ({ tr, dispatch }) => {
          resolveChange(tr, "insertion", id, () => true);
          resolveChange(tr, "deletion", id, () => false);
          if (dispatch) dispatch(done(tr));
          return true;
        },
      rejectChange:
        (id) =>
        ({ tr, dispatch }) => {
          resolveChange(tr, "insertion", id, () => false);
          resolveChange(tr, "deletion", id, () => true);
          if (dispatch) dispatch(done(tr));
          return true;
        },
      acceptAllChanges:
        () =>
        ({ tr, dispatch }) => {
          resolveChange(tr, "insertion", null, () => true);
          resolveChange(tr, "deletion", null, () => false);
          if (dispatch) dispatch(done(tr));
          return true;
        },
      rejectAllChanges:
        () =>
        ({ tr, dispatch }) => {
          resolveChange(tr, "insertion", null, () => false);
          resolveChange(tr, "deletion", null, () => true);
          if (dispatch) dispatch(done(tr));
          return true;
        },
      setTracking:
        (on) =>
        ({ tr, dispatch }) => {
          if (dispatch) dispatch(tr.setMeta(reviewKey, { tracking: on }).setMeta("addToHistory", false));
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    const author = () => this.options.author();
    return [
      new Plugin<{ tracking: boolean }>({
        key: reviewKey,
        state: {
          init: () => ({ tracking: false }),
          apply: (tr, prev) => (tr.getMeta(reviewKey) as { tracking: boolean } | undefined) ?? prev,
        },
        props: {
          handleKeyDown(view, event) {
            if (!reviewKey.getState(view.state)?.tracking) return false;
            if (event.key === "Backspace" || event.key === "Delete") {
              // ⌥/Ctrl + borrar (palabra entera) se trata como borrar la selección de la palabra.
              return handleDelete(view, author(), event.key === "Backspace");
            }
            return false;
          },
          handleTextInput(view, from, to, text) {
            if (!reviewKey.getState(view.state)?.tracking || from === to) return false;
            // Escribir sobre una selección: lo seleccionado queda tachado y lo nuevo, insertado.
            const tr = view.state.tr;
            markDeletion(tr, from, to, author());
            const at = tr.mapping.map(to, 1);
            const marks = (view.state.storedMarks ?? view.state.doc.resolve(from).marks()).filter((m) => m.type.name !== "deletion" && m.type.name !== "insertion");
            const ins = neighbor(tr.doc, at, at, "insertion", author()) ?? changeMark(view.state, "insertion", author());
            tr.insert(at, view.state.schema.text(text, [...marks, ins]));
            tr.setSelection(TextSelection.create(tr.doc, at + text.length));
            view.dispatch(tr.setMeta(NO_TRACK, true));
            return true;
          },
          handlePaste(view) {
            if (!reviewKey.getState(view.state)?.tracking || view.state.selection.empty) return false;
            // Pegar sobre una selección: primero se tacha lo seleccionado; luego se pega al final.
            const tr = view.state.tr;
            const { from, to } = view.state.selection;
            markDeletion(tr, from, to, author());
            tr.setSelection(TextSelection.create(tr.doc, tr.mapping.map(to, 1)));
            view.dispatch(tr.setMeta(NO_TRACK, true));
            return false;
          },
          handleDOMEvents: {
            cut(view, event) {
              if (!reviewKey.getState(view.state)?.tracking || view.state.selection.empty) return false;
              // Cortar copia el texto y lo deja tachado.
              const text = view.state.doc.textBetween(view.state.selection.from, view.state.selection.to, "\n");
              event.clipboardData?.setData("text/plain", text);
              event.preventDefault();
              handleDelete(view, author(), true);
              return true;
            },
          },
        },
        // Todo lo que entra al documento con el modo encendido queda marcado como insertado.
        appendTransaction(transactions, _old, state) {
          if (!reviewKey.getState(state)?.tracking) return null;
          const ranges: Range[] = [];
          for (const tr of transactions) {
            if (!tr.docChanged || tr.getMeta(NO_TRACK) || tr.getMeta("history$") || tr.getMeta("addToHistory") === false) {
              // Las posiciones anteriores se mueven con esta transacción.
              for (const r of ranges) (r.from = tr.mapping.map(r.from, 1)), (r.to = tr.mapping.map(r.to, -1));
              continue;
            }
            for (const r of ranges) (r.from = tr.mapping.map(r.from, 1)), (r.to = tr.mapping.map(r.to, -1));
            tr.mapping.maps.forEach((map, i) => {
              map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
                if (newEnd <= newStart) return;
                // Mover el rango a través de los pasos que siguen.
                const rest = tr.mapping.slice(i + 1);
                ranges.push({ from: rest.map(newStart, 1), to: rest.map(newEnd, -1) });
              });
            });
          }
          const live = ranges.filter((r) => r.to > r.from);
          if (!live.length) return null;
          const tr = state.tr;
          for (const r of live) {
            const mark = neighbor(state.doc, r.from, r.to, "insertion", author()) ?? changeMark(state, "insertion", author());
            tr.removeMark(r.from, r.to, state.schema.marks.deletion);
            tr.addMark(r.from, r.to, mark);
          }
          return tr.setMeta(NO_TRACK, true);
        },
      }),
    ];
  },
});

export function isTracking(editor: Editor): boolean {
  return Boolean(reviewKey.getState(editor.state)?.tracking);
}
