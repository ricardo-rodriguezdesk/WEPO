// Tarjeta de un comentario de celda, como en Excel 365: la conversación con sus
// respuestas, un cuadro para responder y las opciones (resolver, editar, borrar).

import { useEffect, useRef, useState } from "react";
import type { CommentCardAction, CommentView } from "../../lib/spreadsheet";
import { keys } from "../../lib/platform";

type Props = {
  style: { left: number; top: number };
  /** La conversación de la celda, o null para empezar una. */
  thread: CommentView | null;
  author: string;
  /** Abierta a propósito (no solo por pasar el mouse): el cuadro de texto toma el foco. */
  pinned: boolean;
  onAction: (action: CommentCardAction) => void;
  onClose: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
};

/** "2026-10-28T10:30:00.00" (UTC) → "28 oct 2026, 4:30 a. m." en la hora de la computadora. */
export function formatCommentDate(iso: string): string {
  const date = new Date(iso.replace(/\.\d+$/, "") + "Z");
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("es-MX", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
}

function initials(name: string) {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase())
      .join("") || "?"
  );
}

export default function CommentCard({ style, thread, author, pinned, onAction, onClose, onMouseEnter, onMouseLeave }: Props) {
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (pinned) input.current?.focus();
  }, [pinned, thread?.id]);

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    if (thread) onAction({ kind: "reply", thread: thread.id, author, text });
    else onAction({ kind: "add", text });
  };
  const saveEdit = (id: string) => {
    if (!thread) return;
    const text = editText.trim();
    setEditing(null);
    if (text) onAction({ kind: "edit", thread: thread.id, message: id, text });
  };

  return (
    <div
      className={`comment-card${thread?.done ? " done" : ""}`}
      style={style}
      role="dialog"
      aria-label={thread ? "Comentario" : "Comentario nuevo"}
      onMouseDown={(e) => e.stopPropagation()}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") onClose();
      }}
    >
      {thread && (
        <header>
          {thread.done ? <span className="comment-done-label">Resuelto</span> : <span />}
          <span className="comment-tools">
            <button
              type="button"
              className="comment-tool"
              title={thread.done ? "Volver a abrir la conversación" : "Resolver: la conversación queda cerrada (se puede volver a abrir)"}
              onClick={() => onAction({ kind: "resolve", thread: thread.id, done: !thread.done })}
            >
              {thread.done ? "Volver a abrir" : "Resolver"}
            </button>
            <button
              type="button"
              className="comment-tool danger"
              title="Borrar el comentario y todas sus respuestas"
              onClick={() => onAction({ kind: "delete", thread: thread.id, message: thread.id })}
            >
              Eliminar
            </button>
          </span>
        </header>
      )}
      {thread?.messages.map((m, i) => (
        <article key={m.id} className="comment-message">
          <div className="comment-head">
            <span className="comment-avatar" aria-hidden="true">
              {initials(m.author)}
            </span>
            <span className="comment-author">{m.author || "Sin nombre"}</span>
            <small className="comment-date">{formatCommentDate(m.date)}</small>
          </div>
          {editing === m.id ? (
            <div className="comment-edit">
              <textarea
                className="comment-input"
                value={editText}
                autoFocus
                aria-label="Editar el comentario"
                onChange={(e) => setEditText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) saveEdit(m.id);
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    setEditing(null);
                  }
                }}
              />
              <div className="comment-buttons">
                <button type="button" className="btn" onClick={() => setEditing(null)}>
                  Cancelar
                </button>
                <button type="button" className="btn btn-primary" onClick={() => saveEdit(m.id)}>
                  Guardar
                </button>
              </div>
            </div>
          ) : (
            <p className="comment-text">{m.text}</p>
          )}
          {editing !== m.id && (
            <div className="comment-actions">
              <button
                type="button"
                onClick={() => {
                  setEditing(m.id);
                  setEditText(m.text);
                }}
              >
                Editar
              </button>
              {i > 0 && (
                <button type="button" onClick={() => onAction({ kind: "delete", thread: thread.id, message: m.id })}>
                  Eliminar
                </button>
              )}
            </div>
          )}
        </article>
      ))}
      <div className="comment-reply">
        <textarea
          ref={input}
          className="comment-input"
          placeholder={thread ? "Responder…" : "Empieza una conversación…"}
          aria-label={thread ? "Responder" : "Comentario nuevo"}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="comment-buttons">
          <small className="note-hint">{keys("⌘")}↩ para publicar</small>
          {!thread && (
            <button type="button" className="btn" onClick={onClose}>
              Cancelar
            </button>
          )}
          <button type="button" className="btn btn-primary" disabled={!draft.trim()} onClick={send}>
            {thread ? "Responder" : "Publicar"}
          </button>
        </div>
      </div>
    </div>
  );
}
