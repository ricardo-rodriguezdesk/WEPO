import { useState } from "react";
import Dialog from "../../components/Dialog";

type Props = {
  /** La contraseña con la que se va a guardar (null = sin contraseña). */
  current: string | null;
  onSave: (password: string | null) => void;
  onClose: () => void;
};

/** Proteger el PDF con contraseña, cambiarla o quitarla (se aplica al guardar). */
export default function PasswordDialog({ current, onSave, onClose }: Props) {
  const [first, setFirst] = useState("");
  const [second, setSecond] = useState("");
  const [shown, setShown] = useState(false);
  const problem = !first ? "" : first.length < 4 ? "Usa al menos 4 caracteres." : second && first !== second ? "Las dos no coinciden." : "";
  const ready = first.length >= 4 && first === second;
  const apply = () => {
    if (!ready) return;
    onSave(first);
    onClose();
  };
  return (
    <Dialog
      title={current ? "Contraseña del PDF" : "Proteger con contraseña"}
      onClose={onClose}
      width={440}
      footer={
        <>
          {current && (
            <button
              className="btn pdf-password-remove"
              onClick={() => {
                onSave(null);
                onClose();
              }}
            >
              Quitar la contraseña
            </button>
          )}
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn btn-primary" disabled={!ready} onClick={apply}>
            {current ? "Cambiar" : "Proteger"}
          </button>
        </>
      }
    >
      <form
        className="pdf-password-form"
        onSubmit={(e) => {
          e.preventDefault();
          apply();
        }}
      >
        <p className="hint">
          {current
            ? "Este PDF se guarda con contraseña. Puedes cambiarla o quitarla; el cambio se aplica al guardar."
            : "Al guardar, el PDF va a pedir esta contraseña para abrirse (en WEPO, Acrobat, Vista Previa o el navegador). Se cifra con AES de 256 bits."}
        </p>
        <label className="field">
          {current ? "Contraseña nueva" : "Contraseña"}
          <input className="input" type={shown ? "text" : "password"} value={first} autoFocus autoComplete="new-password" onChange={(e) => setFirst(e.target.value)} aria-label="Contraseña nueva" />
        </label>
        <label className="field">
          Escríbela otra vez
          <input className="input" type={shown ? "text" : "password"} value={second} autoComplete="new-password" onChange={(e) => setSecond(e.target.value)} aria-label="Repetir la contraseña" />
        </label>
        <label className="radio">
          <input type="checkbox" checked={shown} onChange={(e) => setShown(e.target.checked)} /> Mostrar
        </label>
        {problem && <span className="cf-error">{problem}</span>}
        <p className="hint">Si se te olvida, no hay manera de recuperarla: guárdala en un lugar seguro.</p>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

/** Pide la contraseña de otro PDF (al combinar). */
export function OpenPasswordDialog({ name, wrong, onSubmit, onClose }: { name: string; wrong: boolean; onSubmit: (password: string) => void; onClose: () => void }) {
  const [value, setValue] = useState("");
  return (
    <Dialog
      title="PDF con contraseña"
      onClose={onClose}
      width={420}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn btn-primary" disabled={!value} onClick={() => onSubmit(value)}>
            Abrir
          </button>
        </>
      }
    >
      <form
        className="pdf-password-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (value) onSubmit(value);
        }}
      >
        <p className="hint">«{name}» está protegido. Escribe su contraseña para agregar sus páginas.</p>
        <input className="input" type="password" value={value} autoFocus onChange={(e) => setValue(e.target.value)} aria-label="Contraseña del PDF que se agrega" />
        {wrong && <span className="cf-error">La contraseña no es correcta.</span>}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
