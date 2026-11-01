import { useMemo, useState } from "react";
import Dialog from "../../components/Dialog";
import type { Range } from "../../lib/spreadsheet";
import { cellName, columnName } from "../../lib/spreadsheet";

/** Cómo se parte (lo mismo que entiende Rust: sheets/what_if.rs). */
export type SplitSpec = { kind: "delimited"; delimiters: string[]; merge: boolean; quote: string | null } | { kind: "fixed"; breaks: number[] };

/** La misma partición que hace Rust, para la vista previa. */
export function splitText(text: string, spec: SplitSpec): string[] {
  if (spec.kind === "fixed") {
    const chars = [...text];
    const cuts = [...new Set(spec.breaks.filter((b) => b > 0))].sort((a, b) => a - b);
    const out: string[] = [];
    let start = 0;
    for (const b of cuts) {
      if (b >= chars.length) break;
      out.push(chars.slice(start, b).join("").trim());
      start = b;
    }
    out.push(chars.slice(start).join("").trim());
    return out;
  }
  const out: string[] = [];
  let current = "";
  let quoted = false;
  let last = false;
  for (const ch of text) {
    if (spec.quote && ch === spec.quote) {
      quoted = !quoted;
      last = false;
      continue;
    }
    if (!quoted && spec.delimiters.includes(ch)) {
      if (spec.merge && last) continue;
      out.push(current);
      current = "";
      last = true;
    } else {
      current += ch;
      last = false;
    }
  }
  out.push(current);
  return out;
}

const DELIMITERS: [string, string][] = [
  ["\\t", "Tabulación"],
  [";", "Punto y coma"],
  [",", "Coma"],
  [" ", "Espacio"],
];

type Props = {
  region: Range;
  /** El texto de cada celda (como se ve). */
  samples: string[];
  /** ¿Las columnas de la derecha ya tienen algo? (para avisar antes de encimarlo) */
  occupied: (from: number, count: number) => boolean;
  onApply: (spec: SplitSpec, dest: number) => void;
  onClose: () => void;
};

/** Texto en columnas, como en Excel: «Juan Pérez» → «Juan» | «Pérez». */
export default function TextColumnsDialog({ region, samples, occupied, onApply, onClose }: Props) {
  // Lo más probable: tabulación, punto y coma o coma si aparecen; si no, espacio.
  const guess = useMemo(() => {
    const text = samples.join("\n");
    return text.includes("\t") ? ["\t"] : text.includes(";") ? [";"] : text.includes(",") ? [","] : [" "];
  }, [samples]);
  const [mode, setMode] = useState<"delimited" | "fixed">("delimited");
  const [delims, setDelims] = useState<string[]>(guess);
  const [other, setOther] = useState("");
  const [merge, setMerge] = useState(true);
  const [quote, setQuote] = useState(true);
  const [widths, setWidths] = useState("");
  const [dest, setDest] = useState(cellName({ r: region.r1, c: region.c1 }));

  const breaks = widths
    .split(/[,\s]+/)
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0)
    .reduce<number[]>((acc, w) => [...acc, (acc[acc.length - 1] ?? 0) + w], []);
  const spec: SplitSpec = mode === "fixed" ? { kind: "fixed", breaks } : { kind: "delimited", delimiters: [...delims, ...(other ? [...other] : [])], merge, quote: quote ? '"' : null };
  const preview = samples.slice(0, 8).map((s) => splitText(s, spec));
  const width = Math.max(1, ...samples.map((s) => splitText(s, spec).length));
  const destCol = (() => {
    const m = /^\s*\$?([A-Z]{1,3})\$?\d*\s*$/i.exec(dest);
    if (!m) return null;
    return m[1].toUpperCase().split("").reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  })();
  const ready = destCol !== null && (mode === "fixed" ? breaks.length > 0 : spec.kind === "delimited" && spec.delimiters.length > 0);
  // Las columnas que se van a llenar, salvo la de origen.
  const overwrites = destCol !== null && occupied(destCol === region.c1 ? destCol + 1 : destCol, destCol === region.c1 ? width - 1 : width);
  const toggle = (d: string) => setDelims((list) => (list.includes(d) ? list.filter((x) => x !== d) : [...list, d]));

  return (
    <Dialog
      title={`Texto en columnas: ${cellName({ r: region.r1, c: region.c1 })}:${cellName({ r: region.r2, c: region.c1 })}`}
      onClose={onClose}
      width={560}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn btn-primary" disabled={!ready} onClick={() => destCol !== null && onApply(spec, destCol)}>
            {`Separar en ${width} ${width === 1 ? "columna" : "columnas"}`}
          </button>
        </>
      }
    >
      <div className="split-form">
        <div className="split-modes" role="radiogroup" aria-label="Cómo separar">
          <label className="radio">
            <input type="radio" checked={mode === "delimited"} onChange={() => setMode("delimited")} /> Por un separador (coma, espacio…)
          </label>
          <label className="radio">
            <input type="radio" checked={mode === "fixed"} onChange={() => setMode("fixed")} /> Por ancho fijo (número de letras)
          </label>
        </div>
        {mode === "delimited" ? (
          <div className="split-delims">
            {DELIMITERS.map(([d, name]) => {
              const ch = d === "\\t" ? "\t" : d;
              return (
                <label key={d} className="radio">
                  <input type="checkbox" checked={delims.includes(ch)} onChange={() => toggle(ch)} /> {name}
                </label>
              );
            })}
            <label className="radio">
              Otro:
              <input className="input split-other" maxLength={3} value={other} aria-label="Otro separador" onChange={(e) => setOther(e.target.value)} />
            </label>
            <label className="radio">
              <input type="checkbox" checked={merge} onChange={(e) => setMerge(e.target.checked)} /> Varios seguidos cuentan como uno
            </label>
            <label className="radio">
              <input type="checkbox" checked={quote} onChange={(e) => setQuote(e.target.checked)} /> Lo que va entre comillas no se separa
            </label>
          </div>
        ) : (
          <label className="field">
            Ancho de cada parte (letras), separados por comas
            <input className="input" value={widths} placeholder="Por ejemplo: 4, 2, 2" aria-label="Anchos" onChange={(e) => setWidths(e.target.value)} />
          </label>
        )}
        <label className="field split-dest">
          Poner desde la columna
          <input className="input" value={dest} aria-label="Destino" onChange={(e) => setDest(e.target.value)} />
        </label>
        <div className="split-preview" aria-label="Vista previa">
          <table>
            <thead>
              <tr>
                {Array.from({ length: width }, (_, i) => (
                  <th key={i}>{destCol !== null ? columnName(destCol + i) : i + 1}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {preview.map((parts, r) => (
                <tr key={r}>
                  {Array.from({ length: width }, (_, i) => (
                    <td key={i}>{parts[i] ?? ""}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {overwrites && <p className="cf-error">Las columnas de la derecha ya tienen datos: se van a reemplazar (se puede deshacer con ⌘Z).</p>}
      </div>
    </Dialog>
  );
}
