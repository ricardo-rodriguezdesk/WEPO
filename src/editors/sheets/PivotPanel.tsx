// Panel «Campos de tabla dinámica», como el de Excel: arriba la lista de campos
// (marcarlos los acomoda solos) y abajo las cuatro áreas —Filtros, Columnas,
// Filas y Valores— entre las que se arrastran.

import { useEffect, useRef, useState } from "react";
import type { PivotFunc, PivotLayout, PivotView } from "../../lib/spreadsheet";

type Area = "filters" | "cols" | "rows" | "values";

const AREAS: { id: Area; label: string; hint: string }[] = [
  { id: "filters", label: "Filtros", hint: "Arriba de la tabla, para elegir qué se toma en cuenta" },
  { id: "cols", label: "Columnas", hint: "Un valor distinto por columna" },
  { id: "rows", label: "Filas", hint: "Un valor distinto por fila" },
  { id: "values", label: "Valores", hint: "Lo que se suma, cuenta o promedia" },
];

export const PIVOT_FUNCS: { id: PivotFunc; label: string }[] = [
  { id: "sum", label: "Suma" },
  { id: "count", label: "Cuenta" },
  { id: "average", label: "Promedio" },
  { id: "max", label: "Máx." },
  { id: "min", label: "Mín." },
];

/** Lo que se arrastra: un campo desde la lista, o una ficha desde un área (con su posición). */
type Drag = { field: number; from: Area | null; index: number };

type Props = {
  pivot: PivotView;
  onChange: (layout: PivotLayout) => void;
  onRefresh: () => void;
  onDelete: () => void;
  onClose: () => void;
};

function used(layout: PivotLayout, field: number) {
  return layout.rows.includes(field) || layout.cols.includes(field) || layout.values.some((v) => v.field === field) || layout.filters.some((f) => f.field === field);
}

/** Saca la ficha `index` del área `area`. */
function removeAt(layout: PivotLayout, area: Area, index: number): PivotLayout {
  const next: PivotLayout = { rows: [...layout.rows], cols: [...layout.cols], values: [...layout.values], filters: [...layout.filters] };
  next[area].splice(index, 1);
  return next;
}

/** Pone el campo en el área, en la posición `at` (al final si no se dice). Un campo va en una sola de
 *  Filtros, Columnas o Filas; en Valores puede repetirse (por ejemplo, suma y promedio del mismo campo). */
function insert(layout: PivotLayout, area: Area, field: number, at?: number): PivotLayout {
  const next: PivotLayout = { rows: [...layout.rows], cols: [...layout.cols], values: [...layout.values], filters: [...layout.filters] };
  if (area !== "values") {
    next.rows = next.rows.filter((f) => f !== field);
    next.cols = next.cols.filter((f) => f !== field);
    next.filters = next.filters.filter((f) => f.field !== field);
  }
  const pos = (len: number) => Math.max(0, Math.min(at ?? len, len));
  if (area === "rows") next.rows.splice(pos(next.rows.length), 0, field);
  if (area === "cols") next.cols.splice(pos(next.cols.length), 0, field);
  if (area === "filters") next.filters.splice(pos(next.filters.length), 0, { field, hidden: [] });
  if (area === "values") next.values.splice(pos(next.values.length), 0, { field, func: "sum" });
  return next;
}

