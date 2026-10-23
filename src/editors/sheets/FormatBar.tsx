import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { BorderKind, StyleView } from "../../lib/spreadsheet";
import { fontFamily } from "./cellStyle";
import "./FormatBar.css";

type Props = {
  /** Estilo de la celda activa: decide qué botones aparecen activados. */
  style: StyleView;
  onStyle: (path: string, value: string) => void;
  onBorder: (kind: BorderKind, style: string, color: string) => void;
  /** Devuelve el foco a la cuadrícula después de usar un control. */
  onDone: () => void;
};

const FONTS = [
  "Helvetica Neue",
  "Arial",
  "Calibri",
  "Avenir Next",
  "Georgia",
  "Times New Roman",
  "Verdana",
  "Trebuchet MS",
  "Gill Sans",
  "Futura",
  "Courier New",
  "Menlo",
];

const SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36, 48, 72];

export const NUMBER_FORMATS: { label: string; value: string }[] = [
  { label: "General", value: "general" },
  { label: "Número", value: "#,##0.00" },
  { label: "Moneda", value: "$#,##0.00" },
  { label: "Porcentaje", value: "0.00%" },
  { label: "Fecha", value: "dd/mm/yyyy" },
  { label: "Hora", value: "hh:mm" },
  { label: "Texto", value: "@" },
];

const PALETTE = [
  "#000000", "#434343", "#666666", "#999999", "#B7B7B7", "#D9D9D9", "#EFEFEF", "#FFFFFF",
  "#C00000", "#E53935", "#FB8C00", "#FDD835", "#43A047", "#00897B", "#1E88E5", "#5E35B1",
  "#F4CCCC", "#FCE5CD", "#FFF2CC", "#D9EAD3", "#D0E0E3", "#CFE2F3", "#D9D2E9", "#EAD1DC",
  "#990000", "#B45F06", "#BF9000", "#38761D", "#134F5C", "#0B5394", "#351C75", "#741B47",
];

const BORDER_OPTIONS: { kind: BorderKind; label: string; icon: ReactNode }[] = [
  { kind: "all", label: "Todos los bordes", icon: <BorderIcon lines="M3 3h18v18H3zM12 3v18M3 12h18" /> },
  { kind: "outer", label: "Borde exterior", icon: <BorderIcon lines="M3 3h18v18H3z" /> },
  { kind: "inner", label: "Bordes interiores", icon: <BorderIcon lines="M12 3v18M3 12h18" /> },
  { kind: "top", label: "Borde superior", icon: <BorderIcon lines="M3 3h18" /> },
  { kind: "bottom", label: "Borde inferior", icon: <BorderIcon lines="M3 21h18" /> },
  { kind: "left", label: "Borde izquierdo", icon: <BorderIcon lines="M3 3v18" /> },
  { kind: "right", label: "Borde derecho", icon: <BorderIcon lines="M21 3v18" /> },
  { kind: "none", label: "Sin bordes", icon: <BorderIcon lines="" /> },
];

const BORDER_STYLES = [
  { value: "thin", label: "Delgado" },
  { value: "medium", label: "Medio" },
  { value: "thick", label: "Grueso" },
  { value: "double", label: "Doble" },
  { value: "dotted", label: "Punteado" },
  { value: "dashed", label: "Discontinuo" },
];

