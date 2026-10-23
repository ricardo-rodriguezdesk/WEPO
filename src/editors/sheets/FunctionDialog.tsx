import { useMemo, useState } from "react";
import Dialog from "../../components/Dialog";
import type { FormulaLanguage } from "../../lib/preferences";
import type { FunctionInfo } from "./functions";
import { FUNCTIONS } from "./functions";
import { CATEGORIES, categoryOf } from "./functionCategories";

type Props = {
  language: FormulaLanguage;
  onInsert: (fn: FunctionInfo) => void;
  onClose: () => void;
};

const USED = "usadas";

/** Ventana «Insertar función» (fx): buscar por nombre o descripción, o por categoría. */
export default function FunctionDialog({ language, onInsert, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState(USED);
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = FUNCTIONS.filter((f) => {
      if (q) return f[language].toLowerCase().includes(q) || f.en.toLowerCase().includes(q) || (f.description ?? "").toLowerCase().includes(q);
      // "Más usadas": las que traen explicación en español.
      return category === USED ? Boolean(f.description) : categoryOf(f.en) === category;
    });
    return matches.sort((a, b) => a[language].localeCompare(b[language]));
  }, [query, category, language]);
  const [selected, setSelected] = useState<FunctionInfo | null>(null);
  const current = selected && list.includes(selected) ? selected : list[0] ?? null;

  return (
    <Dialog
      title="Insertar función"
      onClose={onClose}
      width={620}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn btn-primary" disabled={!current} onClick={() => current && onInsert(current)}>
            Insertar
          </button>
        </>
      }
    >
      <div className="fn-dialog">
        <input
          className="input"
          placeholder="Buscar: suma, fecha, buscar, promedio…"
          value={query}
          autoFocus
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && current && onInsert(current)}
        />
        <div className="fn-columns">
          <div className="fn-categories" role="listbox" aria-label="Categorías">
            {[{ id: USED, label: "Más usadas" }, ...CATEGORIES].map((c) => (
              <button
                key={c.id}
                type="button"
                className={!query && category === c.id ? "selected" : ""}
                onClick={() => {
                  setQuery("");
                  setCategory(c.id);
                }}
              >
                {c.label}
              </button>
            ))}
          </div>
          <div className="fn-list" role="listbox" aria-label="Funciones">
            {list.map((f) => (
              <button
                key={f.en}
                type="button"
                role="option"
                aria-selected={current === f}
                className={current === f ? "selected" : ""}
                onClick={() => setSelected(f)}
                onDoubleClick={() => onInsert(f)}
              >
                {f[language]}
              </button>
            ))}
            {!list.length && <p className="hint">No hay funciones con ese nombre.</p>}
          </div>
        </div>
        {current && (
          <div className="fn-detail">
            <b>
              {current[language]}({(current.args ?? []).join("; ")})
            </b>
            <p>{current.description ?? `Función de ${CATEGORIES.find((c) => c.id === categoryOf(current.en))?.label.toLowerCase()}. En inglés: ${current.en}.`}</p>
          </div>
        )}
      </div>
    </Dialog>
  );
}
