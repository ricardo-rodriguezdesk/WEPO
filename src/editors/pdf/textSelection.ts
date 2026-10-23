// Selección de texto en las páginas del PDF.
//
// Quién elige el texto con el mouse está en Annotations.tsx (lo hace WEPO, no el
// navegador). Aquí se miden los rectángulos de lo elegido para resaltarlo.

/**
 * Los rectángulos (en pantalla) del texto elegido dentro de un elemento: solo
 * los de las letras, nunca las cajas de los elementos completos (que en Safari
 * pueden medir toda la página).
 */
export function selectedTextRects(range: Range, within: HTMLElement): DOMRect[] {
  const out: DOMRect[] = [];
  const bounds = within.getBoundingClientRect();
  const walker = document.createTreeWalker(within, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    if (!range.intersectsNode(node) || !node.data.trim()) continue;
    if ((node.parentElement as HTMLElement | null)?.closest(".endOfContent")) continue;
    const part = document.createRange();
    part.selectNodeContents(node);
    if (node === range.startContainer) part.setStart(node, range.startOffset);
    if (node === range.endContainer) part.setEnd(node, range.endOffset);
    if (part.collapsed) continue;
    for (const r of Array.from(part.getClientRects())) {
      // Recortado a la página; se descartan cajas vacías.
      const left = Math.max(r.left, bounds.left);
      const top = Math.max(r.top, bounds.top);
      const right = Math.min(r.right, bounds.right);
      const bottom = Math.min(r.bottom, bounds.bottom);
      if (right - left > 1 && bottom - top > 1) out.push(new DOMRect(left, top, right - left, bottom - top));
    }
  }
  return out;
}
