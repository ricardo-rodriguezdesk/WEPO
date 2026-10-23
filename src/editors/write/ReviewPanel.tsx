import { useEffect, useMemo, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { useEditorState } from "@tiptap/react";
import { TextSelection } from "@tiptap/pm/state";
import type { Comment } from "./review";
import { commentPositions, initialsOf, listChanges, markRanges, newId } from "./review";

type Props = {
  editor: Editor;
  comments: Comment[];
  onChange: (comments: Comment[]) => void;
  /** Comentario recién creado: se abre para escribirlo. */
  editingId: string | null;
  onEditingDone: () => void;
  author: string;
  onAuthor: (name: string) => void;
  tracking: boolean;
  onTracking: (on: boolean) => void;
  onClose: () => void;
};

const dateFormat = new Intl.DateTimeFormat("es-MX", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : dateFormat.format(d);
}

/** Panel de revisión (a la derecha de la hoja): comentarios y cambios registrados, en el orden del documento. */
export default function ReviewPanel(props: Props) {
  const { editor, comments, onChange, editingId, author } = props;
  const [showDone, setShowDone] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(author);

  const info = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const { from } = e.state.selection;
      const active = new Set<string>();
      const $from = e.state.doc.resolve(from);
      for (const m of [...$from.marks(), ...($from.nodeAfter?.marks ?? [])]) if (m.type.name === "comment") active.add(m.attrs.id);
      return { positions: commentPositions(e.state.doc), changes: listChanges(e.state.doc), active: [...active].join(",") };
    },
    equalityFn: (a, b) => {
      if (!b || a.active !== b.active || a.changes.length !== b.changes.length) return false;
      if (a.changes.some((c, i) => c.id !== b.changes[i].id || c.text !== b.changes[i].text || c.from !== b.changes[i].from)) return false;
      if (a.positions.size !== b.positions.size) return false;
      for (const [k, v] of a.positions) if (b.positions.get(k) !== v) return false;
      return true;
    },
  });
  const active = new Set(info.active ? info.active.split(",") : []);

  // Comentarios que siguen sobre el texto, en orden; y los cambios, intercalados por posición.
  const items = useMemo(() => {
    const list: ({ kind: "comment"; at: number; comment: Comment } | { kind: "change"; at: number; change: (typeof info.changes)[number] })[] = [];
    for (const c of comments) {
      const at = info.positions.get(c.id);
      if (at === undefined || (c.done && !showDone && c.id !== editingId)) continue;
      list.push({ kind: "comment", at, comment: c });
    }
    for (const ch of info.changes) list.push({ kind: "change", at: ch.from, change: ch });
    return list.sort((a, b) => a.at - b.at);
  }, [comments, info, showDone, editingId]);

  const doneCount = comments.filter((c) => c.done && info.positions.has(c.id)).length;

  function update(id: string, patch: Partial<Comment>) {
    onChange(comments.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }

  function remove(id: string) {
    editor.commands.removeComment(id);
    onChange(comments.filter((c) => c.id !== id));
  }

  function select(from: number, to?: number) {
    const ranges = to === undefined ? [] : [{ from, to }];
    const target = ranges[0] ?? { from, to: from };
    const tr = editor.state.tr.setSelection(TextSelection.create(editor.state.doc, target.from, target.to)).scrollIntoView();
    editor.view.dispatch(tr);
    editor.view.focus();
  }

  function goToComment(id: string) {
    const r = markRanges(editor.state.doc, "comment", id)[0];
    if (r) select(r.from, r.to);
  }

  const resolvedCss = comments
    .filter((c) => c.done)
    .map((c) => `.write-content .write-comment[data-comment="${CSS.escape(c.id)}"]`)
    .join(",");
  const activeCss = [...active].map((id) => `.write-content .write-comment[data-comment="${CSS.escape(id)}"]`).join(",");

  return (
    <aside className="review-panel" aria-label="Revisión">
      <style>
        {`${resolvedCss ? `${resolvedCss} { background: none; border-bottom: 1px dashed #c9b458; }` : ""}${activeCss ? `${activeCss} { background: #ffd966; }` : ""}`}
      </style>
      <header className="review-header">
        <b>Revisión</b>
        <button type="button" className="btn btn-icon" aria-label="Cerrar revisión" onClick={props.onClose}>
          ×
        </button>
      </header>
      <div className="review-who">
        {renaming ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (draftName.trim()) props.onAuthor(draftName.trim());
              setRenaming(false);
            }}
          >
            <input className="input" value={draftName} onChange={(e) => setDraftName(e.target.value)} autoFocus aria-label="Tu nombre" onBlur={() => setRenaming(false)} />
          </form>
        ) : (
          <button type="button" className="review-name" title="Cambiar el nombre con el que firmas" onClick={() => (setDraftName(author), setRenaming(true))}>
            <span className="review-avatar">{initialsOf(author)}</span> Comentas como <b>{author}</b> ✎
          </button>
        )}
      </div>
      <label className={`review-track${props.tracking ? " on" : ""}`}>
        <input type="checkbox" role="switch" checked={props.tracking} onChange={(e) => props.onTracking(e.target.checked)} />
        <span className="autosave-track" aria-hidden />
        Control de cambios
      </label>
      {info.changes.length > 0 && (
        <div className="review-all">
          <span>
            {info.changes.length} {info.changes.length === 1 ? "cambio" : "cambios"}
          </span>
          <button type="button" className="btn" onClick={() => editor.chain().focus().acceptAllChanges().run()}>
            Aceptar todo
          </button>
          <button type="button" className="btn" onClick={() => editor.chain().focus().rejectAllChanges().run()}>
            Rechazar todo
          </button>
        </div>
      )}

      <div className="review-list">
        {!items.length && (
          <p className="review-empty">
            Selecciona texto y usa <b>Comentario</b> para comentarlo. Con el control de cambios encendido, lo que escribas o borres queda marcado para aceptarlo o
            rechazarlo.
          </p>
        )}
        {items.map((item) =>
          item.kind === "comment" ? (
            <CommentCard
              key={item.comment.id}
              comment={item.comment}
              active={active.has(item.comment.id)}
              editing={editingId === item.comment.id}
              author={author}
              onSelect={() => goToComment(item.comment.id)}
              onText={(text) => {
                update(item.comment.id, { text });
                props.onEditingDone();
              }}
              onCancelNew={() => {
                remove(item.comment.id);
                props.onEditingDone();
              }}
              onToggleDone={() => update(item.comment.id, { done: !item.comment.done })}
              onRemove={() => remove(item.comment.id)}
              onReply={(text) =>
                update(item.comment.id, {
                  replies: [...item.comment.replies, { id: newId("k"), author, initials: initialsOf(author), date: nowIso(), text, done: false, replies: [] }],
                })
              }
            />
          ) : (
            <div
              key={`${item.change.kind}-${item.change.id}`}
              className={`review-card review-change ${item.change.kind}`}
              onClick={() => select(item.change.from, item.change.from + Math.min(item.change.text.length, 1))}
            >
              <div className="review-meta">
                <span className="review-avatar small">{initialsOf(item.change.author)}</span>
                <b>{item.change.author || "Alguien"}</b>
                <span>{when(item.change.date)}</span>
              </div>
              <p>
                {item.change.kind === "insertion" ? "Insertó " : "Borró "}
                <span className={item.change.kind === "insertion" ? "write-ins" : "write-del"}>«{clip(item.change.text)}»</span>
              </p>
              <div className="review-actions">
                <button
                  type="button"
                  className="btn"
                  title="Aceptar este cambio"
                  onClick={(e) => (e.stopPropagation(), editor.chain().focus().acceptChange(item.change.id).run())}
                >
                  ✓ Aceptar
                </button>
                <button
                  type="button"
                  className="btn"
                  title="Rechazar este cambio"
                  onClick={(e) => (e.stopPropagation(), editor.chain().focus().rejectChange(item.change.id).run())}
                >
                  ✕ Rechazar
                </button>
              </div>
            </div>
          ),
        )}
        {doneCount > 0 && (
          <button type="button" className="review-show-done" onClick={() => setShowDone((v) => !v)}>
            {showDone ? "Ocultar resueltos" : `Mostrar ${doneCount} ${doneCount === 1 ? "comentario resuelto" : "comentarios resueltos"}`}
          </button>
        )}
      </div>
    </aside>
  );
}

