import { useState } from "react";
import Dialog from "../../components/Dialog";

type Props = {
  sheetName: string;
  /** "protect": ponerle protección; "unprotect": quitársela (con contraseña si tiene). */
  mode: "protect" | "unprotect";
  /** Al quitarla: la contraseña no fue correcta. */
  wrong?: boolean;
  /** Cuántas celdas se pueden editar (marcadas antes de proteger). */
  unlockedCount: number;
  onSubmit: (password: string | null) => void;
  onClose: () => void;
};

/** Proteger la hoja (contraseña opcional) o quitarle la protección, como en Excel. */
export default function ProtectSheetDialog({ sheetName, mode, wrong, unlockedCount, onSubmit, onClose }: Props) {
  const [first, setFirst] = useState("");
  const [second, setSecond] = useState("");
  const protect = mode === "protect";
  const mismatch = protect && first !== "" && second !== "" && first !== second;
  const ready = protect ? first === second : first !== "";
  const submit = () => {
    if (!ready) return;
    onSubmit(first || null);
  };
  return (
    <Dialog
      title={protect ? `Proteger la hoja «${sheetName}»` : `Quitar la protección de «${sheetName}»`}
      onClose={onClose}
      width={430}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn btn-primary" disabled={!ready} onClick={submit}>
            {protect ? "Proteger" : "Quitar la protección"}
          </button>
        </>
      }
    >
      <form
        className="protect-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {protect ? (
          <>
            <p className="hint">
              Con la hoja protegida no se pueden cambiar sus celdas, su formato ni sus filas y columnas.{" "}
              {unlockedCount > 0
                ? `Las ${unlockedCount} celdas que marcaste como editables sí se pueden llenar.`
                : "Si quieres dejar algunas celdas para llenar, márcalas antes con clic derecho → «Permitir editar estas celdas»."}
            </p>
            <label className="field">
              Contraseña para quitar la protección (opcional)
              <input className="input" type="password" value={first} autoFocus autoComplete="new-password" aria-label="Contraseña de la hoja" onChange={(e) => setFirst(e.target.value)} />
            </label>
            {first && (
              <label className="field">
                Escríbela otra vez
                <input className="input" type="password" value={second} autoComplete="new-password" aria-label="Repetir la contraseña de la hoja" onChange={(e) => setSecond(e.target.value)} />
              </label>
            )}
            {mismatch && <span className="cf-error">Las dos no coinciden.</span>}
            <p className="hint">La protección de una hoja evita cambios por error; no es para guardar secretos (para eso, guarda el archivo con contraseña).</p>
          </>
        ) : (
          <>
            <label className="field">
              Contraseña
              <input className="input" type="password" value={first} autoFocus aria-label="Contraseña de la hoja" onChange={(e) => setFirst(e.target.value)} />
            </label>
            {wrong && <span className="cf-error">La contraseña no es correcta.</span>}
          </>
        )}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
