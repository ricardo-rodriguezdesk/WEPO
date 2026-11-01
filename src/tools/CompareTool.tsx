// Comparar PDF: dos versiones lado a lado, con lo que se quitó en rojo, lo que
// se agregó en verde y (si se pide) las partes donde cambió el dibujo.

import { useEffect, useRef, useState } from "react";
import type { ToolDef } from "./tools";
import type { DropHandler } from "./ToolsScreen";
import { ToolFrame, ToolIcon } from "./ToolsScreen";
import type { InputFile } from "./io";
import { pickFiles, readInput, sizeLabel } from "./io";
import { extensionOf } from "../lib/documents";
import type { PDFDocumentProxy } from "../lib/pdf";
import { proxyOf } from "./pdfTools";
import type { Change, Word } from "./compare";
import { changesOf, visualDiff, wordsOf } from "./compare";

const WIDTH = 380;
type Rect = { x: number; y: number; w: number; h: number };
type Compared = { a: PDFDocumentProxy; b: PDFDocumentProxy; changes: Change[]; sizesA: { width: number; height: number }[]; sizesB: { width: number; height: number }[] };

async function sizes(doc: PDFDocumentProxy) {
  const out: { width: number; height: number }[] = [];
  for (let i = 0; i < doc.numPages; i++) {
    const v = (await doc.getPage(i + 1)).getViewport({ scale: 1 });
    out.push({ width: v.width, height: v.height });
  }
  return out;
}

const snippet = (words: Word[]) => {
  const t = words.map((w) => w.text).join(" ");
  return t.length > 80 ? `${t.slice(0, 78)}…` : t;
};

