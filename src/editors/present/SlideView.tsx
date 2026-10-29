import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type SyntheticEvent } from "react";
import type { Deck, ImageElement, Para, Run, ShapeElement, Slide, SlideElement, TableElement, TextBody } from "./model";
import { isEmptyText, placeholderHint } from "./model";
import { isLine, shapePath } from "./geometry";
import ChartSvg from "../sheets/ChartSvg";
import { chartView } from "./charts";
import { mediaUrl } from "./media";

/** Las gráficas se dibujan a esta escala (letra de unos 16 px en la diapositiva). */
const CHART_SCALE = 1.5;

/** Interlineado "sencillo" de PowerPoint en CSS. */
const LINE = 1.2;

export type TextDefaults = { font: string; color: string; size: number };

/** Letra, color y tamaño que usa un cuadro cuando su texto no dice otra cosa. */
export function textDefaults(el: ShapeElement | null, deck: Deck): TextDefaults {
  const title = el?.role === "title";
  return {
    font: title ? deck.theme.fonts.major : deck.theme.fonts.minor,
    color: title ? deck.theme.title : deck.theme.text,
    size: el?.text?.defaultSize ?? 18,
  };
}

export function fontStack(font: string): string {
  return `"${font}", "Helvetica Neue", Arial, sans-serif`;
}

export function runStyle(run: Run): CSSProperties {
  const style: CSSProperties = {};
  if (run.bold) style.fontWeight = 700;
  if (run.italic) style.fontStyle = "italic";
  const deco = [run.underline ? "underline" : "", run.strike ? "line-through" : ""].filter(Boolean).join(" ");
  if (deco) style.textDecoration = deco;
  if (run.size) style.fontSize = `${run.size}pt`;
  if (run.color) style.color = run.color;
  if (run.font) style.fontFamily = fontStack(run.font);
  return style;
}

export function paraStyle(p: Para): CSSProperties {
  const style: CSSProperties = {};
  if (p.align && p.align !== "left") style.textAlign = p.align;
  if (p.spaceBefore !== undefined) style.marginTop = `${p.spaceBefore}pt`;
  if (p.spaceAfter !== undefined) style.marginBottom = `${p.spaceAfter}pt`;
  if (p.lineSpacing) style.lineHeight = String(Math.round(p.lineSpacing * LINE * 1000) / 1000);
  // El tamaño del párrafo (se nota en los vacíos); igual que en el editor.
  if (p.endSize) (style as Record<string, string>)["--end-size"] = `${p.endSize}pt`;
  return style;
}

/** Texto de un cuadro, con el mismo marcado que usa el editor (así se ve igual al editar). */
export function TextContent({ text, hint }: { text: TextBody; hint?: string | null }) {
  if (hint && isEmptyText(text)) {
    const p = text.paras[0];
    return (
      <p className="slide-hint" style={paraStyle(p ?? { runs: [] })} data-bullet={p?.bullet ?? undefined}>
        {hint}
      </p>
    );
  }
  return (
    <>
      {text.paras.map((p, i) => (
        <p key={i} style={paraStyle(p)} data-bullet={p.bullet ?? undefined} data-level={p.level || undefined} data-para={i}>
          {p.runs.some((r) => r.text) ? (
            p.runs.map((r, j) => {
              const parts = r.text.split("\n");
              const content = parts.flatMap((part, k) => (k ? [<br key={`b${k}`} />, part] : [part]));
              return r.link ? (
                <a key={j} href={r.link} style={runStyle(r)}>
                  {content}
                </a>
              ) : (
                <span key={j} style={runStyle(r)}>
                  {content}
                </span>
              );
            })
          ) : (
            <br />
          )}
        </p>
      ))}
    </>
  );
}

/** Caja de texto con sus márgenes internos y su alineación vertical. */
export function textBoxStyle(el: ShapeElement, deck: Deck): CSSProperties {
  const d = textDefaults(el, deck);
  const [l, t, r, b] = el.text?.insets ?? [9.6, 4.8, 9.6, 4.8];
  return {
    padding: `${t}px ${r}px ${b}px ${l}px`,
    justifyContent: el.text?.anchor === "middle" ? "center" : el.text?.anchor === "bottom" ? "flex-end" : "flex-start",
    fontFamily: fontStack(d.font),
    color: d.color,
    fontSize: `${d.size}pt`,
    lineHeight: el.role === "title" ? 0.9 * LINE : LINE,
  };
}

