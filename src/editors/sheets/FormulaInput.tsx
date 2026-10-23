import { useLayoutEffect, useRef } from "react";
import type { CSSProperties, FocusEventHandler, KeyboardEventHandler, Ref } from "react";
import { findRefs } from "./formulaRefs";

type Props = {
  value: string;
  onChange: (value: string, caret: number) => void;
  /** Se llama cuando el cursor se mueve (clic, flechas, selección). */
  onCaret: (caret: number) => void;
  onKeyDown?: KeyboardEventHandler<HTMLInputElement>;
  onFocus?: FocusEventHandler<HTMLInputElement>;
  onBlur?: FocusEventHandler<HTMLInputElement>;
  inputRef?: Ref<HTMLInputElement>;
  className?: string;
  style?: CSSProperties;
  label: string;
};

/**
 * Campo de texto que pinta de colores las referencias de una fórmula, como
 * Excel. Truco: el texto real del <input> es transparente y, detrás, una
 * copia con las referencias coloreadas se desplaza junto con él.
 */
export default function FormulaInput(props: Props) {
  const { value, onChange, onCaret } = props;
  const mirrorRef = useRef<HTMLDivElement>(null);
  const localRef = useRef<HTMLInputElement | null>(null);
  const isFormula = value.startsWith("=");

  function setRefs(el: HTMLInputElement | null) {
    localRef.current = el;
    const { inputRef } = props;
    if (typeof inputRef === "function") inputRef(el);
    else if (inputRef) (inputRef as { current: HTMLInputElement | null }).current = el;
  }

  // La copia de colores sigue el desplazamiento horizontal del texto.
  function syncScroll() {
    if (mirrorRef.current && localRef.current) mirrorRef.current.scrollLeft = localRef.current.scrollLeft;
  }
  useLayoutEffect(syncScroll);

  const parts: { text: string; color?: string }[] = [];
  if (isFormula) {
    let pos = 0;
    for (const ref of findRefs(value)) {
      if (ref.start > pos) parts.push({ text: value.slice(pos, ref.start) });
      parts.push({ text: ref.text, color: ref.color });
      pos = ref.end;
    }
    parts.push({ text: value.slice(pos) });
  }

  const reportCaret = () => {
    const el = localRef.current;
    if (el) onCaret(el.selectionStart ?? el.value.length);
    syncScroll();
  };

  return (
    <div className={`formula-input${isFormula ? " is-formula" : ""} ${props.className ?? ""}`} style={props.style}>
      {isFormula && (
        <div className="fi-mirror" ref={mirrorRef} aria-hidden>
          {parts.map((p, i) => (
            <span key={i} style={p.color ? { color: p.color, fontWeight: 600 } : undefined}>
              {p.text}
            </span>
          ))}
        </div>
      )}
      <input
        ref={setRefs}
        aria-label={props.label}
        spellCheck={false}
        autoComplete="off"
        value={value}
        onChange={(e) => {
          onChange(e.target.value, e.target.selectionStart ?? e.target.value.length);
          syncScroll();
        }}
        onSelect={reportCaret}
        onKeyUp={reportCaret}
        onClick={reportCaret}
        onScroll={syncScroll}
        onKeyDown={props.onKeyDown}
        onFocus={props.onFocus}
        onBlur={props.onBlur}
      />
    </div>
  );
}
