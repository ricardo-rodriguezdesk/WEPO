import { useState } from "react";
import Dialog from "../../components/Dialog";
import { roman } from "./notes";

type Props = {
  n: number;
  /** Nota al pie o al final (i, ii, iii…). */
  kind?: "foot" | "end";
  text: string;
  onSave: (text: string) => void;
  onDelete: () => void;
  onClose: () => void;
};

/** Escribir o cambiar el texto de una nota al pie. */
export default function FootnoteDialog({ n, kind = "foot", text, onSave, onDelete, onClose }: Props) {
  const [value, setValue] = useState(text);
  const save = () => {
    onSave(value.trim());
    onClose();
  };
  return (
    <Dialog
      title={kind === "end" ? `Nota al final ${roman(n)}` : `Nota al pie ${n}`}
      onClose={onClose}
      width={460}
      footer={
        <>
          <button
            className="btn write-footnote-delete"
            onClick={() => {
              onDelete();
              onClose();
            }}
          >
            Eliminar nota
          </button>
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn btn-primary" onClick={save}>
            Listo
          </button>
        </>
      }
    >
      <textarea
        className="input write-footnote-input"
        aria-label="Texto de la nota"
        placeholder="Por ejemplo: Fuente: INEGI, 2025."
        value={value}
        rows={4}
        autoFocus
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            save();
          }
        }}
      />
      <p className="hint">
        {kind === "end" ? "Las notas al final van todas juntas después del texto del documento." : "La nota se ve al pie de la hoja donde está su número."} Mayús + Intro para otro renglón.
      </p>
    </Dialog>
  );
}
