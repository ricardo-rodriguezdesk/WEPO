// Traduce el estilo de una celda (StyleView, calculado en Rust) a CSS.

import type { CSSProperties } from "react";
import type { BorderView, StyleView } from "../../lib/spreadsheet";

/** Si la fuente del archivo no está instalada en la Mac, se usa la del sistema. */
const FALLBACK_FONTS = '-apple-system, "Segoe UI", "Helvetica Neue", Arial, sans-serif';

const BORDER_CSS: Record<string, string> = {
  thin: "1px solid",
  medium: "2px solid",
  thick: "3px solid",
  double: "3px double",
  dotted: "1px dotted",
  dashed: "1px dashed",
};

function border(b: BorderView): string | undefined {
  return b ? `${BORDER_CSS[b.style] ?? "1px solid"} ${b.color}` : undefined;
}

export function fontFamily(name: string): string {
  return name ? `"${name}", ${FALLBACK_FONTS}` : FALLBACK_FONTS;
}

/** `zoom` agranda o achica la letra junto con la cuadrícula. */
export function cellCss(style: StyleView, numeric: boolean, zoom = 1): CSSProperties {
  const decorations = [style.u && "underline", style.strike && "line-through"].filter(Boolean);
  const horizontal = style.h ?? (numeric ? "right" : "left");

  const css: CSSProperties = {
    fontWeight: style.b ? 700 : undefined,
    fontStyle: style.i ? "italic" : undefined,
    textDecoration: decorations.length ? decorations.join(" ") : undefined,
    fontSize: `${style.size * zoom}pt`,
    fontFamily: fontFamily(style.font),
    color: style.color ?? undefined,
    background: style.fill ?? undefined,
    textAlign: horizontal === "justify" ? "justify" : horizontal,
    justifyContent: { left: "flex-start", center: "center", right: "flex-end", justify: "flex-start" }[horizontal],
    // Como en Excel, el texto va abajo salvo que se indique otra cosa.
    alignItems: style.v === "top" ? "flex-start" : style.v === "center" ? "center" : "flex-end",
    whiteSpace: style.wrap ? "normal" : undefined,
  };

  const [top, right, bottom, left] = style.borders.map(border);
  if (top) css.borderTop = top;
  if (right) css.borderRight = right;
  if (bottom) css.borderBottom = bottom;
  if (left) css.borderLeft = left;
  return css;
}

/** Íconos del formato condicional (nombres de IronCalc) dibujados con caracteres. */
export const ICON_GLYPHS: Record<string, string> = {
  ArrowUp: "▲",
  ArrowRight: "▶",
  ArrowDown: "▼",
  ArrowAngleUp: "◥",
  ArrowAngleDown: "◢",
  Circle: "●",
  TriangleUp: "▲",
  TriangleDown: "▼",
  TriangleUpFilled: "▲",
  TriangleDownFilled: "▼",
  FlatRectangle: "▬",
  Rhombus: "◆",
  Flag: "⚑",
  Check: "✔",
  Cross: "✖",
  Exclamation: "!",
  Star: "★",
  Heart: "♥",
  ThumbsUp: "👍",
  ThumbsDown: "👎",
};
