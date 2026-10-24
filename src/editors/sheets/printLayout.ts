// Cómo se reparte una hoja en páginas al imprimir: tamaño de papel, márgenes,
// escala ("ajustar al ancho" o "a una página") y qué filas y columnas caben en
// cada página. Lo usan la vista previa, la impresión y Exportar PDF, así que lo
// que se ve antes es exactamente lo que sale.

import type { Range } from "../../lib/spreadsheet";
import type { Axis } from "./layout";

export type Paper = "letter" | "a4" | "legal";
export type Margins = "normal" | "narrow" | "wide";
export type Scaling = "none" | "width" | "page";

/** Tamaño del papel vertical, en px CSS (96 por pulgada). */
export const PAPERS: Record<Paper, { label: string; width: number; height: number }> = {
  letter: { label: "Carta (21.6 × 27.9 cm)", width: 816, height: 1056 },
  a4: { label: "A4 (21 × 29.7 cm)", width: 794, height: 1123 },
  legal: { label: "Oficio (21.6 × 35.6 cm)", width: 816, height: 1344 },
};

/** Margen igual en los cuatro lados, en px CSS. */
export const MARGINS: Record<Margins, { label: string; px: number }> = {
  normal: { label: "Normales (1.2 cm)", px: 45 },
  narrow: { label: "Estrechos (0.6 cm)", px: 24 },
  wide: { label: "Anchos (2.5 cm)", px: 96 },
};

export const HEADER_TEXT_HEIGHT = 28;
export const HEADING_WIDTH = 40;
export const HEADING_HEIGHT = 20;

export type PageSetup = {
  paper: Paper;
  landscape: boolean;
  margins: Margins;
  scaling: Scaling;
  headings: boolean;
  header: boolean;
  footer: boolean;
};

export type PrintPage = {
  /** Columnas y filas (visibles) de esta página. */
  cols: number[];
  rows: number[];
};

export type Layout = {
  /** Hoja completa y margen, en px CSS. */
  width: number;
  height: number;
  margin: number;
  /** Escala con que se dibuja el contenido (1 = tamaño real). */
  scale: number;
  pages: PrintPage[];
  /** Filas que se repiten arriba en cada página. */
  repeated: number[];
};

export function pageSize(setup: Pick<PageSetup, "paper" | "landscape">): { width: number; height: number } {
  const p = PAPERS[setup.paper];
  return setup.landscape ? { width: p.height, height: p.width } : { width: p.width, height: p.height };
}

/** Reparte el rango en páginas: primero hacia abajo y luego a la derecha, como Excel. */
export function layoutPages(range: Range, cols: Axis, rows: Axis, setup: PageSetup, repeat: [number, number] | null): Layout {
  const { width, height } = pageSize(setup);
  const margin = MARGINS[setup.margins].px;
  const contentW = width - margin * 2;
  const contentH = height - margin * 2;

  const visibleCols: number[] = [];
  for (let c = range.c1; c <= range.c2; c++) if (cols.size(c) > 0) visibleCols.push(c);
  const repeated: number[] = [];
  if (repeat) for (let r = repeat[0]; r <= repeat[1]; r++) if (rows.size(r) > 0) repeated.push(r);
  const visibleRows: number[] = [];
  for (let r = range.r1; r <= range.r2; r++) if (rows.size(r) > 0 && !repeated.includes(r)) visibleRows.push(r);

  const headW = setup.headings ? HEADING_WIDTH : 0;
  const fixedH =
    (setup.header ? HEADER_TEXT_HEIGHT : 0) +
    (setup.footer ? HEADER_TEXT_HEIGHT : 0) +
    (setup.headings ? HEADING_HEIGHT : 0) +
    repeated.reduce((s, r) => s + rows.size(r), 0);
  const totalW = headW + visibleCols.reduce((s, c) => s + cols.size(c), 0);
  const totalH = fixedH + visibleRows.reduce((s, r) => s + rows.size(r), 0);

  let scale = 1;
  if (setup.scaling === "width") scale = Math.min(1, contentW / Math.max(1, totalW));
  else if (setup.scaling === "page") scale = Math.min(1, contentW / Math.max(1, totalW), contentH / Math.max(1, totalH));
  // Un poco de holgura para que el redondeo no empuje una fila a la página siguiente.
  scale = Math.max(0.1, scale * 0.999);

  const capW = contentW / scale - headW;
  const capH = contentH / scale - fixedH;
  const groups = (list: number[], size: (i: number) => number, cap: number): number[][] => {
    const out: number[][] = [];
    let current: number[] = [];
    let used = 0;
    for (const i of list) {
      const s = size(i);
      if (current.length && used + s > cap) {
        out.push(current);
        current = [];
        used = 0;
      }
      current.push(i);
      used += s;
    }
    if (current.length) out.push(current);
    return out.length ? out : [[]];
  };
  const colGroups = groups(visibleCols, (c) => cols.size(c), capW);
  const rowGroups = groups(visibleRows, (r) => rows.size(r), capH);
  const pages: PrintPage[] = [];
  for (const cg of colGroups) for (const rg of rowGroups) pages.push({ cols: cg, rows: rg });
  return { width, height, margin, scale, pages, repeated };
}

/** "B2:F30" o "B2" → rango desde 0 (o null si no se entiende). */
export function parseRange(text: string): Range | null {
  const m = /^\s*\$?([A-Z]{1,3})\$?(\d{1,7})\s*(?::\s*\$?([A-Z]{1,3})\$?(\d{1,7}))?\s*$/i.exec(text);
  if (!m) return null;
  const col = (s: string) => s.toUpperCase().split("").reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  const r1 = Number(m[2]) - 1;
  const c1 = col(m[1]);
  const r2 = m[4] ? Number(m[4]) - 1 : r1;
  const c2 = m[3] ? col(m[3]) : c1;
  if (r1 < 0 || r2 < 0) return null;
  return { r1: Math.min(r1, r2), c1: Math.min(c1, c2), r2: Math.max(r1, r2), c2: Math.max(c1, c2) };
}
