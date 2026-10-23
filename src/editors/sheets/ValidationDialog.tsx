import { useState } from "react";
import Dialog from "../../components/Dialog";
import type { CompareOp, ListSource, Range, ValidationView } from "../../lib/spreadsheet";
import { cellName } from "../../lib/spreadsheet";

type Props = {
  range: Range;
  /** Validación que ya tenía la celda activa, para editarla. */
  current: ValidationView | null;
  onSave: (source: ListSource | null, message: string) => Promise<boolean>;
  onClose: () => void;
};

type Kind = "items" | "range" | "whole" | "decimal" | "date";

export const COMPARE_OPS: { op: CompareOp; label: string }[] = [
  { op: "between", label: "entre" },
  { op: "not_between", label: "fuera de" },
  { op: "equal", label: "igual a" },
  { op: "not_equal", label: "distinto de" },
  { op: "greater", label: "mayor que" },
  { op: "less", label: "menor que" },
  { op: "greater_or_equal", label: "mayor o igual a" },
  { op: "less_or_equal", label: "menor o igual a" },
];

function initial(current: ValidationView | null) {
  const spec = current?.spec;
  const base = { kind: "items" as Kind, items: "", range: "", op: "between" as CompareOp, a: "", b: "" };
  if (!spec) return base;
  switch (spec.kind) {
    case "items":
      return { ...base, items: spec.items.join(", ") };
    case "range":
      return { ...base, kind: "range" as Kind, range: `=${spec.range}` };
    case "number":
      return { ...base, kind: (spec.integer ? "whole" : "decimal") as Kind, op: spec.op, a: String(spec.a), b: spec.b === null ? "" : String(spec.b) };
    case "date":
      return { ...base, kind: "date" as Kind, op: spec.op, a: spec.a, b: spec.b ?? "" };
  }
}

/** Validación de datos: una lista desplegable, o solo números o fechas que cumplan una condición. */
export default function ValidationDialog({ range, current, onSave, onClose }: Props) {
  const start = initial(current);
  const [kind, setKind] = useState<Kind>(start.kind);
  const [items, setItems] = useState(start.items);
  const [source, setSource] = useState(start.range);
  const [op, setOp] = useState<CompareOp>(start.op);
  const [a, setA] = useState(start.a);
  const [b, setB] = useState(start.b);
  const [message, setMessage] = useState(current?.message ?? "");
  const [error, setError] = useState<string | null>(null);
  const twoValues = op === "between" || op === "not_between";

  const rangeLabel =
    range.r1 === range.r2 && range.c1 === range.c2
      ? cellName({ r: range.r1, c: range.c1 })
      : `${cellName({ r: range.r1, c: range.c1 })}:${cellName({ r: range.r2, c: range.c2 })}`;

  async function save() {
    let rule: ListSource;
    if (kind === "items") {
      const list = items.split(/[,\n]/).map((i) => i.trim()).filter(Boolean);
      if (!list.length) return setError("Escribe al menos una opción");
      rule = { kind: "items", items: list };
    } else if (kind === "range") {
      if (!/^=?('?[^!]+'?!)?\$?[A-Za-z]{1,3}\$?\d+(:\$?[A-Za-z]{1,3}\$?\d+)?$/.test(source.trim())) {
        return setError("Escribe un rango como =$H$1:$H$5 o =Opciones!$A$1:$A$9");
      }
      rule = { kind: "range", range: source.trim() };
    } else if (kind === "date") {
      const isDate = (v: string) => /^\d{4}-\d{1,2}-\d{1,2}$/.test(v.trim());
      if (!isDate(a) || (twoValues && !isDate(b))) return setError("Escribe las fechas como 2026-01-31");
      rule = { kind: "date", op, a: a.trim(), b: twoValues ? b.trim() : null };
    } else {
      const num = (v: string) => Number(v.trim().replace(",", "."));
      if (!a.trim() || Number.isNaN(num(a)) || (twoValues && (!b.trim() || Number.isNaN(num(b))))) {
        return setError("Escribe los números límite");
      }
      rule = { kind: "number", integer: kind === "whole", op, a: num(a), b: twoValues ? num(b) : null };
    }
    if (await onSave(rule, message)) onClose();
  }

  const placeholder = kind === "date" ? "2026-01-31" : "0";

  return (
    <Dialog
      title={`Validación de datos en ${rangeLabel}`}
      onClose={onClose}
      width={460}
      footer={
        <>
          {current && (
            <button className="btn" style={{ marginRight: "auto" }} onClick={async () => (await onSave(null, "")) && onClose()}>
              Quitar validación
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
      <label className="field">
        <span>Permitir</span>
        <select
          className="input"
          value={kind}
          onChange={(e) => {
            setKind(e.target.value as Kind);
            setError(null);
          }}
        >
          <option value="items">Lista escrita (desplegable)</option>
          <option value="range">Lista de un rango de celdas (desplegable)</option>
          <option value="whole">Números enteros</option>
          <option value="decimal">Números con decimales</option>
          <option value="date">Fechas</option>
        </select>
      </label>

      {kind === "items" && (
        <label className="field">
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
      {kind === "range" && (
        <label className="field">
          <input className="input" value={source} placeholder="=$H$1:$H$5" onChange={(e) => setSource(e.target.value)} autoFocus />
          <span className="hint">Si cambias esas celdas, la lista se actualiza sola.</span>
        </label>
      )}
      {(kind === "whole" || kind === "decimal" || kind === "date") && (
        <div className="field-row" style={{ marginBottom: 12 }}>
          <select className="input" value={op} onChange={(e) => setOp(e.target.value as CompareOp)} aria-label="Condición">
            {COMPARE_OPS.map((o) => (
              <option key={o.op} value={o.op}>
                {o.label}
              </option>
            ))}
          </select>
          <input className="input" style={{ width: 120 }} value={a} placeholder={placeholder} onChange={(e) => setA(e.target.value)} aria-label="Valor" autoFocus />
          {twoValues && (
            <>
              <span>y</span>
              <input className="input" style={{ width: 120 }} value={b} placeholder={placeholder} onChange={(e) => setB(e.target.value)} aria-label="Segundo valor" />
            </>
          )}
        </div>
      )}

      <label className="field">
        <span>Mensaje si el valor no es válido (opcional)</span>
        <input className="input" value={message} placeholder="Por ejemplo: escribe una cantidad del 1 al 100" onChange={(e) => setMessage(e.target.value)} />
      </label>
      {error && <p className="cf-error">{error}</p>}
    </Dialog>
  );
}
