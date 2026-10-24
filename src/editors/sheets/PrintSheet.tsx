// Versión para imprimir (o guardar como PDF) de una hoja, ya repartida en
// páginas (ver printLayout.ts): cada página es una hoja del tamaño del papel con
// sus filas y columnas, el encabezado y pie, y las gráficas e imágenes que caen
// ahí. La misma página se usa en la vista previa, así que lo que se ve es lo que sale.

import type { CSSProperties, ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Decoration, Range, SheetView } from "../../lib/spreadsheet";
import { columnName } from "../../lib/spreadsheet";
import ChartSvg from "./ChartSvg";
import { ICON_GLYPHS, cellCss } from "./cellStyle";
import { tableAt, withTableStyle } from "./tables";
import type { Axis } from "./layout";
import type { MergedCells } from "./regions";
import type { Layout, Margins, Paper, PrintPage, Scaling } from "./printLayout";
import { HEADER_TEXT_HEIGHT, HEADING_HEIGHT, HEADING_WIDTH, layoutPages } from "./printLayout";
import "./print.css";

export type PrintOptions = {
  /** Toda la hoja, la selección o el área de impresión guardada en el archivo. */
  area: "sheet" | "selection" | "saved";
  gridlines: boolean;
  headings: boolean;
  scaling: Scaling;
  landscape: boolean;
  paper: Paper;
  margins: Margins;
};

export type PrintJob = PrintOptions & {
  range: Range;
  /** Imágenes ya cargadas (data URL) por id, para que estén listas al imprimir. */
  images: Record<number, string>;
  /** Encabezado y pie con la fecha, el archivo y la hoja puestos ([Página] se llena en cada página). */
  header: string;
  footer: string;
  /** Filas que se repiten arriba en cada página (desde 0). */
  repeat: [number, number] | null;
};

/** "[Archivo] · [Fecha]" → "Ventas.xlsx · 22/10/2026". [Página] y [Páginas] se llenan en cada página. */
export function fillPageFields(text: string, fileName: string, sheetName: string): string {
  return text
    .split("[Fecha]").join(new Date().toLocaleDateString("es-MX"))
    .split("[Archivo]").join(fileName)
    .split("[Hoja]").join(sheetName)
    .trim();
}

function pageText(text: string, page: number, pages: number): string {
  return text.split("[Páginas]").join(String(pages)).split("[Página]").join(String(page));
}

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

export type SheetData = {
  view: SheetView;
  cols: Axis;
  rows: Axis;
  merged: MergedCells;
  decorations: Map<string, Decoration>;
};

export function printLayout(job: PrintJob, data: SheetData): Layout {
  return layoutPages(job.range, data.cols, data.rows, { ...job, header: Boolean(job.header), footer: Boolean(job.footer) }, job.repeat);
}

