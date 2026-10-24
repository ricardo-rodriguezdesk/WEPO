// Imprimir o exportar a PDF en WEPO Write, con vista previa.
//
// Write dibuja el documento como una sola columna con franjas entre hojas (ver
// la paginación en extensions.ts). Para imprimir solo algunas páginas, o con los
// comentarios al final, se toma una copia de lo que se ve y se recorta en hojas
// del tamaño del papel. La vista previa usa esas mismas hojas: lo que se ve es lo que sale.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Dialog from "../../components/Dialog";
import type { Comment } from "./review";
import type { PageSize } from "./docx";
import "../sheets/PrintDialog.css";
import "../sheets/print.css";

const px = (twips: number) => twips / 15;

/** Copia de las páginas tal como se ven, y dónde empieza cada una (px, sin zoom). */
export type Snapshot = { html: string; tops: number[]; width: number; height: number };

export function snapshotPages(pageEl: HTMLElement, page: PageSize): Snapshot {
  const rect = pageEl.getBoundingClientRect();
  const k = rect.height / Math.max(1, pageEl.offsetHeight);
  const tops = [0, ...Array.from(pageEl.querySelectorAll(".write-gap-band")).map((b) => (b.getBoundingClientRect().bottom - rect.top) / k)];
  const clone = pageEl.cloneNode(true) as HTMLElement;
  clone.style.zoom = "1";
  clone.style.margin = "0";
  clone.querySelectorAll("[contenteditable]").forEach((el) => el.removeAttribute("contenteditable"));
  clone.querySelectorAll(".ProseMirror-selectednode, .write-match, .ProseMirror-focused").forEach((el) => el.classList.remove("ProseMirror-selectednode", "write-match", "ProseMirror-focused"));
  return { html: clone.outerHTML, tops, width: px(page.width), height: px(page.height) };
}

/** "1-3, 5" → [0, 1, 2, 4] (desde 0). null si no se entiende o se sale del documento. */
export function parsePages(text: string, total: number): number[] | null {
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

/** Una hoja del documento: la copia recortada a esa página. */
function DocPage({ snap, index, comments }: { snap: Snapshot; index: number; comments: boolean }) {
  return (
    <section className={`write-print-frame${comments ? "" : " no-comments"}`} style={{ width: snap.width, height: snap.height - 1 }}>
      <div style={{ marginTop: -snap.tops[index] }} dangerouslySetInnerHTML={{ __html: snap.html }} />
    </section>
  );
}

export type CommentEntry = { comment: Comment; quote: string };

const dateText = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("es-MX", { day: "numeric", month: "short", year: "numeric" });
};

function CommentItem({ entry, n }: { entry: CommentEntry; n: number }) {
  const { comment, quote } = entry;
  return (
    <div className="write-print-comment">
      <div className="write-print-comment-head">
        <b>
          {n}. {comment.author}
        </b>
        <span>{dateText(comment.date)}</span>
        {comment.done && <span className="write-print-done">Resuelto</span>}
      </div>
      {quote && <div className="write-print-quote">«{quote.length > 220 ? `${quote.slice(0, 220)}…` : quote}»</div>}
      <div className="write-print-text">{comment.text}</div>
      {comment.replies.map((r) => (
        <div key={r.id} className="write-print-reply">
          <b>{r.author}</b> <span>{dateText(r.date)}</span>
          <div className="write-print-text">{r.text}</div>
        </div>
      ))}
    </div>
  );
}

/** Hoja con comentarios (los que caben en ella). */
function CommentsPage({ entries, items, first, page, width, height }: { entries: CommentEntry[]; items: number[]; first: boolean; page: PageSize; width: number; height: number }) {
  return (
    <section className="write-print-frame write-print-comments" style={{ width, height: height - 1, padding: `${px(page.top)}px ${px(page.right)}px ${px(page.bottom)}px ${px(page.left)}px` }}>
      {first && <h2>Comentarios</h2>}
      {items.map((i) => (
        <CommentItem key={entries[i].comment.id} entry={entries[i]} n={i + 1} />
      ))}
    </section>
  );
}

