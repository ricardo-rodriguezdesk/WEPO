// Versión para imprimir (o guardar como PDF) de una hoja: una tabla con las
// mismas medidas, estilos y celdas combinadas que la cuadrícula, más las
// gráficas e imágenes encima. Solo se ve al imprimir (ver print.css).

import type { CSSProperties, ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Decoration, Range, SheetView } from "../../lib/spreadsheet";
import { columnName } from "../../lib/spreadsheet";
import ChartSvg from "./ChartSvg";
import { ICON_GLYPHS, cellCss } from "./cellStyle";
import type { Axis } from "./layout";
import type { MergedCells } from "./regions";
import "./print.css";

export type PrintOptions = {
  area: "sheet" | "selection";
  gridlines: boolean;
  headings: boolean;
  fit: boolean;
  landscape: boolean;
};

export type PrintJob = PrintOptions & {
  range: Range;
  /** Imágenes ya cargadas (data URL) por id, para que estén listas al imprimir. */
  images: Record<number, string>;
};

/** Ancho útil aproximado de una hoja carta o A4 con márgenes de 12 mm, en px CSS. */
const PAGE_WIDTH = { portrait: 700, landscape: 960 };
const HEADING_WIDTH = 40;
const HEADING_HEIGHT = 20;

/** ¿La celda tiene algo que imprimir? (texto, relleno o bordes). */
function hasContent(view: SheetView, r: number, c: number): boolean {
  const cell = view.rows[r]?.[c];
  if (!cell) return false;
  if (cell[0] !== "") return true;
  const style = view.styles[cell[2]];
  return Boolean(style && (style.fill || style.borders.some(Boolean)));
}

/**
 * Rango que se imprime al elegir "toda la hoja": desde A1 hasta la última
 * celda con contenido, incluyendo lo que cubran gráficas e imágenes.
 */
export function usedRange(view: SheetView, cols: Axis, rows: Axis): Range | null {
  let r2 = -1;
  let c2 = -1;
  view.rows.forEach((row, r) =>
    row?.forEach((_, c) => {
      if (hasContent(view, r, c)) {
        r2 = Math.max(r2, r);
        c2 = Math.max(c2, c);
      }
    }),
  );
  for (const [row, col, width, height] of view.merged) {
    if (hasContent(view, row - 1, col - 1)) {
      r2 = Math.max(r2, row - 1 + height - 1);
      c2 = Math.max(c2, col - 1 + width - 1);
    }
  }
  for (const d of view.drawings) {
    const right = d.x + d.w;
    const bottom = d.y + d.h;
    let c = 0;
    while (cols.start(c + 1) < right && c < 16383) c++;
    let r = 0;
    while (rows.start(r + 1) < bottom && r < 1048575) r++;
    r2 = Math.max(r2, r);
    c2 = Math.max(c2, c);
  }
  return r2 < 0 ? null : { r1: 0, c1: 0, r2, c2 };
}

type Props = {
  job: PrintJob;
  view: SheetView;
  cols: Axis;
  rows: Axis;
  merged: MergedCells;
  decorations: Map<string, Decoration>;
};

