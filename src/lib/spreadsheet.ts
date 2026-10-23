// Comunicación con el núcleo de hojas de cálculo en Rust (src-tauri/src/sheets.rs).
//
// En la interfaz las filas y columnas empiezan en 0; en Rust (y en Excel)
// empiezan en 1. Esta capa hace la conversión para que el resto del código
// no tenga que pensar en ello.

import { invoke } from "@tauri-apps/api/core";

/** [texto ya formateado, es número, índice de su estilo en `styles`] */
export type CellView = [string, boolean, number];

export type BorderView = { style: string; color: string } | null;

/** Estilo de una celda, tal como lo prepara Rust (ver sheet_format.rs). */
export type StyleView = {
  b: boolean;
  i: boolean;
  u: boolean;
  strike: boolean;
  /** Tamaño en puntos */
  size: number;
  font: string;
  color: string | null;
  fill: string | null;
  h: "left" | "center" | "right" | "justify" | null;
  v: "top" | "center" | null;
  wrap: boolean;
  /** arriba, derecha, abajo, izquierda */
  borders: [BorderView, BorderView, BorderView, BorderView];
  num_fmt: string;
};

/** "Foto" de una hoja que devuelve Rust después de cada operación. */
export type SheetView = {
  sheet_names: string[];
  sheet: number;
  rows: CellView[][];
  /** Estilos usados en la hoja; el 0 es el de una celda vacía. */
  styles: StyleView[];
  /** [columna desde 1, píxeles] de las columnas con ancho propio */
  col_widths: [number, number][];
  /** [fila desde 1, píxeles] de las filas con alto propio */
  row_heights: [number, number][];
  /** El archivo tenía gráficas o imágenes que WEPO todavía no conserva. */
  has_drawings: boolean;
  /** Celdas combinadas: [fila, columna, ancho, alto], desde 1. */
  merged: [number, number, number, number][];
  frozen_rows: number;
  frozen_cols: number;
  /** Filas y columnas ocultas, desde 1. */
  hidden_rows: number[];
  hidden_cols: number[];
  /** Barras de datos, íconos y calificaciones del formato condicional (filas y columnas desde 1). */
  decorations: Decoration[];
  /** Listas desplegables de la hoja (desde 1). */
  validations: ValidationView[];
};

export type Decoration = {
  row: number;
  col: number;
  bar: { value: number; axis: number; color: string; negative: string; gradient: boolean } | null;
  icon: { icon: string; color: string } | null;
  rating: { icon: string; count: number; max: number; color: string } | null;
  show_value: boolean;
};

export type ValidationView = {
  row1: number;
  col1: number;
  row2: number;
  col2: number;
  /** Opciones ya resueltas. */
  items: string[];
  /** Cómo se definió: "Sí, No" o "=$H$1:$H$5". */
  source: string;
};

export type ListSource = { kind: "items"; items: string[] } | { kind: "range"; range: string };

/** Una regla de formato condicional tal como la describe el motor. */
export type ConditionalRule = {
  index: number;
  range: string;
  priority: number;
  cf_rule: { type: string; [key: string]: unknown };
  format: { font?: { color?: string; b?: boolean } | null; fill?: { color?: string } | null } | null;
};

export type FindMatch = { sheet: number; row: number; col: number };

/** Respuesta del motor sobre lo que espera una fórmula en el cursor. Sus posiciones no cuentan el "=". */
export type CompletionContext = {
  expecting: ({ FunctionName: string } | { Argument: [string, number] } | "Range" | "Other")[];
  replace_from: number;
};
export type FindOptions = { case: boolean; whole: boolean; all: boolean };

/** Rango en el formato que esperan los comandos de Rust (base 1). */
function rect(range: Range) {
  return { row1: range.r1 + 1, col1: range.c1 + 1, row2: range.r2 + 1, col2: range.c2 + 1 };
}

