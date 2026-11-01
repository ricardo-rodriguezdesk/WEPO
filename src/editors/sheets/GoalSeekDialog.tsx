import { useState } from "react";
import Dialog from "../../components/Dialog";
import { parseRange } from "./printLayout";

export type GoalResult = { found: boolean; value: number; result: number; before: string };

type Props = {
  /** La celda elegida (para proponerla como la de la fórmula). */
  initialTarget: string;
  onSeek: (target: { r: number; c: number }, goal: number, changing: { r: number; c: number }) => Promise<GoalResult | null>;
  /** Quedarse con el valor encontrado o regresar al de antes. */
  onFinish: (keep: boolean) => void;
};

const fmt = (n: number) => n.toLocaleString("es-MX", { maximumFractionDigits: 6 });

/** Buscar objetivo (Análisis Y si…): qué valor necesita una celda para que la fórmula dé lo que quieres. */
export default function GoalSeekDialog({ initialTarget, onSeek, onFinish }: Props) {
  const [target, setTarget] = useState(initialTarget);
  const [goal, setGoal] = useState("");
  const [changing, setChanging] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<GoalResult | null>(null);
  const t = parseRange(target);
  const c = parseRange(changing);
  const g = Number(goal.replace(/,/g, ""));
  const ready = t && c && t.r1 === t.r2 && t.c1 === t.c2 && c.r1 === c.r2 && c.c1 === c.c2 && goal.trim() !== "" && Number.isFinite(g);
  async function seek() {
    if (!ready || !t || !c) return;
    setBusy(true);
    try {
      setResult(await onSeek({ r: t.r1, c: t.c1 }, g, { r: c.r1, c: c.c1 }));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title="Buscar objetivo"
      onClose={() => onFinish(Boolean(result))}
      width={420}
      footer={
        result ? (
          <>
            <button className="btn" onClick={() => onFinish(false)}>
              Cancelar
            </button>
            <button className="btn btn-primary" onClick={() => onFinish(true)}>
              Aceptar
            </button>
          </>
        ) : (
          <>
            <button className="btn" onClick={() => onFinish(false)}>
              Cancelar
            </button>
            <button className="btn btn-primary" disabled={!ready || busy} onClick={seek}>
              {busy ? "Buscando…" : "Buscar"}
            </button>
          </>
        )
      }
    >
      {result ? (
        <div className="goal-result" role="status">
          <p>
            <b>{result.found ? "Se encontró una solución." : "No se encontró una solución exacta."}</b>
          </p>
          <p>{`${changing.toUpperCase()} = ${fmt(result.value)}`}</p>
          <p>{`${target.toUpperCase()} da ${fmt(result.result)} (el objetivo era ${fmt(g)})`}</p>
          <p className="hint">«Aceptar» deja el valor; «Cancelar» regresa al que tenía.</p>
        </div>
      ) : (
        <form
          className="goal-form"
          onSubmit={(e) => {
            e.preventDefault();
            void seek();
          }}
        >
          <label className="field">
            Definir la celda (la que tiene la fórmula)
            <input className="input" value={target} autoFocus aria-label="Definir la celda" onChange={(e) => setTarget(e.target.value)} />
          </label>
          <label className="field">
            Con el valor
            <input className="input" value={goal} inputMode="decimal" aria-label="Con el valor" onChange={(e) => setGoal(e.target.value)} />
          </label>
          <label className="field">
            Cambiando la celda
            <input className="input" value={changing} placeholder="Por ejemplo: B2" aria-label="Cambiando la celda" onChange={(e) => setChanging(e.target.value)} />
          </label>
          <button type="submit" hidden />
        </form>
      )}
    </Dialog>
  );
}