/** Reparte los comentarios en hojas según lo que mide cada uno. */
function useCommentPages(entries: CommentEntry[], page: PageSize, enabled: boolean): { pages: number[][]; measurer: React.ReactNode } {
  const box = useRef<HTMLDivElement>(null);
  const [pages, setPages] = useState<number[][]>([]);
  const width = px(page.width) - px(page.left) - px(page.right);
  const available = px(page.height) - px(page.top) - px(page.bottom);
  useLayoutEffect(() => {
    if (!enabled || !entries.length || !box.current) return setPages([]);
    const title = (box.current.querySelector("h2") as HTMLElement | null)?.offsetHeight ?? 40;
    const heights = Array.from(box.current.querySelectorAll<HTMLElement>(".write-print-comment")).map((el) => el.offsetHeight + 10);
    const out: number[][] = [[]];
    let used = title + 12;
    heights.forEach((h, i) => {
      if (out[out.length - 1].length && used + h > available) {
        out.push([]);
        used = 0;
      }
      out[out.length - 1].push(i);
      used += h;
    });
    setPages(out);
  }, [entries, enabled, width, available]);
  const measurer = enabled && entries.length ? (
    <div ref={box} className="write-print-comments write-print-measure" style={{ width }} aria-hidden>
      <h2>Comentarios</h2>
      {entries.map((e, i) => (
        <CommentItem key={e.comment.id} entry={e} n={i + 1} />
      ))}
    </div>
  ) : null;
  return { pages, measurer };
}

export type WritePrintJob = { snap: Snapshot; pages: number[]; comments: CommentEntry[]; commentPages: number[][]; page: PageSize };

/** Lo que se imprime, fuera de la app: solo se ve al imprimir. */
export function WritePrintPortal({ job }: { job: WritePrintJob }) {
  const { snap } = job;
  return createPortal(
    <div className="print-root write-print-root" aria-hidden>
      <style>{`@page { size: ${snap.width / 96}in ${snap.height / 96}in; margin: 0; }`}</style>
      {job.pages.map((i) => (
        <DocPage key={i} snap={snap} index={i} comments={job.commentPages.length > 0} />
      ))}
      {job.commentPages.map((items, i) => (
        <CommentsPage key={`c${i}`} entries={job.comments} items={items} first={i === 0} page={job.page} width={snap.width} height={snap.height} />
      ))}
    </div>,
    document.body,
  );
}

type Props = {
  /** Toma una copia de las páginas (después de que el documento se acomoda). */
  snapshot: () => Snapshot;
  page: PageSize;
  /** Página donde está el cursor (desde 0). */
  currentPage: number;
  comments: CommentEntry[];
  /** Cambiar el tamaño u orientación de la hoja del documento. */
  onPageChange: (page: PageSize) => void;
  sizes: { label: string; width: number; height: number }[];
  /** `all`: todo el documento sin comentarios (se imprime directo, como siempre). */
  onPrint: (job: WritePrintJob, toPdf: boolean, all: boolean) => void;
  onClose: () => void;
  pdf?: boolean;
};

