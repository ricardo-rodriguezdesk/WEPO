import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { DrawingPatch, DrawingView } from "../../lib/spreadsheet";
import { sheetApi } from "../../lib/spreadsheet";
import ChartSvg from "./ChartSvg";
import { HEADER_HEIGHT, HEADER_WIDTH } from "./layout";

type Props = {
  drawings: DrawingView[];
  selected: number | null;
  onSelect: (id: number | null) => void;
  /** Se llama al soltar después de mover o redimensionar. */
  onChange: (id: number, patch: DrawingPatch) => void;
  onEdit: (id: number) => void;
};

type Box = { x: number; y: number; w: number; h: number };
type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/** Gráficas e imágenes flotando sobre la cuadrícula. Se mueven arrastrando y se redimensionan con las asas. */
export default function DrawingLayer({ drawings, selected, onSelect, onChange, onEdit }: Props) {
  const [images, setImages] = useState<Record<number, string>>({});
  // Mientras se arrastra, la posición se muestra aquí y solo se guarda al soltar.
  const [preview, setPreview] = useState<{ id: number; box: Box } | null>(null);
  const drag = useRef<{ id: number; handle: Handle | "move"; startX: number; startY: number; start: Box; ratio: number | null } | null>(null);

  // Las imágenes se piden una sola vez a Rust (como data URL) y se recuerdan.
  useEffect(() => {
    for (const d of drawings) {
      if (d.type === "image" && !(d.id in images)) {
        sheetApi
          .imageData(d.id)
          .then((url) => setImages((prev) => ({ ...prev, [d.id]: url })))
          .catch(() => {});
      }
    }
  }, [drawings]); // eslint-disable-line react-hooks/exhaustive-deps

  function start(e: ReactPointerEvent, d: DrawingView, handle: Handle | "move") {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    onSelect(d.id);
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    drag.current = {
      id: d.id,
      handle,
      startX: e.clientX,
      startY: e.clientY,
      start: { x: d.x, y: d.y, w: d.w, h: d.h },
      // Las imágenes conservan su proporción al estirarlas desde una esquina.
      ratio: d.type === "image" ? d.w / Math.max(1, d.h) : null,
    };
  }

  function move(e: ReactPointerEvent) {
    const current = drag.current;
    if (!current) return;
    const dx = e.clientX - current.startX;
    const dy = e.clientY - current.startY;
    const s = current.start;
    let box: Box;
    if (current.handle === "move") {
      box = { ...s, x: Math.max(0, s.x + dx), y: Math.max(0, s.y + dy) };
    } else {
      const h = current.handle;
      let { x, y, w, h: height } = s;
      if (h.includes("e")) w = Math.max(30, s.w + dx);
      if (h.includes("s")) height = Math.max(30, s.h + dy);
      if (h.includes("w")) {
        w = Math.max(30, s.w - dx);
        x = s.x + s.w - w;
      }
      if (h.includes("n")) {
        height = Math.max(30, s.h - dy);
        y = s.y + s.h - height;
      }
      if (current.ratio && h.length === 2 && !e.shiftKey) {
        height = w / current.ratio;
        if (h.includes("n")) y = s.y + s.h - height;
      }
      box = { x: Math.max(0, x), y: Math.max(0, y), w, h: height };
    }
    setPreview({ id: current.id, box });
  }

  function end() {
    const current = drag.current;
    drag.current = null;
    if (!current || !preview || preview.id !== current.id) {
      setPreview(null);
      return;
    }
    const { box } = preview;
    const s = current.start;
    if (box.x !== s.x || box.y !== s.y || box.w !== s.w || box.h !== s.h) {
      onChange(current.id, {
        x: Math.round(box.x),
        y: Math.round(box.y),
        w: Math.round(box.w),
        h: Math.round(box.h),
      });
    }
    // Se quita la vista previa cuando llegue la hoja actualizada.
    setTimeout(() => setPreview(null), 0);
  }

  return (
    <>
      {drawings.map((d) => {
        const box = preview?.id === d.id ? preview.box : d;
        const isSelected = selected === d.id;
        return (
          <div
            key={d.id}
            className={`drawing${isSelected ? " selected" : ""}`}
            style={{ left: HEADER_WIDTH + box.x, top: HEADER_HEIGHT + box.y, width: box.w, height: box.h }}
            onPointerDown={(e) => start(e, d, "move")}
            onPointerMove={move}
            onPointerUp={end}
            onDoubleClick={() => d.type === "chart" && onEdit(d.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onSelect(d.id);
              if (d.type === "chart") onEdit(d.id);
            }}
            role="img"
            aria-label={d.type === "chart" ? `Gráfica ${d.title || d.kind}` : `Imagen ${d.name}`}
          >
            {d.type === "chart" ? (
              <ChartSvg chart={d} width={box.w} height={box.h} />
            ) : images[d.id] ? (
              <img src={images[d.id]} alt={d.name} draggable={false} />
            ) : (
              <div className="drawing-loading">Cargando imagen…</div>
            )}
            {isSelected &&
              HANDLES.map((h) => (
                <span
                  key={h}
                  className={`drawing-handle ${h}`}
                  onPointerDown={(e) => start(e, d, h)}
                  onPointerMove={move}
                  onPointerUp={end}
                />
              ))}
          </div>
        );
      })}
    </>
  );
}
