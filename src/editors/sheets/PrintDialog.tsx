import { useState } from "react";
import Dialog from "../../components/Dialog";
import type { PrintOptions } from "./PrintSheet";

const KEY = "wepo.print";

function loadOptions(): PrintOptions {
  const defaults: PrintOptions = { area: "sheet", gridlines: false, headings: false, fit: true, landscape: false };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(KEY) ?? "{}"), area: "sheet" };
  } catch {
    return defaults;
  }
}

type Props = {
  /** Texto de la selección actual, como "B2:D9". */
  selectionLabel: string;
  onPrint: (options: PrintOptions) => void;
  onClose: () => void;
};

/** Opciones antes de abrir el diálogo de impresión de macOS (donde también se guarda como PDF). */
export default function PrintDialog({ selectionLabel, onPrint, onClose }: Props) {
  const [options, setOptions] = useState(loadOptions);
  const set = (patch: Partial<PrintOptions>) => setOptions((o) => ({ ...o, ...patch }));

  function print() {
    try {
      localStorage.setItem(KEY, JSON.stringify(options));
    } catch {
      // Sin almacenamiento las opciones no se recuerdan.
    }
    onPrint(options);
  }

  return (
    <Dialog
      title="Imprimir o exportar a PDF"
      onClose={onClose}
      width={420}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn btn-primary" onClick={print} autoFocus>
            Imprimir…
          </button>
        </>
      }
    >
      <div className="print-options">
        <fieldset>
          <legend>Qué imprimir</legend>
          <label className="radio">
            <input type="radio" checked={options.area === "sheet"} onChange={() => set({ area: "sheet" })} /> Toda la hoja
          </label>
          <label className="radio">
            <input type="radio" checked={options.area === "selection"} onChange={() => set({ area: "selection" })} /> Solo la
            selección ({selectionLabel})
          </label>
        </fieldset>
        <fieldset>
          <legend>Orientación</legend>
          <label className="radio">
            <input type="radio" checked={!options.landscape} onChange={() => set({ landscape: false })} /> Vertical
          </label>
          <label className="radio">
            <input type="radio" checked={options.landscape} onChange={() => set({ landscape: true })} /> Horizontal
          </label>
        </fieldset>
        <fieldset>
          <legend>Opciones</legend>
          <label className="radio">
            <input type="checkbox" checked={options.fit} onChange={(e) => set({ fit: e.target.checked })} /> Ajustar al ancho
            de la página
          </label>
          <label className="radio">
            <input type="checkbox" checked={options.gridlines} onChange={(e) => set({ gridlines: e.target.checked })} />{" "}
            Imprimir la cuadrícula
          </label>
          <label className="radio">
            <input type="checkbox" checked={options.headings} onChange={(e) => set({ headings: e.target.checked })} />{" "}
            Encabezados de filas y columnas
          </label>
        </fieldset>
        <p className="hint">Para crear un PDF, elige «Guardar como PDF» en el menú «PDF» del diálogo de impresión.</p>
      </div>
    </Dialog>
  );
}
