import { useState } from "react";
import Dialog from "../../components/Dialog";
import type { TableStyle, TableView } from "../../lib/spreadsheet";
import { TABLE_COLORS } from "./tables";

type Props = {
  /** Texto del rango, como "A1:D20". */
  rangeLabel: string;
  /** La tabla que se edita (si no, se crea una nueva). */
  table: TableView | null;
  onSave: (style: TableStyle, banded: boolean, totals: boolean) => void;
  onRemove: () => void;
  onClose: () => void;
};

/** Dar formato como tabla: color, filas alternas y fila de totales. */
export default function TableDialog({ rangeLabel, table, onSave, onRemove, onClose }: Props) {
  const [style, setStyle] = useState<TableStyle>(table?.style ?? "azul");
  const [banded, setBanded] = useState(table?.banded ?? true);
  const [totals, setTotals] = useState(table?.totals ?? false);

  return (
    <Dialog
      title={table ? `Tabla ${table.name}` : `Dar formato como tabla (${rangeLabel})`}
      onClose={onClose}
      width={440}
      footer={
        <>
          {table && (
            <button className="btn" style={{ marginRight: "auto" }} onClick={onRemove} title="Los datos se quedan; solo deja de ser tabla">
              Convertir en rango
            </button>
          )}
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button
            className="btn btn-primary"
            onClick={() => {
              onSave(style, banded, totals);
              onClose();
            }}
          >
            {table ? "Aplicar" : "Crear tabla"}
          </button>
        </>
      }
    >
      <div className="field">
        <span>Color</span>
        <div className="table-styles">
          {(Object.keys(TABLE_COLORS) as TableStyle[]).map((key) => {
            const c = TABLE_COLORS[key];
            return (
              <button
                key={key}
                type="button"
                className={`table-style${style === key ? " selected" : ""}`}
                title={c.label}
                aria-label={c.label}
                aria-pressed={style === key}
                onClick={() => setStyle(key)}
              >
                <span style={{ background: c.header }} />
                <span style={{ background: banded ? c.band : "transparent" }} />
                <span />
                <span style={{ background: banded ? c.band : "transparent" }} />
              </button>
            );
          })}
        </div>
      </div>
      <label className="radio">
        <input type="checkbox" checked={banded} onChange={(e) => setBanded(e.target.checked)} /> Filas con bandas
      </label>
      <label className="radio">
        <input type="checkbox" checked={totals} onChange={(e) => setTotals(e.target.checked)} /> Fila de totales
      </label>
      <p className="hint">
        {table
          ? "Usa la flecha de cada encabezado para filtrar u ordenar la tabla."
          : "La primera fila se usa como encabezados. Cada encabezado tendrá su flecha para filtrar."}
      </p>
    </Dialog>
  );
}
