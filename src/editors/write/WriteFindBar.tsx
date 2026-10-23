import { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { useEditorState } from "@tiptap/react";
import { searchState } from "./extensions";
import "../sheets/FindBar.css";

type Props = { editor: Editor; onClose: () => void };

/** Buscar y reemplazar en el documento (⌘F). */
export default function WriteFindBar({ editor, onClose }: Props) {
  const [query, setQuery] = useState(() => {
    const { from, to, empty } = editor.state.selection;
    const selected = empty ? "" : editor.state.doc.textBetween(from, to, " ");
    return selected.length < 80 && !selected.includes("\n") ? selected : "";
  });
  const [replacement, setReplacement] = useState("");
  const [showReplace, setShowReplace] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const st = searchState(e.state);
      return { count: st?.matches.length ?? 0, index: st?.index ?? -1 };
    },
  });

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    editor.commands.setSearch(query, { caseSensitive, wholeWord });
  }, [editor, query, caseSensitive, wholeWord]);

  // Al cerrar se quitan los resaltados.
  useEffect(() => () => void editor.commands.clearSearch(), [editor]);

  function close() {
    onClose();
    editor.commands.focus();
  }

  function replaceAll() {
    const count = s.count;
    if (!count) return;
    editor.commands.replaceAllMatches(replacement);
    setMessage(count === 1 ? "1 cambio" : `${count} cambios`);
  }

  return (
    <div className="find-bar" role="search" onKeyDown={(e) => e.key === "Escape" && close()}>
      <div className="find-row">
        <button
          type="button"
          className="fb-button"
          title={showReplace ? "Ocultar reemplazar" : "Mostrar reemplazar"}
          aria-label="Mostrar reemplazar"
          aria-expanded={showReplace}
          onClick={() => setShowReplace((v) => !v)}
        >
          {showReplace ? "▾" : "▸"}
        </button>
        <input
          ref={inputRef}
          className="find-input"
          placeholder="Buscar en el documento"
          aria-label="Buscar"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setMessage(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              editor.commands.goToMatch(e.shiftKey ? -1 : 1);
            }
          }}
        />
        <span className="find-count" aria-live="polite">
          {query ? (!s.count ? "Sin resultados" : s.index === -1 ? `${s.count} ${s.count === 1 ? "resultado" : "resultados"}` : `${s.index + 1} de ${s.count}`) : ""}
        </span>
        <button type="button" className="fb-button" title="Anterior (⇧↩)" aria-label="Anterior" onClick={() => editor.commands.goToMatch(-1)}>
          ↑
        </button>
        <button type="button" className="fb-button" title="Siguiente (↩)" aria-label="Siguiente" onClick={() => editor.commands.goToMatch(1)}>
          ↓
        </button>
        <label className="find-option">
          <input type="checkbox" checked={caseSensitive} onChange={() => setCaseSensitive((v) => !v)} /> Mayúsculas
        </label>
        <label className="find-option">
          <input type="checkbox" checked={wholeWord} onChange={() => setWholeWord((v) => !v)} /> Palabra completa
        </label>
        <button type="button" className="btn btn-icon find-close" aria-label="Cerrar búsqueda" onClick={close}>
          ×
        </button>
      </div>
      {showReplace && (
        <div className="find-row">
          <span className="find-spacer" />
          <input
            className="find-input"
            placeholder="Reemplazar con"
            aria-label="Reemplazar con"
            value={replacement}
            onChange={(e) => setReplacement(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                editor.commands.replaceMatch(replacement);
              }
            }}
          />
          <button type="button" className="btn" onClick={() => editor.commands.replaceMatch(replacement)} disabled={!s.count}>
            Reemplazar
          </button>
          <button type="button" className="btn" onClick={replaceAll} disabled={!s.count}>
            Reemplazar todo
          </button>
          {message && <span className="find-count">{message}</span>}
        </div>
      )}
    </div>
  );
}