function ShapeView({ el, deck, hints, textSlot }: { el: ShapeElement; deck: Deck; hints: boolean; textSlot?: ReactNode }) {
  const { d, open } = shapePath(el.geom, el.w, el.h);
  const line = el.line;
  const strokeWidth = line?.width ?? 0;
  const dash = line?.dash === "dash" ? `${strokeWidth * 4} ${strokeWidth * 3}` : line?.dash === "dot" ? `${strokeWidth} ${strokeWidth * 2}` : undefined;
  const hint = hints && el.role ? placeholderHint(el.role) : null;
  const showBorder = hints && el.role && isEmptyText(el.text) && !el.fill && !el.line;
  return (
    <>
      {(el.fill || line) && (
        <svg className="slide-shape-svg" width={el.w} height={el.h} viewBox={`0 0 ${el.w} ${el.h}`} overflow="visible" aria-hidden>
          <path
            d={d}
            fill={open ? "none" : (el.fill ?? "none")}
            stroke={line?.color ?? "none"}
            strokeWidth={strokeWidth}
            strokeDasharray={dash}
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
          {isLine(el.geom) && el.geom === "straightConnector1" && line && (
            <polygon points={`${el.w},${el.h} ${el.w - 10},${el.h - 4} ${el.w - 4},${el.h - 10}`} fill={line.color} />
          )}
        </svg>
      )}
      {showBorder && <div className="slide-placeholder-border" />}
      {(el.text || textSlot) && (
        <div className="slide-text" style={textBoxStyle(el, deck)}>
          {textSlot ?? (el.text && <TextContent text={el.text} hint={hint} />)}
        </div>
      )}
    </>
  );
}

type CellRef = { r: number; c: number };

