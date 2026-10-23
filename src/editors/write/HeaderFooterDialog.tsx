import { useRef, useState } from "react";
import Dialog from "../../components/Dialog";
import type { HeaderFooterSet } from "./docx";
import type { HeaderFooter } from "./extensions";

type Props = {
  value: HeaderFooterSet;
  onSave: (value: HeaderFooterSet) => void;
  onClose: () => void;
};

const FIELDS = [
  { text: "[Página]", label: "Número de página" },
  { text: "[Páginas]", label: "Total de páginas" },
  { text: "[Fecha]", label: "Fecha" },
  { text: "[Archivo]", label: "Nombre del archivo" },
];

const ALIGNS: { value: HeaderFooter["align"]; label: string }[] = [
  { value: "left", label: "Izquierda" },
  { value: "center", label: "Centro" },
  { value: "right", label: "Derecha" },
];

/** Encabezado y pie de página: el mismo texto en todas las hojas, con número de página. */
export default function HeaderFooterDialog({ value, onSave, onClose }: Props) {
  const [form, setForm] = useState<HeaderFooterSet>(() => structuredClone(value));
  const focused = useRef<"header" | "footer">("header");
  const inputs = { header: useRef<HTMLInputElement>(null), footer: useRef<HTMLInputElement>(null) };

  const set = (kind: "header" | "footer", patch: Partial<HeaderFooter>) => setForm((f) => ({ ...f, [kind]: { ...f[kind], ...patch } }));

  function insert(field: string) {
    const kind = focused.current;
    const input = inputs[kind].current;
    const text = form[kind].text;
    const start = input?.selectionStart ?? text.length;
    const end = input?.selectionEnd ?? text.length;
    set(kind, { text: text.slice(0, start) + field + text.slice(end) });
    requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(start + field.length, start + field.length);
    });
  }

  function section(kind: "header" | "footer", title: string, placeholder: string) {
    return (
      <fieldset className="hf-section">
        <legend>{title}</legend>
        <input
          ref={inputs[kind]}
          className="input"
          value={form[kind].text}
          placeholder={placeholder}
          aria-label={title}
          onFocus={() => (focused.current = kind)}
          onChange={(e) => set(kind, { text: e.target.value })}
          autoFocus={kind === "header"}
        />
        <div className="hf-align" role="radiogroup" aria-label={`Alineación del ${title.toLowerCase()}`}>
          {ALIGNS.map((a) => (
            <label key={a.value} className="radio">
              <input type="radio" checked={form[kind].align === a.value} onChange={() => set(kind, { align: a.value })} /> {a.label}
            </label>
          ))}
        </div>
      </fieldset>
    );
  }

  return (
    <Dialog
      title="Encabezado y pie de página"
      onClose={onClose}
      width={500}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button
            className="btn btn-primary"
            onClick={() => {
              onSave(form);
              onClose();
            }}
          >
            Aceptar
          </button>
        </>
      }
    >
      {section("header", "Encabezado", "Por ejemplo: Informe trimestral")}
      {section("footer", "Pie de página", "Por ejemplo: Página [Página] de [Páginas]")}
      <div className="field-row hf-fields">
        <span className="hint">Insertar:</span>
        {FIELDS.map((f) => (
          <button key={f.text} type="button" className="btn" title={f.label} onMouseDown={(e) => e.preventDefault()} onClick={() => insert(f.text)}>
            {f.label}
          </button>
        ))}
      </div>
      <label className="radio">
        <input type="checkbox" checked={form.skipFirst} onChange={(e) => setForm((f) => ({ ...f, skipFirst: e.target.checked }))} /> No mostrar en la
        primera página (portada)
      </label>
    </Dialog>
  );
}