/** Barra de formato de WEPO Sheets: fuente, colores, alineación, bordes y número. */
export default function FormatBar({ style, onStyle, onBorder, onDone }: Props) {
  const fonts = FONTS.includes(style.font) || !style.font ? FONTS : [style.font, ...FONTS];
  const sizes = SIZES.includes(style.size) ? SIZES : [...SIZES, style.size].sort((a, b) => a - b);
  const numberFormat = NUMBER_FORMATS.some((f) => f.value === style.num_fmt) ? style.num_fmt : "custom";

  function select(path: string, value: string) {
    onStyle(path, value);
    onDone();
  }

  function toggle(path: string, active: boolean) {
    onStyle(path, String(!active));
  }

  function align(value: "left" | "center" | "right") {
    onStyle("alignment.horizontal", style.h === value ? "general" : value);
  }

  return (
    <div className="format-bar" role="toolbar" aria-label="Formato de celdas">
      <select
        className="fb-select fb-font"
        aria-label="Fuente"
        value={style.font}
        style={{ fontFamily: fontFamily(style.font) }}
        onChange={(e) => select("font.name", e.target.value)}
      >
        {fonts.map((f) => (
          <option key={f} value={f} style={{ fontFamily: fontFamily(f) }}>
            {f}
          </option>
        ))}
      </select>
      <select
        className="fb-select fb-size"
        aria-label="Tamaño de letra"
        value={style.size}
        onChange={(e) => select("font.size", e.target.value)}
      >
        {sizes.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>

      <Separator />

      <ToolButton label="Negrita (⌘B)" pressed={style.b} onClick={() => toggle("font.b", style.b)}>
        <b>B</b>
      </ToolButton>
      <ToolButton label="Cursiva (⌘I)" pressed={style.i} onClick={() => toggle("font.i", style.i)}>
        <i style={{ fontFamily: "Georgia, serif" }}>I</i>
      </ToolButton>
      <ToolButton label="Subrayado (⌘U)" pressed={style.u} onClick={() => toggle("font.u", style.u)}>
        <u>U</u>
      </ToolButton>
      <ToolButton label="Tachado" pressed={style.strike} onClick={() => toggle("font.strike", style.strike)}>
        <s>S</s>
      </ToolButton>

      <ColorButton
        label="Color de texto"
        current={style.color}
        emptyLabel="Automático"
        onPick={(color) => onStyle("font.color", color)}
        icon={<span className="fb-letter">A</span>}
      />
      <ColorButton
        label="Color de relleno"
        current={style.fill}
        emptyLabel="Sin relleno"
        onPick={(color) => onStyle("fill.fg_color", color)}
        icon={
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
            <path d="M5 11l7-7 7 7-7 7z" />
            <path d="M19 15c0 1.5 1 2.5 1 3.5a1 1 0 01-2 0c0-1 1-2 1-3.5z" fill="currentColor" />
          </svg>
        }
      />

      <Separator />

      <ToolButton label="Alinear a la izquierda" pressed={style.h === "left"} onClick={() => align("left")}>
        <AlignIcon lines={["M4 6h16", "M4 10h10", "M4 14h16", "M4 18h10"]} />
      </ToolButton>
      <ToolButton label="Centrar" pressed={style.h === "center"} onClick={() => align("center")}>
        <AlignIcon lines={["M4 6h16", "M7 10h10", "M4 14h16", "M7 18h10"]} />
      </ToolButton>
      <ToolButton label="Alinear a la derecha" pressed={style.h === "right"} onClick={() => align("right")}>
        <AlignIcon lines={["M4 6h16", "M10 10h10", "M4 14h16", "M10 18h10"]} />
      </ToolButton>
      <ToolButton
        label="Ajustar texto en varias líneas"
        pressed={style.wrap}
        onClick={() => toggle("alignment.wrap_text", style.wrap)}
      >
        <AlignIcon lines={["M4 6h16", "M4 12h13a3 3 0 010 6h-4", "M4 18h5"]} />
      </ToolButton>

      <Separator />

      <BorderButton onBorder={onBorder} />

      <Separator />

      <select
        className="fb-select fb-number"
        aria-label="Formato de número"
        value={numberFormat}
        onChange={(e) => select("num_fmt", e.target.value)}
      >
        {numberFormat === "custom" && <option value="custom">Personalizado</option>}
        {NUMBER_FORMATS.map((f) => (
          <option key={f.value} value={f.value}>
            {f.label}
          </option>
        ))}
      </select>
    </div>
  );
}

// ───────────── piezas ─────────────

function Separator() {
  return <span className="fb-separator" aria-hidden />;
}

/** Los botones no se quedan con el foco: así se puede seguir escribiendo en la hoja. */
function ToolButton(props: { label: string; pressed?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      className={`fb-button${props.pressed ? " pressed" : ""}`}
      title={props.label}
      aria-label={props.label}
      aria-pressed={props.pressed}
      onMouseDown={(e) => e.preventDefault()}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

/** Menú desplegable que se cierra al hacer clic fuera o con Esc. */
function Popover({ button, children }: { button: (toggle: () => void, open: boolean) => ReactNode; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="fb-popover-anchor" ref={ref}>
      {button(() => setOpen((v) => !v), open)}
      {open && (
        <div className="fb-popover" role="dialog">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

function ColorButton(props: {
  label: string;
  current: string | null;
  emptyLabel: string;
  icon: ReactNode;
  onPick: (color: string) => void;
}) {
  const [last, setLast] = useState(props.label === "Color de texto" ? "#C00000" : "#FFF2CC");

  function pick(color: string, close: () => void) {
    if (color) setLast(color);
    props.onPick(color);
    close();
  }

  return (
    <Popover
      button={(toggle, open) => (
        <div className="fb-split">
          <button
            type="button"
            className="fb-button fb-color"
            title={`${props.label}: aplicar el último color`}
            aria-label={props.label}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => props.onPick(last)}
          >
            {props.icon}
            <span className="fb-color-bar" style={{ background: last }} />
          </button>
          <button
            type="button"
            className={`fb-button fb-caret${open ? " pressed" : ""}`}
            title={`Elegir ${props.label.toLowerCase()}`}
            aria-label={`Elegir ${props.label.toLowerCase()}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={toggle}
          >
            ▾
          </button>
        </div>
      )}
    >
      {(close) => (
        <div className="fb-palette">
          <button type="button" className="fb-palette-none" onMouseDown={(e) => e.preventDefault()} onClick={() => pick("", close)}>
            {props.emptyLabel}
          </button>
          <div className="fb-swatches">
            {PALETTE.map((color) => (
              <button
                key={color}
                type="button"
                className={`fb-swatch${props.current?.toUpperCase() === color ? " current" : ""}`}
                style={{ background: color }}
                title={color}
                aria-label={color}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(color, close)}
              />
            ))}
          </div>
          <label className="fb-custom-color">
            Otro color…
            <input type="color" defaultValue={last} onChange={(e) => pick(e.target.value.toUpperCase(), close)} />
          </label>
        </div>
      )}
    </Popover>
  );
}

function BorderButton({ onBorder }: { onBorder: Props["onBorder"] }) {
  const [lineStyle, setLineStyle] = useState("thin");
  const [color, setColor] = useState("#000000");

  return (
    <Popover
      button={(toggle, open) => (
        <button
          type="button"
          className={`fb-button${open ? " pressed" : ""}`}
          title="Bordes"
          aria-label="Bordes"
          onMouseDown={(e) => e.preventDefault()}
          onClick={toggle}
        >
          <BorderIcon lines="M3 3h18v18H3zM12 3v18M3 12h18" /> ▾
        </button>
      )}
    >
      {(close) => (
        <div className="fb-borders">
          <div className="fb-border-grid">
            {BORDER_OPTIONS.map((option) => (
              <button
                key={option.kind}
                type="button"
                className="fb-button"
                title={option.label}
                aria-label={option.label}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onBorder(option.kind, lineStyle, color);
                  close();
                }}
              >
                {option.icon}
              </button>
            ))}
          </div>
          <div className="fb-border-options">
            <select className="fb-select" aria-label="Estilo de línea" value={lineStyle} onChange={(e) => setLineStyle(e.target.value)}>
              {BORDER_STYLES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
            <label className="fb-border-color" title="Color del borde">
              <span style={{ background: color }} />
              <input type="color" value={color} onChange={(e) => setColor(e.target.value.toUpperCase())} />
            </label>
          </div>
        </div>
      )}
    </Popover>
  );
}

function BorderIcon({ lines }: { lines: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M3 3h18v18H3z" stroke="currentColor" strokeOpacity="0.25" strokeDasharray="2 2" />
      {lines && <path d={lines} stroke="currentColor" strokeWidth="2" />}
    </svg>
  );
}

function AlignIcon({ lines }: { lines: string[] }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      {lines.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
