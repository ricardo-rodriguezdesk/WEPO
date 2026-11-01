// Recortar PDF: arrastra las orillas del recuadro (o escribe los márgenes) y
// elige si va en todas las páginas, solo en esta, o que cada página quite sus
// propios márgenes en blanco.

import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { ToolDef } from "./tools";
import type { DropHandler, ToolResult } from "./ToolsScreen";
import { FileList, PagePreview, ResultBox, ToolFrame, useFiles } from "./ToolsScreen";
import type { Margins } from "./pdfTools";
import { baseName, blankMargins, cropPdf, proxyOf } from "./pdfTools";
import type { PDFDocumentProxy } from "../lib/pdf";
import { saveOutputs } from "./io";

const MM = 25.4 / 72;
const ZERO: Margins = { top: 0, right: 0, bottom: 0, left: 0 };
type Scope = "all" | "current" | "auto";

export default function CropTool({ def, onBack, onOpenPath, setDropHandler }: { def: ToolDef; onBack: () => void; onOpenPath: (p: string) => void; setDropHandler: (h: DropHandler) => void }) {
  const [error, setError] = useState<string | null>(null);
  const list = useFiles(def, setDropHandler, setError);
  const file = list.files[0];
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(0);
  const [m, setM] = useState<Margins>(ZERO);
  const [scope, setScope] = useState<Scope>("all");
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<ToolResult | null>(null);

  useEffect(() => {
    setDoc(null);
    setPage(0);
    setM(ZERO);
    setResult(null);
    if (!file) return;
    let gone = false;
    proxyOf(file.bytes, file.name)
      .then((d) => !gone && setDoc(d))
      .catch((e) => !gone && setError(String(e?.message ?? e)));
    return () => {
      gone = true;
    };
  }, [file]);

  async function autoMargins() {
    if (!doc) return;
    setBusy("Buscando los márgenes en blanco…");
    try {
      setM(await blankMargins(doc, page));
    } finally {
      setBusy(null);
    }
  }

  async function run() {
    if (!file || !doc) return;
    setError(null);
    try {
      let margins: Margins | ((i: number) => Margins | null) = m;
      if (scope === "auto") {
        const all: Margins[] = [];
        for (let i = 0; i < doc.numPages; i++) {
          setBusy(`Buscando los márgenes en blanco… página ${i + 1} de ${doc.numPages}`);
          all.push(await blankMargins(doc, i));
        }
        margins = (i) => all[i];
      }
      setBusy("Recortando…");
      const bytes = await cropPdf(file.bytes, file.name, margins, scope === "current" ? [page] : undefined);
      setBusy("Guardando…");
      const saved = await saveOutputs([{ name: `${baseName(file.name)} (recortado).pdf`, bytes }], file.path, "PDF", "pdf");
      if (!saved) return;
      const what = scope === "auto" ? "Cada página quedó sin sus márgenes en blanco." : scope === "current" ? `Se recortó la página ${page + 1}.` : `Se recortaron las ${doc.numPages} páginas.`;
      setResult({ lines: [what, "Lo que quedó fuera no se borra: se puede recuperar quitando el recorte en otro programa."], saved, open: { path: saved.paths[0], label: "Abrir en WEPO PDF" } });
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(null);
    }
  }

  const mmInput = (key: keyof Margins, label: string) => (
    <label className="tool-field">
      {label}
      <span className="tool-unit">
        <input className="input" type="number" min={0} step={1} value={Math.round(m[key] * MM)} aria-label={`Recorte ${label.toLowerCase()} (mm)`} disabled={scope === "auto"} onChange={(e) => setM({ ...m, [key]: Math.max(0, Number(e.target.value) || 0) / MM })} />
        mm
      </span>
    </label>
  );

  return (
    <ToolFrame def={def} onBack={onBack}>
      <div className="tool-body">
        <div className="tool-main">
          <FileList def={def} {...list} />
          {file && doc && (
            <div className="tool-crop">
              <PagePreview bytes={file.bytes} page={page} width={380} open>
                {(s, size) => <CropBox m={scope === "auto" ? ZERO : m} s={s} size={size} onChange={setM} disabled={scope === "auto"} />}
              </PagePreview>
              {doc.numPages > 1 && (
                <div className="tool-pager">
                  <button type="button" className="btn btn-icon" aria-label="Página anterior" disabled={page === 0} onClick={() => setPage(page - 1)}>
                    ‹
                  </button>
                  <span>{`Página ${page + 1} de ${doc.numPages}`}</span>
                  <button type="button" className="btn btn-icon" aria-label="Página siguiente" disabled={page >= doc.numPages - 1} onClick={() => setPage(page + 1)}>
                    ›
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
        <aside className="tool-side">
          <fieldset className="tool-options" disabled={!!busy || !doc}>
            <legend>Qué recortar</legend>
            {(
              [
                ["all", "Todas las páginas igual", "Con el recuadro de la vista previa."],
                ["current", "Solo esta página", "Las demás quedan como están."],
                ["auto", "Quitar los márgenes en blanco", "Cada página, según lo que tenga."],
              ] as [Scope, string, string][]
            ).map(([id, name, hint]) => (
              <label key={id} className={`tool-choice${scope === id ? " on" : ""}`}>
                <input type="radio" name="scope" checked={scope === id} onChange={() => setScope(id)} />
                <span>
                  <b>{name}</b>
                  <small>{hint}</small>
                </span>
              </label>
            ))}
            {scope !== "auto" && (
              <>
                <div className="tool-row">
                  {mmInput("top", "Arriba")}
                  {mmInput("bottom", "Abajo")}
                </div>
                <div className="tool-row">
                  {mmInput("left", "Izquierda")}
                  {mmInput("right", "Derecha")}
                </div>
                <div className="tool-row">
                  <button type="button" className="btn" onClick={autoMargins}>
                    Ajustar a lo que hay
                  </button>
                  <button type="button" className="btn" onClick={() => setM(ZERO)}>
                    Sin recorte
                  </button>
                </div>
              </>
            )}
          </fieldset>
          {error && (
            <p className="tool-error" role="alert">
              {error}
            </p>
          )}
          {result ? (
            <ResultBox result={result} onOpenPath={onOpenPath} onReset={() => (setResult(null), list.setFiles([]))} />
          ) : (
            <button type="button" className="btn btn-primary tool-run" disabled={!doc || !!busy || (scope !== "auto" && !m.top && !m.bottom && !m.left && !m.right)} onClick={run}>
              {busy ?? def.action}
            </button>
          )}
        </aside>
      </div>
    </ToolFrame>
  );
}

/** El recuadro que queda: se mueve cada orilla (o una esquina) arrastrando. */
function CropBox({ m, s, size, onChange, disabled }: { m: Margins; s: number; size: { width: number; height: number }; onChange: (m: Margins) => void; disabled: boolean }) {
  const drag = useRef<{ edges: (keyof Margins)[]; x: number; y: number; start: Margins } | null>(null);
  const begin = (edges: (keyof Margins)[]) => (e: ReactPointerEvent) => {
    if (disabled) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { edges, x: e.clientX, y: e.clientY, start: m };
  };
  const moveTo = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.x) / s;
    const dy = (e.clientY - d.y) / s;
    const next = { ...d.start };
    const minW = 36;
    for (const edge of d.edges) {
      if (edge === "left") next.left = Math.max(0, Math.min(size.width - next.right - minW, d.start.left + dx));
      if (edge === "right") next.right = Math.max(0, Math.min(size.width - next.left - minW, d.start.right - dx));
      if (edge === "top") next.top = Math.max(0, Math.min(size.height - next.bottom - minW, d.start.top + dy));
      if (edge === "bottom") next.bottom = Math.max(0, Math.min(size.height - next.top - minW, d.start.bottom - dy));
    }
    onChange(next);
  };
  const end = () => (drag.current = null);
  const box = { left: m.left * s, top: m.top * s, width: (size.width - m.left - m.right) * s, height: (size.height - m.top - m.bottom) * s };
  const handles: [string, (keyof Margins)[]][] = [
    ["n", ["top"]],
    ["s", ["bottom"]],
    ["w", ["left"]],
    ["e", ["right"]],
    ["nw", ["top", "left"]],
    ["ne", ["top", "right"]],
    ["sw", ["bottom", "left"]],
    ["se", ["bottom", "right"]],
  ];
  const W = size.width * s;
  const H = size.height * s;
  return (
    <>
      {!disabled && (
        <>
          {/* Lo que se va a quitar, oscurecido. */}
          <span className="tool-crop-shade" style={{ left: 0, top: 0, width: W, height: box.top }} />
          <span className="tool-crop-shade" style={{ left: 0, top: box.top + box.height, width: W, height: H - box.top - box.height }} />
          <span className="tool-crop-shade" style={{ left: 0, top: box.top, width: box.left, height: box.height }} />
          <span className="tool-crop-shade" style={{ left: box.left + box.width, top: box.top, width: W - box.left - box.width, height: box.height }} />
        </>
      )}
      <div className={`tool-cropbox${disabled ? " off" : ""}`} style={box} onPointerMove={moveTo} onPointerUp={end} onPointerCancel={end} data-testid="crop-box">
        {!disabled && handles.map(([id, edges]) => <span key={id} className={`tool-crop-handle h-${id}`} data-handle={id} onPointerDown={begin(edges)} />)}
      </div>
    </>
  );
}
