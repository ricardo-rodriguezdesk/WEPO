// Dibujo de gráficas en SVG: columnas, barras, líneas, áreas, pastel, dona y
// dispersión. Los datos ya vienen calculados desde Rust (ver drawings.rs).

import type { ChartView, SeriesView } from "../../lib/spreadsheet";

const SLICE_COLORS = ["#4472C4", "#ED7D31", "#A5A5A5", "#FFC000", "#5B9BD5", "#70AD47", "#264478", "#9E480E", "#636363", "#997300"];
const FONT = '-apple-system, "Helvetica Neue", Arial, sans-serif';
const numberFormat = new Intl.NumberFormat("es-MX", { maximumFractionDigits: 2 });
const compactFormat = new Intl.NumberFormat("es-MX", { notation: "compact", maximumFractionDigits: 1 });

/** Escala "bonita" para el eje: mínimo, máximo y paso redondos. */
export function niceScale(min: number, max: number, ticks = 5) {
  if (min === max) {
    min = Math.min(0, min);
    max = max === 0 ? 1 : Math.max(0, max);
  }
  const rough = (max - min) / ticks;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= rough) ?? 10 * power;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const values: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) values.push(Math.round(v / step) * step);
  return { lo, hi, values };
}

function label(v: number): string {
  return Math.abs(v) >= 10000 ? compactFormat.format(v) : numberFormat.format(v);
}

/** `width` y `height` son el tamaño real; `scale` (el zoom) solo agranda el dibujo. */
type Props = { chart: ChartView; width: number; height: number; scale?: number };

export default function ChartSvg({ chart, width, height, scale = 1 }: Props) {
  const pie = chart.kind === "pie" || chart.kind === "doughnut";
  const series = chart.series;
  const titleH = chart.title ? 30 : 8;
  const legendItems = pie
    ? (series[0]?.categories.length ? series[0].categories : (series[0]?.values ?? []).map((_, i) => `${i + 1}`)).map(
        (name, i) => ({ name, color: SLICE_COLORS[i % SLICE_COLORS.length] }),
      )
    : series.map((s) => ({ name: s.name, color: s.color }));
  const legendW = chart.legend ? Math.min(150, width * 0.3) : 0;
  const plot = { x: 8, y: titleH, w: width - 16 - legendW, h: height - titleH - 8 };

  return (
    <svg width={width * scale} height={height * scale} viewBox={`0 0 ${width} ${height}`} className="chart-svg" fontFamily={FONT}>
      <rect width={width} height={height} fill="var(--chart-bg, #fff)" />
      {chart.title && (
        <text x={width / 2} y={21} textAnchor="middle" fontSize="15" fontWeight="600" fill="var(--chart-text, #222)">
          {chart.title}
        </text>
      )}
      {series.length === 0 ? (
        <text x={width / 2} y={height / 2} textAnchor="middle" fontSize="13" fill="#888">
          Sin datos
        </text>
      ) : pie ? (
        <PieChart series={series[0]} plot={plot} doughnut={chart.kind === "doughnut"} />
      ) : (
        <AxisChart chart={chart} plot={plot} />
      )}
      {chart.legend && (
        <g transform={`translate(${width - legendW + 4}, ${titleH + 6})`}>
          {legendItems.slice(0, Math.floor((height - titleH - 10) / 18)).map((item, i) => (
            <g key={i} transform={`translate(0, ${i * 18})`}>
              <rect width="10" height="10" y="2" rx="2" fill={item.color} />
              <text x="15" y="11" fontSize="11" fill="var(--chart-text, #222)">
                {item.name.length > 18 ? `${item.name.slice(0, 17)}…` : item.name}
              </text>
            </g>
          ))}
        </g>
      )}
    </svg>
  );
}

type Plot = { x: number; y: number; w: number; h: number };

