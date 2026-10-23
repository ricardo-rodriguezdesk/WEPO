// Selección de texto en las páginas del PDF, igual que en el visor de pdf.js.
//
// La capa de texto son frases sueltas con espacio vacío entre ellas. En Safari
// (y en la app de Mac, que usa el mismo motor), arrastrar o hacer doble clic
// sobre ese espacio hace que la selección se vaya hasta el final de la página y
// se "pinta todo". pdf.js lo evita con un recuadro invisible (endOfContent) que
// cubre los huecos mientras se elige texto y se mueve junto a donde termina la
// selección. Aquí se hace lo mismo.

const layers = new Map<HTMLElement, HTMLElement>();
let listening: AbortController | null = null;
let prevRange: Range | null = null;
/** Chromium moderno y Firefox no necesitan mover el recuadro (sí Safari/WebKit). */
let modernEngine: boolean | undefined;

function reset(end: HTMLElement, layer: HTMLElement) {
  layer.append(end);
  end.style.width = "";
  end.style.height = "";
  end.style.userSelect = "";
  layer.classList.remove("selecting");
}

function listen() {
  if (listening) return;
  listening = new AbortController();
  const signal = listening.signal;
  let pointerDown = false;
  document.addEventListener("pointerdown", () => (pointerDown = true), { signal });
  document.addEventListener(
    "pointerup",
    () => {
      pointerDown = false;
      layers.forEach(reset);
    },
    { signal },
  );
  window.addEventListener(
    "blur",
    () => {
      pointerDown = false;
      layers.forEach(reset);
    },
    { signal },
  );
  document.addEventListener("keyup", () => !pointerDown && layers.forEach(reset), { signal });
  document.addEventListener(
    "selectionchange",
    () => {
      const selection = document.getSelection();
      if (!selection || selection.rangeCount === 0) {
        layers.forEach(reset);
        return;
      }
      const active = new Set<HTMLElement>();
      for (let i = 0; i < selection.rangeCount; i++) {
        const range = selection.getRangeAt(i);
        for (const layer of layers.keys()) if (range.intersectsNode(layer)) active.add(layer);
      }
      for (const [layer, end] of layers) {
        if (active.has(layer)) layer.classList.add("selecting");
        else reset(end, layer);
      }
      if (modernEngine === undefined) {
        const first = layers.keys().next().value;
        const firefox = first ? getComputedStyle(first).getPropertyValue("-moz-user-select") === "none" : false;
        const chromium = /\bChrome\/(\d+)\b/.exec(navigator.userAgent)?.[1];
        modernEngine = firefox || (!!chromium && parseInt(chromium, 10) >= 148);
      }
      if (modernEngine) return;

      const range = selection.getRangeAt(0);
      const modifyStart =
        prevRange && (range.compareBoundaryPoints(Range.END_TO_END, prevRange) === 0 || range.compareBoundaryPoints(Range.START_TO_END, prevRange) === 0);
      let anchor: Node | null = modifyStart ? range.startContainer : range.endContainer;
      if (anchor?.nodeType === Node.TEXT_NODE) anchor = anchor.parentNode;
      if (!modifyStart && range.endOffset === 0 && anchor) {
        do {
          while (anchor && !anchor.previousSibling) anchor = anchor.parentNode;
          anchor = anchor?.previousSibling ?? null;
        } while (anchor && !anchor.childNodes.length);
      }
      const element = anchor as HTMLElement | null;
      const layer = element?.parentElement?.closest(".textLayer") as HTMLElement | null;
      const end = layer ? layers.get(layer) : undefined;
      if (layer && end && element?.parentElement) {
        end.style.width = layer.style.width;
        end.style.height = layer.style.height;
        end.style.userSelect = "text";
        element.parentElement.insertBefore(end, modifyStart ? element : element.nextSibling);
      }
      prevRange = range.cloneRange();
    },
    { signal },
  );
}

/** Prepara la capa de texto de una página ya dibujada. Devuelve cómo soltarla. */
export function bindTextLayer(layer: HTMLElement): () => void {
  const end = document.createElement("div");
  end.className = "endOfContent";
  layer.append(end);
  const onDown = () => layer.classList.add("selecting");
  layer.addEventListener("mousedown", onDown);
  layers.set(layer, end);
  listen();
  return () => {
    layer.removeEventListener("mousedown", onDown);
    end.remove();
    layers.delete(layer);
    if (!layers.size) {
      listening?.abort();
      listening = null;
      prevRange = null;
    }
  };
}

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
