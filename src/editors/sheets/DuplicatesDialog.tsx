import { useState } from "react";
import Dialog from "../../components/Dialog";
import type { Range } from "../../lib/spreadsheet";
import { cellName, columnName } from "../../lib/spreadsheet";

type Props = {
  region: Range;
  /** Texto de la primera fila de cada columna. */
  headers: string[];
  initialHeader: boolean;
  onApply: (cols: number[], header: boolean) => void;
  onClose: () => void;
};

/** Quitar filas repetidas: se comparan las columnas marcadas. */
export default function DuplicatesDialog({ region, headers, initialHeader, onApply, onClose }: Props) {
  const columns = Array.from({ length: region.c2 - region.c1 + 1 }, (_, i) => region.c1 + i);
  const [header, setHeader] = useState(initialHeader);
  const [checked, setChecked] = useState(() => new Set(columns));
  const toggle = (c: number) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });

  return (
    <Dialog
      title={`Quitar duplicados en ${cellName({ r: region.r1, c: region.c1 })}:${cellName({ r: region.r2, c: region.c2 })}`}
      onClose={onClose}
      width={420}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button
            className="btn btn-primary"
            disabled={checked.size === 0}
            onClick={() => {
              onApply(columns.filter((c) => checked.has(c)), header);
              onClose();
            }}
          >
            Quitar duplicados
          </button>
        </>
      }
    >
      <p className="hint" style={{ marginTop: 0 }}>Se quita cada fila cuyos valores en las columnas marcadas ya aparecieron más arriba.</p>
      <label className="radio" style={{ marginBottom: 10 }}>
        <input type="checkbox" checked={header} onChange={(e) => setHeader(e.target.checked)} /> La primera fila es de encabezados
      </label>
      <div className="dup-columns">
        {columns.map((c, i) => (
          <label key={c} className="radio">
            <input type="checkbox" checked={checked.has(c)} onChange={() => toggle(c)} />
            {header && headers[i] ? `${headers[i]} (${columnName(c)})` : `Columna ${columnName(c)}`}
          </label>
        ))}
      </div>
    </Dialog>
  );
}
