import { useEffect, useMemo, useRef, useState } from "react";

type Props = {
  x: number;
  y: number;
  column: string;
  /** Valores distintos de la columna, tal como se ven. */
  values: string[];
  /** Valores visibles ahora (null = sin filtro, todos visibles). */
  current: string[] | null;
  onApply: (keep: string[] | null) => void;
  onClose: () => void;
};

const EMPTY = "(vacías)";

/** Lista de valores con casillas para filtrar una columna, como el autofiltro de Excel. */
export default function FilterMenu({ x, y, column, values, current, onApply, onClose }: Props) {
  const [search, setSearch] = useState("");
  const [checked, setChecked] = useState(() => new Set(current ?? values));
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const visible = useMemo(
    () => values.filter((v) => (v || EMPTY).toLowerCase().includes(search.toLowerCase())),
    [values, search],
  );
  const allChecked = visible.every((v) => checked.has(v));

  function toggle(value: string) {
    const next = new Set(checked);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    setChecked(next);
  }

  function toggleAll() {
    const next = new Set(checked);
    for (const v of visible) {
      if (allChecked) next.delete(v);
      else next.add(v);
    }
    setChecked(next);
  }

  function apply() {
    const keep = values.filter((v) => checked.has(v));
    onApply(keep.length === values.length ? null : keep);
    onClose();
  }

  return (
    <div
      className="filter-menu"
      ref={ref}
      role="dialog"
      aria-label={`Filtrar columna ${column}`}
      style={{ left: Math.min(x, window.innerWidth - 250), top: Math.min(y, window.innerHeight - 360) }}
    >
      <p className="filter-title">Filtrar columna {column}</p>
      <input
        className="find-input filter-search"
        placeholder="Buscar valor"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        autoFocus
      />
      <div className="filter-list">
        <label>
          <input type="checkbox" checked={allChecked} onChange={toggleAll} /> <b>Seleccionar todo</b>
        </label>
        {visible.map((value) => (
          <label key={value}>
            <input type="checkbox" checked={checked.has(value)} onChange={() => toggle(value)} />
            {value || <i>{EMPTY}</i>}
          </label>
        ))}
      </div>
      <div className="filter-actions">
        <button
          type="button"
          className="btn"
          onClick={() => {
            onApply(null);
            onClose();
          }}
        >
          Quitar filtro
        </button>
        <button type="button" className="btn btn-primary" onClick={apply} disabled={checked.size === 0}>
          Aplicar
        </button>
      </div>
    </div>
  );
}
