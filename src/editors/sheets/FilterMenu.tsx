import { useEffect, useMemo, useRef, useState } from "react";
import type { FilterCondition } from "../../lib/spreadsheet";

/** Filtro de una columna: los valores que se ven, o una condición. */
export type ColumnSpec = { keep?: string[]; condition?: FilterCondition };

type Props = {
  x: number;
  y: number;
  column: string;
  /** Valores distintos de la columna, tal como se ven. */
  values: string[];
  /** Filtro actual de la columna (null = sin filtro). */
  current: ColumnSpec | null;
  onApply: (spec: ColumnSpec | null) => void;
  /** Ordenar la tabla por esta columna (A→Z o Z→A). */
  onSort?: (ascending: boolean) => void;
  onClose: () => void;
};

const EMPTY = "(vacías)";

export const CONDITIONS: { op: string; label: string; numeric?: boolean; two?: boolean }[] = [
  { op: "equals", label: "Es igual a" },
  { op: "not_equals", label: "No es igual a" },
  { op: "contains", label: "Contiene" },
  { op: "not_contains", label: "No contiene" },
  { op: "begins", label: "Empieza con" },
  { op: "ends", label: "Termina con" },
  { op: "greater", label: "Mayor que", numeric: true },
  { op: "greater_or_equal", label: "Mayor o igual que", numeric: true },
  { op: "less", label: "Menor que", numeric: true },
  { op: "less_or_equal", label: "Menor o igual que", numeric: true },
  { op: "between", label: "Entre", numeric: true, two: true },
];

/** "$1,250.50" → 1250.5 (para comparar números tal como se ven en la celda). */
function numberOf(text: string): number | null {
  const clean = text.replace(/[^\d.,-]/g, "").replace(/,(?=\d{3}(\D|$))/g, "");
  const n = Number(clean.replace(",", "."));
  return clean && !Number.isNaN(n) ? n : null;
}

/** La misma regla que aplica Rust (data.rs), para saber qué valores quedan a la vista. */
export function conditionHolds(c: FilterCondition, text: string): boolean {
  const t = text.toLowerCase();
  const v = c.value.trim().toLowerCase();
  const n = numberOf(text);
  const a = numberOf(c.value);
  const b = numberOf(c.value2 ?? "");
  switch (c.op) {
    case "equals":
      return n !== null && a !== null ? n === a : t === v;
    case "not_equals":
      return n !== null && a !== null ? n !== a : t !== v;
    case "contains":
      return t.includes(v);
    case "not_contains":
      return !t.includes(v);
    case "begins":
      return t.startsWith(v);
    case "ends":
      return t.endsWith(v);
    case "greater":
      return n !== null && a !== null && n > a;
    case "greater_or_equal":
      return n !== null && a !== null && n >= a;
    case "less":
      return n !== null && a !== null && n < a;
    case "less_or_equal":
      return n !== null && a !== null && n <= a;
    case "between":
      return n !== null && a !== null && b !== null && n >= Math.min(a, b) && n <= Math.max(a, b);
    default:
      return true;
  }
}

/** Filtro de una columna, como el autofiltro de Excel: por valores o por condición. */
export default function FilterMenu({ x, y, column, values, current, onApply, onSort, onClose }: Props) {
  const [mode, setMode] = useState<"values" | "condition">(current?.condition ? "condition" : "values");
  const [search, setSearch] = useState("");
  const [checked, setChecked] = useState(() => new Set(current?.keep ?? values));
  const [op, setOp] = useState(current?.condition?.op ?? "contains");
  const [value, setValue] = useState(current?.condition?.value ?? "");
  const [value2, setValue2] = useState(current?.condition?.value2 ?? "");
  const ref = useRef<HTMLDivElement>(null);
  const condition = CONDITIONS.find((c) => c.op === op) ?? CONDITIONS[2];

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

  function toggle(v: string) {
    const next = new Set(checked);
    if (next.has(v)) next.delete(v);
    else next.add(v);
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
    if (mode === "condition") {
      if (!value.trim()) return;
      onApply({ condition: { op, value, value2: condition.two ? value2 : null } });
    } else {
      const keep = values.filter((v) => checked.has(v));
      onApply(keep.length === values.length ? null : { keep });
    }
    onClose();
  }

  return (
    <div
      className="filter-menu"
      ref={ref}
      role="dialog"
      aria-label={`Filtrar columna ${column}`}
      style={{ left: Math.min(x, window.innerWidth - 260), top: Math.min(y, window.innerHeight - 420) }}
    >
      <p className="filter-title">Filtrar columna {column}</p>
      {onSort && (
        <div className="filter-sort">
          <button type="button" className="btn" onClick={() => (onSort(true), onClose())}>
            A → Z
          </button>
          <button type="button" className="btn" onClick={() => (onSort(false), onClose())}>
            Z → A
          </button>
        </div>
      )}
      <div className="filter-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={mode === "values"} className={mode === "values" ? "active" : ""} onClick={() => setMode("values")}>
          Por valores
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "condition"}
          className={mode === "condition" ? "active" : ""}
          onClick={() => setMode("condition")}
        >
          Por condición
        </button>
      </div>
      {mode === "values" ? (
        <>
          <input className="find-input filter-search" placeholder="Buscar valor" value={search} onChange={(e) => setSearch(e.target.value)} autoFocus />
          <div className="filter-list">
            <label>
              <input type="checkbox" checked={allChecked} onChange={toggleAll} /> <b>Seleccionar todo</b>
            </label>
            {visible.map((v) => (
              <label key={v}>
                <input type="checkbox" checked={checked.has(v)} onChange={() => toggle(v)} />
                {v || <i>{EMPTY}</i>}
              </label>
            ))}
          </div>
        </>
      ) : (
        <div className="filter-condition" onKeyDown={(e) => e.key === "Enter" && apply()}>
          <select className="find-input" value={op} onChange={(e) => setOp(e.target.value)} aria-label="Condición">
            {CONDITIONS.map((c) => (
              <option key={c.op} value={c.op}>
                {c.label}
              </option>
            ))}
          </select>
          <input className="find-input" value={value} onChange={(e) => setValue(e.target.value)} placeholder={condition.numeric ? "Número" : "Texto"} aria-label="Valor" autoFocus />
          {condition.two && (
            <input className="find-input" value={value2} onChange={(e) => setValue2(e.target.value)} placeholder="y…" aria-label="Segundo valor" />
          )}
        </div>
      )}
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
        <button type="button" className="btn btn-primary" onClick={apply} disabled={mode === "values" ? checked.size === 0 : !value.trim()}>
          Aplicar
        </button>
      </div>
    </div>
  );
}
