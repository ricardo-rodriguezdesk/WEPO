import { useState } from "react";
import Dialog from "../../components/Dialog";

type Props = {
  /** Rango de los datos propuesto, como "A1:D20". */
  source: string;
  /** Celda propuesta si se pone en esta hoja, como "F1". */
  here: string;
  onCreate: (source: string, at: string | null) => void;
  onClose: () => void;
};

/** «Insertar tabla dinámica», como en Excel: los datos y dónde ponerla. */
export default function PivotDialog({ source, here, onCreate, onClose }: Props) {
  const [range, setRange] = useState(source);
  const [where, setWhere] = useState<"new" | "here">("new");
  const [cell, setCell] = useState(here);
  const ready = /^\$?[A-Z]+\$?\d+:\$?[A-Z]+\$?\d+$/i.test(range.trim()) && (where === "new" || /^\$?[A-Z]+\$?\d+$/i.test(cell.trim()));
  const create = () => {
    if (!ready) return;
    onCreate(range.trim().toUpperCase().replace(/\$/g, ""), where === "new" ? null : cell.trim().toUpperCase().replace(/\$/g, ""));
    onClose();
  };
  return (
    <Dialog
      title="Insertar tabla dinámica"
      onClose={onClose}
      width={440}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn btn-primary" disabled={!ready} onClick={create}>
            Crear
          </button>
        </>
      }
    >
      <form
        className="pivot-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          create();
        }}
      >
        <label className="field">
          <span>Datos (con la fila de encabezados)</span>
          <input className="input" value={range} autoFocus onChange={(e) => setRange(e.target.value)} aria-label="Rango de los datos" />
        </label>
        <span className="field-label">¿Dónde va?</span>
        <label className="radio">
          <input type="radio" name="pivot-where" checked={where === "new"} onChange={() => setWhere("new")} /> En una hoja nueva
        </label>
        <label className="radio">
          <input type="radio" name="pivot-where" checked={where === "here"} onChange={() => setWhere("here")} /> En esta hoja, desde la celda
          <input
            className="input pivot-cell"
            value={cell}
            disabled={where !== "here"}
            onChange={(e) => setCell(e.target.value)}
            aria-label="Celda donde empieza la tabla dinámica"
          />
        </label>
        <p className="hint">Después eliges en el panel de la derecha qué campo va en filas, columnas, valores y filtros.</p>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
