// Comunicación con el núcleo de hojas de cálculo en Rust (src-tauri/src/sheets.rs).
//
// En la interfaz las filas y columnas empiezan en 0; en Rust (y en Excel)
// empiezan en 1. Esta capa hace la conversión para que el resto del código
// no tenga que pensar en ello.

import { invoke } from "@tauri-apps/api/core";

/** [texto ya formateado, es número] */
export type CellView = [string, boolean];

/** "Foto" de una hoja que devuelve Rust después de cada operación. */
export type SheetView = {
  sheet_names: string[];
  sheet: number;
  rows: CellView[][];
};

export const sheetApi = {
  create: () => invoke<SheetView>("sheet_new"),
  open: (path: string) => invoke<SheetView>("sheet_open", { path }),
  view: (sheet: number) => invoke<SheetView>("sheet_view", { sheet }),

  /** Lo que el usuario escribió: la fórmula (=SUM…) o el valor. */
  cellInput: (sheet: number, row: number, col: number) =>
    invoke<string>("sheet_cell_input", { sheet, row: row + 1, col: col + 1 }),

  setCell: (sheet: number, row: number, col: number, input: string) =>
    invoke<SheetView>("sheet_set_cell", { sheet, row: row + 1, col: col + 1, input }),

  clear: (sheet: number, range: Range) =>
    invoke<SheetView>("sheet_clear", {
      sheet,
      row1: range.r1 + 1,
      col1: range.c1 + 1,
      row2: range.r2 + 1,
      col2: range.c2 + 1,
    }),

  undo: (sheet: number) => invoke<SheetView>("sheet_undo", { sheet }),
  redo: (sheet: number) => invoke<SheetView>("sheet_redo", { sheet }),
  addSheet: () => invoke<SheetView>("sheet_add"),

  /** .xlsx guarda el libro completo; .csv solo la hoja indicada. */
  save: (path: string, sheet: number) => invoke<void>("sheet_save", { path, sheet }),
};

export type Cell = { r: number; c: number };
export type Range = { r1: number; c1: number; r2: number; c2: number };

/** Rectángulo normalizado entre dos celdas (sin importar el orden). */
export function rangeOf(a: Cell, b: Cell): Range {
  return {
    r1: Math.min(a.r, b.r),
    c1: Math.min(a.c, b.c),
    r2: Math.max(a.r, b.r),
    c2: Math.max(a.c, b.c),
  };
}

/** Convierte un índice de columna en su nombre: 0 → A, 25 → Z, 26 → AA. */
export function columnName(index: number): string {
  let name = "";
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

export function cellName({ r, c }: Cell): string {
  return `${columnName(c)}${r + 1}`;
}
