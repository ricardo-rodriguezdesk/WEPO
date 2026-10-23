import { useRef, useState } from "react";
import Dialog from "../../components/Dialog";
import type { PageView } from "../../lib/spreadsheet";
import { cellName } from "../../lib/spreadsheet";
import type { PrintOptions } from "./PrintSheet";
import { isMac, isWindows } from "../../lib/platform";

const KEY = "wepo.print";

function loadOptions(hasArea: boolean): PrintOptions {
  const defaults: PrintOptions = { area: "sheet", gridlines: false, headings: false, fit: true, landscape: false };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(KEY) ?? "{}"), area: hasArea ? "saved" : "sheet" };
  } catch {
    return { ...defaults, area: hasArea ? "saved" : "sheet" };
  }
}

/** Configuración de página tal como se escribe en el diálogo. */
export type PageForm = { header: string; footer: string; repeatRows: string; printArea: string };

export function pageForm(page: PageView): PageForm {
  return {
    header: page.header,
    footer: page.footer,
    repeatRows: page.repeat_rows ? (page.repeat_rows[0] === page.repeat_rows[1] ? `${page.repeat_rows[0]}` : `${page.repeat_rows[0]}:${page.repeat_rows[1]}`) : "",
    printArea: page.print_area
      ? `${cellName({ r: page.print_area[0] - 1, c: page.print_area[1] - 1 })}:${cellName({ r: page.print_area[2] - 1, c: page.print_area[3] - 1 })}`
      : "",
  };
}

const FIELDS = ["[Fecha]", "[Archivo]", "[Hoja]"];

type Props = {
  /** Texto de la selección actual, como "B2:D9". */
  selectionLabel: string;
  page: PageView;
  onPrint: (options: PrintOptions, page: PageForm) => void;
  onClose: () => void;
};

/** Opciones antes de abrir el diálogo de impresión del sistema (donde también se guarda como PDF). */
export default function PrintDialog({ selectionLabel, page, onPrint, onClose }: Props) {
  const [form, setForm] = useState<PageForm>(() => pageForm(page));
  const [options, setOptions] = useState(() => loadOptions(Boolean(page.print_area)));
  const set = (patch: Partial<PrintOptions>) => setOptions((o) => ({ ...o, ...patch }));
  const field = (patch: Partial<PageForm>) => setForm((f) => ({ ...f, ...patch }));
  const focused = useRef<"header" | "footer">("header");

  function insertField(text: string) {
    const key = focused.current;
    field({ [key]: `${form[key]}${form[key] && !form[key].endsWith(" ") ? " " : ""}${text}` });
  }

  function print() {
    try {
      localStorage.setItem(KEY, JSON.stringify({ ...options, area: "sheet" }));
    } catch {
      // Sin almacenamiento las opciones no se recuerdan.
    }
    onPrint(options.area === "saved" && !form.printArea.trim() ? { ...options, area: "sheet" } : options, form);
  }

  return (
    <Dialog
      title="Imprimir o exportar a PDF"
      onClose={onClose}
      width={520}
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
      <div className="print-options two">
        <fieldset>
          <legend>Qué imprimir</legend>
          <label className="radio">
            <input type="radio" checked={options.area === "sheet"} onChange={() => set({ area: "sheet" })} /> Toda la hoja
          </label>
          <label className="radio">
            <input type="radio" checked={options.area === "selection"} onChange={() => set({ area: "selection" })} /> Solo la selección (
            {selectionLabel})
          </label>
          <label className="radio">
            <input type="radio" checked={options.area === "saved"} onChange={() => set({ area: "saved" })} /> Área de impresión:
          </label>
          <div className="field-row">
            <input
              className="input"
              style={{ width: 110 }}
              value={form.printArea}
              placeholder="A1:F20"
              aria-label="Área de impresión"
              onChange={(e) => {
                field({ printArea: e.target.value.toUpperCase() });
                set({ area: "saved" });
              }}
            />
            <button type="button" className="btn" onClick={() => (field({ printArea: selectionLabel.includes(":") ? selectionLabel : `${selectionLabel}:${selectionLabel}` }), set({ area: "saved" }))}>
              Usar la selección
            </button>
          </div>
        </fieldset>
        <fieldset>
          <legend>Opciones</legend>
          <label className="radio">
            <input type="radio" checked={!options.landscape} onChange={() => set({ landscape: false })} /> Vertical
          </label>
          <label className="radio">
            <input type="radio" checked={options.landscape} onChange={() => set({ landscape: true })} /> Horizontal
          </label>
          <label className="radio">
            <input type="checkbox" checked={options.fit} onChange={(e) => set({ fit: e.target.checked })} /> Ajustar al ancho de la página
          </label>
          <label className="radio">
            <input type="checkbox" checked={options.gridlines} onChange={(e) => set({ gridlines: e.target.checked })} /> Cuadrícula
          </label>
          <label className="radio">
            <input type="checkbox" checked={options.headings} onChange={(e) => set({ headings: e.target.checked })} /> Encabezados de filas y columnas
          </label>
        </fieldset>
      </div>

      <fieldset className="print-page">
        <legend>Página (se guarda con el archivo)</legend>
        <label className="field">
          <span>Encabezado</span>
          <input className="input" value={form.header} placeholder="Por ejemplo: Reporte de ventas" onFocus={() => (focused.current = "header")} onChange={(e) => field({ header: e.target.value })} />
        </label>
        <label className="field">
          <span>Pie de página</span>
          <input className="input" value={form.footer} placeholder="Por ejemplo: [Archivo] · [Fecha]" onFocus={() => (focused.current = "footer")} onChange={(e) => field({ footer: e.target.value })} />
        </label>
        <div className="field-row print-fields">
          <span className="hint">Insertar:</span>
          {FIELDS.map((f) => (
            <button key={f} type="button" className="btn" onMouseDown={(e) => e.preventDefault()} onClick={() => insertField(f)}>
              {f.slice(1, -1)}
            </button>
          ))}
        </div>
        <label className="field">
          <span>Filas que se repiten arriba en cada página</span>
          <input className="input" style={{ width: 110 }} value={form.repeatRows} placeholder="1 o 1:2" onChange={(e) => field({ repeatRows: e.target.value })} />
        </label>
      </fieldset>
      <p className="hint">
        {isMac
          ? "Para crear un PDF, elige «Guardar como PDF» en el menú «PDF» del diálogo de impresión."
          : isWindows
            ? "Para crear un PDF, elige la impresora «Microsoft Print to PDF» en el diálogo de impresión."
            : "Para crear un PDF, elige «Imprimir a un archivo» (formato PDF) en el diálogo de impresión."}
      </p>
    </Dialog>
  );
}
