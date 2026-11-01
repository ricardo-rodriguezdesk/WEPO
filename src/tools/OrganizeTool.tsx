// Ordenar PDF: las páginas en miniatura; se arrastran para cambiarlas de lugar,
// se giran o se quitan, y se guarda el PDF nuevo.

import { useEffect, useRef, useState } from "react";
import type { ToolDef } from "./tools";
import type { DropHandler, ToolResult } from "./ToolsScreen";
import { FileList, ResultBox, ToolFrame, useFiles } from "./ToolsScreen";
import type { PDFDocumentProxy } from "../lib/pdf";
import { baseName, proxyOf } from "./pdfTools";
import { reorderPdf } from "./moreTools";
import { saveOutputs } from "./io";

type Item = { key: string; index: number; rotation: number };
const THUMB = 130;

export default function OrganizeTool({ def, onBack, onOpenPath, setDropHandler }: { def: ToolDef; onBack: () => void; onOpenPath: (p: string) => void; setDropHandler: (h: DropHandler) => void }) {
  const [error, setError] = useState<string | null>(null);
  const list = useFiles(def, setDropHandler, setError);
  const file = list.files[0];
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<ToolResult | null>(null);

  const reset = (d: PDFDocumentProxy | null) => {
    setItems(d ? Array.from({ length: d.numPages }, (_, i) => ({ key: `p${i}`, index: i, rotation: 0 })) : []);
    setSelected(new Set());
  };

  useEffect(() => {
    setDoc(null);
    reset(null);
    setResult(null);
    if (!file) return;
    let gone = false;
    proxyOf(file.bytes, file.name)
      .then((d) => {
        if (gone) return;
        setDoc(d);
        reset(d);
      })
      .catch((e) => !gone && setError(String(e?.message ?? e)));
    return () => {
      gone = true;
    };
  }, [file]);

  const targets = (key?: string) => (key && !selected.has(key) ? new Set([key]) : selected);
  const rotate = (delta: number, key?: string) => {
    const t = targets(key);
    setItems((list) => list.map((it) => (t.has(it.key) ? { ...it, rotation: (((it.rotation + delta) % 360) + 360) % 360 } : it)));
  };
  const remove = (key?: string) => {
    const t = targets(key);
    setItems((list) => list.filter((it) => !t.has(it.key)));
    setSelected(new Set());
  };
  const moveTo = (from: string, to: string) => {
    if (from === to) return;
    setItems((list) => {
      const moving = selected.has(from) ? list.filter((it) => selected.has(it.key)) : list.filter((it) => it.key === from);
      const rest = list.filter((it) => !moving.includes(it));
      const at = rest.findIndex((it) => it.key === to);
      const fromIndex = list.findIndex((it) => it.key === from);
      const toIndex = list.findIndex((it) => it.key === to);
      const pos = at < 0 ? rest.length : fromIndex < toIndex ? at + 1 : at;
      return [...rest.slice(0, pos), ...moving, ...rest.slice(pos)];
    });
  };
  const click = (e: React.MouseEvent, key: string) => {
    const next = new Set(e.metaKey || e.ctrlKey || e.shiftKey ? selected : []);
    if (next.has(key) && (e.metaKey || e.ctrlKey)) next.delete(key);
    else next.add(key);
    setSelected(next);
  };

  async function run() {
    if (!file || !items.length) return;
    setError(null);
    try {
      setBusy("Guardando…");
      const bytes = await reorderPdf(
        file.bytes,
        file.name,
        items.map((it) => ({ index: it.index, rotation: it.rotation })),
      );
      const saved = await saveOutputs([{ name: `${baseName(file.name)} (ordenado).pdf`, bytes }], file.path, "PDF", "pdf");
      if (!saved) return;
      const removed = (doc?.numPages ?? 0) - items.length;
      const turned = items.filter((it) => it.rotation).length;
      const lines = [`${items.length} ${items.length === 1 ? "página" : "páginas"}${removed ? `, ${removed} ${removed === 1 ? "quitada" : "quitadas"}` : ""}${turned ? `, ${turned} ${turned === 1 ? "girada" : "giradas"}` : ""}.`];
      setResult({ lines, saved, open: { path: saved.paths[0], label: "Abrir en WEPO PDF" } });
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(null);
    }
  }

  const changed = doc && (items.length !== doc.numPages || items.some((it, i) => it.index !== i || it.rotation));
  return (
    <ToolFrame def={def} onBack={onBack}>
      <div className="tool-body">
        <div className="tool-main">
          <FileList def={def} {...list} />
          {doc && (
            <>
              <div className="tool-organize-bar">
                <span className="hint">{selected.size ? `${selected.size} ${selected.size === 1 ? "elegida" : "elegidas"}` : "Arrastra las páginas para cambiarlas de lugar; ⌘ o ⇧ + clic para elegir varias"}</span>
                <button type="button" className="btn" disabled={!selected.size} onClick={() => rotate(-90)}>
                  ↺ Girar
                </button>
                <button type="button" className="btn" disabled={!selected.size} onClick={() => rotate(90)}>
                  ↻ Girar
                </button>
                <button type="button" className="btn" disabled={!selected.size || selected.size === items.length} onClick={() => remove()}>
                  Quitar
                </button>
                <button type="button" className="btn" onClick={() => setItems((l) => [...l].reverse())}>
                  Orden inverso
                </button>
                <button type="button" className="btn" disabled={!changed} onClick={() => reset(doc)}>
                  Como estaba
                </button>
              </div>
              <ol className="tool-organize" aria-label="Páginas">
                {items.map((it, n) => (
                  <li
                    key={it.key}
                    className={`tool-thumb${selected.has(it.key) ? " on" : ""}${dragging === it.key ? " dragging" : ""}${over === it.key && dragging !== it.key ? " over" : ""}`}
                    draggable
                    data-page={it.index + 1}
                    aria-label={`Página ${it.index + 1}${it.rotation ? `, girada ${it.rotation}°` : ""}`}
                    onClick={(e) => click(e, it.key)}
                    onDragStart={(e) => {
                      setDragging(it.key);
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("text/plain", it.key);
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setOver(it.key);
                    }}
                    onDragLeave={() => setOver((o) => (o === it.key ? null : o))}
                    onDrop={(e) => {
                      e.preventDefault();
                      const from = e.dataTransfer.getData("text/plain") || dragging;
                      if (from) moveTo(from, it.key);
                      setDragging(null);
                      setOver(null);
                    }}
                    onDragEnd={() => (setDragging(null), setOver(null))}
                  >
                    <Thumb doc={doc} index={it.index} rotation={it.rotation} />
                    <span className="tool-thumb-num">{n + 1}</span>
                    <span className="tool-thumb-actions">
                      <button type="button" aria-label={`Girar la página ${it.index + 1} a la izquierda`} onClick={(e) => (e.stopPropagation(), rotate(-90, it.key))}>
                        ↺
                      </button>
                      <button type="button" aria-label={`Girar la página ${it.index + 1} a la derecha`} onClick={(e) => (e.stopPropagation(), rotate(90, it.key))}>
                        ↻
                      </button>
                      <button type="button" aria-label={`Quitar la página ${it.index + 1}`} disabled={items.length === 1} onClick={(e) => (e.stopPropagation(), remove(it.key))}>
                        ×
                      </button>
                    </span>
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>
        <aside className="tool-side">
          <div className="tool-options tool-note">
            <p>Mueve las páginas arrastrándolas, gíralas con ↺ ↻ o quítalas con ×. El original no se toca.</p>
          </div>
          {error && (
            <p className="tool-error" role="alert">
              {error}
            </p>
          )}
          {result ? (
            <ResultBox result={result} onOpenPath={onOpenPath} onReset={() => (setResult(null), list.setFiles([]))} />
          ) : (
            <button type="button" className="btn btn-primary tool-run" disabled={!doc || !changed || !!busy} onClick={run}>
              {busy ?? def.action}
            </button>
          )}
        </aside>
      </div>
    </ToolFrame>
  );
}

function Thumb({ doc, index, rotation }: { doc: PDFDocumentProxy; index: number; rotation: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [ratio, setRatio] = useState(1.3);
  useEffect(() => {
    let gone = false;
    (async () => {
      const p = await doc.getPage(index + 1);
      const v = p.getViewport({ scale: 1 });
      const vp = p.getViewport({ scale: (THUMB / Math.max(v.width, v.height)) * (window.devicePixelRatio || 1) });
      const c = ref.current;
      if (!c || gone) return;
      c.width = vp.width;
      c.height = vp.height;
      setRatio(v.height / v.width);
      const ctx = c.getContext("2d")!;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, c.width, c.height);
      await p.render({ canvasContext: ctx, viewport: vp, canvas: c } as Parameters<typeof p.render>[0]).promise;
    })().catch(() => {});
    return () => {
      gone = true;
    };
  }, [doc, index]);
  const w = ratio >= 1 ? THUMB / ratio : THUMB;
  const h = ratio >= 1 ? THUMB : THUMB * ratio;
  return (
    <span className="tool-thumb-page">
      <canvas ref={ref} style={{ width: w, height: h, transform: `rotate(${rotation}deg)` }} />
    </span>
  );
}
