// Utilidades sobre rangos: celdas combinadas y detección de la tabla de datos
// alrededor de una celda (lo que Excel llama "región actual").

import type { Cell, CellView, Range, SheetView } from "../../lib/spreadsheet";

export const MAX_ROW = 1_048_575; // límites de Excel (base 0)
export const MAX_COL = 16_383;

/** Busca rápidamente si una celda pertenece a un rango combinado. */
export class MergedCells {
  readonly ranges: Range[];
  private byCell = new Map<string, Range>();

  constructor(merged: SheetView["merged"]) {
    this.ranges = merged.map(([row, col, width, height]) => ({
      r1: row - 1,
      c1: col - 1,
      r2: row - 1 + height - 1,
      c2: col - 1 + width - 1,
    }));
    for (const range of this.ranges) {
      for (let r = range.r1; r <= range.r2; r++) {
        for (let c = range.c1; c <= range.c2; c++) this.byCell.set(`${r},${c}`, range);
      }
    }
  }

  at(r: number, c: number): Range | undefined {
    return this.byCell.get(`${r},${c}`);
  }

  /** Amplía un rango para que no corte ninguna celda combinada por la mitad. */
  expand(range: Range): Range {
    let result = { ...range };
    let changed = true;
    while (changed) {
      changed = false;
      for (const m of this.ranges) {
        const overlaps = m.r1 <= result.r2 && m.r2 >= result.r1 && m.c1 <= result.c2 && m.c2 >= result.c1;
        const contained = m.r1 >= result.r1 && m.r2 <= result.r2 && m.c1 >= result.c1 && m.c2 <= result.c2;
        if (overlaps && !contained) {
          result = {
            r1: Math.min(result.r1, m.r1),
            c1: Math.min(result.c1, m.c1),
            r2: Math.max(result.r2, m.r2),
            c2: Math.max(result.c2, m.c2),
          };
          changed = true;
        }
      }
    }
    return result;
  }
}

function hasValue(rows: CellView[][], r: number, c: number): boolean {
  return (rows[r]?.[c]?.[0] ?? "") !== "";
}

/**
 * La tabla de datos que rodea a una celda: se expande mientras haya
 * contenido en las filas y columnas vecinas (como ⌘A en Excel).
 */
export function currentRegion(rows: CellView[][], cell: Cell): Range {
  const region: Range = { r1: cell.r, c1: cell.c, r2: cell.r, c2: cell.c };
  const rowHasData = (r: number) => {
    for (let c = region.c1; c <= region.c2; c++) if (hasValue(rows, r, c)) return true;
    return false;
  };
  const colHasData = (c: number) => {
    for (let r = region.r1; r <= region.r2; r++) if (hasValue(rows, r, c)) return true;
    return false;
  };
  let changed = true;
  while (changed) {
    changed = false;
    if (region.r1 > 0 && rowHasData(region.r1 - 1)) (region.r1--, (changed = true));
    if (region.r2 < rows.length && rowHasData(region.r2 + 1)) (region.r2++, (changed = true));
    if (region.c1 > 0 && colHasData(region.c1 - 1)) (region.c1--, (changed = true));
    if (colHasData(region.c2 + 1)) (region.c2++, (changed = true));
  }
  return region;
}

/** La primera fila parece encabezado si toda es texto y la de abajo tiene números o la tabla es de texto. */
export function looksLikeHeader(rows: CellView[][], region: Range): boolean {
  if (region.r2 <= region.r1) return false;
  let filled = 0;
  for (let c = region.c1; c <= region.c2; c++) {
    const cell = rows[region.r1]?.[c];
    if (!cell || cell[0] === "") continue;
    if (cell[1]) return false; // un número en la primera fila: no es encabezado
    filled++;
  }
  return filled > 0;
}

/** Recorta un rango a la zona con datos (para no recorrer un millón de filas vacías). */
export function clampToData(rows: CellView[][], range: Range): Range {
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  return {
    r1: range.r1,
    c1: range.c1,
    r2: Math.max(range.r1, Math.min(range.r2, rows.length - 1)),
    c2: Math.max(range.c1, Math.min(range.c2, width - 1)),
  };
}
