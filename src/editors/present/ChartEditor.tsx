// Panel de una gráfica de WEPO Present: tipo, título, leyenda y la tabla de
// datos (categorías hacia abajo, series hacia la derecha, como en PowerPoint).

import type { ChartElement, ChartKind, Theme } from "./model";
import { CHART_KINDS, seriesColor } from "./charts";

type Props = {
  chart: ChartElement;
  theme: Theme;
  onChange: (next: ChartElement) => void;
  onClose: () => void;
};

const numberText = (v: number | null) => (v === null ? "" : String(v));

/** "1,234.5", "12.5", "12,5", "$1,200" → número (o null si está vacío o no es número). */
function parseNumber(text: string): number | null {
  let t = text.trim().replace(/\s|%|\$/g, "");
  if (!t) return null;
  if (/,\d{1,2}$/.test(t) && !/\.\d{1,2}$/.test(t)) t = t.replace(/\./g, "").replace(",", ".");
  else t = t.replace(/,/g, "");
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export default function ChartEditor({ chart, theme, onChange, onClose }: Props) {
  const pie = chart.chartType === "pie" || chart.chartType === "doughnut";
  const set = (patch: Partial<ChartElement>) => onChange({ ...chart, ...patch });
  // Cada vez que los datos cambian desde fuera (deshacer), las casillas se vuelven a llenar.
  const dataKey = JSON.stringify([chart.categories, chart.series.map((s) => [s.name, s.values])]);

  /** Las casillas se guardan al salir de ellas o con ↩ (así deshacer va casilla por casilla). */
  const field = (value: string, save: (text: string) => void, label: string, numeric = false) => (
    <input
      className={`input chart-cell${numeric ? " num" : ""}`}
      defaultValue={value}
      aria-label={label}
      onBlur={(e) => e.target.value !== value && save(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          (e.target as HTMLInputElement).value = value;
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );

  function addCategory() {
    set({ categories: [...chart.categories, `Categoría ${chart.categories.length + 1}`], series: chart.series.map((s) => ({ ...s, values: [...s.values, null] })) });
  }
  function removeCategory(i: number) {
    if (chart.categories.length <= 1) return;
    set({ categories: chart.categories.filter((_, k) => k !== i), series: chart.series.map((s) => ({ ...s, values: s.values.filter((_, k) => k !== i) })) });
  }
  function addSeries() {
    const n = chart.series.length;
    set({ series: [...chart.series, { name: `Serie ${n + 1}`, values: chart.categories.map(() => null), color: seriesColor(theme, n) }] });
  }
  function removeSeries(i: number) {
    if (chart.series.length <= 1) return;
    set({ series: chart.series.filter((_, k) => k !== i) });
  }

  return (
    <aside className="present-chart-panel" aria-label="Gráfica" onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <header>
        <h3>Gráfica</h3>
        <button type="button" className="btn btn-icon" aria-label="Cerrar el panel de la gráfica" onClick={onClose}>
          ×
        </button>
      </header>
      <div className="chart-kinds" role="radiogroup" aria-label="Tipo de gráfica">
        {CHART_KINDS.map((k) => (
          <button
            key={k.id}
            type="button"
            role="radio"
            aria-checked={chart.chartType === k.id}
            className={chart.chartType === k.id ? "on" : ""}
            onClick={() => set({ chartType: k.id as ChartKind, stacked: k.id === "pie" || k.id === "doughnut" ? false : chart.stacked })}
          >
            {k.name}
          </button>
        ))}
      </div>
      <label className="field">
        Título
        <input
          key={`t-${chart.title}`}
          className="input"
          defaultValue={chart.title}
          placeholder="Sin título"
          aria-label="Título de la gráfica"
          onBlur={(e) => e.target.value !== chart.title && set({ title: e.target.value })}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
      </label>
      <div className="chart-options">
        <label className="radio">
          <input type="checkbox" checked={chart.legend} onChange={(e) => set({ legend: e.target.checked })} /> Leyenda
        </label>
        <label className="radio">
          <input type="checkbox" checked={chart.labels} onChange={(e) => set({ labels: e.target.checked })} /> Valores
        </label>
        {!pie && (
          <label className="radio">
            <input type="checkbox" checked={chart.stacked} onChange={(e) => set({ stacked: e.target.checked })} /> Apiladas
          </label>
        )}
      </div>

      <p className="present-menu-title">Datos{pie ? " (el pastel usa la primera serie)" : ""}</p>
      <div className="chart-data" key={dataKey}>
        <table>
          <thead>
            <tr>
              <th />
              {chart.series.map((s, i) => (
                <th key={i} className={pie && i > 0 ? "unused" : ""}>
                  <div className="chart-series-head">
                    {!pie && (
                      <input
                        type="color"
                        value={s.color}
                        aria-label={`Color de ${s.name}`}
                        onChange={(e) => set({ series: chart.series.map((x, k) => (k === i ? { ...x, color: e.target.value } : x)) })}
                      />
                    )}
                    {field(s.name, (t) => set({ series: chart.series.map((x, k) => (k === i ? { ...x, name: t } : x)) }), `Nombre de la serie ${i + 1}`)}
                    <button type="button" className="chart-remove" title="Quitar esta serie" aria-label={`Quitar la serie ${i + 1}`} disabled={chart.series.length <= 1} onClick={() => removeSeries(i)}>
                      ×
                    </button>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {chart.categories.map((cat, r) => (
              <tr key={r}>
                <th>
                  <div className="chart-series-head">
                    {field(cat, (t) => set({ categories: chart.categories.map((x, k) => (k === r ? t : x)) }), `Categoría ${r + 1}`)}
                    <button type="button" className="chart-remove" title="Quitar esta fila" aria-label={`Quitar la categoría ${r + 1}`} disabled={chart.categories.length <= 1} onClick={() => removeCategory(r)}>
                      ×
                    </button>
                  </div>
                </th>
                {chart.series.map((s, i) => (
                  <td key={i} className={pie && i > 0 ? "unused" : ""}>
                    {field(
                      numberText(s.values[r] ?? null),
                      (t) => set({ series: chart.series.map((x, k) => (k === i ? { ...x, values: x.values.map((v, j) => (j === r ? parseNumber(t) : v)) } : x)) }),
                      `${s.name}, ${cat}`,
                      true,
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="chart-add">
        <button type="button" className="btn" onClick={addCategory}>
          + Fila
        </button>
        <button type="button" className="btn" onClick={addSeries}>
          + Serie
        </button>
      </div>
      <p className="hint">Escribe los números como en Excel (12.5 o 1,250). En PowerPoint los datos se pueden seguir editando con «Editar datos».</p>
    </aside>
  );
}
