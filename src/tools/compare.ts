// Comparar dos PDF: qué palabras se quitaron, cuáles se agregaron (y dónde), y
// en qué partes cambió el dibujo de cada página.

import type { PDFDocumentProxy } from "../lib/pdf";
import { renderPage } from "./pdfTools";

/** Una palabra con su lugar en la página (en puntos, desde arriba a la izquierda, como se ve). */
export type Word = { text: string; page: number; x: number; y: number; w: number; h: number };
export type Change = { kind: "removed" | "added" | "changed"; before: Word[]; after: Word[] };

export async function wordsOf(doc: PDFDocumentProxy): Promise<Word[]> {
  const words: Word[] = [];
  for (let p = 0; p < doc.numPages; p++) {
    const page = await doc.getPage(p + 1);
    const view = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    for (const it of content.items) {
      if (!("str" in it) || !it.str.trim()) continue;
      const [a, b, c, d, e, f] = it.transform as number[];
      const size = Math.hypot(c, d);
      const [x0, base] = view.convertToViewportPoint(e, f);
      const [x1] = view.convertToViewportPoint(e + (a / (Math.hypot(a, b) || 1)) * it.width, f);
      const left = Math.min(x0, x1);
      const width = Math.abs(x1 - x0);
      // Las palabras se reparten el ancho del pedazo de texto según sus letras.
      const chars = it.str.length || 1;
      let at = 0;
      for (const m of it.str.matchAll(/\S+/g)) {
        const start = m.index ?? 0;
        at = start;
        words.push({ text: m[0], page: p, x: left + (width * at) / chars, y: base - size * 0.85, w: (width * m[0].length) / chars, h: size * 1.1 });
      }
    }
  }
  return words;
}

const norm = (t: string) => t.normalize("NFC").replace(/[‘’]/g, "'").replace(/[“”]/g, '"');

/**
 * Diferencias entre dos listas de palabras (algoritmo de Myers: el menor
 * número de cambios). Devuelve, para cada palabra, si se queda, se quita o se agrega.
 */
export function diffWords(a: string[], b: string[]): ("=" | "-" | "+")[] {
  // Lo igual al principio y al final no cuenta (así los documentos largos casi iguales van rápido).
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) (endA--, endB--);
  const A = a.slice(start, endA);
  const B = b.slice(start, endB);
  const N = A.length;
  const M = B.length;
  const max = N + M;
  const ops: ("=" | "-" | "+")[] = [];
  if (max > 0) {
    const offset = max;
    const v = new Int32Array(2 * max + 2);
    // Para volver sobre los pasos: de cada paso solo se guarda la parte que se usó.
    const trace: { lo: number; arr: Int32Array }[] = [];
    const at = (t: { lo: number; arr: Int32Array }, i: number) => t.arr[i - t.lo] ?? 0;
    let found = false;
    const limit = Math.min(max, 3000);
    for (let dd = 0; dd <= limit && !found; dd++) {
      const lo = Math.max(0, offset - dd - 1);
      trace.push({ lo, arr: v.slice(lo, offset + dd + 2) });
      for (let k = -dd; k <= dd; k += 2) {
        let x = k === -dd || (k !== dd && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
        let y = x - k;
        while (x < N && y < M && A[x] === B[y]) (x++, y++);
        v[offset + k] = x;
        if (x >= N && y >= M) {
          found = true;
          break;
        }
      }
    }
    if (!found) {
      // Demasiado distintos: todo lo de uno se quita y todo lo del otro se agrega.
      ops.push(...Array(N).fill("-"), ...Array(M).fill("+"));
    } else {
      let x = N;
      let y = M;
      const rev: ("=" | "-" | "+")[] = [];
      for (let dd = trace.length - 1; dd >= 0; dd--) {
        const t = trace[dd];
        const k = x - y;
        const prevK = k === -dd || (k !== dd && at(t, offset + k - 1) < at(t, offset + k + 1)) ? k + 1 : k - 1;
        const prevX = dd === 0 ? 0 : at(t, offset + prevK);
        const prevY = dd === 0 ? 0 : prevX - prevK;
        while (x > prevX && y > prevY) (rev.push("="), x--, y--);
        if (dd > 0) {
          if (x === prevX) (rev.push("+"), y--);
          else (rev.push("-"), x--);
        }
      }
      ops.push(...rev.reverse());
    }
  }
  return [...Array(start).fill("="), ...ops, ...Array(a.length - endA).fill("=")];
}

/** Junta las palabras cambiadas seguidas en cambios: «se quitó», «se agregó» o «cambió de… a…». */
export function changesOf(a: Word[], b: Word[]): Change[] {
  const ops = diffWords(
    a.map((w) => norm(w.text)),
    b.map((w) => norm(w.text)),
  );
  const changes: Change[] = [];
  let i = 0;
  let j = 0;
  let current: Change | null = null;
  for (const op of ops) {
    if (op === "=") {
      current = null;
      i++;
      j++;
      continue;
    }
    if (!current) {
      current = { kind: op === "-" ? "removed" : "added", before: [], after: [] };
      changes.push(current);
    }
    if (op === "-") current.before.push(a[i++]);
    else current.after.push(b[j++]);
    current.kind = current.before.length && current.after.length ? "changed" : current.before.length ? "removed" : "added";
  }
  return changes;
}

/** Partes de una página que se ven distintas (en puntos, como se ve). */
export async function visualDiff(docA: PDFDocumentProxy, docB: PDFDocumentProxy, page: number): Promise<{ x: number; y: number; w: number; h: number }[]> {
  if (page >= docA.numPages || page >= docB.numPages) return [];
  const scale = 1;
  const [ca, cb] = await Promise.all([renderPage(docA, page, scale), renderPage(docB, page, scale)]);
  const w = Math.min(ca.width, cb.width);
  const h = Math.min(ca.height, cb.height);
  const da = ca.getContext("2d")!.getImageData(0, 0, w, h).data;
  const db = cb.getContext("2d")!.getImageData(0, 0, w, h).data;
  // En cuadritos de 12 puntos: los que tienen puntos distintos se marcan.
  const cell = 12;
  const cols = Math.ceil(w / cell);
  const rows = Math.ceil(h / cell);
  const marked = new Uint8Array(cols * rows);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]) > 90) marked[Math.floor(y / cell) * cols + Math.floor(x / cell)] = 1;
    }
  }
  ca.width = ca.height = cb.width = cb.height = 0;
  // Cuadritos juntos de un mismo renglón se vuelven un rectángulo.
  const rects: { x: number; y: number; w: number; h: number }[] = [];
  for (let r = 0; r < rows; r++) {
    let c = 0;
    while (c < cols) {
      if (!marked[r * cols + c]) {
        c++;
        continue;
      }
      const c0 = c;
      while (c < cols && marked[r * cols + c]) c++;
      const prev = rects.find((q) => q.y + q.h === r * cell && q.x === c0 * cell && q.w === (c - c0) * cell);
      if (prev) prev.h += cell;
      else rects.push({ x: c0 * cell, y: r * cell, w: (c - c0) * cell, h: cell });
    }
  }
  return rects;
}
