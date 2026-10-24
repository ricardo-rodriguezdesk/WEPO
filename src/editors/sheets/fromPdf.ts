// Las tablas de un PDF convertido (lib/pdfConvert.ts) como hojas de WEPO Sheets:
// una hoja por tabla. El libro lo arma Rust (sheet_from_tables) de una vez.

import { invoke } from "@tauri-apps/api/core";
import type { Block, Converted } from "../../lib/pdfConvert";
import type { SheetView } from "../../lib/spreadsheet";

type TableCell = { row: number; col: number; text: string; rowspan: number; colspan: number; bold: boolean; fill: string | null };
type TableSheet = { name: string; cells: TableCell[]; widths: number[]; heights: number[]; border: string | null };

const PX_PER_PT = 96 / 72;

/** El texto de una celda (los renglones del PDF se juntan; la celda ajusta el texto). */
function cellText(blocks: Block[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.kind === "paragraph" || b.kind === "heading") parts.push(b.runs.map((r) => r.text).join(""));
    else if (b.kind === "list") parts.push(...b.items.map((runs) => `• ${runs.map((r) => r.text).join("")}`));
    else if (b.kind === "code") parts.push(b.text);
  }
  return parts.join("\n");
}

function allBold(blocks: Block[]): boolean {
  const runs = blocks.flatMap((b) => (b.kind === "paragraph" || b.kind === "heading" ? b.runs : b.kind === "list" ? b.items.flat() : []));
  return runs.length > 0 && runs.every((r) => r.bold || !r.text.trim());
}

export function pdfTables(converted: Converted): TableSheet[] {
  const tables = converted.blocks.filter((b): b is Extract<Block, { kind: "table" }> => b.kind === "table" && !b.boxes);
  return tables.map((t, n) => {
    // Posición real de cada celda: se saltan los lugares que ocupan celdas de arriba que bajan.
    const taken = new Set<string>();
    const cells: TableCell[] = [];
    const lines: number[] = Array(t.rows.length).fill(1);
    t.rows.forEach((row, r) => {
      let col = 0;
      for (const cell of row) {
        while (taken.has(`${r},${col}`)) col++;
        for (let dr = 0; dr < cell.rowspan; dr++) for (let dc = 0; dc < cell.colspan; dc++) taken.add(`${r + dr},${col + dc}`);
        const text = cellText(cell.blocks);
        cells.push({ row: r, col, text: text.replace(/\n(?!•)/g, " ").trim(), rowspan: cell.rowspan, colspan: cell.colspan, bold: (t.header && r === 0) || allBold(cell.blocks), fill: cell.fill });
        // Renglones que tenía en el PDF (para el alto de la fila).
        const count = Math.max(1, cell.text.split("\n").length);
        lines[r] = Math.max(lines[r], Math.ceil(count / cell.rowspan));
        col += cell.colspan;
      }
    });
    const size = converted.bodySize * PX_PER_PT;
    return {
      name: `Tabla ${n + 1}`,
      cells,
      widths: t.widths.map((w) => Math.round(w * PX_PER_PT)),
      heights: lines.map((l) => Math.round(Math.max(22, l * size * 1.35 + 8))),
      border: "#C0C8D4",
    };
  });
}

/** Libro nuevo con las tablas (queda abierto en el motor de esta ventana). */
export function pdfToSheets(converted: Converted): Promise<SheetView> {
  return invoke<SheetView>("sheet_from_tables", { tables: pdfTables(converted) });
}
