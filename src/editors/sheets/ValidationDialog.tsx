import { useState } from "react";
import Dialog from "../../components/Dialog";
import type { ListSource, Range, ValidationView } from "../../lib/spreadsheet";
import { cellName } from "../../lib/spreadsheet";

type Props = {
  range: Range;
  /** Lista que ya tenía la celda activa, para editarla. */
  current: ValidationView | null;
  onSave: (source: ListSource | null) => Promise<boolean>;
  onClose: () => void;
};

/** Lista desplegable: opciones escritas a mano o tomadas de un rango de celdas. */
export default function ValidationDialog({ range, current, onSave, onClose }: Props) {
  const fromRange = current?.source.startsWith("=") ?? false;
  const [kind, setKind] = useState<"items" | "range">(fromRange ? "range" : "items");
  const [items, setItems] = useState(fromRange ? "" : (current?.source ?? ""));
  const [source, setSource] = useState(fromRange ? current!.source : "");
  const [error, setError] = useState<string | null>(null);

  const rangeLabel =
    range.r1 === range.r2 && range.c1 === range.c2
      ? cellName({ r: range.r1, c: range.c1 })
      : `${cellName({ r: range.r1, c: range.c1 })}:${cellName({ r: range.r2, c: range.c2 })}`;

  async function save() {
    if (kind === "items") {
      const list = items.split(/[,\n]/).map((i) => i.trim()).filter(Boolean);
      if (!list.length) return setError("Escribe al menos una opción");
      if (await onSave({ kind: "items", items: list })) onClose();
    } else {
      if (!/^=?('?[^!]+'?!)?\$?[A-Za-z]{1,3}\$?\d+(:\$?[A-Za-z]{1,3}\$?\d+)?$/.test(source.trim())) {
        return setError("Escribe un rango como =$H$1:$H$5 o =Opciones!$A$1:$A$9");
      }
      if (await onSave({ kind: "range", range: source.trim() })) onClose();
    }
  }

  return (
    <Dialog
      title={`Lista desplegable en ${rangeLabel}`}
      onClose={onClose}
      width={440}
      footer={
        <>
          {current && (
            <button
              className="btn"
              style={{ marginRight: "auto" }}
              onClick={async () => (await onSave(null)) && onClose()}
            >
              Quitar lista
            </button>
          )}
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn btn-primary" onClick={save}>
            Guardar
          </button>
        </>
      }
    >
      <label className="radio">
        <input type="radio" checked={kind === "items"} onChange={() => setKind("items")} /> Escribir las opciones
      </label>
      {kind === "items" && (
        <label className="field" style={{ marginTop: 8 }}>
          <textarea
            className="textarea"
            value={items}
            placeholder={"Pendiente, En proceso, Terminado"}
            onChange={(e) => setItems(e.target.value)}
            autoFocus
          />
          <span className="hint">Sepáralas con comas o una por línea.</span>
        </label>
      )}
      <label className="radio" style={{ marginTop: 8 }}>
        <input type="radio" checked={kind === "range"} onChange={() => setKind("range")} /> Tomarlas de un rango de celdas
      </label>
      {kind === "range" && (
        <label className="field" style={{ marginTop: 8 }}>
          <input className="input" value={source} placeholder="=$H$1:$H$5" onChange={(e) => setSource(e.target.value)} autoFocus />
          <span className="hint">Si cambias esas celdas, la lista se actualiza sola.</span>
        </label>
      )}
      <p className="hint">Al escribir en estas celdas solo se aceptarán valores de la lista.</p>
      {error && <p className="cf-error">{error}</p>}
    </Dialog>
  );
}