export default function PrintSheet({ job, view, cols, rows, merged, decorations }: Props) {
  const { range } = job;
  const visibleCols: number[] = [];
  for (let c = range.c1; c <= range.c2; c++) if (cols.size(c) > 0) visibleCols.push(c);
  const visibleRows: number[] = [];
  for (let r = range.r1; r <= range.r2; r++) if (rows.size(r) > 0) visibleRows.push(r);

  const headingW = job.headings ? HEADING_WIDTH : 0;
  const headingH = job.headings ? HEADING_HEIGHT : 0;
  const width = headingW + visibleCols.reduce((sum, c) => sum + cols.size(c), 0);
  const pageWidth = job.landscape ? PAGE_WIDTH.landscape : PAGE_WIDTH.portrait;
  const zoom = job.fit && width > pageWidth ? pageWidth / width : 1;

  /** ¿El texto de la celda puede pasar por encima de la vecina de la derecha? */
  function spills(r: number, c: number): boolean {
    const next = c + 1;
    if (next > range.c2 || merged.at(r, next) || decorations.has(`${r},${next}`)) return false;
    const cell = view.rows[r]?.[next];
    return !cell || (cell[0] === "" && !view.styles[cell[2]]?.fill);
  }

  function renderCell(r: number, c: number): ReactNode {
    const area = merged.at(r, c);
    let colSpan = 1;
    let rowSpan = 1;
    let source = { r, c };
    if (area) {
      // Una combinada se dibuja una sola vez, en su primera celda visible dentro
      // del área impresa, y abarca las filas y columnas visibles que cubre.
      const spanRows = visibleRows.filter((k) => k >= area.r1 && k <= area.r2);
      const spanCols = visibleCols.filter((k) => k >= area.c1 && k <= area.c2);
      if (spanRows[0] !== r || spanCols[0] !== c) return null;
      rowSpan = spanRows.length;
      colSpan = spanCols.length;
      source = { r: area.r1, c: area.c1 };
    }
    const height = area
      ? visibleRows.filter((k) => k >= r && k <= area.r2).reduce((sum, k) => sum + rows.size(k), 0)
      : rows.size(r);
    const [text, numeric, styleId] = view.rows[source.r]?.[source.c] ?? ["", false, 0];
    const style = view.styles[styleId] ?? view.styles[0];
    const deco = decorations.get(`${source.r},${source.c}`);
    const css = cellCss(style, numeric);
    const overflow =
      !area && text && !numeric && !style.wrap && (!style.h || style.h === "left") && !deco && spills(r, c);
    const { background, borderTop, borderRight, borderBottom, borderLeft, ...inner } = css;
    const tdStyle: CSSProperties = { background, borderTop, borderRight, borderBottom, borderLeft };
    return (
      <td key={c} colSpan={colSpan > 1 ? colSpan : undefined} rowSpan={rowSpan > 1 ? rowSpan : undefined} style={tdStyle}>
        <div className={`print-cell${overflow ? " spill" : ""}`} style={{ ...inner, height }}>
          {deco?.bar && (
            <span
              className="data-bar"
              style={{ width: `${Math.max(0, Math.min(1, deco.bar.value)) * 100}%`, background: deco.bar.color }}
            />
          )}
          {deco?.icon && (
            <span className="cf-icon" style={{ color: deco.icon.color }}>
              {ICON_GLYPHS[deco.icon.icon] ?? "●"}
            </span>
          )}
          {deco?.rating && (
            <span className="cf-rating" style={{ color: deco.rating.color }}>
              {Array.from({ length: deco.rating.max }, (_, i) => (
                <span key={i} style={{ opacity: i < deco.rating!.count ? 1 : 0.25 }}>
                  {ICON_GLYPHS[deco.rating!.icon] ?? "★"}
                </span>
              ))}
            </span>
          )}
          {(!deco || deco.show_value) && <span className="cell-text">{text}</span>}
        </div>
      </td>
    );
  }

  // Gráficas e imágenes: misma posición que en pantalla, relativa al área impresa.
  const originX = cols.start(range.c1) - headingW;
  const originY = rows.start(range.r1) - headingH;
  const areaRight = cols.start(range.c2 + 1);
  const areaBottom = rows.start(range.r2 + 1);
  const drawings = view.drawings.filter(
    (d) => d.x < areaRight && d.x + d.w > cols.start(range.c1) && d.y < areaBottom && d.y + d.h > rows.start(range.r1),
  );

  return createPortal(
    <div className="print-root" aria-hidden>
      <style>{`@page { size: ${job.landscape ? "landscape" : "portrait"}; margin: 12mm; }`}</style>
      <div className={`print-sheet${job.gridlines ? " gridlines" : ""}`} style={{ width, zoom }}>
        <table className="print-table" style={{ width }}>
          <colgroup>
            {job.headings && <col style={{ width: HEADING_WIDTH }} />}
            {visibleCols.map((c) => (
              <col key={c} style={{ width: cols.size(c) }} />
            ))}
          </colgroup>
          {job.headings && (
            <thead>
              <tr style={{ height: HEADING_HEIGHT }}>
                <th className="print-heading" />
                {visibleCols.map((c) => (
                  <th key={c} className="print-heading">
                    {columnName(c)}
                  </th>
                ))}
              </tr>
            </thead>
          )}
          <tbody>
            {visibleRows.map((r) => (
              <tr key={r} style={{ height: rows.size(r) }}>
                {job.headings && <th className="print-heading">{r + 1}</th>}
                {visibleCols.map((c) => renderCell(r, c))}
              </tr>
            ))}
          </tbody>
        </table>
        {drawings.map((d) => (
          <div
            key={d.id}
            className="print-drawing"
            style={{ left: d.x - originX, top: d.y - originY, width: d.w, height: d.h }}
          >
            {d.type === "chart" ? (
              <ChartSvg chart={d} width={d.w} height={d.h} />
            ) : job.images[d.id] ? (
              <img src={job.images[d.id]} alt={d.name} />
            ) : null}
          </div>
        ))}
      </div>
    </div>,
    document.body,
  );
}
