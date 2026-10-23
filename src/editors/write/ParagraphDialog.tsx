import { useState } from "react";
import Dialog from "../../components/Dialog";
import type { ParagraphFormat } from "./extensions";

type Props = {
  value: ParagraphFormat;
  onSave: (value: ParagraphFormat) => void;
  onClose: () => void;
};

const CM_PER_PT = 2.54 / 72;
const cm = (pt: number | null) => (pt ? String(Math.round(pt * CM_PER_PT * 100) / 100) : "");
const toPt = (cmText: string) => {
  const n = Number(cmText.replace(",", "."));
  return cmText.trim() && Number.isFinite(n) && n !== 0 ? Math.round((n / CM_PER_PT) * 10) / 10 : null;
};
const num = (text: string) => {
  const n = Number(text.replace(",", "."));
  return text.trim() && Number.isFinite(n) && n >= 0 ? n : null;
};

type LineKind = "auto" | "1" | "1.15" | "1.5" | "2" | "multiple" | "exact";

function lineKind(v: ParagraphFormat["lineHeight"]): LineKind {
  if (v === null) return "auto";
  if (typeof v === "string") return "exact";
  return (["1", "1.15", "1.5", "2"] as const).find((k) => Number(k) === v) ?? "multiple";
}

/** Formato de párrafo: interlineado, espacio antes y después, y sangrías (en centímetros). */
export default function ParagraphDialog({ value, onSave, onClose }: Props) {
  const [kind, setKind] = useState<LineKind>(lineKind(value.lineHeight));
  const [lineValue, setLineValue] = useState(
    typeof value.lineHeight === "string" ? String(parseFloat(value.lineHeight)) : typeof value.lineHeight === "number" ? String(value.lineHeight) : "",
  );
  const [before, setBefore] = useState(value.spaceBefore === null ? "" : String(value.spaceBefore));
  const [after, setAfter] = useState(value.spaceAfter === null ? "" : String(value.spaceAfter));
  const [indent, setIndent] = useState(cm(value.indent));
  const [special, setSpecial] = useState<"none" | "first" | "hanging">(!value.firstLine ? "none" : value.firstLine > 0 ? "first" : "hanging");
  const [firstLine, setFirstLine] = useState(cm(value.firstLine ? Math.abs(value.firstLine) : null) || "1.25");

  function save() {
    let lineHeight: ParagraphFormat["lineHeight"] = null;
    if (kind === "exact") lineHeight = num(lineValue) ? `${num(lineValue)}pt` : null;
    else if (kind === "multiple") lineHeight = num(lineValue);
    else if (kind !== "auto") lineHeight = Number(kind);
    const first = special === "none" ? null : toPt(firstLine);
    onSave({
      lineHeight,
      spaceBefore: num(before),
      spaceAfter: num(after),
      indent: toPt(indent),
      firstLine: first === null ? null : special === "hanging" ? -first : first,
    });
    onClose();
  }

  return (
    <Dialog
      title="Párrafo"
      onClose={onClose}
      width={440}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn btn-primary" onClick={save}>
            Aceptar
          </button>
        </>
      }
    >
      <div className="paragraph-form" onKeyDown={(e) => e.key === "Enter" && save()}>
        <span className="pf-label">Interlineado</span>
        <div className="field-row">
          <select className="input" value={kind} onChange={(e) => setKind(e.target.value as LineKind)} aria-label="Interlineado" autoFocus>
            <option value="auto">Predeterminado</option>
            <option value="1">Sencillo</option>
            <option value="1.15">1.15</option>
            <option value="1.5">1.5 líneas</option>
            <option value="2">Doble</option>
            <option value="multiple">Múltiple…</option>
            <option value="exact">Exacto (pt)…</option>
          </select>
          {(kind === "multiple" || kind === "exact") && (
            <input className="input pf-num" value={lineValue} onChange={(e) => setLineValue(e.target.value)} placeholder={kind === "exact" ? "14" : "1.3"} aria-label="Valor del interlineado" />
          )}
        </div>

        <span className="pf-label">Espacio antes</span>
        <div className="field-row">
          <input className="input pf-num" value={before} onChange={(e) => setBefore(e.target.value)} placeholder="0" aria-label="Espacio antes (pt)" /> pt
        </div>
        <span className="pf-label">Espacio después</span>
        <div className="field-row">
          <input className="input pf-num" value={after} onChange={(e) => setAfter(e.target.value)} placeholder="8" aria-label="Espacio después (pt)" /> pt
        </div>

        <span className="pf-label">Sangría izquierda</span>
        <div className="field-row">
          <input className="input pf-num" value={indent} onChange={(e) => setIndent(e.target.value)} placeholder="0" aria-label="Sangría izquierda (cm)" /> cm
        </div>
        <span className="pf-label">Especial</span>
        <div className="field-row">
          <select className="input" value={special} onChange={(e) => setSpecial(e.target.value as typeof special)} aria-label="Sangría especial">
            <option value="none">Ninguna</option>
            <option value="first">Primera línea</option>
            <option value="hanging">Francesa</option>
          </select>
          {special !== "none" && (
            <>
              <input className="input pf-num" value={firstLine} onChange={(e) => setFirstLine(e.target.value)} aria-label="Medida de la sangría (cm)" /> cm
            </>
          )}
        </div>
      </div>
      <p className="hint">Deja un campo vacío para usar el valor normal del documento.</p>
    </Dialog>
  );
}