export default function WritePrintDialog({ snapshot, page, currentPage, comments, onPageChange, sizes, onPrint, onClose, pdf = false }: Props) {
  const [snap, setSnap] = useState<Snapshot>(() => snapshot());
  const [which, setWhich] = useState<"all" | "current" | "range">("all");
  const [range, setRange] = useState("");
  const [withComments, setWithComments] = useState(false);
  const [current, setCurrent] = useState(0);

  // Al cambiar la hoja, el documento se vuelve a acomodar: se toma otra copia.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    // Se espera a que las páginas dejen de moverse (la paginación tarda unos cuadros).
    let cancelled = false;
    let last = "";
    let steady = 0;
    let tries = 0;
    const tick = () => {
      if (cancelled) return;
      const next = snapshot();
      const key = `${next.tops.join(",")}|${next.html.length}`;
      steady = key === last ? steady + 1 : 0;
      last = key;
      tries++;
      if (steady >= 2 || tries > 20) setSnap(next);
      else setTimeout(tick, 120);
    };
    const timer = setTimeout(tick, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [page.width, page.height]); // eslint-disable-line react-hooks/exhaustive-deps

  const total = snap.tops.length;
  const selected = which === "all" ? [...Array(total).keys()] : which === "current" ? [Math.min(currentPage, total - 1)] : parsePages(range, total);
  const { pages: commentPages, measurer } = useCommentPages(comments, page, withComments);
  const previews = useMemo(
    () => [...(selected ?? []).map((i) => ({ kind: "doc" as const, i })), ...(withComments ? commentPages.map((items, i) => ({ kind: "comments" as const, i, items })) : [])],
    [selected?.join(","), withComments, commentPages], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const shown = Math.min(current, Math.max(0, previews.length - 1));

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
  const zoom = Math.min(paneSize.width / snap.width, paneSize.height / snap.height);

  const landscape = page.width > page.height;
  const sizeLabel = sizes.find((s) => (s.width === page.width && s.height === page.height) || (s.height === page.width && s.width === page.height))?.label ?? "Personalizado";
  const badRange = which === "range" && !selected;

  function go(toPdf: boolean) {
    if (!selected) return;
    const job: WritePrintJob = { snap, pages: selected, comments, commentPages: withComments ? commentPages : [], page };
    onPrint(job, toPdf, which === "all" && !withComments);
  }

  const item = previews[shown];
  return (
    <Dialog
      title="Imprimir o exportar a PDF"
      onClose={onClose}
      width={Math.min(1120, window.innerWidth - 40)}
      footer={
        <>
          <span className="print-count">{previews.length ? `${previews.length} ${previews.length === 1 ? "página" : "páginas"}` : ""}</span>
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className={`btn${pdf ? " btn-primary" : ""}`} onClick={() => go(true)} autoFocus={pdf} disabled={!selected}>
            Exportar PDF…
          </button>
          <button className={`btn${pdf ? "" : " btn-primary"}`} onClick={() => go(false)} autoFocus={!pdf} disabled={!selected}>
            Imprimir…
          </button>
        </>
      }
    >
      <div className="print-screen">
        <div className="print-settings">
          <fieldset>
            <legend>Páginas</legend>
            <label className="radio">
              <input type="radio" checked={which === "all"} onChange={() => setWhich("all")} /> Todas ({total})
            </label>
            <label className="radio">
              <input type="radio" checked={which === "current"} onChange={() => setWhich("current")} /> Página actual ({Math.min(currentPage, total - 1) + 1})
            </label>
            <label className="radio">
              <input type="radio" checked={which === "range"} onChange={() => setWhich("range")} /> Estas páginas:
            </label>
            <input
              className={`input${badRange ? " invalid" : ""}`}
              value={range}
              placeholder="Por ejemplo: 1-3, 5"
              aria-label="Páginas que se imprimen"
              onFocus={() => setWhich("range")}
              onChange={(e) => {
                setRange(e.target.value);
                setWhich("range");
                setCurrent(0);
              }}
            />
            {badRange && <span className="cf-error">Escribe páginas entre 1 y {total}, como 1-3, 5.</span>}
          </fieldset>

          <fieldset>
            <legend>Hoja del documento</legend>
            <label className="field">
              <span>Tamaño</span>
              <select
                className="input"
                value={sizeLabel}
                onChange={(e) => {
                  const s = sizes.find((x) => x.label === e.target.value);
                  if (s) onPageChange({ ...page, width: landscape ? s.height : s.width, height: landscape ? s.width : s.height });
                }}
              >
                {sizes.map((s) => (
                  <option key={s.label}>{s.label}</option>
                ))}
                {sizeLabel === "Personalizado" && <option>Personalizado</option>}
              </select>
            </label>
            <div className="print-segment" role="radiogroup" aria-label="Orientación">
              <button type="button" className={!landscape ? "on" : ""} onClick={() => landscape && onPageChange({ ...page, width: page.height, height: page.width })}>
                Vertical
              </button>
              <button type="button" className={landscape ? "on" : ""} onClick={() => !landscape && onPageChange({ ...page, width: page.height, height: page.width })}>
                Horizontal
              </button>
            </div>
            <span className="hint">Cambia la hoja del documento (como en Word): el texto se vuelve a acomodar.</span>
          </fieldset>

          <fieldset>
            <legend>Comentarios</legend>
            <label className="radio">
              <input type="checkbox" checked={withComments} disabled={!comments.length} onChange={(e) => setWithComments(e.target.checked)} /> Imprimir los comentarios al final
            </label>
            <span className="hint">{comments.length ? `${comments.length} ${comments.length === 1 ? "comentario" : "comentarios"} en el documento.` : "El documento no tiene comentarios."}</span>
          </fieldset>
        </div>

        <div className="print-preview">
          <div className="print-preview-pane" ref={pane}>
            {item ? (
              <div className="print-preview-sheet" style={{ width: snap.width * zoom, height: snap.height * zoom }}>
                <div style={{ transform: `scale(${zoom})`, transformOrigin: "0 0", width: snap.width, height: snap.height }}>
                  {item.kind === "doc" ? (
                    <DocPage snap={snap} index={item.i} comments={withComments} />
                  ) : (
                    <CommentsPage entries={comments} items={item.items} first={item.i === 0} page={page} width={snap.width} height={snap.height} />
                  )}
                </div>
              </div>
            ) : (
              <p className="hint">{badRange ? "Las páginas no son válidas." : "No hay páginas que imprimir."}</p>
            )}
          </div>
          <div className="print-pager">
            <button type="button" className="btn btn-icon" disabled={shown <= 0} onClick={() => setCurrent(shown - 1)} aria-label="Página anterior">
              ‹
            </button>
            <span>
              {item ? (item.kind === "doc" ? `Página ${item.i + 1} del documento` : `Comentarios (${item.i + 1})`) : "Sin páginas"}
              {previews.length > 1 ? ` · ${shown + 1} de ${previews.length}` : ""}
            </span>
            <button type="button" className="btn btn-icon" disabled={shown >= previews.length - 1} onClick={() => setCurrent(shown + 1)} aria-label="Página siguiente">
              ›
            </button>
          </div>
        </div>
      </div>
      {measurer}
    </Dialog>
  );
}