export default function PivotPanel({ pivot, onChange, onRefresh, onDelete, onClose }: Props) {
  const { layout, fields } = pivot;
  const [drag, setDrag] = useState<Drag | null>(null);
  const [over, setOver] = useState<Area | null>(null);
  const [filterOpen, setFilterOpen] = useState<number | null>(null);
  const [search, setSearch] = useState("");

  const chips = (area: Area): { field: number; func?: PivotFunc }[] =>
    area === "values" ? layout.values : area === "filters" ? layout.filters.map((f) => ({ field: f.field })) : layout[area].map((field) => ({ field }));

  function toggle(field: number, on: boolean) {
    if (on) onChange(insert(layout, pivot.numeric[field] ? "values" : "rows", field));
    else
      onChange({
        rows: layout.rows.filter((f) => f !== field),
        cols: layout.cols.filter((f) => f !== field),
        values: layout.values.filter((v) => v.field !== field),
        filters: layout.filters.filter((f) => f.field !== field),
      });
  }

  function drop(area: Area | null, at?: number) {
    const d = drag;
    setDrag(null);
    setOver(null);
    if (!d) return;
    // Soltar fuera de las áreas (en la lista de campos) quita la ficha.
    if (area === null) {
      if (d.from) onChange(removeAt(layout, d.from, d.index));
      return;
    }
    // Al mover dentro de la misma área, la posición se cuenta sin la ficha que se movió.
    const index = d.from === area && at !== undefined && at > d.index ? at - 1 : at;
    if (d.from === "values" && area === "values") {
      // Dentro de Valores se conserva la función (suma, promedio…).
      const values = [...layout.values];
      const [item] = values.splice(d.index, 1);
      values.splice(index ?? values.length, 0, item);
      return onChange({ ...layout, values });
    }
    onChange(insert(d.from ? removeAt(layout, d.from, d.index) : layout, area, d.field, index));
  }

  const startDrag = (e: React.DragEvent, value: Drag) => {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", fields[value.field] ?? "");
    setDrag(value);
  };

  return (
    <aside className="pivot-panel" aria-label="Campos de tabla dinámica">
      <header>
        <h3>Campos de tabla dinámica</h3>
        <button type="button" className="btn btn-icon" aria-label="Cerrar panel" onClick={onClose}>
          ×
        </button>
      </header>
      <p className="hint pivot-source">
        {pivot.name} · datos de <strong>{pivot.source}</strong>
      </p>

      <div
        className="pivot-fields"
        aria-label="Campos"
        onDragOver={(e) => drag?.from && e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          drop(null);
        }}
      >
        {fields.map((name, i) => (
          <label key={i} className="pivot-field" draggable onDragStart={(e) => startDrag(e, { field: i, from: null, index: -1 })} onDragEnd={() => setDrag(null)}>
            <input type="checkbox" checked={used(layout, i)} onChange={(e) => toggle(i, e.target.checked)} />
            <span>{name}</span>
            {pivot.numeric[i] && <small aria-hidden="true">123</small>}
          </label>
        ))}
      </div>
      <p className="hint">Marca un campo o arrástralo a un área. Para quitarlo, desmárcalo o arrástralo de vuelta a la lista.</p>

      <div className="pivot-areas">
        {AREAS.map((area) => (
          <section
            key={area.id}
            className={`pivot-area${over === area.id ? " over" : ""}`}
            aria-label={area.label}
            title={area.hint}
            data-area={area.id}
            onDragOver={(e) => {
              if (!drag) return;
              e.preventDefault();
              setOver(area.id);
            }}
            onDragLeave={() => setOver((o) => (o === area.id ? null : o))}
            onDrop={(e) => {
              e.preventDefault();
              drop(area.id);
            }}
          >
            <h4>{area.label}</h4>
            {chips(area.id).map((chip, index) => (
              <div
                key={`${chip.field}-${index}`}
                className="pivot-chip"
                draggable
                data-field={fields[chip.field]}
                onDragStart={(e) => startDrag(e, { field: chip.field, from: area.id, index })}
                onDragEnd={() => setDrag(null)}
                onDragOver={(e) => drag && e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  drop(area.id, index);
                }}
              >
                <span className="pivot-chip-name">{fields[chip.field]}</span>
                {area.id === "values" && (
                  <select
                    aria-label={`Resumir ${fields[chip.field]} por`}
                    value={chip.func}
                    onChange={(e) => onChange({ ...layout, values: layout.values.map((v, k) => (k === index ? { ...v, func: e.target.value as PivotFunc } : v)) })}
                  >
                    {PIVOT_FUNCS.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                )}
                {area.id === "filters" && (
                  <button
                    type="button"
                    className={`pivot-filter-btn${layout.filters[index]?.hidden.length ? " on" : ""}`}
                    aria-label={`Filtrar ${fields[chip.field]}`}
                    title="Elegir qué se toma en cuenta"
                    onClick={() => {
                      setSearch("");
                      setFilterOpen(filterOpen === index ? null : index);
                    }}
                  >
                    ▾
                  </button>
                )}
                <button type="button" className="pivot-chip-remove" aria-label={`Quitar ${fields[chip.field]} de ${area.label}`} onClick={() => onChange(removeAt(layout, area.id, index))}>
                  ×
                </button>
                {area.id === "filters" && filterOpen === index && (
                  <FilterItems
                    items={pivot.items.find(([f]) => f === chip.field)?.[1] ?? []}
                    hidden={layout.filters[index]?.hidden ?? []}
                    search={search}
                    onSearch={setSearch}
                    onApply={(hidden) => {
                      setFilterOpen(null);
                      onChange({ ...layout, filters: layout.filters.map((f, k) => (k === index ? { ...f, hidden } : f)) });
                    }}
                    onClose={() => setFilterOpen(null)}
                  />
                )}
              </div>
            ))}
          </section>
        ))}
      </div>

      <div className="pivot-actions">
        <button type="button" className="btn" onClick={onRefresh} title="Vuelve a leer los datos (por si cambiaron)">
          Actualizar
        </button>
        <button type="button" className="btn pivot-delete" onClick={onDelete}>
          Eliminar tabla dinámica
        </button>
      </div>
    </aside>
  );
}

/** Lista con casillas de los elementos de un filtro. */
function FilterItems({
  items,
  hidden,
  search,
  onSearch,
  onApply,
  onClose,
}: {
  items: string[];
  hidden: string[];
  search: string;
  onSearch: (text: string) => void;
  onApply: (hidden: string[]) => void;
  onClose: () => void;
}) {
  const [off, setOff] = useState<Set<string>>(() => new Set(hidden));
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("pointerdown", close, true);
    return () => window.removeEventListener("pointerdown", close, true);
  }, [onClose]);
  const shown = items.filter((i) => i.toLowerCase().includes(search.toLowerCase()));
  const allOn = items.every((i) => !off.has(i));
  return (
    <div className="pivot-filter-menu" ref={ref} role="dialog" aria-label="Elementos del filtro" onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <input className="input" placeholder="Buscar" value={search} autoFocus onChange={(e) => onSearch(e.target.value)} aria-label="Buscar elementos" />
      <div className="pivot-filter-list">
        <label className="radio">
          <input type="checkbox" checked={allOn} onChange={(e) => setOff(e.target.checked ? new Set() : new Set(items))} /> (Todos)
        </label>
        {shown.map((item) => (
          <label key={item} className="radio">
            <input
              type="checkbox"
              checked={!off.has(item)}
              onChange={(e) => {
                const next = new Set(off);
                if (e.target.checked) next.delete(item);
                else next.add(item);
                setOff(next);
              }}
            />{" "}
            {item}
          </label>
        ))}
      </div>
      <div className="pivot-filter-buttons">
        <button type="button" className="btn" onClick={onClose}>
          Cancelar
        </button>
        <button type="button" className="btn btn-primary" disabled={items.length > 0 && off.size >= items.length} onClick={() => onApply(items.filter((i) => off.has(i)))}>
          Aceptar
        </button>
      </div>
    </div>
  );
}
