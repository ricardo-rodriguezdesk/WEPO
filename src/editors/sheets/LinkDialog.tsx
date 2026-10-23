import { useState } from "react";
import Dialog from "../../components/Dialog";

type Props = {
  /** Texto que se ve en la celda. */
  text: string;
  /** Dirección actual, si la celda ya tiene vínculo. */
  target: string | null;
  onSave: (target: string, text: string) => Promise<boolean>;
  onRemove: () => void;
  onClose: () => void;
};

/** Insertar o editar un vínculo: a una página, un correo o una celda del libro. */
export default function LinkDialog({ text: initialText, target, onSave, onRemove, onClose }: Props) {
  const [text, setText] = useState(initialText);
  const [address, setAddress] = useState(target ?? "");

  async function save() {
    if (!address.trim()) return;
    if (await onSave(address.trim(), text)) onClose();
  }

  return (
    <Dialog
      title={target ? "Editar vínculo" : "Insertar vínculo"}
      onClose={onClose}
      width={440}
      footer={
        <>
          {target && (
            <button className="btn" style={{ marginRight: "auto" }} onClick={onRemove}>
              Quitar vínculo
            </button>
          )}
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn btn-primary" onClick={save} disabled={!address.trim()}>
            Aceptar
          </button>
        </>
      }
    >
      <div className="link-form" onKeyDown={(e) => e.key === "Enter" && save()}>
        <label className="field">
          <span>Texto que se muestra</span>
          <input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Igual que la dirección" />
        </label>
        <label className="field">
          <span>Dirección</span>
          <input
            className="input"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="https://… · nombre@correo.com · Hoja2!A1"
            autoFocus
          />
        </label>
        <p className="hint">Puede ser una página web, un correo o una celda de este libro, como «Hoja2!A1».</p>
      </div>
    </Dialog>
  );
}