export const sheetApi = {
  create: () => invoke<SheetView>("sheet_new"),
  open: (path: string) => invoke<SheetView>("sheet_open", { path }),
  view: (sheet: number) => invoke<SheetView>("sheet_view", { sheet }),

  /** Lo que el usuario escribió: la fórmula (=SUM…) o el valor. */
  cellInput: (sheet: number, row: number, col: number) =>
    invoke<string>("sheet_cell_input", { sheet, row: row + 1, col: col + 1 }),

  setCell: (sheet: number, row: number, col: number, input: string) =>
    invoke<SheetView>("sheet_set_cell", { sheet, row: row + 1, col: col + 1, input }),

  clear: (sheet: number, range: Range) => invoke<SheetView>("sheet_clear", { sheet, ...rect(range) }),

  /** Cambia una propiedad de formato: font.b, font.size, fill.fg_color, num_fmt… */
  style: (sheet: number, range: Range, path: string, value: string) =>
    invoke<SheetView>("sheet_style", { sheet, ...rect(range), path, value }),

  border: (sheet: number, range: Range, kind: BorderKind, style: string, color: string) =>
    invoke<SheetView>("sheet_border", { sheet, ...rect(range), kind, style, color }),

  columnWidth: (sheet: number, col1: number, col2: number, width: number) =>
    invoke<SheetView>("sheet_column_width", { sheet, col1: col1 + 1, col2: col2 + 1, width }),

  rowHeight: (sheet: number, row1: number, row2: number, height: number) =>
    invoke<SheetView>("sheet_row_height", { sheet, row1: row1 + 1, row2: row2 + 1, height }),

  /** Copia o corta y devuelve el texto (separado por tabuladores) para el portapapeles. */
  copy: (sheet: number, range: Range, cut: boolean) =>
    invoke<string>("sheet_copy", { sheet, ...rect(range), cut }),

  paste: (sheet: number, row: number, col: number, text: string) =>
    invoke<SheetView>("sheet_paste", { sheet, row: row + 1, col: col + 1, text }),

  // Filas y columnas (índices desde 0 en la interfaz)
  insertRows: (sheet: number, row: number, count: number) =>
    invoke<SheetView>("sheet_insert_rows", { sheet, row: row + 1, count }),
  deleteRows: (sheet: number, row: number, count: number) =>
    invoke<SheetView>("sheet_delete_rows", { sheet, row: row + 1, count }),
  insertColumns: (sheet: number, col: number, count: number) =>
    invoke<SheetView>("sheet_insert_columns", { sheet, col: col + 1, count }),
  deleteColumns: (sheet: number, col: number, count: number) =>
    invoke<SheetView>("sheet_delete_columns", { sheet, col: col + 1, count }),
  hideRows: (sheet: number, row1: number, row2: number, hidden: boolean) =>
    invoke<SheetView>("sheet_hide_rows", { sheet, row1: row1 + 1, row2: row2 + 1, hidden }),
  hideColumns: (sheet: number, col1: number, col2: number, hidden: boolean) =>
    invoke<SheetView>("sheet_hide_columns", { sheet, col1: col1 + 1, col2: col2 + 1, hidden }),
  merge: (sheet: number, range: Range, merge: boolean) =>
    invoke<SheetView>("sheet_merge", { sheet, ...rect(range), merge }),
  /** Deja fijas las primeras `rows` filas y `cols` columnas (0 para quitar). */
  freeze: (sheet: number, rows: number, cols: number) => invoke<SheetView>("sheet_freeze", { sheet, rows, cols }),
  autofill: (sheet: number, source: Range, target: Range) =>
    invoke<SheetView>("sheet_autofill", {
      sheet,
      source: [source.r1 + 1, source.c1 + 1, source.r2 + 1, source.c2 + 1],
      target: [target.r1 + 1, target.c1 + 1, target.r2 + 1, target.c2 + 1],
    }),

  // Pestañas
  renameSheet: (sheet: number, name: string) => invoke<SheetView>("sheet_rename", { sheet, name }),
  deleteSheet: (sheet: number) => invoke<SheetView>("sheet_delete", { sheet }),
  duplicateSheet: (sheet: number) => invoke<SheetView>("sheet_duplicate", { sheet }),
  moveSheet: (sheet: number, to: number) => invoke<SheetView>("sheet_move", { sheet, to }),

  // Datos
  /** Ordena por una o varias columnas (índices desde 0). */
  sort: (sheet: number, range: Range, keys: { col: number; ascending: boolean }[], header: boolean) =>
    invoke<SheetView>("sheet_sort", {
      sheet,
      ...rect(range),
      keys: keys.map((k) => ({ col: k.col + 1, ascending: k.ascending })),
      header,
    }),
  /** Deja visibles solo las filas cuyo valor en `col` está en `keep`; `null` quita el filtro. */
  filter: (sheet: number, range: Range, col: number, keep: string[] | null) =>
    invoke<SheetView>("sheet_filter", { sheet, ...rect(range), col: col + 1, keep }),
  find: async (sheet: number, query: string, options: FindOptions): Promise<FindMatch[]> => {
    const found = await invoke<FindMatch[]>("sheet_find", { sheet, query, ...options });
    return found.map((m) => ({ sheet: m.sheet, row: m.row - 1, col: m.col - 1 }));
  },
  replaceAll: (sheet: number, query: string, replacement: string, options: FindOptions) =>
    invoke<{ count: number; view: SheetView }>("sheet_replace", { sheet, query, replacement, ...options }),

  // Formato condicional y listas desplegables
  conditionalRules: (sheet: number) => invoke<ConditionalRule[]>("sheet_cf_list", { sheet }),
  /** `rule` en el formato de IronCalc, p. ej. {type: "CellIs", operator: "GreaterThan", …}. */
  addConditionalRule: (sheet: number, range: Range, rule: object) =>
    invoke<SheetView>("sheet_cf_add", { sheet, ...rect(range), rule }),
  addIconSet: (sheet: number, range: Range, preset: string) =>
    invoke<SheetView>("sheet_cf_icons", { sheet, ...rect(range), preset }),
  deleteConditionalRule: (sheet: number, index: number) => invoke<SheetView>("sheet_cf_delete", { sheet, index }),
  /** Pone una lista desplegable en el rango, o la quita con `null`. */
  setValidation: (sheet: number, range: Range, source: ListSource | null) =>
    invoke<SheetView>("sheet_validation", { sheet, ...rect(range), source }),

  // Fórmulas
  /** Idioma de las funciones: "es" (SUMA, BUSCARV…) o "en" (SUM, VLOOKUP…). */
  setLanguage: (sheet: number, language: "es" | "en") => invoke<SheetView>("sheet_language", { sheet, language }),
  /** Qué espera la fórmula en la posición del cursor (para el autocompletado). */
  complete: (sheet: number, row: number, col: number, formula: string, cursor: number) =>
    invoke<CompletionContext>("sheet_complete", { sheet, row: row + 1, col: col + 1, formula, cursor }),

  undo: (sheet: number) => invoke<SheetView>("sheet_undo", { sheet }),
  redo: (sheet: number) => invoke<SheetView>("sheet_redo", { sheet }),
  addSheet: () => invoke<SheetView>("sheet_add"),

  /** .xlsx guarda el libro completo; .csv solo la hoja indicada. */
  save: (path: string, sheet: number) => invoke<void>("sheet_save", { path, sheet }),
};

export type BorderKind = "all" | "outer" | "inner" | "top" | "bottom" | "left" | "right" | "none";

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
