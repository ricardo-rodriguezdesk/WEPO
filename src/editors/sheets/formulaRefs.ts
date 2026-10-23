// Referencias dentro de una fórmula (A1, $B$2, C3:D10, Hoja2!A1…): dónde
// están en el texto, a qué celdas apuntan y con qué color se pintan.

import type { Range } from "../../lib/spreadsheet";

/** Colores de referencia, como los de Excel y Numbers. */
export const REF_COLORS = ["#1a73e8", "#d93025", "#7b1fa2", "#188038", "#e37400", "#00838f", "#c2185b", "#5d4037"];

export type FormulaRef = {
  /** Posición en el texto: [start, end) */
  start: number;
  end: number;
  text: string;
  /** Nombre de la hoja si la referencia lo indica (Hoja2!A1). */
  sheet: string | null;
  range: Range;
  color: string;
};

const CELL = String.raw`\$?[A-Za-z]{1,3}\$?\d{1,7}`;
const SHEET = String.raw`(?:'[^']+'|[A-Za-zÀ-ÿ_][\wÀ-ÿ.]*)!`;
const REF = new RegExp(String.raw`(${SHEET})?(${CELL})(?::(${CELL}))?`, "g");

function columnIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function parseCell(text: string): { r: number; c: number } | null {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(text);
  if (!m) return null;
  return { r: Number(m[2]) - 1, c: columnIndex(m[1]) };
}

/** Partes del texto que están entre comillas (no contienen referencias). */
function stringSpans(formula: string): [number, number][] {
  const spans: [number, number][] = [];
  let start = -1;
  for (let i = 0; i < formula.length; i++) {
    if (formula[i] === '"') {
      if (start === -1) start = i;
      else if (formula[i + 1] === '"') i++; // comilla escapada ""
      else {
        spans.push([start, i + 1]);
        start = -1;
      }
    }
  }
  if (start !== -1) spans.push([start, formula.length]);
  return spans;
}

/** Encuentra las referencias de una fórmula. La misma referencia conserva su color. */
export function findRefs(formula: string): FormulaRef[] {
  if (!formula.startsWith("=")) return [];
  const strings = stringSpans(formula);
  const refs: FormulaRef[] = [];
  const colors = new Map<string, string>();
  for (const m of formula.matchAll(REF)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (strings.some(([a, b]) => start >= a && start < b)) continue;
    // No es referencia si forma parte de un nombre (p. ej. LOG10( o una palabra más larga).
    const before = formula[start - 1] ?? "";
    const after = formula[end] ?? "";
    if (/[\w.]/.test(before) || /[\w(]/.test(after)) continue;
    const a = parseCell(m[2]);
    const b = m[3] ? parseCell(m[3]) : a;
    if (!a || !b) continue;
    const key = m[0].replace(/\$/g, "").toUpperCase();
    if (!colors.has(key)) colors.set(key, REF_COLORS[colors.size % REF_COLORS.length]);
    const sheet = m[1] ? m[1].slice(0, -1).replace(/^'|'$/g, "") : null;
    refs.push({
      start,
      end,
      text: m[0],
      sheet,
      range: { r1: Math.min(a.r, b.r), c1: Math.min(a.c, b.c), r2: Math.max(a.r, b.r), c2: Math.max(a.c, b.c) },
      color: colors.get(key)!,
    });
  }
  return refs;
}

/** En la posición `caret`, ¿se puede insertar una referencia haciendo clic en una celda? */
export function canPointAt(formula: string, caret: number): boolean {
  if (!formula.startsWith("=")) return false;
  const before = formula.slice(0, caret).trimEnd();
  return /[=(,;+\-*/^&<>:]$/.test(before);
}

/**
 * F4: alterna entre A1 → $A$1 → A$1 → $A1 → A1 en la referencia donde está
 * el cursor. Devuelve el nuevo texto y la nueva posición del cursor.
 */
export function cycleReference(formula: string, caret: number): { value: string; caret: number } | null {
  const ref = findRefs(formula).find((r) => caret >= r.start && caret <= r.end);
  if (!ref) return null;
  const cycle = (cell: string) => {
    const m = /^(\$?)([A-Za-z]{1,3})(\$?)(\d+)$/.exec(cell);
    if (!m) return cell;
    const [, colAbs, col, rowAbs, row] = m;
    const state = (colAbs ? 2 : 0) + (rowAbs ? 1 : 0); // 0: A1, 3: $A$1, 1: A$1, 2: $A1
    const next = { 0: 3, 3: 1, 1: 2, 2: 0 }[state]!;
    return `${next & 2 ? "$" : ""}${col}${next & 1 ? "$" : ""}${row}`;
  };
  const bang = ref.text.lastIndexOf("!");
  const prefix = bang === -1 ? "" : ref.text.slice(0, bang + 1);
  const body = ref.text.slice(prefix.length).split(":").map(cycle).join(":");
  const replaced = prefix + body;
  return {
    value: formula.slice(0, ref.start) + replaced + formula.slice(ref.end),
    caret: ref.start + replaced.length,
  };
}
