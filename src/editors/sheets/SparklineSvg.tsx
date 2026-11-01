import type { SparklineView } from "../../lib/spreadsheet";

/**
 * Minigráfico dentro de una celda: línea, columnas o ganancia/pérdida.
 * Ocupa toda la celda (con un margen chico), como en Excel.
 */
export default function SparklineSvg({ spark, width, height }: { spark: SparklineView; width: number; height: number }) {
  const pad = Math.max(2, Math.min(4, height * 0.15));
  const w = Math.max(1, width - pad * 2);
  const h = Math.max(1, height - pad * 2);
  const values = spark.values;
  const nums = values.filter((v): v is number => v !== null);
  if (!nums.length) return null;
  const n = values.length;
  const color = spark.color;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const label = `Minigráfico de ${spark.source}`;
  if (spark.kind === "winloss") {
    const bw = w / n;
    return (
      <svg className="sparkline" width={width} height={height} role="img" aria-label={label}>
        {values.map((v, i) =>
          v === null || v === 0 ? null : (
            <rect key={i} x={pad + i * bw + bw * 0.1} y={v > 0 ? pad : pad + h / 2} width={bw * 0.8} height={h / 2} fill={v > 0 ? color : "#D00000"} />
          ),
        )}
      </svg>
    );
  }
  if (spark.kind === "column") {
    const lo = Math.min(0, min);
    const hi = Math.max(0, max);
    const span = hi - lo || 1;
    const zero = pad + (hi / span) * h;
    const bw = w / n;
    return (
      <svg className="sparkline" width={width} height={height} role="img" aria-label={label}>
        {values.map((v, i) => {
          if (v === null) return null;
          const top = pad + ((hi - Math.max(v, 0)) / span) * h;
          const bottom = pad + ((hi - Math.min(v, 0)) / span) * h;
          const mark = spark.markers && (v === max || v === min);
          return <rect key={i} x={pad + i * bw + bw * 0.12} y={top} width={bw * 0.76} height={Math.max(1, bottom - top)} fill={v < 0 ? "#D00000" : mark && v === max ? "#1F8A55" : color} />;
        })}
        {lo < 0 && <line x1={pad} x2={pad + w} y1={zero} y2={zero} stroke="#999" strokeWidth={0.5} />}
      </svg>
    );
  }
  const span = max - min || 1;
  const x = (i: number) => pad + (n === 1 ? w / 2 : (i / (n - 1)) * w);
  const y = (v: number) => pad + ((max - v) / span) * h;
  // Los huecos (celdas vacías) cortan la línea.
  const parts: string[] = [];
  let current = "";
  values.forEach((v, i) => {
    if (v === null) {
      if (current) parts.push(current);
      current = "";
      return;
    }
    current += `${current ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
  });
  if (current) parts.push(current);
  return (
    <svg className="sparkline" width={width} height={height} role="img" aria-label={label}>
      <path d={parts.join("")} fill="none" stroke={color} strokeWidth={1.4} strokeLinejoin="round" strokeLinecap="round" />
      {spark.markers &&
        values.map((v, i) => (v === null ? null : <circle key={i} cx={x(i)} cy={y(v)} r={1.8} fill={v === max ? "#1F8A55" : v === min ? "#D00000" : color} />))}
    </svg>
  );
}
