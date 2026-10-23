import { useState } from "react";
import Dialog from "../../components/Dialog";
import type { Range } from "../../lib/spreadsheet";
import { cellName, columnName } from "../../lib/spreadsheet";

export type SortLevel = { col: number; ascending: boolean };

type Props = {
  region: Range;
  /** Nombre de cada columna según la primera fila (si es encabezado). */
  headers: string[];
  initialHeader: boolean;
  onSort: (levels: SortLevel[], header: boolean) => void;
  onClose: () => void;
};

/** Ordenar por varias columnas: primero por una, y en empate por la siguiente. */
export default function SortDialog({ region, headers, initialHeader, onSort, onClose }: Props) {
  const [header, setHeader] = useState(initialHeader);
  const [levels, setLevels] = useState<SortLevel[]>([{ col: region.c1, ascending: true }]);
  const columns = Array.from({ length: region.c2 - region.c1 + 1 }, (_, i) => region.c1 + i);
  const label = (c: number) => {
    const name = headers[c - region.c1];
    return header && name ? `${name} (${columnName(c)})` : `Columna ${columnName(c)}`;
  };
  const update = (i: number, patch: Partial<SortLevel>) => setLevels((all) => all.map((l, k) => (k === i ? { ...l, ...patch } : l)));
  const unused = columns.find((c) => !levels.some((l) => l.col === c));

  return (
    <Dialog
      title={`Ordenar ${cellName({ r: region.r1, c: region.c1 })}:${cellName({ r: region.r2, c: region.c2 })}`}
      onClose={onClose}
      width={500}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button
            className="btn btn-primary"
            onClick={() => {
              onSort(levels, header);
              onClose();
            }}
          >
            Ordenar
          </button>
        </>
      }
    >
      <div className="sort-levels">
        {levels.map((level, i) => (
          <div key={i} className="sort-level">
            <span className="sort-level-label">{i === 0 ? "Ordenar por" : "Luego por"}</span>
            <select className="input" value={level.col} onChange={(e) => update(i, { col: Number(e.target.value) })} aria-label={`Columna del nivel ${i + 1}`}>
              {columns.map((c) => (
                <option key={c} value={c}>
                  {label(c)}
                </option>
              ))}
            </select>
            <select
              className="input"
              value={level.ascending ? "asc" : "desc"}
              onChange={(e) => update(i, { ascending: e.target.value === "asc" })}
              aria-label={`Sentido del nivel ${i + 1}`}
            >
              <option value="asc">A → Z (menor a mayor)</option>
              <option value="desc">Z → A (mayor a menor)</option>
            </select>
            <button
              type="button"
              className="btn btn-icon"
              aria-label={`Quitar nivel ${i + 1}`}
              disabled={levels.length === 1}
              onClick={() => setLevels((all) => all.filter((_, k) => k !== i))}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <div className="sort-footer">
        <button
          type="button"
          className="btn"
          disabled={unused === undefined}
          onClick={() => unused !== undefined && setLevels((all) => [...all, { col: unused, ascending: true }])}
        >
          + Agregar nivel
        </button>
        <label className="radio">
          <input type="checkbox" checked={header} onChange={(e) => setHeader(e.target.checked)} /> La primera fila es de encabezados
        </label>
      </div>
    </Dialog>
  );
}
