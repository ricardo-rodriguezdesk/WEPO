// Imprimir o exportar a PDF en WEPO Present, con vista previa: una diapositiva
// por hoja, con sus notas, o 2, 3 o 6 por hoja (como los documentos de PowerPoint).
// Las mismas páginas se usan en la vista previa, al imprimir y en el PDF.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Dialog from "../../components/Dialog";
import type { Deck } from "./model";
import SlideView from "./SlideView";
import "../sheets/PrintDialog.css";
import "../sheets/print.css";

export type SlideLayout = "slides" | "notes" | "h2" | "h3" | "h6";
export type SlidePaper = "letter" | "a4";

export type SlidePrintJob = {
  layout: SlideLayout;
  /** Diapositivas que se imprimen (índices en el orden de la presentación). */
  slides: number[];
  paper: SlidePaper;
};

const PAPER: Record<SlidePaper, { label: string; width: number; height: number }> = {
  letter: { label: "Carta", width: 816, height: 1056 },
  a4: { label: "A4", width: 794, height: 1123 },
};
const MARGIN = 58; // 0.6 pulgadas
const PER_PAGE: Record<SlideLayout, number> = { slides: 1, notes: 1, h2: 2, h3: 3, h6: 6 };
const LAYOUT_LABEL: Record<SlideLayout, string> = {
  slides: "Diapositivas (una por hoja, del tamaño de la diapositiva)",
  notes: "Diapositivas con sus notas",
  h2: "Documento: 2 diapositivas por hoja",
  h3: "Documento: 3 por hoja, con renglones para apuntes",
  h6: "Documento: 6 diapositivas por hoja",
};

/** Tamaño de la hoja en px CSS. */
export function sheetSize(job: SlidePrintJob, deck: Deck): { width: number; height: number } {
  if (job.layout === "slides") return { width: deck.width, height: deck.height };
  return PAPER[job.paper];
}

/** Las diapositivas de cada hoja. */
export function slidePages(job: SlidePrintJob): number[][] {
  const per = PER_PAGE[job.layout];
  const out: number[][] = [];
  for (let i = 0; i < job.slides.length; i += per) out.push(job.slides.slice(i, i + per));
  return out;
}

/** "1-3, 5" → índices desde 0 (null si no se entiende o se sale de la presentación). */
export function parseSlides(text: string, total: number): number[] | null {
  const out = new Set<number>();
  for (const part of text.split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = /^(\d+)\s*(?:-\s*(\d+))?$/.exec(part);
    if (!m) return null;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (a < 1 || b < a || b > total) return null;
    for (let i = a; i <= b; i++) out.add(i - 1);
  }
  return out.size ? [...out].sort((x, y) => x - y) : null;
}

