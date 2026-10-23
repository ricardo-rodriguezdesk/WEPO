import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import Dialog from "../../components/Dialog";
import type { Annotation, FormValues, Ink, PageRef } from "./pdfEdit";
import { pid, rectToPdf, rectToView, shownSize, toPdf, toView } from "./pdfEdit";
import { selectedTextRects } from "./textSelection";

export type Tool = "select" | "highlight" | "text" | "draw" | "note" | "sign";

/** Campo de formulario de una página, como lo describe pdf.js. */
export type FormField = {
  name: string;
  type: "text" | "checkbox" | "radio" | "choice";
  rect: [number, number, number, number];
  value: string | boolean;
  options?: string[];
  /** Valor que marca este botón (casillas y botones de opción). */
  exportValue?: string;
  multiline?: boolean;
  readOnly?: boolean;
};

/** Nota que ya venía en el archivo (de Vista Previa, Acrobat o una versión anterior). */
export type FileNote = { id: string; rect: [number, number, number, number]; text: string; author: string; drawn: boolean };

export type ToolStyle = { highlight: string; ink: string; inkWidth: number; textColor: string; textSize: number };

type Props = {
  page: PageRef;
  /** Píxeles de pantalla por punto del PDF. */
  scale: number;
  tool: Tool;
  style: ToolStyle;
  annotations: Annotation[];
  selected: string | null;
  fields: FormField[];
  /** Notas que ya traía el PDF: se ven y se leen. */
  fileNotes?: FileNote[];
  form: FormValues;
  /** Firma lista para colocar con un clic (herramienta Firmar). */
  signature: { src: string; ratio: number } | null;
  onAdd: (a: Annotation) => void;
  onChange: (a: Annotation, record?: boolean) => void;
  onSelect: (id: string | null) => void;
  onForm: (name: string, value: string | boolean) => void;
  onNeedSignature: () => void;
};

