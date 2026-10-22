// Modelo de datos de la hoja de cálculo y comunicación con el núcleo en Rust.

import { invoke } from "@tauri-apps/api/core";

export type Sheet = { name: string; rows: string[][] };
export type Workbook = { sheets: Sheet[] };

/** Lee el archivo con Rust (calamine / csv) y devuelve todas sus hojas. */
export function openSpreadsheet(path: string): Promise<Workbook> {
  return invoke<Workbook>("open_spreadsheet", { path });
}

export function emptyWorkbook(): Workbook {
  return { sheets: [{ name: "Hoja1", rows: [] }] };
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
