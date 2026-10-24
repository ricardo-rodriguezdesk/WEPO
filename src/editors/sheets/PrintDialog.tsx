// Imprimir o exportar a PDF, como en Excel: las opciones a la izquierda y la
// vista previa de las páginas a la derecha, que cambia con cada opción.

import { useEffect, useMemo, useRef, useState } from "react";
import Dialog from "../../components/Dialog";
import type { PageView, Range } from "../../lib/spreadsheet";
import { cellName } from "../../lib/spreadsheet";
import type { PrintJob, PrintOptions, SheetData } from "./PrintSheet";
import { SheetPage, fillPageFields, printLayout } from "./PrintSheet";
import type { Margins, Paper, Scaling } from "./printLayout";
import { MARGINS, PAPERS } from "./printLayout";
import "./PrintDialog.css";

const KEY = "wepo.print";

export function loadOptions(hasArea: boolean): PrintOptions {
  const defaults: PrintOptions = { area: "sheet", gridlines: false, headings: false, scaling: "width", landscape: false, paper: "letter", margins: "normal" };
  let saved: Partial<PrintOptions> & { fit?: boolean } = {};
  try {
    saved = JSON.parse(localStorage.getItem(KEY) ?? "{}");
  } catch {
    // Sin almacenamiento se usan las opciones normales.
  }
  // Antes había solo "ajustar al ancho" (sí o no).
  if (saved.scaling === undefined && saved.fit !== undefined) saved.scaling = saved.fit ? "width" : "none";
  delete saved.fit;
  return { ...defaults, ...saved, area: hasArea ? "saved" : "sheet" };
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

/** "1" o "1:2" → [0, 0] o [0, 1] (filas desde 0). */
export function parseRepeat(text: string): [number, number] | null {
  const m = /^\s*(\d+)\s*(?::\s*(\d+))?\s*$/.exec(text);
  if (!m) return null;
  const a = Number(m[1]) - 1;
  const b = (m[2] ? Number(m[2]) : Number(m[1])) - 1;
  return a < 0 || b < 0 ? null : [Math.min(a, b), Math.max(a, b)];
}

const FIELDS = ["[Página]", "[Páginas]", "[Fecha]", "[Archivo]", "[Hoja]"];

type Props = {
  /** Texto de la selección actual, como "B2:D9". */
  selectionLabel: string;
  page: PageView;
  /** Opciones y formulario con que se abre (por ejemplo, al volver de elegir el área en la hoja). */
  initial?: { options: PrintOptions; form: PageForm } | null;
  /** Lo que se imprime con cada opción (null si no hay nada). */
  rangeFor: (area: PrintOptions["area"], printArea: string) => Range | null;
  data: SheetData;
  fileName: string;
  sheetName: string;
  /** Imágenes de la hoja (para la vista previa). */
  loadImages: () => Promise<Record<number, string>>;
  /** `toPdf`: guardar directo como PDF en vez de abrir el diálogo de impresión. */
  onPrint: (options: PrintOptions, page: PageForm, toPdf: boolean) => void;
  /** Elegir el área de impresión con el mouse, en la hoja. */
  onPickArea: (options: PrintOptions, page: PageForm) => void;
  onClose: () => void;
  /** Abierto desde "Exportar como PDF": ese botón es el principal. */
  pdf?: boolean;
};

export default function PrintDialog({ selectionLabel, page, initial, rangeFor, data, fileName, sheetName, loadImages, onPrint, onPickArea, onClose, pdf = false }: Props) {
  const [form, setForm] = useState<PageForm>(() => initial?.form ?? pageForm(page));
  const [options, setOptions] = useState(() => initial?.options ?? loadOptions(Boolean(page.print_area)));
  const [images, setImages] = useState<Record<number, string>>({});
  const [current, setCurrent] = useState(0);
  const set = (patch: Partial<PrintOptions>) => setOptions((o) => ({ ...o, ...patch }));
  const field = (patch: Partial<PageForm>) => setForm((f) => ({ ...f, ...patch }));
  const focused = useRef<"header" | "footer">("header");

  useEffect(() => {
    loadImages().then(setImages).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const effective: PrintOptions = options.area === "saved" && !form.printArea.trim() ? { ...options, area: "sheet" } : options;
  const range = rangeFor(effective.area, form.printArea);
  const badArea = options.area === "saved" && form.printArea.trim() !== "" && !range;

  const job: PrintJob | null = useMemo(
    () =>
      range
        ? {
            ...effective,
            range,
            images,
            header: fillPageFields(form.header, fileName, sheetName),
            footer: fillPageFields(form.footer, fileName, sheetName),
            repeat: parseRepeat(form.repeatRows),
          }
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(effective), JSON.stringify(range), images, form, fileName, sheetName],
  );
  const layout = useMemo(() => (job ? printLayout(job, data) : null), [job, data]);
  const total = layout?.pages.length ?? 0;
  const pageIndex = Math.min(current, Math.max(0, total - 1));

  // La página de muestra cabe en el panel de la derecha.
  const pane = useRef<HTMLDivElement>(null);
  const [paneSize, setPaneSize] = useState({ width: 520, height: 560 });
  useEffect(() => {
    const el = pane.current;
    if (!el) return;
    const measure = () => setPaneSize({ width: el.clientWidth - 32, height: el.clientHeight - 32 });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const zoom = layout ? Math.min(paneSize.width / layout.width, paneSize.height / layout.height) : 1;

  function insertField(text: string) {
    const key = focused.current;
    field({ [key]: `${form[key]}${form[key] && !form[key].endsWith(" ") ? " " : ""}${text}` });
  }

  function print(toPdf: boolean) {
    try {
      localStorage.setItem(KEY, JSON.stringify({ ...options, area: "sheet" }));
    } catch {
      // Sin almacenamiento las opciones no se recuerdan.
    }
    onPrint(effective, form, toPdf);
  }

  return (
    <Dialog
      title="Imprimir o exportar a PDF"
      onClose={onClose}
      width={Math.min(1120, window.innerWidth - 40)}
      footer={
        <>
          <span className="print-count">{total ? `${total} ${total === 1 ? "página" : "páginas"}` : ""}</span>
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className={`btn${pdf ? " btn-primary" : ""}`} onClick={() => print(true)} autoFocus={pdf} disabled={!range}>
            Exportar PDF…
          </button>
          <button className={`btn${pdf ? "" : " btn-primary"}`} onClick={() => print(false)} autoFocus={!pdf} disabled={!range}>
            Imprimir…
          </button>
        </>
      }
    >
      <div className="print-screen">
        <div className="print-settings">
          <fieldset>
            <legend>Qué imprimir</legend>
            <label className="radio">
              <input type="radio" checked={options.area === "sheet"} onChange={() => set({ area: "sheet" })} /> Toda la hoja
            </label>
            <label className="radio">
              <input type="radio" checked={options.area === "selection"} onChange={() => set({ area: "selection" })} /> Solo la selección ({selectionLabel})
            </label>
            <label className="radio">
              <input type="radio" checked={options.area === "saved"} onChange={() => set({ area: "saved" })} /> Área de impresión
            </label>
            <div className="field-row print-area-row">
              <input
                className={`input${badArea ? " invalid" : ""}`}
                value={form.printArea}
                placeholder="A1:F20"
                aria-label="Área de impresión"
                onChange={(e) => {
                  field({ printArea: e.target.value.toUpperCase() });
                  set({ area: "saved" });
                }}
              />
              <button type="button" className="btn" onClick={() => onPickArea({ ...options, area: "saved" }, form)} title="Elegir el área con el mouse en la hoja">
                Seleccionar en la hoja…
              </button>
            </div>
            {badArea && <span className="cf-error">Escribe un rango como A1:F20.</span>}
          </fieldset>

          <fieldset>
            <legend>Página</legend>
            <label className="field">
              <span>Papel</span>
              <select className="input" value={options.paper} onChange={(e) => set({ paper: e.target.value as Paper })}>
                {(Object.keys(PAPERS) as Paper[]).map((p) => (
                  <option key={p} value={p}>
                    {PAPERS[p].label}
                  </option>
                ))}
              </select>
            </label>
            <div className="print-segment" role="radiogroup" aria-label="Orientación">
              <button type="button" className={!options.landscape ? "on" : ""} onClick={() => set({ landscape: false })}>
                Vertical
              </button>
              <button type="button" className={options.landscape ? "on" : ""} onClick={() => set({ landscape: true })}>
                Horizontal
              </button>
            </div>
            <label className="field">
              <span>Márgenes</span>
              <select className="input" value={options.margins} onChange={(e) => set({ margins: e.target.value as Margins })}>
                {(Object.keys(MARGINS) as Margins[]).map((m) => (
                  <option key={m} value={m}>
                    {MARGINS[m].label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Escala</span>
              <select className="input" value={options.scaling} onChange={(e) => set({ scaling: e.target.value as Scaling })}>
                <option value="none">Tamaño real</option>
                <option value="width">Ajustar todas las columnas en una página</option>
                <option value="page">Ajustar la hoja en una página</option>
              </select>
            </label>
            <label className="radio">
              <input type="checkbox" checked={options.gridlines} onChange={(e) => set({ gridlines: e.target.checked })} /> Cuadrícula
            </label>
            <label className="radio">
              <input type="checkbox" checked={options.headings} onChange={(e) => set({ headings: e.target.checked })} /> Encabezados de filas y columnas
            </label>
          </fieldset>

          <fieldset>
            <legend>Encabezado y pie (se guardan con el archivo)</legend>
            <label className="field">
              <span>Encabezado</span>
              <input className="input" value={form.header} placeholder="Por ejemplo: Reporte de ventas" onFocus={() => (focused.current = "header")} onChange={(e) => field({ header: e.target.value })} />
            </label>
            <label className="field">
              <span>Pie de página</span>
              <input className="input" value={form.footer} placeholder="Por ejemplo: Página [Página] de [Páginas]" onFocus={() => (focused.current = "footer")} onChange={(e) => field({ footer: e.target.value })} />
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
        </div>

        <div className="print-preview">
          <div className="print-preview-pane" ref={pane}>
            {layout && job ? (
              <div className="print-preview-sheet" style={{ width: layout.width * zoom, height: layout.height * zoom }}>
                <div style={{ transform: `scale(${zoom})`, transformOrigin: "0 0", width: layout.width, height: layout.height }}>
                  <SheetPage job={job} layout={layout} index={pageIndex} data={data} />
                </div>
              </div>
            ) : (
              <p className="hint">{badArea ? "El área de impresión no es válida." : "No hay nada que imprimir con estas opciones."}</p>
            )}
          </div>
          <div className="print-pager">
            <button type="button" className="btn btn-icon" disabled={pageIndex <= 0} onClick={() => setCurrent(pageIndex - 1)} aria-label="Página anterior">
              ‹
            </button>
            <span>{total ? `Página ${pageIndex + 1} de ${total}` : "Sin páginas"}</span>
            <button type="button" className="btn btn-icon" disabled={pageIndex >= total - 1} onClick={() => setCurrent(pageIndex + 1)} aria-label="Página siguiente">
              ›
            </button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