export default function CompareTool({ def, onBack, setDropHandler }: { def: ToolDef; onBack: () => void; setDropHandler: (h: DropHandler) => void }) {
  const [slots, setSlots] = useState<[InputFile | null, InputFile | null]>([null, null]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<Compared | null>(null);
  const [visual, setVisual] = useState(false);
  const [boxes, setBoxes] = useState<Record<number, Rect[]>>({});
  const [focus, setFocus] = useState<number | null>(null);

  const fill = async (paths: string[], slot?: 0 | 1) => {
    const pdfs = paths.filter((p) => extensionOf(p) === "pdf");
    if (!pdfs.length) {
      if (paths.length) setError("Para comparar se necesitan dos PDF");
      return;
    }
    setError(null);
    const read = await Promise.all(pdfs.slice(0, 2).map(readInput));
    setDone(null);
    setSlots((s) => {
      const next: [InputFile | null, InputFile | null] = [...s];
      if (slot !== undefined) next[slot] = read[0];
      else if (read.length === 2) (next[0] = read[0]), (next[1] = read[1]);
      else next[next[0] ? 1 : 0] = read[0];
      return next;
    });
  };
  const fillRef = useRef(fill);
  fillRef.current = fill;
  useEffect(() => {
    setDropHandler((paths) => void fillRef.current(paths));
    return () => setDropHandler(null);
  }, [setDropHandler]);

  async function compare() {
    const [fa, fb] = slots;
    if (!fa || !fb) return;
    setError(null);
    setBoxes({});
    setVisual(false);
    try {
      setBusy("Leyendo los dos PDF…");
      const [a, b] = await Promise.all([proxyOf(fa.bytes, fa.name), proxyOf(fb.bytes, fb.name)]);
      setBusy("Comparando el texto…");
      const [wa, wb] = await Promise.all([wordsOf(a), wordsOf(b)]);
      const changes = changesOf(wa, wb);
      setDone({ a, b, changes, sizesA: await sizes(a), sizesB: await sizes(b) });
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(null);
    }
  }

  async function toggleVisual(on: boolean) {
    setVisual(on);
    if (!on || !done || Object.keys(boxes).length) return;
    setBusy("Comparando el dibujo de cada página…");
    const out: Record<number, Rect[]> = {};
    for (let p = 0; p < Math.min(done.a.numPages, done.b.numPages); p++) out[p] = await visualDiff(done.a, done.b, p);
    setBoxes(out);
    setBusy(null);
  }

  const slot = (i: 0 | 1, label: string) => {
    const f = slots[i];
    return (
      <div className={`tool-compare-slot${f ? " full" : ""}`}>
        <span className="tool-label">{label}</span>
        {f ? (
          <>
            <b className="tool-file-name" title={f.path}>
              {f.name}
            </b>
            <span className="hint">{sizeLabel(f.bytes.length)}</span>
          </>
        ) : (
          <ToolIcon def={def} size={40} />
        )}
        <button type="button" className={`btn${f ? "" : " btn-primary"}`} onClick={async () => fill(await pickFiles("PDF", ["pdf"], false), i)}>
          {f ? "Cambiar" : "Elegir PDF"}
        </button>
      </div>
    );
  };

  if (done) {
    const { changes } = done;
    const counts = { removed: changes.filter((c) => c.kind === "removed").length, added: changes.filter((c) => c.kind === "added").length, changed: changes.filter((c) => c.kind === "changed").length };
    return (
      <ToolFrame def={def} onBack={onBack}>
        <div className="tool-compare-bar">
          <span className="tool-compare-summary" role="status">
            {changes.length
              ? `${changes.length} ${changes.length === 1 ? "diferencia" : "diferencias"} en el texto: ${counts.removed} ${counts.removed === 1 ? "quitada" : "quitadas"}, ${counts.added} ${counts.added === 1 ? "agregada" : "agregadas"}, ${counts.changed} ${counts.changed === 1 ? "cambiada" : "cambiadas"}`
              : "El texto de los dos PDF es igual."}
          </span>
          <label className="tool-check">
            <input type="checkbox" checked={visual} onChange={(e) => toggleVisual(e.target.checked)} disabled={!!busy} />
            Marcar también los cambios de dibujo (imágenes, colores, formas)
          </label>
          {busy && <span className="hint">{busy}</span>}
          <button type="button" className="btn" onClick={() => setDone(null)}>
            Comparar otros
          </button>
        </div>
        <div className="tool-compare">
          <div className="tool-compare-cols">
            <Column title={`Antes: ${slots[0]!.name}`} doc={done.a} sizes={done.sizesA} changes={changes} side="before" focus={focus} visual={null} />
            <Column title={`Después: ${slots[1]!.name}`} doc={done.b} sizes={done.sizesB} changes={changes} side="after" focus={focus} visual={visual ? boxes : null} />
          </div>
          <aside className="tool-compare-list" aria-label="Diferencias">
            {changes.length === 0 && <p className="hint">No hay diferencias en el texto.</p>}
            {changes.map((c, i) => {
              const page = (c.after[0] ?? c.before[0]).page + 1;
              return (
                <button key={i} type="button" className={`tool-change ${c.kind}${focus === i ? " on" : ""}`} onClick={() => setFocus(i)}>
                  <span className="tool-change-kind">{c.kind === "removed" ? "Se quitó" : c.kind === "added" ? "Se agregó" : "Cambió"} · pág. {page}</span>
                  {c.before.length > 0 && <del>{snippet(c.before)}</del>}
                  {c.after.length > 0 && <ins>{snippet(c.after)}</ins>}
                </button>
              );
            })}
          </aside>
        </div>
      </ToolFrame>
    );
  }

  return (
    <ToolFrame def={def} onBack={onBack}>
      <div className="tool-compare-pick">
        {slot(0, "Antes (la versión original)")}
        <span className="tool-compare-vs" aria-hidden>
          ⇄
        </span>
        {slot(1, "Después (la versión nueva)")}
      </div>
      {error && (
        <p className="tool-error" role="alert">
          {error}
        </p>
      )}
      <div className="tool-compare-go">
        <button type="button" className="btn btn-primary tool-run" disabled={!slots[0] || !slots[1] || !!busy} onClick={compare}>
          {busy ?? def.action}
        </button>
        <p className="hint">Puedes arrastrar los dos PDF a la ventana.</p>
      </div>
    </ToolFrame>
  );
}

function Column({ title, doc, sizes, changes, side, focus, visual }: { title: string; doc: PDFDocumentProxy; sizes: { width: number; height: number }[]; changes: Change[]; side: "before" | "after"; focus: number | null; visual: Record<number, Rect[]> | null }) {
  const ref = useRef<HTMLDivElement>(null);
  // Al elegir una diferencia, las dos columnas van a donde está.
  useEffect(() => {
    if (focus === null) return;
    const c = changes[focus];
    const words = side === "before" ? c.before : c.after;
    const w = words[0] ?? (side === "before" ? c.after[0] : c.before[0]);
    if (!w) return;
    const target = ref.current?.querySelector<HTMLElement>(`[data-page="${w.page}"]`);
    const s = WIDTH / (sizes[w.page]?.width || 1);
    if (target && ref.current) ref.current.scrollTo({ top: target.offsetTop + w.y * s - 120, behavior: "smooth" });
  }, [focus, changes, side, sizes]);
  return (
    <div className="tool-compare-col">
      <h3 title={title}>{title}</h3>
      <div className="tool-compare-pages" ref={ref}>
        {sizes.map((size, p) => {
          const s = WIDTH / size.width;
          return (
            <div key={p} className="tool-compare-page" data-page={p} style={{ width: WIDTH, height: size.height * s }}>
              <PageCanvas doc={doc} page={p} width={WIDTH} />
              {changes.map((c, i) =>
                (side === "before" ? c.before : c.after)
                  .filter((w) => w.page === p)
                  .map((w, k) => <span key={`${i}-${k}`} className={`tool-hl ${side === "before" ? "removed" : "added"}${focus === i ? " on" : ""}`} style={{ left: w.x * s - 1, top: w.y * s - 1, width: w.w * s + 2, height: w.h * s + 2 }} />),
              )}
              {visual?.[p]?.map((r, k) => <span key={`v${k}`} className="tool-hl visual" style={{ left: r.x * s, top: r.y * s, width: r.w * s, height: r.h * s }} />)}
              <span className="tool-compare-num">{p + 1}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PageCanvas({ doc, page, width }: { doc: PDFDocumentProxy; page: number; width: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let gone = false;
    (async () => {
      const p = await doc.getPage(page + 1);
      const v = p.getViewport({ scale: 1 });
      const vp = p.getViewport({ scale: (width / v.width) * (window.devicePixelRatio || 1) });
      const c = ref.current;
      if (!c || gone) return;
      c.width = vp.width;
      c.height = vp.height;
      const ctx = c.getContext("2d")!;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, c.width, c.height);
      await p.render({ canvasContext: ctx, viewport: vp, canvas: c } as Parameters<typeof p.render>[0]).promise;
    })().catch(() => {});
    return () => {
      gone = true;
    };
  }, [doc, page, width]);
  return <canvas ref={ref} style={{ width: "100%", height: "100%" }} />;
}