function TableView({ el, deck, active, editing, slot }: { el: TableElement; deck: Deck; active?: CellRef | null; editing?: CellRef | null; slot?: ReactNode }) {
  const border = el.border ? `1px solid ${el.border}` : "none";
  return (
    <table className="slide-table" style={{ width: el.w, fontFamily: fontStack(deck.theme.fonts.minor), color: deck.theme.text }}>
      <colgroup>
        {el.cols.map((w, i) => (
          <col key={i} style={{ width: w }} />
        ))}
      </colgroup>
      <tbody>
        {el.rows.map((row, ri) => (
          <tr key={ri} style={{ height: row.h }}>
            {row.cells.map((cell, ci) => {
              if (cell.merged) return null;
              const isEditing = editing?.r === ri && editing.c === ci;
              const isActive = active?.r === ri && active.c === ci;
              // La fila de encabezado: letra blanca y en negrita, salvo que el texto diga otra cosa.
              const header = el.header && ri === 0;
              return (
                <td
                  key={ci}
                  data-cell={`${ri},${ci}`}
                  className={`${isActive ? "slide-cell-active" : ""}${isEditing ? " slide-cell-editing" : ""}`}
                  colSpan={cell.span}
                  rowSpan={cell.rowSpan}
                  style={{
                    background: cell.fill ?? undefined,
                    border,
                    fontSize: `${cell.text.defaultSize ?? 18}pt`,
                    color: header ? "#FFFFFF" : undefined,
                    fontWeight: header ? 700 : undefined,
                  }}
                >
                  {isEditing && slot ? slot : <TextContent text={cell.text} />}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function elementBoxStyle(el: SlideElement): CSSProperties {
  const transforms = [el.rot ? `rotate(${el.rot}deg)` : "", el.flipH ? "scaleX(-1)" : "", el.flipV ? "scaleY(-1)" : ""].filter(Boolean).join(" ");
  return { left: el.x, top: el.y, width: Math.max(el.w, 1), height: Math.max(el.h, 1), transform: transforms || undefined };
}

type Props = {
  slide: Slide;
  deck: Deck;
  /** Escala con la que se ve (1 = tamaño real de la diapositiva). */
  scale: number;
  /** Textos grises de ejemplo en los cuadros vacíos (solo al editar). */
  hints?: boolean;
  /** Cuadro cuyo texto se está editando: se dibuja con `editingSlot` en vez del texto. */
  editingId?: string | null;
  editingSlot?: ReactNode;
  /** Celda elegida y celda que se está escribiendo de una tabla (con su editor). */
  activeCell?: { id: string; r: number; c: number } | null;
  editingCell?: { id: string; r: number; c: number } | null;
  /** Para que el editor sepa en qué elemento se hizo clic. */
  interactive?: boolean;
  /** Al presentar: los videos y audios se pueden reproducir (si no, se ve su portada). */
  play?: boolean;
  className?: string;
  children?: ReactNode;
};

/** Una diapositiva dibujada con HTML y SVG, del tamaño que se pida. */
export default function SlideView({ slide, deck, scale, hints = false, editingId, editingSlot, activeCell, editingCell, interactive = false, play = false, className, children }: Props) {
  const background = slide.background ?? deck.theme.background;
  return (
    <div className={`slide-frame ${className ?? ""}`} style={{ width: deck.width * scale, height: deck.height * scale }}>
      <div
        className="slide"
        style={{
          width: deck.width,
          height: deck.height,
          transform: `scale(${scale})`,
          background: slide.backgroundImage ? `center / cover no-repeat url("${slide.backgroundImage}"), ${background}` : background,
          color: deck.theme.text,
        }}
      >
        {slide.elements.map((el) => (
          <div
            key={el.id}
            className={`slide-el slide-${el.kind}${el.kind === "image" && el.media ? ` slide-media slide-${el.media.type}` : ""}${el.kind === "shape" && isLine(el.geom) ? " slide-line" : ""}`}
            data-el={interactive ? el.id : undefined}
            data-anim={el.id}
            style={elementBoxStyle(el)}
          >
            {el.kind === "shape" && <ShapeView el={el} deck={deck} hints={hints} textSlot={el.id === editingId ? editingSlot : undefined} />}
            {el.kind === "image" && (el.media ? <MediaView el={el} play={play} /> : <img src={(el as ImageElement).src} alt="" draggable={false} />)}
            {el.kind === "chart" && (
              // En una diapositiva la letra va más grande que en una hoja de cálculo: se dibuja más chica y se agranda.
              <div className="slide-chart-box" style={{ ["--chart-bg" as string]: background, ["--chart-text" as string]: deck.theme.text, ["--chart-muted" as string]: deck.theme.text, ["--chart-grid" as string]: "rgba(128,128,128,.3)" }}>
                <ChartSvg chart={chartView(el)} width={Math.max(el.w, 1) / CHART_SCALE} height={Math.max(el.h, 1) / CHART_SCALE} scale={CHART_SCALE} />
              </div>
            )}
            {el.kind === "table" && (
              <TableView
                el={el}
                deck={deck}
                active={activeCell?.id === el.id ? activeCell : null}
                editing={editingCell?.id === el.id ? editingCell : null}
                slot={editingCell?.id === el.id ? editingSlot : undefined}
              />
            )}
          </div>
        ))}
        {children}
      </div>
    </div>
  );
}

/** Video o audio: al editar se ve su portada (con una marca); al presentar se reproduce. */
function MediaView({ el, play }: { el: ImageElement; play: boolean }) {
  const media = el.media!;
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    // Al salir de la diapositiva se detiene (los clones de la transición no suenan).
    const a = audio.current;
    return () => a?.pause();
  }, []);
  if (!play) {
    return (
      <>
        <img src={el.src} alt="" draggable={false} />
        <span className="slide-media-badge" aria-label={media.type === "video" ? "Video" : "Audio"}>
          <svg viewBox="0 0 24 24" aria-hidden>
            {media.type === "video" ? <path d="M8 5v14l11-7z" /> : <path d="M4 9h4l5-4v14l-5-4H4z" />}
          </svg>
        </span>
      </>
    );
  }
  // Un clic en el video o en sus controles no pasa a la siguiente diapositiva.
  const stop = (e: SyntheticEvent) => e.stopPropagation();
  if (media.type === "video") {
    return <video src={mediaUrl(media.src)} poster={el.src} controls autoPlay={media.autoplay} loop={media.loop} playsInline onClick={stop} onDoubleClick={stop} />;
  }
  return (
    <button
      type="button"
      className={`slide-audio-button${playing ? " playing" : ""}`}
      aria-label={playing ? "Pausar el audio" : "Reproducir el audio"}
      onClick={(e) => {
        stop(e);
        const a = audio.current;
        if (!a) return;
        if (a.paused) void a.play();
        else a.pause();
      }}
    >
      <img src={el.src} alt="" draggable={false} />
      <audio ref={audio} src={mediaUrl(media.src)} autoPlay={media.autoplay} loop={media.loop} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} />
    </button>
  );
}