/** Lo que se dibuja encima de una página: resaltados, texto, trazos, notas, firmas y campos de formulario. */
export default function AnnotationLayer(props: Props) {
  const { page, scale: s, tool, annotations, selected } = props;
  const layer = useRef<HTMLDivElement>(null);
  const [drawing, setDrawing] = useState<[number, number][] | null>(null);
  const [box, setBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [openNote, setOpenNote] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const drag = useRef<{ id: string; x: number; y: number; orig: Annotation; moved: boolean; resize?: boolean } | null>(null);

  function local(e: { clientX: number; clientY: number }): [number, number] {
    const r = layer.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  // ───── crear con la herramienta elegida ─────

  function onPointerDown(e: ReactPointerEvent) {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest("[data-annot], .pdf-field, .pdf-note-popup, .pdf-text-edit")) return;
    const [vx, vy] = local(e);
    if (tool === "draw") {
      e.preventDefault();
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      setDrawing([[vx, vy]]);
    } else if (tool === "highlight") {
      // Sin texto seleccionable (un escaneo), se resalta un recuadro arrastrando.
      if (!target.closest(".textLayer span")) {
        e.preventDefault();
        setBox({ x: vx, y: vy, w: 0, h: 0 });
      }
    } else if (tool === "text") {
      e.preventDefault();
      const [x, y] = toPdf(page, s, vx, vy - props.style.textSize * s * 0.6);
      const a: Annotation = { id: pid("a"), page: page.id, kind: "text", x, y, text: "", size: props.style.textSize, color: props.style.textColor };
      props.onAdd(a);
      setEditing(a.id);
    } else if (tool === "note") {
      e.preventDefault();
      const [x, y] = toPdf(page, s, vx - 10, vy - 10);
      const a: Annotation = { id: pid("a"), page: page.id, kind: "note", x, y, text: "" };
      props.onAdd(a);
      setOpenNote(a.id);
    } else if (tool === "sign") {
      e.preventDefault();
      if (!props.signature) return props.onNeedSignature();
      const w = 180 * s;
      const h = w / props.signature.ratio;
      const [x, y] = toPdf(page, s, vx - w / 2, vy + h / 2);
      props.onAdd({ id: pid("a"), page: page.id, kind: "image", x, y, w: 180, h: 180 / props.signature.ratio, src: props.signature.src });
    } else {
      props.onSelect(null);
    }
  }

  function onPointerMove(e: ReactPointerEvent) {
    if (drawing) setDrawing([...drawing, local(e)]);
    else if (box) {
      const [vx, vy] = local(e);
      setBox({ ...box, w: vx - box.x, h: vy - box.y });
    } else if (drag.current) {
      const d = drag.current;
      const dx = (e.clientX - d.x) / s;
      const dy = (e.clientY - d.y) / s;
      if (!d.moved && Math.abs(dx * s) < 3 && Math.abs(dy * s) < 3) return;
      d.moved = true;
      props.onChange(d.resize ? resized(d.orig, dx) : moved(d.orig, dx, dy), false);
    }
  }

  function onPointerUp(e: ReactPointerEvent) {
    if (drawing) {
      if (drawing.length > 1) {
        const ink: Ink = { id: pid("a"), page: page.id, kind: "ink", paths: [drawing.map(([x, y]) => toPdf(page, s, x, y))], color: props.style.ink, width: props.style.inkWidth };
        props.onAdd(ink);
      }
      setDrawing(null);
    } else if (box) {
      if (Math.abs(box.w) > 4 && Math.abs(box.h) > 4) {
        const x = Math.min(box.x, box.x + box.w);
        const y = Math.min(box.y, box.y + box.h);
        props.onAdd({ id: pid("a"), page: page.id, kind: "highlight", rects: [rectToPdf(page, s, x, y, Math.abs(box.w), Math.abs(box.h))], color: props.style.highlight });
      }
      setBox(null);
    } else if (drag.current) {
      const d = drag.current;
      drag.current = null;
      if (d.moved) {
        // Se anota para deshacer: el cambio completo de una sola vez.
        const dx = (e.clientX - d.x) / s;
        const dy = (e.clientY - d.y) / s;
        props.onChange(d.resize ? resized(d.orig, dx) : moved(d.orig, dx, dy), true);
      }
    }
  }

  /** Mover una anotación: el arrastre en pantalla convertido a puntos del PDF. */
  function moved(a: Annotation, dx: number, dy: number): Annotation {
    const [ox, oy] = toPdf(page, 1, 0, 0);
    const [px, py] = toPdf(page, 1, dx, dy);
    const mx = px - ox;
    const my = py - oy;
    if (a.kind === "highlight") return { ...a, rects: a.rects.map(([x, y, w, h]) => [x + mx, y + my, w, h]) };
    if (a.kind === "ink") return { ...a, paths: a.paths.map((path) => path.map(([x, y]) => [x + mx, y + my])) };
    return { ...a, x: a.x + mx, y: a.y + my };
  }

  function resized(a: Annotation, dx: number): Annotation {
    if (a.kind !== "image") return a;
    const w = Math.max(30, a.w + dx);
    const h = (w * a.h) / a.w;
    // La esquina de arriba a la izquierda se queda en su lugar.
    return { ...a, w, h, y: a.y + a.h - h };
  }

  function startDrag(e: ReactPointerEvent, a: Annotation, resize = false) {
    if (tool !== "select" && tool !== "sign") return;
    e.stopPropagation();
    e.preventDefault();
    props.onSelect(a.id);
    drag.current = { id: a.id, x: e.clientX, y: e.clientY, orig: structuredClone(a), moved: false, resize };
  }

  // Al soltar el mouse con texto elegido (herramienta Resaltar), ese texto se resalta.
  useEffect(() => {
    if (tool !== "highlight") return;
    function onUp() {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !layer.current) return;
      const pageEl = layer.current.parentElement!;
      const textEl = pageEl.querySelector<HTMLElement>(".textLayer");
      const range = sel.getRangeAt(0);
      if (!textEl || !pageEl.contains(range.commonAncestorContainer)) return;
      const base = pageEl.getBoundingClientRect();
      const rects = selectedTextRects(range, textEl).map((r) => rectToPdf(page, s, r.left - base.left, r.top - base.top, r.width, r.height));
      sel.removeAllRanges();
      if (rects.length) props.onAdd({ id: pid("a"), page: page.id, kind: "highlight", rects: mergeLines(rects), color: props.style.highlight });
    }
    document.addEventListener("pointerup", onUp);
    return () => document.removeEventListener("pointerup", onUp);
  }, [tool, page, s, props.style.highlight]); // eslint-disable-line react-hooks/exhaustive-deps

  // Del tamaño de la página (no del que tenía la capa antes de girarla).
  const shown = shownSize(page);
  const W = shown.width * s;
  const H = shown.height * s;
  const capture = tool === "draw" || tool === "text" || tool === "note" || tool === "sign";

  return (
    <div
      ref={layer}
      className={`pdf-annot-layer tool-${tool}${capture ? " capture" : ""}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <svg className="pdf-annot-svg" width="100%" height="100%" viewBox={`0 0 ${W || 1} ${H || 1}`} preserveAspectRatio="none">
        {annotations.map((a) => {
          if (a.kind === "highlight") {
            return (
              <g key={a.id} data-annot={a.id} className={selected === a.id ? "selected" : ""} onPointerDown={(e) => startDrag(e, a)}>
                {a.rects.map((r, i) => {
                  const v = rectToView(page, s, r);
                  return <rect key={i} x={v.left} y={v.top} width={v.width} height={v.height} fill={a.color} fillOpacity={0.4} style={{ mixBlendMode: "multiply" }} />;
                })}
              </g>
            );
          }
          if (a.kind === "ink") {
            return (
              <g key={a.id} data-annot={a.id} className={selected === a.id ? "selected" : ""} onPointerDown={(e) => startDrag(e, a)}>
                {a.paths.map((path, i) => (
                  <polyline
                    key={i}
                    points={path.map(([x, y]) => toView(page, s, x, y).join(",")).join(" ")}
                    fill="none"
                    stroke={a.color}
                    strokeWidth={a.width * s}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                ))}
              </g>
            );
          }
          return null;
        })}
        {drawing && <polyline points={drawing.map((p) => p.join(",")).join(" ")} fill="none" stroke={props.style.ink} strokeWidth={props.style.inkWidth * s} strokeLinecap="round" strokeLinejoin="round" />}
        {box && (
          <rect x={Math.min(box.x, box.x + box.w)} y={Math.min(box.y, box.y + box.h)} width={Math.abs(box.w)} height={Math.abs(box.h)} fill={props.style.highlight} fillOpacity={0.4} />
        )}
      </svg>

      {annotations.map((a) => {
        if (a.kind === "text") {
          const [left, top] = toView(page, s, a.x, a.y);
          const style = { left, top, fontSize: a.size * s, color: a.color };
          return editing === a.id ? (
            <TextEdit
              key={a.id}
              style={style}
              value={a.text}
              onDone={(text) => {
                setEditing(null);
                props.onChange({ ...a, text }, true);
              }}
            />
          ) : (
            <div
              key={a.id}
              data-annot={a.id}
              className={`pdf-annot-text${selected === a.id ? " selected" : ""}`}
              style={style}
              onPointerDown={(e) => startDrag(e, a)}
              onDoubleClick={() => setEditing(a.id)}
            >
              {a.text || " "}
            </div>
          );
        }
        if (a.kind === "note") {
          const [left, top] = toView(page, s, a.x, a.y);
          return (
            <div key={a.id} className="pdf-note-wrap" style={{ left, top }}>
              <button
                type="button"
                data-annot={a.id}
                className={`pdf-annot-note${selected === a.id ? " selected" : ""}`}
                title={a.text || "Nota"}
                onPointerDown={(e) => startDrag(e, a)}
                onClick={() => setOpenNote(openNote === a.id ? null : a.id)}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="#FFD233" stroke="#8a6d00" strokeWidth="1.5" aria-hidden>
                  <path d="M4 4h16v12H10l-6 4z" />
                </svg>
              </button>
              {openNote === a.id && (
                <div className="pdf-note-popup" onPointerDown={(e) => e.stopPropagation()}>
                  <textarea
                    className="textarea"
                    autoFocus
                    defaultValue={a.text}
                    placeholder="Escribe la nota"
                    onBlur={(e) => {
                      if (e.target.value !== a.text) props.onChange({ ...a, text: e.target.value }, true);
                    }}
                    onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), setOpenNote(null))}
                  />
                  <button type="button" className="btn" onClick={() => setOpenNote(null)}>
                    Listo
                  </button>
                </div>
              )}
            </div>
          );
        }
        if (a.kind === "image") {
          const v = rectToView(page, s, [a.x, a.y, a.w, a.h]);
          return (
            <div
              key={a.id}
              data-annot={a.id}
              className={`pdf-annot-image${selected === a.id ? " selected" : ""}`}
              style={v}
              onPointerDown={(e) => startDrag(e, a)}
            >
              <img src={a.src} alt="Firma" draggable={false} />
              {selected === a.id && <span className="pdf-annot-handle" onPointerDown={(e) => startDrag(e, a, true)} />}
            </div>
          );
        }
        return null;
      })}

      {(props.fileNotes ?? []).map((n) => {
        const v = rectToView(page, s, n.rect);
        const box = n.drawn ? v : { left: v.left, top: v.top, width: 18, height: 18 };
        return (
          <div key={n.id} className="pdf-file-note" style={box}>
            <button
              type="button"
              className={`pdf-annot-note${n.drawn ? " over" : ""}`}
              title={n.text || "Nota"}
              aria-label={`Nota: ${n.text}`}
              onClick={() => setOpenNote(openNote === n.id ? null : n.id)}
            >
              {!n.drawn && (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="#FFD233" stroke="#8a6d00" strokeWidth="1.5" aria-hidden>
                  <path d="M4 4h16v12H10l-6 4z" />
                </svg>
              )}
            </button>
            {openNote === n.id && (
              <div className="pdf-note-popup" style={{ top: box.height + 4 }} onPointerDown={(e) => e.stopPropagation()}>
                {n.author && <span className="pdf-note-author">{n.author}</span>}
                <p className="pdf-note-text">{n.text || "(nota vacía)"}</p>
                <button type="button" className="btn" onClick={() => setOpenNote(null)}>
                  Cerrar
                </button>
              </div>
            )}
          </div>
        );
      })}

      {props.fields.map((f, i) => {
        const v = rectToView(page, s, f.rect);
        const value = props.form[f.name] ?? f.value;
        const font = Math.max(9, Math.min(v.height * 0.62, 14 * s));
        if (f.type === "checkbox" || f.type === "radio") {
          const on = f.type === "checkbox" ? value === true || value === f.exportValue || value === "Yes" || value === "On" : value === f.exportValue;
          return (
            <input
              key={`${f.name}-${i}`}
              className="pdf-field pdf-field-check"
              type={f.type}
              title={f.name}
              style={v}
              checked={Boolean(on)}
              disabled={f.readOnly}
              onChange={(e) => props.onForm(f.name, f.type === "checkbox" ? e.target.checked : (f.exportValue ?? "On"))}
            />
          );
        }
        if (f.type === "choice") {
          return (
            <select key={`${f.name}-${i}`} className="pdf-field" title={f.name} style={{ ...v, fontSize: font }} value={String(value ?? "")} disabled={f.readOnly} onChange={(e) => props.onForm(f.name, e.target.value)}>
              {(f.options ?? []).map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
          );
        }
        return f.multiline ? (
          <textarea key={`${f.name}-${i}`} className="pdf-field" title={f.name} style={{ ...v, fontSize: font }} value={String(value ?? "")} readOnly={f.readOnly} onChange={(e) => props.onForm(f.name, e.target.value)} />
        ) : (
          <input key={`${f.name}-${i}`} className="pdf-field" title={f.name} style={{ ...v, fontSize: font }} value={String(value ?? "")} readOnly={f.readOnly} onChange={(e) => props.onForm(f.name, e.target.value)} />
        );
      })}
    </div>
  );
}

/** Junta los pedazos de una misma línea (el navegador da un rectángulo por palabra). */
function mergeLines(rects: [number, number, number, number][]): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  for (const r of [...rects].sort((a, b) => b[1] - a[1] || a[0] - b[0])) {
    const last = out[out.length - 1];
    if (last && Math.abs(last[1] - r[1]) < 2 && Math.abs(last[3] - r[3]) < 3 && r[0] <= last[0] + last[2] + 4) {
      const right = Math.max(last[0] + last[2], r[0] + r[2]);
      last[2] = right - last[0];
    } else out.push([...r]);
  }
  return out;
}

function TextEdit({ style, value, onDone }: { style: React.CSSProperties; value: string; onDone: (text: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(value);
  useEffect(() => ref.current?.focus(), []);
  const lines = text.split("\n");
  return (
    <textarea
      ref={ref}
      className="pdf-text-edit"
      style={{ ...style, width: `${Math.max(6, ...lines.map((l) => l.length)) * 0.62}em`, height: `${lines.length * 1.2 + 0.2}em` }}
      value={text}
      placeholder="Escribe aquí"
      onChange={(e) => setText(e.target.value)}
      onBlur={() => onDone(text)}
      onKeyDown={(e) => {
        if (e.key === "Escape") (e.stopPropagation(), onDone(text));
      }}
      onPointerDown={(e) => e.stopPropagation()}
    />
  );
}

// ───────────── firma ─────────────

const SIGNATURE_KEY = "wepo.firma";

export function loadSignature(): { src: string; ratio: number } | null {
  try {
    const raw = localStorage.getItem(SIGNATURE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** Dibujar la firma con el mouse (o el trackpad) o escribirla; se guarda en esta computadora para la próxima vez. */
export function SignatureDialog({ onDone, onClose }: { onDone: (sig: { src: string; ratio: number }) => void; onClose: () => void }) {
  const [mode, setMode] = useState<"draw" | "type">("draw");
  const [name, setName] = useState("");
  const [remember, setRemember] = useState(true);
  const canvas = useRef<HTMLCanvasElement>(null);
  const last = useRef<[number, number] | null>(null);
  const [empty, setEmpty] = useState(true);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, c.width, c.height);
    setEmpty(true);
  }, [mode]);

  function point(e: React.PointerEvent): [number, number] {
    const r = canvas.current!.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * canvas.current!.width, ((e.clientY - r.top) / r.height) * canvas.current!.height];
  }

  function draw(e: React.PointerEvent) {
    if (!last.current) return;
    const ctx = canvas.current!.getContext("2d")!;
    const p = point(e);
    ctx.strokeStyle = "#1a2a6c";
    ctx.lineWidth = 5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(...last.current);
    ctx.lineTo(...p);
    ctx.stroke();
    last.current = p;
    setEmpty(false);
  }

  /** La firma recortada a lo que tiene trazo, como PNG transparente. */
  function finish() {
    let source = canvas.current!;
    if (mode === "type") {
      const c = document.createElement("canvas");
      c.width = 1200;
      c.height = 300;
      const ctx = c.getContext("2d")!;
      ctx.fillStyle = "#1a2a6c";
      ctx.font = `italic 140px "Snell Roundhand", "Brush Script MT", "Segoe Script", "URW Chancery L", cursive`;
      ctx.textBaseline = "middle";
      ctx.fillText(name, 30, 150);
      source = c;
    }
    const ctx = source.getContext("2d")!;
    const { width, height } = source;
    const pixels = ctx.getImageData(0, 0, width, height).data;
    let [x1, y1, x2, y2] = [width, height, 0, 0];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (pixels[(y * width + x) * 4 + 3] > 10) {
          if (x < x1) x1 = x;
          if (y < y1) y1 = y;
          if (x > x2) x2 = x;
          if (y > y2) y2 = y;
        }
      }
    }
    if (x2 <= x1 || y2 <= y1) return;
    const pad = 8;
    const out = document.createElement("canvas");
    out.width = x2 - x1 + pad * 2;
    out.height = y2 - y1 + pad * 2;
    out.getContext("2d")!.drawImage(source, x1 - pad, y1 - pad, out.width, out.height, 0, 0, out.width, out.height);
    const sig = { src: out.toDataURL("image/png"), ratio: out.width / out.height };
    try {
      if (remember) localStorage.setItem(SIGNATURE_KEY, JSON.stringify(sig));
      else localStorage.removeItem(SIGNATURE_KEY);
    } catch {
      // Sin almacenamiento la firma no se recuerda.
    }
    onDone(sig);
  }

  return (
    <Dialog
      title="Tu firma"
      onClose={onClose}
      width={560}
      footer={
        <>
          <label className="radio" style={{ marginRight: "auto" }}>
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Recordarla en esta computadora
          </label>
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn btn-primary" disabled={mode === "draw" ? empty : !name.trim()} onClick={finish}>
            Usar firma
          </button>
        </>
      }
    >
      <div className="filter-tabs" role="tablist">
        <button type="button" className={mode === "draw" ? "active" : ""} onClick={() => setMode("draw")}>
          Dibujar
        </button>
        <button type="button" className={mode === "type" ? "active" : ""} onClick={() => setMode("type")}>
          Escribir
        </button>
      </div>
      {mode === "draw" ? (
        <>
          <canvas
            ref={canvas}
            className="pdf-signature-pad"
            width={1000}
            height={300}
            onPointerDown={(e) => {
              (e.target as HTMLElement).setPointerCapture(e.pointerId);
              last.current = point(e);
            }}
            onPointerMove={draw}
            onPointerUp={() => (last.current = null)}
          />
          <div className="field-row">
            <span className="hint">Firma con el mouse o el trackpad dentro del recuadro.</span>
            <button
              type="button"
              className="btn"
              style={{ marginLeft: "auto" }}
              onClick={() => {
                canvas.current!.getContext("2d")!.clearRect(0, 0, 1000, 300);
                setEmpty(true);
              }}
            >
              Borrar
            </button>
          </div>
        </>
      ) : (
        <>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Tu nombre" autoFocus />
          <p className="pdf-signature-preview">{name || "Tu nombre"}</p>
        </>
      )}
    </Dialog>
  );
}
