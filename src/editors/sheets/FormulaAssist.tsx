import type { FormulaLanguage } from "../../lib/preferences";
import type { FunctionInfo } from "./functions";

type Props = {
  /** Esquina inferior izquierda del campo donde se escribe, en la ventana. */
  anchor: { left: number; top: number };
  language: FormulaLanguage;
  suggestions: FunctionInfo[];
  selected: number;
  onPick: (fn: FunctionInfo) => void;
  /** Función cuyos argumentos se están escribiendo, y cuál (desde 0). */
  signature: { fn: FunctionInfo; arg: number } | null;
};

/** Sugerencias de funciones mientras se escribe una fórmula, y ayuda con sus argumentos. */
export default function FormulaAssist({ anchor, language, suggestions, selected, onPick, signature }: Props) {
  const style = { left: Math.min(anchor.left, window.innerWidth - 380), top: anchor.top + 4 };

  if (suggestions.length) {
    return (
      <div className="formula-assist" style={style} role="listbox" aria-label="Funciones sugeridas">
        {suggestions.map((fn, i) => (
          <button
            key={fn.en}
            type="button"
            role="option"
            aria-selected={i === selected}
            className={`fa-option${i === selected ? " selected" : ""}`}
            // El campo de la fórmula no debe perder el foco al elegir.
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(fn);
            }}
          >
            <span className="fa-name">{fn[language]}</span>
            {fn.description && <span className="fa-description">{fn.description}</span>}
          </button>
        ))}
        <div className="fa-hint">↑↓ para elegir · Tab o ↩ para insertar</div>
      </div>
    );
  }

  if (signature && !signature.fn.args) {
    return (
      <div className="formula-assist signature" style={style} role="tooltip">
        <div className="fa-signature">
          <b>{signature.fn[language]}</b>(…)
        </div>
      </div>
    );
  }

  if (signature) {
    const { fn, arg } = signature;
    const args = fn.args ?? [];
    // En funciones con "…" los argumentos se repiten: se resalta el último antes de "…".
    const ellipsis = args.indexOf("…");
    const current = ellipsis !== -1 && arg >= ellipsis ? ellipsis - 1 : arg;
    return (
      <div className="formula-assist signature" style={style} role="tooltip">
        <div className="fa-signature">
          <b>{fn[language]}</b>(
          {args.map((a, i) => (
            <span key={i}>
              {i > 0 && ", "}
              <span className={i === current ? "fa-current-arg" : undefined}>{a}</span>
            </span>
          ))}
          )
        </div>
        {fn.description && <div className="fa-description">{fn.description}</div>}
      </div>
    );
  }
  return null;
}
