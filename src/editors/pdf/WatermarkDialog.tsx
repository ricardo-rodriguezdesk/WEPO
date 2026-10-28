import { useState } from "react";
import Dialog from "../../components/Dialog";
import type { Watermark } from "./pdfEdit";

const COLORS = [
  { id: "#8A8A8A", label: "Gris" },
  { id: "#D93025", label: "Rojo" },
  { id: "#1A73E8", label: "Azul" },
  { id: "#1D1D1F", label: "Negro" },
];

const SUGGESTIONS = ["CONFIDENCIAL", "BORRADOR", "COPIA", "NO VÁLIDO", "MUESTRA"];

type Props = {
  current: Watermark | null;
  onSave: (mark: Watermark | null) => void;
  onClose: () => void;
};

/** Marca de agua de texto en todas las páginas (se ve aquí y se agrega al guardar). */
export default function WatermarkDialog({ current, onSave, onClose }: Props) {
  const [text, setText] = useState(current?.text ?? "CONFIDENCIAL");
  const [color, setColor] = useState(current?.color ?? COLORS[0].id);
  const [opacity, setOpacity] = useState(current?.opacity ?? 0.25);
  const [diagonal, setDiagonal] = useState(current?.diagonal ?? true);
  const apply = () => {
    if (!text.trim()) return;
    onSave({ text: text.trim(), color, opacity, diagonal });
    onClose();
  };
  return (
    <Dialog
      title="Marca de agua"
      onClose={onClose}
      width={440}
      footer={
        <>
          {current && (
            <button
              className="btn"
              style={{ marginRight: "auto" }}
              onClick={() => {
                onSave(null);
                onClose();
              }}
            >
              Quitar la marca de agua
            </button>
          )}
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn btn-primary" disabled={!text.trim()} onClick={apply}>
            {current ? "Aplicar" : "Agregar"}
          </button>
        </>
      }
    >
      <form
        className="pdf-watermark-form"
        onSubmit={(e) => {
          e.preventDefault();
          apply();
        }}
      >
        <label className="field">
          Texto
          <input className="input" value={text} autoFocus maxLength={60} aria-label="Texto de la marca de agua" onChange={(e) => setText(e.target.value)} list="wepo-watermarks" />
          <datalist id="wepo-watermarks">
            {SUGGESTIONS.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </label>
        <div className="field">
          <span>Color</span>
          <div className="pdf-swatches" role="radiogroup" aria-label="Color de la marca de agua">
            {COLORS.map((c) => (
              <button key={c.id} type="button" role="radio" aria-checked={color === c.id} aria-label={c.label} title={c.label} className={color === c.id ? "on" : ""} style={{ background: c.id }} onClick={() => setColor(c.id)} />
            ))}
          </div>
        </div>
        <label className="field">
          Transparencia: {Math.round((1 - opacity) * 100)} %
          <input type="range" min={0.1} max={0.6} step={0.05} value={opacity} aria-label="Qué tanto se ve" onChange={(e) => setOpacity(Number(e.target.value))} />
        </label>
        <div className="field">
          <span>Dirección</span>
          <label className="radio">
            <input type="radio" name="wm-dir" checked={diagonal} onChange={() => setDiagonal(true)} /> En diagonal
          </label>
          <label className="radio">
            <input type="radio" name="wm-dir" checked={!diagonal} onChange={() => setDiagonal(false)} /> Horizontal
          </label>
        </div>
        <div className="pdf-watermark-sample" aria-hidden="true">
          <span style={{ color, opacity: Math.min(1, opacity * 1.6), transform: diagonal ? "rotate(-35deg)" : undefined }}>{text || " "}</span>
        </div>
        <p className="hint">Va en todas las páginas, en el centro. Se agrega al guardar; aquí ya la ves.</p>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
