import { useEffect, useRef, useState } from "react";
import type { FindMatch, FindOptions } from "../../lib/spreadsheet";
import { sheetApi } from "../../lib/spreadsheet";
import "./FindBar.css";

type Props = {
  sheet: number;
  /** Cambia cada vez que el documento cambia, para volver a buscar. */
  version: unknown;
  onGo: (match: FindMatch) => void;
  onReplaceAll: (query: string, replacement: string, options: FindOptions) => Promise<number>;
  onClose: () => void;
};

/** Barra de buscar y reemplazar (⌘F). */
export default function FindBar({ sheet, version, onGo, onReplaceAll, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [showReplace, setShowReplace] = useState(false);
  const [options, setOptions] = useState<FindOptions>({ case: false, whole: false, all: false });
  const [matches, setMatches] = useState<FindMatch[]>([]);
  // -1: todavía no se ha ido a ningún resultado; el primer Enter va al primero.
  const [index, setIndex] = useState(-1);
  const [message, setMessage] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => inputRef.current?.focus(), []);

  // Busca de nuevo al escribir, al cambiar opciones o cuando cambia la hoja.
  useEffect(() => {
    if (!query) {
      setMatches([]);
      setIndex(-1);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      sheetApi
        .find(sheet, query, options)
        .then((found) => {
          if (cancelled) return;
          setMatches(found);
          setIndex((i) => (i < found.length ? i : -1));
        })
        .catch(() => !cancelled && setMatches([]));
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, options, sheet, version]);

  function go(step: number) {
    if (!matches.length) return;
    const next = index === -1 ? (step > 0 ? 0 : matches.length - 1) : (index + step + matches.length) % matches.length;
    setIndex(next);
    onGo(matches[next]);
  }

  async function replaceAll() {
    if (!query) return;
    const count = await onReplaceAll(query, replacement, options);
    setMessage(count === 1 ? "1 celda cambiada" : `${count} celdas cambiadas`);
  }

  function toggle(key: keyof FindOptions) {
    setOptions((o) => ({ ...o, [key]: !o[key] }));
  }

  return (
    <div className="find-bar" role="search" onKeyDown={(e) => e.key === "Escape" && onClose()}>
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
          placeholder="Buscar en la hoja"
          aria-label="Buscar"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(-1);
            setMessage(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              go(e.shiftKey ? -1 : 1);
            }
          }}
        />
        <span className="find-count" aria-live="polite">
          {query
            ? !matches.length
              ? "Sin resultados"
              : index === -1
                ? `${matches.length} ${matches.length === 1 ? "resultado" : "resultados"}`
                : `${index + 1} de ${matches.length}`
            : ""}
        </span>
        <button type="button" className="fb-button" title="Anterior (⇧↩)" aria-label="Anterior" onClick={() => go(-1)}>
          ↑
        </button>
        <button type="button" className="fb-button" title="Siguiente (↩)" aria-label="Siguiente" onClick={() => go(1)}>
          ↓
        </button>
        <label className="find-option">
          <input type="checkbox" checked={options.case} onChange={() => toggle("case")} /> Mayúsculas
        </label>
        <label className="find-option">
          <input type="checkbox" checked={options.whole} onChange={() => toggle("whole")} /> Celda completa
        </label>
        <label className="find-option">
          <input type="checkbox" checked={options.all} onChange={() => toggle("all")} /> Todas las hojas
        </label>
        <button type="button" className="btn btn-icon find-close" aria-label="Cerrar búsqueda" onClick={onClose}>
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
            onKeyDown={(e) => e.key === "Enter" && replaceAll()}
          />
          <button type="button" className="btn" onClick={replaceAll} disabled={!query}>
            Reemplazar todo
          </button>
          {message && <span className="find-count">{message}</span>}
        </div>
      )}
    </div>
  );
}
