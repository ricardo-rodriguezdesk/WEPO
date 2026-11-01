import { useState } from "react";
import Dialog from "../../components/Dialog";
import type { SparkAction, SparklineView } from "../../lib/spreadsheet";
import { parseRange } from "./printLayout";
import SparklineSvg from "./SparklineSvg";

const KINDS: { id: SparklineView["kind"]; name: string }[] = [
  { id: "line", name: "Línea" },
  { id: "column", name: "Columnas" },
  { id: "winloss", name: "Ganancia y pérdida" },
];
const COLORS = ["#376092", "#1F8A55", "#D9572B", "#8E44AD", "#C42B45", "#1D1D1F"];
const SAMPLE = [3, 5, 2, 6, 4, -1, 7, 5];

type Props = {
  /** Con uno ya puesto en la celda: se cambia (o se quita) en vez de crear otro. */
  existing: SparklineView | null;
  initialData: string;
  initialLocation: string;
  onApply: (action: SparkAction) => void;
  onClose: () => void;
};

/** Minigráficos: una gráfica chiquita en cada celda, con los datos de su fila (o columna). */
export default function SparklineDialog({ existing, initialData, initialLocation, onApply, onClose }: Props) {
  const [kind, setKind] = useState<SparklineView["kind"]>(existing?.kind ?? "line");
  const [color, setColor] = useState(existing?.color ?? COLORS[0]);
  const [markers, setMarkers] = useState(existing?.markers ?? false);
  const [data, setData] = useState(initialData);
  const [location, setLocation] = useState(initialLocation);
  const loc = parseRange(location);
  const src = parseRange(data.replace(/^.*!/, ""));
  const ready = Boolean(loc) && (existing || Boolean(src));
  const rect = loc ? { row1: loc.r1 + 1, col1: loc.c1 + 1, row2: loc.r2 + 1, col2: loc.c2 + 1 } : null;
  const apply = () => {
    if (!rect) return;
    if (existing) onApply({ action: "update", ...rect, kind, color, markers });
    else onApply({ action: "add", data: data.trim(), ...rect, kind, color, markers });
  };
  const sample: SparklineView = { row: 1, col: 1, kind, color, markers, values: kind === "winloss" ? SAMPLE : SAMPLE.map((v) => Math.abs(v)), source: "" };
  return (
    <Dialog
      title={existing ? "Minigráficos" : "Insertar minigráficos"}
      onClose={onClose}
      width={440}
      footer={
        <>
          {existing && rect && (
            <button className="btn" style={{ marginRight: "auto" }} onClick={() => onApply({ action: "remove", ...rect })}>
              Quitar
            </button>
          )}
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn btn-primary" disabled={!ready} onClick={apply}>
            {existing ? "Aplicar" : "Insertar"}
          </button>
        </>
      }
    >
      <form
        className="spark-form"
        onSubmit={(e) => {
          e.preventDefault();
          apply();
        }}
      >
        <div className="spark-kinds" role="radiogroup" aria-label="Tipo de minigráfico">
          {KINDS.map((k) => (
            <button key={k.id} type="button" role="radio" aria-checked={kind === k.id} className={kind === k.id ? "on" : ""} onClick={() => setKind(k.id)}>
              <SparklineSvg spark={{ ...sample, kind: k.id, values: k.id === "winloss" ? SAMPLE : SAMPLE.map((v) => Math.abs(v)) }} width={84} height={30} />
              <span>{k.name}</span>
            </button>
          ))}
        </div>
        {!existing && (
          <label className="field">
            Datos
            <input className="input" value={data} placeholder="Por ejemplo: B2:M4" aria-label="Rango de datos" onChange={(e) => setData(e.target.value)} autoFocus />
          </label>
        )}
        <label className="field">
          {existing ? "Celdas" : "Dónde ponerlos (una celda por fila de datos)"}
          <input className="input" value={location} placeholder="Por ejemplo: N2:N4" aria-label="Ubicación" onChange={(e) => setLocation(e.target.value)} />
        </label>
        <div className="field">
          <span>Color</span>
          <div className="spark-colors" role="radiogroup" aria-label="Color del minigráfico">
            {COLORS.map((c) => (
              <button key={c} type="button" role="radio" aria-checked={color === c} aria-label={c} className={color === c ? "on" : ""} style={{ background: c }} onClick={() => setColor(c)} />
            ))}
          </div>
        </div>
        <label className="radio">
          <input type="checkbox" checked={markers} onChange={(e) => setMarkers(e.target.checked)} /> {kind === "line" ? "Marcar los puntos (el más alto en verde, el más bajo en rojo)" : "Marcar el más alto"}
        </label>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
