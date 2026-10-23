// Medir el ancho de un texto con su fuente, sin dibujarlo: lo usan el texto
// que se desborda a celdas vacías, el alto automático de filas y el autoajuste
// de columnas.

import type { StyleView } from "../../lib/spreadsheet";
import { fontFamily } from "./cellStyle";

let context: CanvasRenderingContext2D | null = null;
const cache = new Map<string, number>();

export function cssFont(style: StyleView): string {
  const px = (style.size * 4) / 3; // puntos → píxeles
  return `${style.i ? "italic " : ""}${style.b ? "700 " : ""}${px}px ${fontFamily(style.font)}`;
}

export function textWidth(text: string, style: StyleView): number {
  const font = cssFont(style);
  const key = `${font}|${text}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  context ??= document.createElement("canvas").getContext("2d");
  if (!context) return text.length * 7;
  context.font = font;
  const width = context.measureText(text).width;
  if (cache.size > 5000) cache.clear();
  cache.set(key, width);
  return width;
}

/** Alto de una línea de texto con este estilo, en píxeles. */
export function lineHeight(style: StyleView): number {
  return Math.ceil(((style.size * 4) / 3) * 1.25);
}

/** Cuántas líneas ocupa un texto que se ajusta dentro de `width` píxeles. */
export function wrappedLines(text: string, style: StyleView, width: number): number {
  if (width <= 0) return 1;
  let lines = 0;
  for (const paragraph of text.split("\n")) {
    let current = 0;
    lines++;
    for (const word of paragraph.split(/(\s+)/)) {
      const w = textWidth(word, style);
      if (current + w > width && current > 0) {
        lines++;
        current = word.trim() ? w : 0;
      } else {
        current += w;
      }
    }
  }
  return Math.max(1, lines);
}
