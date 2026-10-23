import { createPortal } from "react-dom";
import type { Deck } from "./model";
import SlideView from "./SlideView";

export type SlidePrintJob = { notes: boolean; hidden: boolean };

/**
 * Versión de la presentación para imprimir o guardar como PDF: una diapositiva por
 * hoja (del tamaño de la diapositiva) o, con notas, la diapositiva arriba y sus notas abajo.
 */
export default function PrintSlides({ deck, job }: { deck: Deck; job: SlidePrintJob }) {
  const slides = deck.slides.filter((s) => job.hidden || !s.hidden);
  // Una diapositiva de 1280 × 720 px mide 13.333 × 7.5 pulgadas (96 px por pulgada).
  const pageCss = job.notes
    ? "@page { size: letter portrait; margin: 0.6in; }"
    : `@page { size: ${deck.width / 96}in ${deck.height / 96}in; margin: 0; }`;
  // En la hoja con notas, la diapositiva ocupa el ancho de la hoja carta menos los márgenes.
  const notesScale = (7.3 * 96) / deck.width;
  return createPortal(
    <div className="print-root present-print" aria-hidden>
      <style>{pageCss}</style>
      {slides.map((s, i) =>
        job.notes ? (
          <section key={s.id} className="present-print-notes">
            <SlideView slide={s} deck={deck} scale={notesScale} />
            <p className="present-print-number">Diapositiva {deck.slides.indexOf(s) + 1}</p>
            <div className="present-print-text">{s.notes}</div>
            {i < slides.length - 1 && <div className="present-print-break" />}
          </section>
        ) : (
          <section key={s.id} className="present-print-page">
            <SlideView slide={s} deck={deck} scale={1} />
          </section>
        ),
      )}
    </div>,
    document.body,
  );
}