/** Una hoja impresa, a tamaño real. */
export function SlidePage({ deck, job, slides, index, total }: { deck: Deck; job: SlidePrintJob; slides: number[]; index: number; total: number }) {
  const { width, height } = sheetSize(job, deck);
  const innerW = width - MARGIN * 2;
  const innerH = height - MARGIN * 2;
  const number = (i: number) => <span className="present-print-number">Diapositiva {i + 1}</span>;
  const slide = (i: number, w: number, h: number) => {
    const scale = Math.min(w / deck.width, h / deck.height);
    return <SlideView slide={deck.slides[i]} deck={deck} scale={scale} className="present-print-slide" />;
  };
  let body;
  if (job.layout === "slides") {
    body = <SlideView slide={deck.slides[slides[0]]} deck={deck} scale={1} />;
  } else if (job.layout === "notes") {
    const i = slides[0];
    body = (
      <div className="present-print-sheet" style={{ padding: MARGIN }}>
        {slide(i, innerW, innerH * 0.48)}
        {number(i)}
        <div className="present-print-text">{deck.slides[i].notes}</div>
      </div>
    );
  } else if (job.layout === "h2") {
    const h = (innerH - 40) / 2;
    body = (
      <div className="present-print-sheet present-print-h2" style={{ padding: MARGIN }}>
        {slides.map((i) => (
          <div key={i} className="present-print-cell" style={{ height: h }}>
            {slide(i, innerW, h - 24)}
            {number(i)}
          </div>
        ))}
      </div>
    );
  } else if (job.layout === "h3") {
    const h = (innerH - 30) / 3;
    body = (
      <div className="present-print-sheet present-print-h3" style={{ padding: MARGIN }}>
        {slides.map((i) => (
          <div key={i} className="present-print-row" style={{ height: h }}>
            <div className="present-print-cell">
              {slide(i, innerW * 0.48, h - 24)}
              {number(i)}
            </div>
            <div className="present-print-lines" aria-hidden>
              {Array.from({ length: 6 }, (_, k) => (
                <span key={k} />
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  } else {
    const w = (innerW - 24) / 2;
    const h = (innerH - 40) / 3;
    body = (
      <div className="present-print-sheet present-print-h6" style={{ padding: MARGIN }}>
        {slides.map((i) => (
          <div key={i} className="present-print-cell" style={{ width: w, height: h }}>
            {slide(i, w, h - 24)}
            {number(i)}
          </div>
        ))}
      </div>
    );
  }
  return (
    <section className="present-print-page" style={{ width, height: height - 1 }}>
      {body}
      {job.layout !== "slides" && total > 1 && <span className="present-print-folio">{index + 1}</span>}
    </section>
  );
}

/** Todas las hojas, fuera de la app: solo se ven al imprimir. */
export default function PrintSlides({ deck, job }: { deck: Deck; job: SlidePrintJob }) {
  const { width, height } = sheetSize(job, deck);
  const pages = slidePages(job);
  return createPortal(
    <div className="print-root present-print" aria-hidden>
      <style>{`@page { size: ${width / 96}in ${height / 96}in; margin: 0; }`}</style>
      {pages.map((slides, i) => (
        <SlidePage key={i} deck={deck} job={job} slides={slides} index={i} total={pages.length} />
      ))}
    </div>,
    document.body,
  );
}

const KEY = "wepo.present.print";

type Props = { deck: Deck; current: number; pdf: boolean; onPrint: (job: SlidePrintJob, toPdf: boolean) => void; onClose: () => void };

export function PresentPrintDialog({ deck, current, pdf, onPrint, onClose }: Props) {
  const [layout, setLayout] = useState<SlideLayout>(() => {
    try {
      return (JSON.parse(localStorage.getItem(KEY) ?? "{}").layout as SlideLayout) ?? "slides";
    } catch {
      return "slides";
    }
  });
  const [paper, setPaper] = useState<SlidePaper>(() => {
    try {
      return (JSON.parse(localStorage.getItem(KEY) ?? "{}").paper as SlidePaper) ?? "letter";
    } catch {
      return "letter";
    }
  });
  const [which, setWhich] = useState<"all" | "current" | "range">("all");
  const [range, setRange] = useState("");
  const [hidden, setHidden] = useState(false);
  const [shown, setShown] = useState(0);
  const total = deck.slides.length;
  const hasHidden = deck.slides.some((s) => s.hidden);

  const chosen = which === "all" ? [...Array(total).keys()] : which === "current" ? [current] : parseSlides(range, total);
  // Las ocultas salen solo si se piden (o si se eligieron una por una en el rango o la actual).
  const slides = chosen ? chosen.filter((i) => hidden || which !== "all" || !deck.slides[i].hidden) : null;
  const job: SlidePrintJob | null = slides && slides.length ? { layout, slides, paper } : null;
  const pages = job ? slidePages(job) : [];
  const page = Math.min(shown, Math.max(0, pages.length - 1));
  const size = job ? sheetSize(job, deck) : PAPER[paper];
  const badRange = which === "range" && !chosen;

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
  const zoom = Math.min(paneSize.width / size.width, paneSize.height / size.height);

  function go(toPdf: boolean) {
    if (!job) return;
    try {
      localStorage.setItem(KEY, JSON.stringify({ layout, paper }));
    } catch {
      // Sin almacenamiento las opciones no se recuerdan.
    }
    onPrint(job, toPdf);
  }

  return (
    <Dialog
      title="Imprimir o exportar a PDF"
      onClose={onClose}
      width={Math.min(1120, window.innerWidth - 40)}
      footer={
        <>
          <span className="print-count">{pages.length ? `${pages.length} ${pages.length === 1 ? "hoja" : "hojas"}` : ""}</span>
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className={`btn${pdf ? " btn-primary" : ""}`} onClick={() => go(true)} autoFocus={pdf} disabled={!job}>
            Exportar PDF…
          </button>
          <button className={`btn${pdf ? "" : " btn-primary"}`} onClick={() => go(false)} autoFocus={!pdf} disabled={!job}>
            Imprimir…
          </button>
        </>
      }
    >
      <div className="print-screen">
        <div className="print-settings">
          <fieldset>
            <legend>Qué imprimir</legend>
            {(Object.keys(LAYOUT_LABEL) as SlideLayout[]).map((l) => (
              <label key={l} className="radio">
                <input
                  type="radio"
                  checked={layout === l}
                  onChange={() => {
                    setLayout(l);
                    setShown(0);
                  }}
                />{" "}
                {LAYOUT_LABEL[l]}
              </label>
            ))}
            {layout !== "slides" && (
              <label className="field">
                <span>Papel</span>
                <select className="input" value={paper} onChange={(e) => setPaper(e.target.value as SlidePaper)}>
                  {(Object.keys(PAPER) as SlidePaper[]).map((p) => (
                    <option key={p} value={p}>
                      {PAPER[p].label}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </fieldset>
          <fieldset>
            <legend>Diapositivas</legend>
            <label className="radio">
              <input type="radio" checked={which === "all"} onChange={() => setWhich("all")} /> Todas ({total})
            </label>
            <label className="radio">
              <input type="radio" checked={which === "current"} onChange={() => setWhich("current")} /> La actual ({current + 1})
            </label>
            <label className="radio">
              <input type="radio" checked={which === "range"} onChange={() => setWhich("range")} /> Estas:
            </label>
            <input
              className={`input${badRange ? " invalid" : ""}`}
              value={range}
              placeholder="Por ejemplo: 1-3, 5"
              aria-label="Diapositivas que se imprimen"
              onFocus={() => setWhich("range")}
              onChange={(e) => {
                setRange(e.target.value);
                setWhich("range");
                setShown(0);
              }}
            />
            {badRange && <span className="cf-error">Escribe diapositivas entre 1 y {total}, como 1-3, 5.</span>}
            {hasHidden && (
              <label className="radio">
                <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} /> Incluir las diapositivas ocultas
              </label>
            )}
          </fieldset>
        </div>

        <div className="print-preview">
          <div className="print-preview-pane" ref={pane}>
            {job && pages.length ? (
              <div className="print-preview-sheet" style={{ width: size.width * zoom, height: size.height * zoom }}>
                <div style={{ transform: `scale(${zoom})`, transformOrigin: "0 0", width: size.width, height: size.height }}>
                  <SlidePage deck={deck} job={job} slides={pages[page]} index={page} total={pages.length} />
                </div>
              </div>
            ) : (
              <p className="hint">{badRange ? "Las diapositivas no son válidas." : "No hay diapositivas que imprimir (puede que todas estén ocultas)."}</p>
            )}
          </div>
          <div className="print-pager">
            <button type="button" className="btn btn-icon" disabled={page <= 0} onClick={() => setShown(page - 1)} aria-label="Hoja anterior">
              ‹
            </button>
            <span>{pages.length ? `Hoja ${page + 1} de ${pages.length}` : "Sin hojas"}</span>
            <button type="button" className="btn btn-icon" disabled={page >= pages.length - 1} onClick={() => setShown(page + 1)} aria-label="Hoja siguiente">
              ›
            </button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