function PieChart({ series, plot, doughnut }: { series: SeriesView; plot: Plot; doughnut: boolean }) {
  const values = series.values.map((v) => Math.max(0, v ?? 0));
  const total = values.reduce((a, b) => a + b, 0);
  const r = Math.max(10, Math.min(plot.w, plot.h) / 2 - 6);
  const cx = plot.x + plot.w / 2;
  const cy = plot.y + plot.h / 2;
  if (total <= 0) return null;
  let angle = -Math.PI / 2;
  return (
    <g>
      {values.map((v, i) => {
        const slice = (v / total) * Math.PI * 2;
        const start = angle;
        angle += slice;
        if (v === 0) return null;
        const color = SLICE_COLORS[i % SLICE_COLORS.length];
        if (slice >= Math.PI * 2 - 1e-6) return <circle key={i} cx={cx} cy={cy} r={r} fill={color} />;
        const [x1, y1] = [cx + r * Math.cos(start), cy + r * Math.sin(start)];
        const [x2, y2] = [cx + r * Math.cos(angle), cy + r * Math.sin(angle)];
        const large = slice > Math.PI ? 1 : 0;
        const mid = start + slice / 2;
        const percent = Math.round((v / total) * 100);
        return (
          <g key={i}>
            <path d={`M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${large} 1 ${x2},${y2} Z`} fill={color} stroke="var(--chart-bg, #fff)" strokeWidth="1.5" />
            {percent >= 5 && (
              <text
                x={cx + r * (doughnut ? 0.78 : 0.62) * Math.cos(mid)}
                y={cy + r * (doughnut ? 0.78 : 0.62) * Math.sin(mid) + 4}
                textAnchor="middle"
                fontSize="11"
                fontWeight="600"
                fill="#fff"
              >
                {percent}%
              </text>
            )}
          </g>
        );
      })}
      {doughnut && <circle cx={cx} cy={cy} r={r * 0.55} fill="var(--chart-bg, #fff)" />}
    </g>
  );
}