/** Una página impresa, a tamaño real (px CSS). */
export function SheetPage({ job, layout, index, data }: { job: PrintJob; layout: Layout; index: number; data: SheetData }) {
  const { view, cols, rows, merged, decorations } = data;
  const page: PrintPage = layout.pages[index];
  const { scale, margin, repeated } = layout;
  const contentW = layout.width - margin * 2;
  const contentH = layout.height - margin * 2;
  const headW = job.headings ? HEADING_WIDTH : 0;
  const headH = job.headings ? HEADING_HEIGHT : 0;
  const tableW = headW + page.cols.reduce((s, c) => s + cols.size(c), 0);
  const pageCols = new Set(page.cols);

  /** ¿El texto de la celda puede pasar por encima de la vecina de la derecha? */
  function spills(r: number, c: number): boolean {
    const next = c + 1;
    if (!pageCols.has(next) || merged.at(r, next) || decorations.has(`${r},${next}`)) return false;
    const cell = view.rows[r]?.[next];
    return !cell || (cell[0] === "" && !view.styles[cell[2]]?.fill);
  }

  function renderCell(r: number, c: number, rowList: number[]): ReactNode {
    const area = merged.at(r, c);
    let colSpan = 1;
    let rowSpan = 1;
    let source = { r, c };
    if (area) {
      // Una combinada se dibuja una vez por página, en su primera celda visible,
      // y abarca las filas y columnas de esta página que cubre.
      const spanRows = rowList.filter((k) => k >= area.r1 && k <= area.r2);
      const spanCols = page.cols.filter((k) => k >= area.c1 && k <= area.c2);
      if (spanRows[0] !== r || spanCols[0] !== c) return null;
      rowSpan = spanRows.length;
      colSpan = spanCols.length;
      source = { r: area.r1, c: area.c1 };
    }
    const height = area ? rowList.filter((k) => k >= r && k <= area.r2).reduce((sum, k) => sum + rows.size(k), 0) : rows.size(r);
    const [text, numeric, styleId] = view.rows[source.r]?.[source.c] ?? ["", false, 0];
    const style = withTableStyle(view.styles[styleId] ?? view.styles[0], tableAt(view.tables ?? [], source.r, source.c), source.r);
    const deco = decorations.get(`${source.r},${source.c}`);
    const css = cellCss(style, numeric);
    const overflow = !area && text && !numeric && !style.wrap && (!style.h || style.h === "left") && !deco && spills(r, c);
    const { background, borderTop, borderRight, borderBottom, borderLeft, ...inner } = css;
    const tdStyle: CSSProperties = { background, borderTop, borderRight, borderBottom, borderLeft };
    return (
      <td key={c} colSpan={colSpan > 1 ? colSpan : undefined} rowSpan={rowSpan > 1 ? rowSpan : undefined} style={tdStyle}>
        <div className={`print-cell${overflow ? " spill" : ""}`} style={{ ...inner, height }}>
          {deco?.bar && <span className="data-bar" style={{ width: `${Math.max(0, Math.min(1, deco.bar.value)) * 100}%`, background: deco.bar.color }} />}
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

  // Gráficas e imágenes que caen en esta página, en su misma posición.
  const firstCol = page.cols[0];
  const lastCol = page.cols[page.cols.length - 1];
  const firstRow = page.rows[0];
  const lastRow = page.rows[page.rows.length - 1];
  const repeatedH = repeated.reduce((s, r) => s + rows.size(r), 0);
  const drawings =
    firstCol === undefined || firstRow === undefined
      ? []
      : view.drawings.filter((d) => d.x < cols.start(lastCol + 1) && d.x + d.w > cols.start(firstCol) && d.y < rows.start(lastRow + 1) && d.y + d.h > rows.start(firstRow));
  const originX = firstCol === undefined ? 0 : cols.start(firstCol) - headW;
  const originY = firstRow === undefined ? 0 : rows.start(firstRow) - headH - repeatedH;
  const total = layout.pages.length;

  return (
    // Un píxel menos de alto: así el redondeo nunca agrega una hoja en blanco.
    <section className="print-page" style={{ width: layout.width, height: layout.height - 1 }}>
      <div className="print-page-area" style={{ left: margin, top: margin, width: contentW, height: contentH }}>
        <div className="print-page-content" style={{ width: contentW / scale, height: contentH / scale, transform: `scale(${scale})` }}>
          {job.header && (
            <div className="print-page-text" style={{ height: HEADER_TEXT_HEIGHT }}>
              {pageText(job.header, index + 1, total)}
            </div>
          )}
          <div className={`print-sheet${job.gridlines ? " gridlines" : ""}`} style={{ width: tableW }}>
            <table className="print-table" style={{ width: tableW }}>
              <colgroup>
                {job.headings && <col style={{ width: HEADING_WIDTH }} />}
                {page.cols.map((c) => (
                  <col key={c} style={{ width: cols.size(c) }} />
                ))}
              </colgroup>
              <tbody>
                {job.headings && (
                  <tr style={{ height: HEADING_HEIGHT }}>
                    <th className="print-heading" />
                    {page.cols.map((c) => (
                      <th key={c} className="print-heading">
                        {columnName(c)}
                      </th>
                    ))}
                  </tr>
                )}
                {repeated.map((r) => (
                  <tr key={`t${r}`} style={{ height: rows.size(r) }}>
                    {job.headings && <th className="print-heading">{r + 1}</th>}
                    {page.cols.map((c) => renderCell(r, c, repeated))}
                  </tr>
                ))}
                {page.rows.map((r) => (
                  <tr key={r} style={{ height: rows.size(r) }}>
                    {job.headings && <th className="print-heading">{r + 1}</th>}
                    {page.cols.map((c) => renderCell(r, c, page.rows))}
                  </tr>
                ))}
              </tbody>
            </table>
            {drawings.map((d) => (
              <div key={d.id} className="print-drawing" style={{ left: d.x - originX, top: d.y - originY, width: d.w, height: d.h }}>
                {d.type === "chart" ? <ChartSvg chart={d} width={d.w} height={d.h} /> : job.images[d.id] ? <img src={job.images[d.id]} alt={d.name} /> : null}
              </div>
            ))}
          </div>
          {job.footer && (
            <div className="print-page-text print-page-footer" style={{ height: HEADER_TEXT_HEIGHT }}>
              {pageText(job.footer, index + 1, total)}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

/** Todas las páginas, fuera de la app: solo se ven al imprimir (ver print.css). */
export default function PrintSheet({ job, ...data }: { job: PrintJob } & SheetData) {
  const layout = printLayout(job, data);
  return createPortal(
    <div className="print-root" aria-hidden>
      <style>{`@page { size: ${layout.width / 96}in ${layout.height / 96}in; margin: 0; }`}</style>
      {layout.pages.map((_, i) => (
        <SheetPage key={i} job={job} layout={layout} index={i} data={data} />
      ))}
    </div>,
    document.body,
  );
}
