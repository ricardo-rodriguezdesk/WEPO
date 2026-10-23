import { useEffect, useState } from "react";
import type { ChartType, ChartView, DrawingPatch } from "../../lib/spreadsheet";
import { columnName } from "../../lib/spreadsheet";

export const CHART_TYPES: { kind: ChartType; label: string; icon: string }[] = [
  { kind: "column", label: "Columnas", icon: "M5 20V11M10 20V6M15 20V13M20 20V8" },
  { kind: "bar", label: "Barras", icon: "M4 5h11M4 10h16M4 15h8M4 20h13" },
  { kind: "line", label: "Líneas", icon: "M3 18l5-7 4 4 8-10" },
  { kind: "area", label: "Áreas", icon: "M3 20V14l5-6 4 4 9-8v16z" },
  { kind: "pie", label: "Pastel", icon: "M12 3a9 9 0 109 9h-9z M13 2v9h9a9 9 0 00-9-9z" },
  { kind: "doughnut", label: "Dona", icon: "M12 3a9 9 0 110 18 9 9 0 010-18zm0 5a4 4 0 100 8 4 4 0 000-8z" },
  { kind: "scatter", label: "Dispersión", icon: "M6 17h.01M9 12h.01M13 15h.01M16 8h.01M19 11h.01M8 7h.01" },
];

export function ChartIcon({ path, size = 18 }: { path: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <path d={path} />
    </svg>
  );
}

/** Rango de datos de una gráfica a partir de sus series (si todas están en la misma hoja). */
function dataRange(chart: ChartView): string {
  const refs = chart.series.flatMap((s) => [s.refs.values, s.refs.categories, s.refs.name_is_ref ? s.refs.name : null]);
  let r1 = Infinity, c1 = Infinity, r2 = -Infinity, c2 = -Infinity;
  for (const ref of refs) {
    if (!ref) continue;
    const range = ref.split("!").pop() ?? "";
    for (const cell of range.split(":")) {
      const m = /^\$?([A-Z]+)\$?(\d+)$/.exec(cell);
      if (!m) continue;
      const col = [...m[1]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
      const row = Number(m[2]) - 1;
      r1 = Math.min(r1, row);
      c1 = Math.min(c1, col);
      r2 = Math.max(r2, row);
      c2 = Math.max(c2, col);
    }
  }
  return Number.isFinite(r1) ? `${columnName(c1)}${r1 + 1}:${columnName(c2)}${r2 + 1}` : "";
}

type Props = {
  chart: ChartView;
  onChange: (patch: DrawingPatch) => void;
  onDelete: () => void;
  onClose: () => void;
};

/** Panel lateral para editar una gráfica: tipo, título, leyenda y datos. */
export default function ChartPanel({ chart, onChange, onDelete, onClose }: Props) {
  const [title, setTitle] = useState(chart.title);
  const [data, setData] = useState(dataRange(chart));

  useEffect(() => {
    setTitle(chart.title);
    setData(dataRange(chart));
  }, [chart.id, chart.title, chart.series]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <aside className="chart-panel" aria-label="Editar gráfica">
      <header>
        <h3>Gráfica</h3>
        <button type="button" className="btn btn-icon" aria-label="Cerrar panel" onClick={onClose}>
          ×
        </button>
      </header>

      <div className="field">
        <span>Tipo</span>
        <div className="chart-types">
          {CHART_TYPES.map((t) => (
            <button
              key={t.kind}
              type="button"
              className={`chart-type${chart.kind === t.kind ? " selected" : ""}`}
              title={t.label}
              aria-pressed={chart.kind === t.kind}
              onClick={() => onChange({ kind: t.kind })}
            >
              <ChartIcon path={t.icon} />
              <small>{t.label}</small>
            </button>
          ))}
        </div>
      </div>

      <label className="field">
        <span>Título</span>
        <input
          className="input"
          value={title}
          placeholder="Sin título"
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => title !== chart.title && onChange({ title })}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
      </label>

      <label className="field">
        <span>Datos</span>
        <input
          className="input"
          value={data}
          placeholder="A1:C7"
          onChange={(e) => setData(e.target.value.toUpperCase())}
          onBlur={() => data && data !== dataRange(chart) && onChange({ data })}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
        <small className="hint">La primera fila con texto da los nombres; la primera columna con texto, las categorías.</small>
      </label>

      <label className="radio">
        <input type="checkbox" checked={chart.legend} onChange={(e) => onChange({ legend: e.target.checked })} /> Mostrar leyenda
      </label>

      <div className="chart-series">
        <span>Series</span>
        {chart.series.map((s, i) => (
          <div key={i} className="chart-series-item">
            <span className="chart-series-color" style={{ background: s.color }} />
            <span>{s.name}</span>
            <small>{s.refs.values.split("!").pop()}</small>
          </div>
        ))}
      </div>

      <button type="button" className="btn chart-delete" onClick={onDelete}>
        Eliminar gráfica
      </button>
    </aside>
  );
}