function AxisChart({ chart, plot }: { chart: ChartView; plot: Plot }) {
  const { kind, series } = chart;
  const scatter = kind === "scatter";
  const horizontal = kind === "bar";
  const count = Math.max(...series.map((s) => s.values.length), 1);
  const categories = series[0]?.categories.length ? series[0].categories : Array.from({ length: count }, (_, i) => `${i + 1}`);

  const all = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  const y = niceScale(Math.min(0, ...all), Math.max(0, ...all));
  const xs = scatter ? series.flatMap((s) => s.x.filter((v): v is number => v !== null)) : [];
  const x = scatter && xs.length ? niceScale(Math.min(...xs), Math.max(...xs)) : null;

  // Espacio para las etiquetas de los ejes.
  const valueLabelW = Math.max(...y.values.map((v) => label(v).length)) * 6.5 + 8;
  const area = horizontal
    ? { x: plot.x + Math.min(90, plot.w * 0.3), y: plot.y + 4, w: plot.w - Math.min(90, plot.w * 0.3) - 6, h: plot.h - 22 }
    : { x: plot.x + valueLabelW, y: plot.y + 10, w: plot.w - valueLabelW - 6, h: plot.h - 30 };

  const valuePos = (v: number) =>
    horizontal
      ? area.x + ((v - y.lo) / (y.hi - y.lo || 1)) * area.w
      : area.y + area.h - ((v - y.lo) / (y.hi - y.lo || 1)) * area.h;
  const band = (horizontal ? area.h : area.w) / count;
  const catCenter = (i: number) => (horizontal ? area.y : area.x) + band * i + band / 2;
  const xPos = (v: number) => (x ? area.x + ((v - x.lo) / (x.hi - x.lo || 1)) * area.w : 0);
  const zero = valuePos(Math.max(y.lo, Math.min(0, y.hi)));
  const skip = Math.ceil(count / Math.max(1, Math.floor((horizontal ? area.h : area.w) / 46)));

  return (
    <g fontSize="10.5" fill="var(--chart-muted, #666)">
      {/* Cuadrícula y valores */}
      {y.values.map((v) =>
        horizontal ? (
          <g key={v}>
            <line x1={valuePos(v)} x2={valuePos(v)} y1={area.y} y2={area.y + area.h} stroke="var(--chart-grid, #e5e5e5)" />
            <text x={valuePos(v)} y={area.y + area.h + 14} textAnchor="middle">
              {label(v)}
            </text>
          </g>
        ) : (
          <g key={v}>
            <line x1={area.x} x2={area.x + area.w} y1={valuePos(v)} y2={valuePos(v)} stroke="var(--chart-grid, #e5e5e5)" />
            <text x={area.x - 6} y={valuePos(v) + 3.5} textAnchor="end">
              {label(v)}
            </text>
          </g>
        ),
      )}
      {/* Categorías (o valores X en dispersión) */}
      {x
        ? x.values.map((v) => (
            <text key={v} x={xPos(v)} y={area.y + area.h + 15} textAnchor="middle">
              {label(v)}
            </text>
          ))
        : categories.map((c, i) =>
            i % skip !== 0 ? null : horizontal ? (
              <text key={i} x={area.x - 6} y={catCenter(i) + 3.5} textAnchor="end">
                {c.length > 14 ? `${c.slice(0, 13)}…` : c}
              </text>
            ) : (
              <text key={i} x={catCenter(i)} y={area.y + area.h + 15} textAnchor="middle">
                {c.length > 12 ? `${c.slice(0, 11)}…` : c}
              </text>
            ),
          )}
      {/* Línea del cero */}
      {horizontal ? (
        <line x1={zero} x2={zero} y1={area.y} y2={area.y + area.h} stroke="var(--chart-axis, #999)" />
      ) : (
        <line x1={area.x} x2={area.x + area.w} y1={zero} y2={zero} stroke="var(--chart-axis, #999)" />
      )}

      {series.map((s, si) => {
        if (kind === "column" || kind === "bar") {
          const groupW = band * 0.7;
          const barW = groupW / series.length;
          return (
            <g key={si} fill={s.color}>
              {s.values.map((v, i) => {
                if (v === null) return null;
                const offset = catCenter(i) - groupW / 2 + barW * si;
                const p = valuePos(v);
                return horizontal ? (
                  <rect key={i} x={Math.min(p, zero)} y={offset} width={Math.abs(p - zero)} height={barW * 0.92} rx="1.5">
                    <title>{`${s.name} · ${categories[i] ?? i + 1}: ${numberFormat.format(v)}`}</title>
                  </rect>
                ) : (
                  <rect key={i} x={offset} y={Math.min(p, zero)} width={barW * 0.92} height={Math.abs(p - zero)} rx="1.5">
                    <title>{`${s.name} · ${categories[i] ?? i + 1}: ${numberFormat.format(v)}`}</title>
                  </rect>
                );
              })}
            </g>
          );
        }
        const points = s.values
          .map((v, i) => (v === null ? null : ([scatter ? xPos(s.x[i] ?? i) : catCenter(i), valuePos(v)] as [number, number])))
          .filter((p): p is [number, number] => p !== null);
        if (!points.length) return null;
        const path = points.map(([px, py], i) => `${i ? "L" : "M"}${px},${py}`).join(" ");
        return (
          <g key={si}>
            {kind === "area" && (
              <path d={`${path} L${points[points.length - 1][0]},${zero} L${points[0][0]},${zero} Z`} fill={s.color} fillOpacity="0.35" />
            )}
            {!scatter && <path d={path} fill="none" stroke={s.color} strokeWidth="2.25" strokeLinejoin="round" />}
            {(kind === "line" || scatter) &&
              points.map(([px, py], i) => (
                <circle key={i} cx={px} cy={py} r={scatter ? 3.5 : 3} fill={s.color} stroke="var(--chart-bg, #fff)" strokeWidth="1" />
              ))}
          </g>
        );
      })}
    </g>
  );
}