function nowIso() {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

function clip(text: string) {
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

function CommentCard(props: {
  comment: Comment;
  active: boolean;
  editing: boolean;
  author: string;
  onSelect: () => void;
  onText: (text: string) => void;
  onCancelNew: () => void;
  onToggleDone: () => void;
  onRemove: () => void;
  onReply: (text: string) => void;
}) {
  const { comment } = props;
  const [draft, setDraft] = useState(comment.text);
  const [editing, setEditing] = useState(props.editing);
  const [reply, setReply] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const isNew = props.editing && !comment.text;

  useEffect(() => {
    if (props.active) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [props.active]);

  function save() {
    if (!draft.trim()) {
      if (isNew) props.onCancelNew();
      else setEditing(false);
      return;
    }
    props.onText(draft.trim());
    setEditing(false);
  }

  return (
    <div ref={ref} className={`review-card review-comment${props.active ? " active" : ""}${comment.done ? " done" : ""}`} onClick={props.onSelect}>
      <div className="review-meta">
        <span className="review-avatar small">{comment.initials || initialsOf(comment.author)}</span>
        <b>{comment.author || "Alguien"}</b>
        <span>{when(comment.date)}</span>
        {comment.done && <span className="review-done-badge">Resuelto</span>}
      </div>
      {editing ? (
        <div className="review-edit" onClick={(e) => e.stopPropagation()}>
          <textarea
            className="textarea"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Escribe tu comentario"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) (e.preventDefault(), save());
              if (e.key === "Escape") (e.stopPropagation(), isNew ? props.onCancelNew() : setEditing(false));
            }}
          />
          <div className="review-actions">
            <button type="button" className="btn" onClick={() => (isNew ? props.onCancelNew() : (setDraft(comment.text), setEditing(false)))}>
              Cancelar
            </button>
            <button type="button" className="btn btn-primary" onClick={save}>
              {isNew ? "Comentar" : "Guardar"}
            </button>
          </div>
        </div>
      ) : (
        <p className="review-text">{comment.text}</p>
      )}
      {comment.replies.map((r) => (
        <div key={r.id} className="review-reply">
          <div className="review-meta">
            <span className="review-avatar small">{r.initials || initialsOf(r.author)}</span>
            <b>{r.author || "Alguien"}</b>
            <span>{when(r.date)}</span>
          </div>
          <p className="review-text">{r.text}</p>
        </div>
      ))}
      {reply !== null && (
        <div className="review-edit" onClick={(e) => e.stopPropagation()}>
          <textarea
            className="textarea"
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            placeholder="Responder"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && reply.trim()) (e.preventDefault(), props.onReply(reply.trim()), setReply(null));
              if (e.key === "Escape") (e.stopPropagation(), setReply(null));
            }}
          />
          <div className="review-actions">
            <button type="button" className="btn" onClick={() => setReply(null)}>
              Cancelar
            </button>
            <button type="button" className="btn btn-primary" disabled={!reply.trim()} onClick={() => (props.onReply(reply.trim()), setReply(null))}>
              Responder
            </button>
          </div>
        </div>
      )}
      {!editing && reply === null && (
        <div className="review-actions" onClick={(e) => e.stopPropagation()}>
          <button type="button" className="btn" onClick={() => setReply("")}>
            Responder
          </button>
          <button type="button" className="btn" onClick={props.onToggleDone}>
            {comment.done ? "Reabrir" : "✓ Resolver"}
          </button>
          {comment.author === props.author && (
            <button type="button" className="btn" onClick={() => (setDraft(comment.text), setEditing(true))}>
              Editar
            </button>
          )}
          <button type="button" className="btn review-delete" onClick={props.onRemove} title="Borrar comentario">
            Borrar
          </button>
        </div>
      )}
    </div>
  );
}
