import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode, PointerEvent as ReactPointerEvent } from "react";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import type { Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import TextAlign from "@tiptap/extension-text-align";
import { Color, FontFamily, FontSize, TextStyle } from "@tiptap/extension-text-style";
import { Placeholder } from "@tiptap/extensions";
import { open as openDialog, save } from "@tauri-apps/plugin-dialog";
import EditorToolbar from "../../components/EditorToolbar";
import ContextMenu from "../../components/ContextMenu";
import type { MenuItem } from "../../components/ContextMenu";
import { AlignIcon, ColorButton, FONTS, Popover, Separator, ToolButton } from "../sheets/FormatBar";
import ZoomControl from "../sheets/ZoomControl";
import { clampZoom, stepZoom } from "../sheets/layout";
import type { AnimEffect, Animation, Deck, LayoutId, Para, Run, ShapeElement, Slide, SlideElement, TableElement, TextBody, Transition } from "./model";
import { LAYOUTS, THEMES, cloneElement, cloneSlide, isEmptyText, layoutElements, newSlide, placeholderHint, slideTitle, uid } from "./model";
import { SHAPES, isLine, shapePath } from "./geometry";
import SlideView, { textDefaults } from "./SlideView";
import { SlideParagraph, allRuns, fromEditor, mapParas, mapRuns, toEditor } from "./slideText";
import { presentationBase64, savePresentation } from "../../lib/present";
import { recoveryApi } from "../../lib/recovery";
import { invoke } from "@tauri-apps/api/core";
import Presenter from "./Presenter";
import ChartEditor from "./ChartEditor";
import { newChart } from "./charts";
import { DIRECTIONS, DURATIONS, TRANSITIONS, playTransition, transitionName } from "./transitions";
import { ANIM_DIRECTIONS, EFFECTS, TRIGGERS, animationSteps, effectName, newAnimation, playStep, textParagraphs } from "./animations";
import PrintSlides, { PresentPrintDialog, sheetSize } from "./PrintSlides";
import type { SlidePrintJob } from "./PrintSlides";
import { imageDataUrl } from "../../lib/write";
import { extensionOf, fileNameOf } from "../../lib/documents";
import { askPdfPath, printReady, writePdf } from "../../lib/exportPdf";
import { onCommand, runCommand } from "../../lib/commands";
import { hasModifier, keys } from "../../lib/platform";
import "../sheets/FormatBar.css";
import "./PresentEditor.css";

type Props = {
  initial: Deck;
  path: string | null;
  fileName: string;
  onHome: () => void;
  onOpen: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onSaved: (path: string) => void;
  recovered?: boolean;
};

const AUTOSAVE_KEY = "wepo.autosave";
function loadAutosave(): boolean {
  try {
    return localStorage.getItem(AUTOSAVE_KEY) === "1";
  } catch {
    return false;
  }
}

const SIZES = [8, 10, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 44, 48, 54, 60, 66, 72, 80, 96];
const HISTORY_LIMIT = 100;
const SNAP = 6;

type Drag =
  | { kind: "move"; ids: string[]; startX: number; startY: number; origs: SlideElement[]; snapshot: Deck; moved: boolean }
  | { kind: "resize"; id: string; handle: string; startX: number; startY: number; orig: SlideElement; snapshot: Deck; moved: boolean }
  | { kind: "rotate"; id: string; startX: number; startY: number; orig: SlideElement; snapshot: Deck; moved: boolean }
  | { kind: "marquee"; startX: number; startY: number; x0: number; y0: number; base: string[]; snapshot: Deck; moved: boolean };

function updateCell(t: TableElement, r: number, c: number, fn: (cell: TableElement["rows"][number]["cells"][number]) => TableElement["rows"][number]["cells"][number]): TableElement {
  return { ...t, rows: t.rows.map((row, ri) => (ri !== r ? row : { ...row, cells: row.cells.map((x, ci) => (ci === c ? fn(x) : x)) })) };
}

/** El color de acento muy claro (para las filas alternas de una tabla nueva). */
function lighten(hex: string): string {
  const n = hex.replace("#", "");
  const mix = (i: number) => Math.round(parseInt(n.slice(i, i + 2), 16) * 0.15 + 255 * 0.85).toString(16).padStart(2, "0");
  return `#${mix(0)}${mix(2)}${mix(4)}`.toUpperCase();
}

/** Caja que encierra varios elementos. */
function bounds(els: SlideElement[]) {
  const x = Math.min(...els.map((e) => e.x));
  const y = Math.min(...els.map((e) => e.y));
  return { x, y, w: Math.max(...els.map((e) => e.x + e.w)) - x, h: Math.max(...els.map((e) => e.y + e.h)) - y };
}

const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/** WEPO Present: diapositivas con texto, formas, imágenes y tablas, que se abren y guardan como .pptx. */
export default function PresentEditor(props: Props) {
  const { initial, onHome, onOpen, onDirtyChange, onSaved } = props;
  const [deck, setDeckState] = useState<Deck>(initial);
  const deckRef = useRef(deck);
  deckRef.current = deck;
  const history = useRef<{ past: Deck[]; future: Deck[] }>({ past: [], future: [] });
  const [current, setCurrent] = useState(0);
  const [selection, setSelection] = useState<string[]>([]);
  const selected = selection.length === 1 ? selection[0] : null;
  const setSelected = (id: string | null) => setSelection(id ? [id] : []);
  /** Panel de datos de la gráfica elegida (se abre al insertarla o con doble clic). */
  const [chartPanel, setChartPanel] = useState(false);
  /** Celda elegida de una tabla, y la que se está escribiendo. */
  const [cell, setCell] = useState<{ r: number; c: number } | null>(null);
  const [editingCell, setEditingCell] = useState<{ id: string; r: number; c: number } | null>(null);
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [textEditor, setTextEditor] = useState<Editor | null>(null);
  const textEditorRef = useRef<Editor | null>(null);
  textEditorRef.current = textEditor;
  /** Letras que se escribieron justo después del doble clic, antes de que el editor estuviera listo. */
  const pendingText = useRef("");
  const [path, setPath] = useState(props.path);
  const [fileName, setFileName] = useState(props.fileName);
  const [dirty, setDirty] = useState(Boolean(props.recovered));
  const [status, setStatus] = useState<{ text: string; error?: boolean } | null>(
    props.recovered ? { text: "Presentación recuperada: guárdala para conservar los cambios" } : null,
  );
  const [zoom, setZoom] = useState<number | null>(null);
  const [fit, setFit] = useState(0.5);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [guides, setGuides] = useState<{ x: number[]; y: number[] }>({ x: [], y: [] });
  const [dragSlide, setDragSlide] = useState<number | null>(null);
  const [protectedPath] = useState(initial.unsupported.length ? props.path : null);
  const [notice, setNotice] = useState(initial.unsupported.length > 0);
  const [presenting, setPresenting] = useState<number | null>(null);
  /** Diálogo de impresión; "pdf" si se abrió para exportar como PDF. */
  const [printDialog, setPrintDialog] = useState<false | "print" | "pdf">(false);
  /** Con "Exportar PDF", dónde se guarda (si no, se abre el diálogo de impresión). */
  const pdfTarget = useRef<string | null>(null);
  const [printJob, setPrintJob] = useState<SlidePrintJob | null>(null);
  const [autosave, setAutosave] = useState(loadAutosave);
  /** Cuenta los cambios: así se sabe si la copia de recuperación o el archivo ya están al día. */
  const [changes, setChanges] = useState(0);
  const changesRef = useRef(0);
  changesRef.current = changes;
  const recoveredAt = useRef(-1);
  const drag = useRef<Drag | null>(null);
  const clipboard = useRef<SlideElement[]>([]);
  const stage = useRef<HTMLDivElement>(null);

  const slide = deck.slides[Math.min(current, deck.slides.length - 1)];
  const scale = zoom ?? fit;
  const selectedEl = slide.elements.find((e) => e.id === selected) ?? null;
  const selectedEls = slide.elements.filter((e) => selection.includes(e.id));

  // ───────────── cambios e historial ─────────────

  function markDirty() {
    setDirty(true);
    setChanges((n) => n + 1);
    onDirtyChange(true);
  }

  /** Cambia la presentación y lo anota para deshacer. `snapshot`: el estado antes del cambio (si ya se movió algo sin anotar). */
  const commit = useCallback((next: Deck, snapshot?: Deck) => {
    history.current.past.push(snapshot ?? deckRef.current);
    if (history.current.past.length > HISTORY_LIMIT) history.current.past.shift();
    history.current.future = [];
    deckRef.current = next;
    setDeckState(next);
    setDirty(true);
    setChanges((n) => n + 1);
    onDirtyChange(true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** Cambio sin anotar (mientras se arrastra o se escribe). */
  function replace(next: Deck) {
    deckRef.current = next;
    setDeckState(next);
  }

  function undo() {
    const prev = history.current.past.pop();
    if (!prev) return;
    history.current.future.push(deckRef.current);
    replace(prev);
    setEditing(null);
    setCurrent((c) => Math.min(c, prev.slides.length - 1));
    markDirty();
  }

  function redo() {
    const next = history.current.future.pop();
    if (!next) return;
    history.current.past.push(deckRef.current);
    replace(next);
    setEditing(null);
    setCurrent((c) => Math.min(c, next.slides.length - 1));
    markDirty();
  }

  function withSlide(d: Deck, index: number, fn: (s: Slide) => Slide): Deck {
    return { ...d, slides: d.slides.map((s, i) => (i === index ? fn(s) : s)) };
  }

  function withElement(d: Deck, id: string, fn: (e: SlideElement) => SlideElement): Deck {
    return withSlide(d, current, (s) => ({ ...s, elements: s.elements.map((e) => (e.id === id ? fn(e) : e)) }));
  }

  function updateElement(id: string, fn: (e: SlideElement) => SlideElement) {
    commit(withElement(deckRef.current, id, fn));
  }

  // ───────────── zoom: la diapositiva cabe en el espacio disponible ─────────────

  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth - 64;
      const h = el.clientHeight - 64;
      setFit(Math.max(0.1, Math.min(w / deck.width, h / deck.height)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [deck.width, deck.height]);

  // ───────────── diapositivas ─────────────

  function goTo(index: number) {
    const i = Math.max(0, Math.min(deckRef.current.slides.length - 1, index));
    setCurrent(i);
    setSelected(null);
    setEditing(null);
    setEditingCell(null);
    setCell(null);
  }

  function addSlide(layout: LayoutId = slide.layout === "title" ? "titleContent" : slide.layout) {
    const d = deckRef.current;
    const s = newSlide(layout, d);
    const slides = [...d.slides];
    slides.splice(current + 1, 0, s);
    commit({ ...d, slides });
    goTo(current + 1);
  }

  function duplicateSlide(index = current) {
    const d = deckRef.current;
    const slides = [...d.slides];
    slides.splice(index + 1, 0, cloneSlide(d.slides[index]));
    commit({ ...d, slides });
    goTo(index + 1);
  }

  function deleteSlide(index = current) {
    const d = deckRef.current;
    if (d.slides.length === 1) {
      setStatus({ text: "La presentación necesita al menos una diapositiva" });
      return;
    }
    commit({ ...d, slides: d.slides.filter((_, i) => i !== index) });
    goTo(Math.min(index, d.slides.length - 2));
  }

  function moveSlide(from: number, to: number) {
    if (from === to) return;
    const d = deckRef.current;
    const slides = [...d.slides];
    const [s] = slides.splice(from, 1);
    slides.splice(to, 0, s);
    commit({ ...d, slides });
    setCurrent(to);
  }

  function toggleHidden(index = current) {
    commit(withSlide(deckRef.current, index, (s) => ({ ...s, hidden: !s.hidden || undefined })));
  }

  // ───────────── elementos ─────────────

  function addElement(el: SlideElement, edit = false) {
    commit(withSlide(deckRef.current, current, (s) => ({ ...s, elements: [...s.elements, el] })));
    setSelected(el.id);
    setEditing(edit ? el.id : null);
  }

  function addTextBox() {
    const d = deckRef.current;
    addElement(
      {
        id: uid(),
        kind: "shape",
        geom: "rect",
        fill: null,
        line: null,
        x: d.width / 2 - 240,
        y: d.height / 2 - 40,
        w: 480,
        h: 80,
        text: { paras: [{ runs: [] }], anchor: "top", defaultSize: 24 },
      },
      true,
    );
  }

  function addShape(geom: string) {
    const d = deckRef.current;
    const line = isLine(geom);
    addElement({
      id: uid(),
      kind: "shape",
      geom,
      fill: line ? null : d.theme.colors.accent1,
      line: line ? { color: d.theme.text, width: 3 } : null,
      x: d.width / 2 - 160,
      y: d.height / 2 - (line ? 0 : 100),
      w: 320,
      h: line ? 0 : 200,
      text: line ? undefined : { paras: [{ runs: [], align: "center" }], anchor: "middle", defaultSize: 20 },
    } as ShapeElement);
  }

  function addChart() {
    const d = deckRef.current;
    addElement(newChart(d.theme, d.width, d.height));
    setChartPanel(true);
  }

  // ───────────── transiciones ─────────────

  function setTransition(t: Transition | null, all = false) {
    const d = deckRef.current;
    commit({ ...d, slides: d.slides.map((s, i) => (all || i === current ? { ...s, transition: t } : s)) });
    if (t && t.kind !== "none") previewTransition(t);
    if (all) setStatus({ text: t ? `Transición «${transitionName(t)}» en todas las diapositivas` : "Se quitaron las transiciones" });
  }

  // ───────────── animaciones ─────────────

  /** Pone, cambia o quita (null) la animación de entrada de un elemento. */
  function setAnimation(target: string, anim: Animation | null) {
    const d = deckRef.current;
    const before = d.slides[current].animations?.find((a) => a.target === target);
    commit(
      withSlide(d, current, (s) => {
        const list = s.animations ?? [];
        const at = list.findIndex((a) => a.target === target);
        const next = anim ? (at >= 0 ? list.map((a, i) => (i === at ? anim : a)) : [...list, anim]) : list.filter((a) => a.target !== target);
        return { ...s, animations: next.length ? next : undefined };
      }),
    );
    // Al elegir otro efecto (o dirección) se ve cómo queda.
    if (anim && (!before || before.effect !== anim.effect || before.direction !== anim.direction)) previewAnimation(anim.id);
  }

  function moveAnimation(id: string, delta: number) {
    commit(
      withSlide(deckRef.current, current, (s) => {
        const list = [...(s.animations ?? [])];
        const i = list.findIndex((a) => a.id === id);
        const j = i + delta;
        if (i < 0 || j < 0 || j >= list.length) return s;
        [list[i], list[j]] = [list[j], list[i]];
        return { ...s, animations: list };
      }),
    );
  }

  /** Vista previa de una animación (o de todas, en orden) en el editor. */
  function previewAnimation(id?: string) {
    requestAnimationFrame(() => {
      const root = stage.current?.querySelector<HTMLElement>(".present-main-slide .slide");
      const s = deckRef.current.slides[current];
      if (!root || !s) return;
      let offset = 0;
      for (const step of animationSteps(s)) {
        const items = step.items.filter((i) => !id || i.anim.id === id);
        if (!items.length) continue;
        const base = Math.min(...items.map((i) => i.start));
        const shifted = { ...step, items: items.map((i) => ({ ...i, start: i.start - base, end: i.end - base })) };
        playStep(shifted, root, s, deckRef.current, offset);
        offset += Math.max(...shifted.items.map((i) => i.end)) + 250;
      }
    });
  }

  /** Vista previa: la diapositiva entra con su transición en el editor. */
  function previewTransition(t: Transition | null | undefined = slide.transition) {
    // Se anima el marco (la diapositiva de adentro ya lleva su escala en transform).
    const el = stage.current?.querySelector<HTMLElement>(".present-main-slide .slide-frame");
    if (!t || t.kind === "none" || !el) return;
    el.getAnimations().forEach((a) => a.cancel());
    playTransition(t, el, null, () => el.getAnimations().forEach((a) => a.cancel()));
  }

  async function addImage() {
    const file = await openDialog({ multiple: false, filters: [{ name: "Imágenes", extensions: ["png", "jpg", "jpeg", "gif"] }] });
    if (!file) return;
    try {
      const src = await imageDataUrl(file);
      const size = await new Promise<{ w: number; h: number }>((resolve) => {
        const img = new Image();
        img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
        img.onerror = () => resolve({ w: 400, h: 300 });
        img.src = src;
      });
      const d = deckRef.current;
      const k = Math.min(1, (d.width * 0.6) / size.w, (d.height * 0.6) / size.h);
      const w = size.w * k;
      const h = size.h * k;
      addElement({ id: uid(), kind: "image", src, x: (d.width - w) / 2, y: (d.height - h) / 2, w, h, name: fileNameOf(file) });
    } catch (e) {
      setStatus({ text: `No se pudo insertar la imagen: ${e}`, error: true });
    }
  }

  function deleteSelected() {
    if (!selection.length) return;
    commit(
      withSlide(deckRef.current, current, (s) => ({
        ...s,
        elements: s.elements.filter((e) => !selection.includes(e.id)),
        animations: s.animations?.filter((a) => !selection.includes(a.target)),
      })),
    );
    setSelection([]);
    setEditing(null);
  }

  function pasteElements(list: SlideElement[]) {
    const copies = list.map((el) => {
      const copy = cloneElement(el, 20, 20);
      if (copy.kind === "shape") delete copy.placeholder;
      return copy;
    });
    commit(withSlide(deckRef.current, current, (s) => ({ ...s, elements: [...s.elements, ...copies] })));
    setSelection(copies.map((c) => c.id));
    return copies;
  }

  function duplicateSelected() {
    if (selectedEls.length) pasteElements(selectedEls);
  }

  function reorder(direction: "front" | "back" | "forward" | "backward") {
    if (!selection.length) return;
    commit(
      withSlide(deckRef.current, current, (s) => {
        const moving = s.elements.filter((e) => selection.includes(e.id));
        const rest = s.elements.filter((e) => !selection.includes(e.id));
        if (direction === "front") return { ...s, elements: [...rest, ...moving] };
        if (direction === "back") return { ...s, elements: [...moving, ...rest] };
        // Un paso: se mueve cada uno respecto al vecino.
        const list = [...s.elements];
        const order = direction === "forward" ? [...list.keys()].reverse() : [...list.keys()];
        for (const i of order) {
          if (!selection.includes(list[i].id)) continue;
          const j = direction === "forward" ? i + 1 : i - 1;
          if (j < 0 || j >= list.length || selection.includes(list[j].id)) continue;
          [list[i], list[j]] = [list[j], list[i]];
        }
        return { ...s, elements: list };
      }),
    );
  }

  function nudge(dx: number, dy: number) {
    if (!selection.length) return;
    commit(withSlide(deckRef.current, current, (s) => ({ ...s, elements: s.elements.map((e) => (selection.includes(e.id) ? { ...e, x: e.x + dx, y: e.y + dy } : e)) })));
  }

  /** Alinear: un elemento respecto a la diapositiva; varios, entre ellos. */
  function align(kind: "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom") {
    if (!selectedEls.length) return;
    const d = deckRef.current;
    const b = selectedEls.length === 1 ? { x: 0, y: 0, w: d.width, h: d.height } : bounds(selectedEls);
    commit(
      withSlide(d, current, (s) => ({
        ...s,
        elements: s.elements.map((e) => {
          if (!selection.includes(e.id)) return e;
          if (kind === "left") return { ...e, x: b.x };
          if (kind === "hcenter") return { ...e, x: b.x + b.w / 2 - e.w / 2 };
          if (kind === "right") return { ...e, x: b.x + b.w - e.w };
          if (kind === "top") return { ...e, y: b.y };
          if (kind === "vcenter") return { ...e, y: b.y + b.h / 2 - e.h / 2 };
          return { ...e, y: b.y + b.h - e.h };
        }),
      })),
    );
  }

  /** Repartir: el mismo espacio entre tres o más elementos. */
  function distribute(axis: "x" | "y") {
    if (selectedEls.length < 3) {
      setStatus({ text: "Selecciona tres o más elementos para repartirlos" });
      return;
    }
    const size = axis === "x" ? "w" : "h";
    const sorted = [...selectedEls].sort((a, b) => a[axis] - b[axis]);
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const used = sorted.reduce((n, e) => n + e[size], 0);
    const gap = (last[axis] + last[size] - first[axis] - used) / (sorted.length - 1);
    const positions = new Map<string, number>();
    let pos = first[axis];
    for (const e of sorted) {
      positions.set(e.id, pos);
      pos += e[size] + gap;
    }
    commit(withSlide(deckRef.current, current, (s) => ({ ...s, elements: s.elements.map((e) => (positions.has(e.id) ? { ...e, [axis]: positions.get(e.id)! } : e)) })));
  }

  // ───────────── arrastrar, cambiar tamaño, girar y seleccionar con un recuadro ─────────────

  function slidePoint(clientX: number, clientY: number) {
    const rect = stage.current?.querySelector(".present-main-slide .slide")?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: (clientX - rect.left) / scale, y: (clientY - rect.top) / scale };
  }

  function onSlidePointerDown(e: ReactPointerEvent) {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    const handle = target.closest("[data-handle]") as HTMLElement | null;
    const elNode = target.closest("[data-el]") as HTMLElement | null;
    const id = handle ? selected : (elNode?.dataset.el ?? null);
    // Dentro del cuadro (o la celda) que se está escribiendo, el clic es para el texto.
    if (editing && id === editing && !handle) return;
    if (editingCell && id === editingCell.id && target.closest(".slide-cell-editing")) return;
    if (editing) setEditing(null);
    if (editingCell) setEditingCell(null);
    const snapshot = deckRef.current;
    if (!id) {
      // Recuadro de selección sobre la diapositiva vacía.
      const p = slidePoint(e.clientX, e.clientY);
      const base = e.shiftKey ? selection : [];
      if (!e.shiftKey) setSelection([]);
      setCell(null);
      drag.current = { kind: "marquee", startX: e.clientX, startY: e.clientY, x0: p.x, y0: p.y, base, snapshot, moved: false };
      return;
    }
    const el = slide.elements.find((x) => x.id === id);
    if (!el) return;
    e.preventDefault();
    const cellNode = target.closest("[data-cell]") as HTMLElement | null;
    if (el.kind === "table" && cellNode) {
      const [r, c] = cellNode.dataset.cell!.split(",").map(Number);
      setCell({ r, c });
    } else setCell(null);
    if (e.shiftKey && !handle) {
      setSelection(selection.includes(id) ? selection.filter((x) => x !== id) : [...selection, id]);
      return;
    }
    const ids = selection.includes(id) ? selection : [id];
    if (!selection.includes(id)) setSelection([id]);
    if (handle?.dataset.handle === "rot") {
      drag.current = { kind: "rotate", id, startX: e.clientX, startY: e.clientY, orig: structuredClone(el), snapshot, moved: false };
    } else if (handle) {
      drag.current = { kind: "resize", id, handle: handle.dataset.handle!, startX: e.clientX, startY: e.clientY, orig: structuredClone(el), snapshot, moved: false };
    } else {
      const origs = slide.elements.filter((x) => ids.includes(x.id)).map((x) => structuredClone(x));
      drag.current = { kind: "move", ids, startX: e.clientX, startY: e.clientY, origs, snapshot, moved: false };
    }
  }

  useEffect(() => {
    function onMove(e: PointerEvent) {
      const g = drag.current;
      if (!g) return;
      const dx = (e.clientX - g.startX) / scale;
      const dy = (e.clientY - g.startY) / scale;
      if (!g.moved && Math.abs(dx) * scale < 3 && Math.abs(dy) * scale < 3) return;
      g.moved = true;
      const lines = { x: [] as number[], y: [] as number[] };
      const d = deckRef.current;
      if (g.kind === "marquee") {
        const p = slidePoint(e.clientX, e.clientY);
        const box = { x: Math.min(g.x0, p.x), y: Math.min(g.y0, p.y), w: Math.abs(p.x - g.x0), h: Math.abs(p.y - g.y0) };
        setMarquee(box);
        const inside = slide.elements.filter((el) => el.x < box.x + box.w && el.x + el.w > box.x && el.y < box.y + box.h && el.y + Math.max(el.h, 1) > box.y).map((el) => el.id);
        setSelection([...new Set([...g.base, ...inside])]);
        return;
      }
      if (g.kind === "move") {
        const b = bounds(g.origs);
        let x = b.x + dx;
        let y = b.y + dy;
        if (!e.altKey) {
          // Se pega a los bordes y al centro de la diapositiva y de los demás elementos.
          const others = slide.elements.filter((t) => !g.ids.includes(t.id));
          const xs = [0, d.width / 2, d.width, ...others.flatMap((t) => [t.x, t.x + t.w / 2, t.x + t.w])];
          const ys = [0, d.height / 2, d.height, ...others.flatMap((t) => [t.y, t.y + t.h / 2, t.y + t.h])];
          const snap = (pos: number, size: number, targets: number[], out: number[]) => {
            let best: { delta: number; line: number } | null = null;
            for (const edge of [0, size / 2, size]) {
              for (const t of targets) {
                const delta = t - (pos + edge);
                if (Math.abs(delta) <= SNAP / scale && (!best || Math.abs(delta) < Math.abs(best.delta))) best = { delta, line: t };
              }
            }
            if (best) out.push(best.line);
            return best ? pos + best.delta : pos;
          };
          x = snap(x, b.w, xs, lines.x);
          y = snap(y, b.h, ys, lines.y);
        }
        const mx = x - b.x;
        const my = y - b.y;
        const moved = new Map(g.origs.map((o) => [o.id, { ...o, x: o.x + mx, y: o.y + my }]));
        setGuides(lines);
        replace(withSlide(d, current, (s) => ({ ...s, elements: s.elements.map((el) => moved.get(el.id) ?? el) })));
        return;
      }
      const o = g.orig;
      let next: SlideElement;
      if (g.kind === "rotate") {
        const p = slidePoint(e.clientX, e.clientY);
        const cx = o.x + o.w / 2;
        const cy = o.y + o.h / 2;
        let angle = (Math.atan2(p.y - cy, p.x - cx) * 180) / Math.PI + 90;
        // Con ⇧ gira de 15 en 15 grados; cerca de 0, 90, 180 y 270 se pega.
        angle = e.shiftKey ? Math.round(angle / 15) * 15 : angle;
        angle = ((angle % 360) + 360) % 360;
        for (const right of [0, 90, 180, 270, 360]) if (Math.abs(angle - right) < 3) angle = right % 360;
        next = { ...o, rot: angle ? Math.round(angle * 10) / 10 : undefined };
      } else {
        let { x, y, w, h } = o;
        const hd = g.handle;
        if (hd.includes("e")) w = o.w + dx;
        if (hd.includes("s")) h = o.h + dy;
        if (hd.includes("w")) (x = o.x + dx), (w = o.w - dx);
        if (hd.includes("n")) (y = o.y + dy), (h = o.h - dy);
        const line = o.kind === "shape" && isLine(o.geom);
        // Las imágenes guardan su proporción desde las esquinas (o con ⇧).
        const corner = hd.length === 2;
        if ((e.shiftKey || (o.kind === "image" && corner)) && o.w > 0 && o.h > 0 && corner) {
          const ratio = o.w / o.h;
          if (Math.abs(w / o.w) > Math.abs(h / o.h)) {
            const nh = w / ratio;
            if (hd.includes("n")) y = o.y + o.h - nh;
            h = nh;
          } else {
            const nw = h * ratio;
            if (hd.includes("w")) x = o.x + o.w - nw;
            w = nw;
          }
        }
        if (!line) {
          if (w < 8) (x = hd.includes("w") ? o.x + o.w - 8 : x), (w = 8);
          if (h < 8) (y = hd.includes("n") ? o.y + o.h - 8 : y), (h = 8);
        }
        next = { ...o, x, y, w, h };
        // Una tabla reparte el cambio entre sus columnas y filas.
        if (o.kind === "table") {
          const t = next as typeof o;
          next = { ...t, cols: o.cols.map((c) => (c * w) / o.w), rows: o.rows.map((r) => ({ ...r, h: (r.h * h) / o.h })) };
        }
      }
      setGuides(lines);
      replace(withElement(d, g.id, () => next));
    }
    function onUp() {
      const g = drag.current;
      drag.current = null;
      setGuides({ x: [], y: [] });
      setMarquee(null);
      if (g?.moved && g.kind !== "marquee") commit(deckRef.current, g.snapshot);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [scale, slide, commit, current]); // eslint-disable-line react-hooks/exhaustive-deps

  function onSlideDoubleClick(e: React.MouseEvent) {
    const elNode = (e.target as HTMLElement).closest("[data-el]") as HTMLElement | null;
    const el = slide.elements.find((x) => x.id === elNode?.dataset.el);
    const cellNode = (e.target as HTMLElement).closest("[data-cell]") as HTMLElement | null;
    if (el?.kind === "table" && cellNode) {
      const [r, c] = cellNode.dataset.cell!.split(",").map(Number);
      setSelected(el.id);
      setCell({ r, c });
      setEditingCell({ id: el.id, r, c });
      return;
    }
    if (el?.kind === "chart") {
      setSelected(el.id);
      setChartPanel(true);
      return;
    }
    if (!el || el.kind !== "shape" || isLine(el.geom)) return;
    if (!el.text) updateElement(el.id, (x) => ({ ...x, text: { paras: [{ runs: [], align: "center" }], anchor: "middle", defaultSize: 18 } }) as ShapeElement);
    setSelected(el.id);
    setEditing(el.id);
  }

  // ───────────── texto ─────────────

  const editingEl = (editing ? slide.elements.find((e) => e.id === editing) : null) as ShapeElement | null;
  const editingTable = (editingCell ? slide.elements.find((e) => e.id === editingCell.id) : null) as TableElement | null;
  const editSnapshot = useRef<Deck | null>(null);
  const editKey = editing ?? (editingCell ? `${editingCell.id}:${editingCell.r}:${editingCell.c}` : null);

  // Toda una sesión de escritura en un cuadro (o una celda) se deshace de una sola vez.
  useEffect(() => {
    if (editSnapshot.current) {
      const before = editSnapshot.current;
      editSnapshot.current = null;
      if (before !== deckRef.current) commit(deckRef.current, before);
    }
    if (editKey) editSnapshot.current = deckRef.current;
  }, [editKey]); // eslint-disable-line react-hooks/exhaustive-deps

  function onCellChange(id: string, r: number, c: number, text: TextBody) {
    replace(withElement(deckRef.current, id, (e) => updateCell(e as TableElement, r, c, (x) => ({ ...x, text }))));
    markDirty();
  }

  function onTextChange(id: string, text: TextBody) {
    replace(withElement(deckRef.current, id, (e) => ({ ...e, text }) as SlideElement));
    markDirty();
  }

  /** Formato de letra: en el texto seleccionado (si se escribe) o en todo el cuadro. */
  function formatText(fn: (t: TextBody) => TextBody) {
    if (selectedEl?.kind === "shape" && selectedEl.text) updateElement(selectedEl.id, (e) => ({ ...e, text: fn((e as ShapeElement).text!) }) as SlideElement);
    else if (selectedEl?.kind === "table") {
      // Sin celda elegida, el formato va a toda la tabla.
      updateElement(selectedEl.id, (e) => {
        const t = e as TableElement;
        return { ...t, rows: t.rows.map((row, ri) => ({ ...row, cells: row.cells.map((x, ci) => (!cell || (cell.r === ri && cell.c === ci) ? { ...x, text: fn(x.text) } : x)) })) };
      });
    }
  }

  function formatRuns(fn: (r: Run) => Run, tiptap: (ed: Editor) => void) {
    if ((editing || editingCell) && textEditor) return tiptap(textEditor);
    formatText((t) => mapRuns(t, fn));
  }

  function formatParas(fn: (p: Para) => Para, tiptap: (ed: Editor) => void) {
    if ((editing || editingCell) && textEditor) return tiptap(textEditor);
    formatText((t) => mapParas(t, fn));
  }

  // ───────────── tablas ─────────────

  function insertTable(rows: number, cols: number) {
    const d = deckRef.current;
    const w = Math.min(d.width * 0.8, cols * 180);
    const rowH = 44;
    const emptyCell = () => ({ text: { paras: [{ runs: [] }], defaultSize: 18 } as TextBody, fill: null });
    const table: TableElement = {
      id: uid(),
      kind: "table",
      x: (d.width - w) / 2,
      y: Math.max(40, (d.height - rows * rowH) / 2),
      w,
      h: rows * rowH,
      cols: Array.from({ length: cols }, () => w / cols),
      rows: Array.from({ length: rows }, (_, r) => ({ h: rowH, cells: Array.from({ length: cols }, () => ({ ...emptyCell(), fill: r === 0 ? d.theme.colors.accent1 : r % 2 ? lighten(d.theme.colors.accent1) : null })) })),
      border: "#BFBFBF",
      header: true,
    };
    addElement(table);
    setCell({ r: 0, c: 0 });
  }

  function tableOp(op: "rowAbove" | "rowBelow" | "colLeft" | "colRight" | "deleteRow" | "deleteCol" | "toggleHeader") {
    if (selectedEl?.kind !== "table") return;
    const t = selectedEl;
    if (op !== "toggleHeader" && t.rows.some((row) => row.cells.some((c) => c.merged || (c.span ?? 1) > 1 || (c.rowSpan ?? 1) > 1))) {
      setStatus({ text: "Esta tabla tiene celdas combinadas: todavía no se pueden agregar ni quitar filas o columnas en ella" });
      return;
    }
    const at = cell ?? { r: t.rows.length - 1, c: t.cols.length - 1 };
    const blank = (fill: string | null = null) => ({ text: { paras: [{ runs: [] }], defaultSize: t.rows[0]?.cells[0]?.text.defaultSize ?? 18 } as TextBody, fill });
    updateElement(t.id, (e) => {
      const x = structuredClone(e as TableElement);
      if (op === "toggleHeader") return { ...x, header: !x.header };
      if (op === "rowAbove" || op === "rowBelow") {
        const i = op === "rowAbove" ? at.r : at.r + 1;
        const h = x.rows[at.r]?.h ?? 40;
        x.rows.splice(i, 0, { h, cells: x.cols.map((_, ci) => blank(x.rows[at.r]?.cells[ci]?.fill && at.r !== 0 ? x.rows[at.r].cells[ci].fill : null)) });
        x.h += h;
      } else if (op === "colLeft" || op === "colRight") {
        const i = op === "colLeft" ? at.c : at.c + 1;
        const w = x.cols[at.c] ?? 120;
        x.cols.splice(i, 0, w);
        x.rows.forEach((row) => row.cells.splice(i, 0, blank(row.cells[at.c]?.fill ?? null)));
        x.w += w;
      } else if (op === "deleteRow" && x.rows.length > 1) {
        x.h -= x.rows[at.r].h;
        x.rows.splice(at.r, 1);
      } else if (op === "deleteCol" && x.cols.length > 1) {
        x.w -= x.cols[at.c];
        x.cols.splice(at.c, 1);
        x.rows.forEach((row) => row.cells.splice(at.c, 1));
      }
      return x;
    });
    if (op === "deleteRow" || op === "deleteCol") setCell(null);
  }

  function cellFill(color: string) {
    if (selectedEl?.kind !== "table") return;
    updateElement(selectedEl.id, (e) => {
      const t = e as TableElement;
      if (!cell) return { ...t, rows: t.rows.map((row) => ({ ...row, cells: row.cells.map((c) => ({ ...c, fill: color || null })) })) };
      return updateCell(t, cell.r, cell.c, (c) => ({ ...c, fill: color || null }));
    });
  }

  // ───────────── diseño, fondo y tamaño de la diapositiva ─────────────

  /** Cambia el diseño: los cuadros del nuevo diseño toman el texto de los que había con el mismo papel. */
  function applyLayout(layout: LayoutId) {
    const d = deckRef.current;
    commit(
      withSlide(d, current, (s) => {
        const fresh = layoutElements(layout, d.width, d.height);
        const old = s.elements.filter((e): e is ShapeElement => e.kind === "shape" && Boolean(e.placeholder));
        const used = new Set<string>();
        for (const box of fresh) {
          const match = old.find((o) => !used.has(o.id) && o.role === box.role);
          if (match) {
            used.add(match.id);
            if (!isEmptyText(match.text)) box.text = { ...match.text!, anchor: box.text?.anchor, defaultSize: box.text?.defaultSize };
          }
        }
        // Lo que no tenía lugar en el diseño nuevo se queda (si tiene texto) como cuadro normal.
        const leftovers = s.elements.filter((e) => !(e.kind === "shape" && e.placeholder && (used.has(e.id) || isEmptyText(e.text))));
        const kept = leftovers.map((e) => (e.kind === "shape" && e.placeholder ? { ...e, placeholder: undefined, role: undefined } : e));
        return { ...s, layout, elements: [...fresh, ...kept] };
      }),
    );
    setSelection([]);
  }

  async function backgroundImage() {
    const file = await openDialog({ multiple: false, filters: [{ name: "Imágenes", extensions: ["png", "jpg", "jpeg", "gif"] }] });
    if (!file) return;
    try {
      const src = await imageDataUrl(file);
      commit(withSlide(deckRef.current, current, (s) => ({ ...s, backgroundImage: src })));
    } catch (e) {
      setStatus({ text: `No se pudo usar la imagen: ${e}`, error: true });
    }
  }

  function setSlideSize(width: number, height: number) {
    const d = deckRef.current;
    if (d.width === width && d.height === height) return;
    const kx = width / d.width;
    const ky = height / d.height;
    const scaleEl = (e: SlideElement): SlideElement => {
      const moved = { ...e, x: e.x * kx, y: e.y * ky, w: e.w * kx, h: e.h * ky };
      return e.kind === "table" ? { ...moved, cols: e.cols.map((c) => c * kx), rows: e.rows.map((r) => ({ ...r, h: r.h * ky })) } as TableElement : moved;
    };
    commit({ ...d, width, height, slides: d.slides.map((s) => ({ ...s, elements: s.elements.map(scaleEl) })) });
  }

  // ───────────── guardar ─────────────

  function canOverwrite(target: string | null): target is string {
    return Boolean(target && target !== protectedPath && extensionOf(target) === "pptx");
  }

  async function saveTo(target: string, quiet = false) {
    try {
      const savedChanges = changesRef.current;
      await savePresentation(target, deckRef.current, fileNameOf(target).replace(/\.[^.]+$/, ""));
      setPath(target);
      setFileName(fileNameOf(target));
      // Si se siguió editando mientras se guardaba, sigue habiendo cambios.
      if (changesRef.current === savedChanges) {
        setDirty(false);
        onDirtyChange(false);
        recoveryApi.clear();
        recoveredAt.current = -1;
      }
      onSaved(target);
      if (!quiet) setStatus({ text: "Guardado" });
      return true;
    } catch (e) {
      setStatus({ text: `No se pudo guardar: ${e}`, error: true });
      return false;
    }
  }

  async function saveDocument(saveAs = false) {
    if (!saveAs && canOverwrite(path)) return saveTo(path);
    const base = (fileName.replace(/\.[^.]+$/, "") || "Presentación") + (protectedPath && path === protectedPath ? " (copia)" : "");
    const target = await save({ defaultPath: `${base}.pptx`, filters: [{ name: "Presentación de PowerPoint (.pptx)", extensions: ["pptx"] }] });
    if (!target) return false;
    const finalPath = /\.pptx$/i.test(target) ? target : `${target}.pptx`;
    if (finalPath === protectedPath) {
      setStatus({ text: "Elige otro nombre: así no se pierde lo que WEPO no conserva del original.", error: true });
      return false;
    }
    return saveTo(finalPath);
  }

  // Autoguardado: con el interruptor encendido, se guarda solo un par de segundos después de cada cambio.
  useEffect(() => {
    if (!autosave || !dirty || !canOverwrite(path) || editing || editingCell) return;
    const timer = setTimeout(() => {
      saveTo(path, true).then((ok) => ok || setAutosave(false));
    }, 1500);
    return () => clearTimeout(timer);
  }, [autosave, dirty, changes, path, editing, editingCell]); // eslint-disable-line react-hooks/exhaustive-deps

  // Copia de recuperación cada 20 segundos mientras haya cambios sin guardar.
  const recoveryState = useRef({ dirty, fileName, path });
  recoveryState.current = { dirty, fileName, path };
  useEffect(() => {
    const timer = setInterval(async () => {
      const r = recoveryState.current;
      if (!r.dirty || recoveredAt.current === changesRef.current) return;
      recoveredAt.current = changesRef.current;
      try {
        await recoveryApi.saveFile(r.fileName, r.path, await presentationBase64(deckRef.current, r.fileName.replace(/\.[^.]+$/, "")), "pptx");
      } catch {
        recoveredAt.current = -1;
      }
    }, 20000);
    return () => clearInterval(timer);
  }, []);

  async function toggleAutosave() {
    const next = !autosave;
    if (next && !canOverwrite(path)) {
      setStatus({ text: "Elige dónde guardar la presentación para activar el autoguardado" });
      if (!(await saveDocument(true))) return;
    }
    setAutosave(next);
    try {
      localStorage.setItem(AUTOSAVE_KEY, next ? "1" : "0");
    } catch {
      // Sin almacenamiento la preferencia no se recuerda.
    }
    setStatus({ text: next ? "Autoguardado activado: cada cambio se guarda solo" : "Autoguardado desactivado" });
  }

  // ───────────── presentar e imprimir ─────────────

  function present(fromStart: boolean) {
    setEditing(null);
    setEditingCell(null);
    setPresenting(fromStart ? deckRef.current.slides.findIndex((x) => !x.hidden) : current);
  }

  async function startPrint(job: SlidePrintJob, toPdf: boolean) {
    setPrintDialog(false);
    pdfTarget.current = null;
    if (toPdf) {
      const target = await askPdfPath(path, fileName);
      if (!target) return;
      pdfTarget.current = target;
    }
    setPrintJob(job);
  }

  useEffect(() => {
    if (!printJob) return;
    const target = pdfTarget.current;
    if (target) {
      let cancelled = false;
      (async () => {
        await printReady();
        if (cancelled) return;
        // Cada hoja ya trae su margen: el PDF es del tamaño de la hoja (la diapositiva o el papel).
        const size = sheetSize(printJob, deckRef.current);
        const page = { width: (size.width * 72) / 96, height: (size.height * 72) / 96, margin: 0 };
        try {
          const name = await writePdf(target, page);
          setStatus({ text: `PDF guardado: ${name}` });
        } catch (e) {
          setStatus({ text: `No se pudo exportar el PDF: ${e}`, error: true });
        } finally {
          pdfTarget.current = null;
          setPrintJob(null);
        }
      })();
      return () => {
        cancelled = true;
      };
    }
    const done = () => setPrintJob(null);
    window.addEventListener("afterprint", done);
    // Se da un momento para que se dibujen las diapositivas antes de abrir el diálogo.
    const timer = setTimeout(() => invoke("print_window").catch(() => window.print()), 150);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("afterprint", done);
    };
  }, [printJob]);

  useEffect(() => {
    if (!status || status.error) return;
    const timer = setTimeout(() => setStatus(null), 4000);
    return () => clearTimeout(timer);
  }, [status]);

  // ───────────── atajos ─────────────

  const actions = useRef({ saveDocument, undo, redo, deleteSelected, duplicateSelected, nudge, goTo, addSlide, pasteElements, current, selected: selection.length > 0, editing, editingCell, selectedEl, selectedEls, scale });
  actions.current = { saveDocument, undo, redo, deleteSelected, duplicateSelected, nudge, goTo, addSlide, pasteElements, current, selected: selection.length > 0, editing, editingCell, selectedEl, selectedEls, scale };
  useEffect(() => {
    if (textEditor && pendingText.current) {
      textEditor.chain().focus("end").insertContent(pendingText.current).run();
      pendingText.current = "";
    }
  }, [textEditor]);
  useEffect(() => {
    const stop = onCommand((command) => {
      const a = actions.current;
      if (command === "save") a.saveDocument(false);
      else if (command === "save-as") a.saveDocument(true);
      else if (command === "zoom-in") setZoom(clampZoom(stepZoom(a.scale, 1)));
      else if (command === "zoom-out") setZoom(clampZoom(stepZoom(a.scale, -1)));
      else if (command === "zoom-reset") setZoom(null);
      else if (command === "print") setPrintDialog("print");
      else if (command === "export-pdf") setPrintDialog("pdf");
    });
    function onKey(e: KeyboardEvent) {
      const a = actions.current;
      const target = e.target as HTMLElement;
      const typing = Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
      const key = e.key.toLowerCase();
      if (e.key === "F5") {
        e.preventDefault();
        presentRef.current(!e.shiftKey);
        return;
      }
      if (hasModifier(e) && e.altKey && (e.code === "KeyP" || key === "p")) {
        e.preventDefault();
        presentRef.current(true);
        return;
      }
      if (hasModifier(e)) {
        const command = key === "s" ? (e.shiftKey ? "save-as" : "save") : key === "p" ? "print" : key === "=" || key === "+" ? "zoom-in" : key === "-" ? "zoom-out" : key === "0" ? "zoom-reset" : null;
        if (command) {
          e.preventDefault();
          runCommand(command);
          return;
        }
        if (typing) return;
        if (key === "z") (e.preventDefault(), e.shiftKey ? a.redo() : a.undo());
        else if (key === "y") (e.preventDefault(), a.redo());
        else if (key === "d" && a.selected) (e.preventDefault(), a.duplicateSelected());
        else if (key === "m") (e.preventDefault(), a.addSlide());
        else if (key === "c" && a.selectedEls.length) clipboard.current = structuredClone(a.selectedEls);
        else if (key === "x" && a.selectedEls.length) (clipboard.current = structuredClone(a.selectedEls)), a.deleteSelected();
        else if (key === "v" && clipboard.current.length) {
          e.preventDefault();
          // Cada vez que se pega, la copia queda un poco más abajo.
          clipboard.current = a.pasteElements(clipboard.current);
        }
        else if (key === "a") {
          e.preventDefault();
          setSelection(slideRef.current.elements.map((x) => x.id));
        }
        return;
      }
      if (typing) {
        if (e.key === "Escape" && a.editing) (e.preventDefault(), setEditing(null));
        return;
      }
      if ((a.editing || a.editingCell) && !textEditorRef.current && e.key.length === 1) {
        e.preventDefault();
        pendingText.current += e.key;
        return;
      }
      // Mientras se abre el editor de texto, las demás teclas no tocan la diapositiva.
      if (a.editing || a.editingCell) return;
      if (e.key === "Escape") setSelection([]);
      else if ((e.key === "Delete" || e.key === "Backspace") && a.selected) (e.preventDefault(), a.deleteSelected());
      else if (e.key.startsWith("Arrow") && a.selected) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        a.nudge(e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0, e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0);
      } else if ((e.key === "PageDown" || e.key === "ArrowDown") && !a.selected) (e.preventDefault(), a.goTo(a.current + 1));
      else if ((e.key === "PageUp" || e.key === "ArrowUp") && !a.selected) (e.preventDefault(), a.goTo(a.current - 1));
      else if (e.key === "Enter" && a.selectedEl?.kind === "shape" && !isLine(a.selectedEl.geom)) (e.preventDefault(), setEditing(a.selectedEl.id));
    }
    window.addEventListener("keydown", onKey);
    return () => {
      stop();
      window.removeEventListener("keydown", onKey);
    };
  }, []);
  const presentRef = useRef(present);
  presentRef.current = present;
  const slideRef = useRef(slide);
  slideRef.current = slide;

  // ───────────── menú de las miniaturas ─────────────

  function slideMenu(e: React.MouseEvent, index: number) {
    e.preventDefault();
    setCurrent(index);
    const s = deck.slides[index];
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: "Presentar desde aquí", shortcut: "⇧F5", action: () => setPresenting(index) },
        "separator",
        { label: "Nueva diapositiva", shortcut: keys("⌘M"), action: () => addSlide() },
        { label: "Duplicar diapositiva", action: () => duplicateSlide(index) },
        { label: s.hidden ? "Mostrar diapositiva" : "Ocultar diapositiva", action: () => toggleHidden(index) },
        "separator",
        { label: "Eliminar diapositiva", danger: true, disabled: deck.slides.length === 1, action: () => deleteSlide(index) },
      ],
    });
  }

  const thumbWidth = 168;

  return (
    <div className="editor kind-present present-editor">
      <EditorToolbar
        kind="present"
        fileName={fileName}
        dirty={dirty}
        onHome={onHome}
        onOpen={onOpen}
        actions={
          <div className="toolbar-group">
            <button className="btn btn-icon" onClick={undo} title={keys("Deshacer (⌘Z)")} aria-label="Deshacer">
              ↶
            </button>
            <button className="btn btn-icon" onClick={redo} title={keys("Rehacer (⌘⇧Z)")} aria-label="Rehacer">
              ↷
            </button>
            <button className="btn btn-icon" onClick={() => setPrintDialog("print")} title={keys("Imprimir o exportar a PDF (⌘P)")} aria-label="Imprimir">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
                <path d="M7 8V3h10v5M7 17H4v-7a2 2 0 012-2h12a2 2 0 012 2v7h-3" />
                <rect x="7" y="14" width="10" height="7" rx="1" />
              </svg>
            </button>
            <button className="btn btn-pdf" onClick={() => setPrintDialog("pdf")} title="Exportar como PDF (guarda el archivo directo)" aria-label="Exportar como PDF">
              PDF
            </button>
            <label
              className={`autosave-toggle${autosave ? " on" : ""}`}
              title={autosave ? "Cada cambio se guarda solo en el archivo" : "Guardar solo cada cambio en el archivo (también hay una copia de recuperación por si la app se cierra)"}
            >
              <input type="checkbox" role="switch" checked={autosave} onChange={toggleAutosave} />
              <span className="autosave-track" aria-hidden />
              Autoguardado
            </label>
            <button className="btn" onClick={() => saveDocument()} title={keys("Guardar (⌘S)")}>
              Guardar
            </button>
            <button className="btn btn-primary present-play" onClick={() => present(true)} title="Presentar desde el inicio (F5) · desde esta diapositiva (⇧F5)">
              ▶ Presentar
            </button>
          </div>
        }
      />
      <PresentBar
        deck={deck}
        slide={slide}
        selected={selectedEl}
        count={selection.length}
        cell={cell}
        editing={editing || editingCell ? textEditor : null}
        onAddSlide={addSlide}
        onTheme={(theme) => commit({ ...deckRef.current, theme })}
        onBackground={(color) => commit(withSlide(deckRef.current, current, (s) => ({ ...s, background: color || null, backgroundImage: color ? null : s.backgroundImage })))}
        onTextBox={addTextBox}
        onShape={addShape}
        onImage={addImage}
        onChart={addChart}
        onEditChart={() => setChartPanel(true)}
        onTransition={setTransition}
        onPreviewTransition={() => previewTransition()}
        onAnimation={setAnimation}
        onMoveAnimation={moveAnimation}
        onPreviewAnimation={previewAnimation}
        formatRuns={formatRuns}
        formatParas={formatParas}
        onFill={(color) => selected && updateElement(selected, (e) => ({ ...e, fill: color || null }) as SlideElement)}
        onLine={(line) => selected && updateElement(selected, (e) => ({ ...e, line }) as SlideElement)}
        onReorder={reorder}
        onDuplicate={duplicateSelected}
        onDelete={deleteSelected}
        onAlign={align}
        onDistribute={distribute}
        onTable={insertTable}
        onTableOp={tableOp}
        onCellFill={cellFill}
        onLayout={applyLayout}
        onBackgroundImage={backgroundImage}
        onClearBackgroundImage={() => commit(withSlide(deckRef.current, current, (s) => ({ ...s, backgroundImage: null })))}
        onSize={setSlideSize}
      />

      {notice && (
        <div className="sheet-notice present-notice" role="status">
          <span>
            Esta presentación tiene cosas que WEPO Present todavía no conserva ({initial.unsupported.join(", ")}). Al guardar se crea una copia y el original queda
            intacto.
          </span>
          <button className="btn btn-icon" aria-label="Cerrar aviso" onClick={() => setNotice(false)}>
            ×
          </button>
        </div>
      )}

      <div className="present-body">
        <nav className="present-slides" aria-label="Diapositivas">
          {deck.slides.map((s, i) => (
            <div
              key={s.id}
              className={`present-thumb${i === current ? " current" : ""}${s.hidden ? " hidden-slide" : ""}${dragSlide !== null && dragSlide !== i ? " drop-target" : ""}`}
              draggable
              onDragStart={(e) => {
                setDragSlide(i);
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragEnd={() => setDragSlide(null)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (dragSlide !== null) moveSlide(dragSlide, i);
                setDragSlide(null);
              }}
              onClick={() => goTo(i)}
              onContextMenu={(e) => slideMenu(e, i)}
              title={slideTitle(s) || `Diapositiva ${i + 1}`}
            >
              <span className="present-thumb-number">{i + 1}</span>
              {s.transition && s.transition.kind !== "none" && (
                <span className="present-thumb-transition" title={`Transición: ${transitionName(s.transition)}`} aria-label={`Transición: ${transitionName(s.transition)}`}>
                  ✦
                </span>
              )}
              <SlideView slide={s} deck={deck} scale={thumbWidth / deck.width} />
            </div>
          ))}
          <button type="button" className="present-add-slide" onClick={() => addSlide()}>
            + Nueva diapositiva
          </button>
        </nav>

        <div className="present-center">
          <div className="present-stage" ref={stage} onPointerDown={(e) => e.target === e.currentTarget && (setSelection([]), setEditing(null), setEditingCell(null))}>
            <div className="present-main-slide" onPointerDown={onSlidePointerDown} onDoubleClick={onSlideDoubleClick}>
              <SlideView
                slide={slide}
                deck={deck}
                scale={scale}
                hints
                interactive
                editingId={editing}
                activeCell={selectedEl?.kind === "table" && cell ? { id: selectedEl.id, ...cell } : null}
                editingCell={editingCell}
                editingSlot={
                  editingEl?.text ? (
                    <TextBox key={editingEl.id} text={editingEl.text} hint={editingEl.role ? placeholderHint(editingEl.role) : "Escribe aquí"} onChange={(t) => onTextChange(editingEl.id, t)} onEditor={setTextEditor} />
                  ) : editingCell && editingTable ? (
                    <TextBox
                      key={editKey!}
                      text={editingTable.rows[editingCell.r].cells[editingCell.c].text}
                      hint=""
                      onChange={(t) => onCellChange(editingCell.id, editingCell.r, editingCell.c, t)}
                      onEditor={setTextEditor}
                    />
                  ) : null
                }
              >
                <AnimationBadges slide={slide} scale={scale} />
                {selectedEls.map((el) => (
                  <SelectionBox key={el.id} el={el} scale={scale} editing={editing === el.id || editingCell?.id === el.id} handles={selectedEls.length === 1} />
                ))}
                {marquee && <div className="present-marquee" style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h, borderWidth: 1 / scale }} />}
                {guides.x.map((x, i) => (
                  <div key={`x${i}`} className="present-guide vertical" style={{ left: x, width: 1 / scale }} />
                ))}
                {guides.y.map((y, i) => (
                  <div key={`y${i}`} className="present-guide horizontal" style={{ top: y, height: 1 / scale }} />
                ))}
              </SlideView>
            </div>
          </div>
          <textarea
            className="present-notes"
            placeholder="Haz clic para agregar notas del orador"
            value={slide.notes}
            onFocus={() => (editSnapshot.current = deckRef.current)}
            onChange={(e) => {
              replace(withSlide(deckRef.current, current, (s) => ({ ...s, notes: e.target.value })));
              markDirty();
            }}
            onBlur={() => {
              const before = editSnapshot.current;
              editSnapshot.current = null;
              if (before && before !== deckRef.current) commit(deckRef.current, before);
            }}
            aria-label="Notas del orador"
          />
        </div>
        {chartPanel && selectedEl?.kind === "chart" && selection.length === 1 && (
          <ChartEditor chart={selectedEl} theme={deck.theme} onChange={(next) => updateElement(next.id, () => next)} onClose={() => setChartPanel(false)} />
        )}
      </div>

      <footer className="write-footer present-footer">
        <span>
          Diapositiva {current + 1} de {deck.slides.length}
          {slide.hidden ? " (oculta)" : ""}
        </span>
        <span className="present-theme-name">Tema: {deck.theme.name}</span>
        {status && <span className={`sheet-status ${status.error ? "error" : ""}`}>{status.text}</span>}
        <button type="button" className="btn present-fit" onClick={() => setZoom(null)} disabled={zoom === null} title={keys("Ajustar a la ventana (⌘0)")}>
          Ajustar
        </button>
        <ZoomControl zoom={Math.round(scale * 100) / 100} onChange={(z) => setZoom(clampZoom(z))} />
      </footer>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {presenting !== null && (
        <Presenter
          deck={deck}
          start={Math.max(0, presenting)}
          onExit={(last) => {
            setPresenting(null);
            setCurrent(last);
          }}
        />
      )}
      {printDialog && (
        <PresentPrintDialog
          deck={deck}
          current={current}
          pdf={printDialog === "pdf"}
          onPrint={(job, toPdf) => void startPrint(job, toPdf)}
          onClose={() => setPrintDialog(false)}
        />
      )}
      {printJob && <PrintSlides deck={deck} job={printJob} />}
    </div>
  );
}

/** Marco de selección con sus agarraderas (de tamaño fijo en la pantalla). */
function SelectionBox({ el, scale, editing, handles: withHandles }: { el: SlideElement; scale: number; editing: boolean; handles: boolean }) {
  const size = 9 / scale;
  const line = el.kind === "shape" && isLine(el.geom);
  const handles = !withHandles ? [] : line ? ["nw", "se"] : [...HANDLES, "rot"];
  const pos = (h: string) =>
    h === "rot" ? { left: el.w / 2 - size / 2, top: -size / 2 - 26 / scale } : {
    left: h.includes("w") ? -size / 2 : h.includes("e") ? el.w - size / 2 : el.w / 2 - size / 2,
    top: h.includes("n") ? -size / 2 : h.includes("s") ? el.h - size / 2 : el.h / 2 - size / 2,
  };
  return (
    <div
      className={`present-selection${editing ? " editing" : ""}`}
      style={{ left: el.x, top: el.y, width: Math.max(el.w, 1), height: Math.max(el.h, 1), borderWidth: 1.5 / scale, transform: el.rot ? `rotate(${el.rot}deg)` : undefined }}
    >
      {!editing && withHandles && !line && <span className="present-rot-stem" style={{ left: el.w / 2, top: -26 / scale, height: 26 / scale - size / 2, width: 1.5 / scale }} />}
      {!editing &&
        handles.map((h) => (
          <span key={h} className={`present-handle h-${h}`} data-handle={h} style={{ ...pos(h), width: size, height: size, borderWidth: 1.5 / scale }} />
        ))}
    </div>
  );
}

/** Editor de texto de un cuadro o una celda (mientras se escribe en él). */
function TextBox({ text, hint, onChange, onEditor }: { text: TextBody; hint: string; onChange: (t: TextBody) => void; onEditor: (e: Editor | null) => void }) {
  const base = useRef(text);
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: false, bulletList: false, orderedList: false, listItem: false, blockquote: false, codeBlock: false, horizontalRule: false, code: false, link: { openOnClick: false } }),
      TextStyle,
      Color,
      FontFamily,
      FontSize,
      TextAlign.configure({ types: ["paragraph"] }),
      SlideParagraph,
      Placeholder.configure({ placeholder: hint }),
    ],
    content: toEditor(text),
    autofocus: "end",
    editorProps: { attributes: { class: "slide-editor", spellcheck: "true", lang: "es" } },
    onUpdate: ({ editor: e }) => onChange(fromEditor(e.getJSON(), base.current)),
  });
  useEffect(() => {
    onEditor(editor);
    return () => onEditor(null);
  }, [editor, onEditor]);
  return <EditorContent editor={editor} className="slide-editor-wrap" onPointerDown={(e) => e.stopPropagation()} />;
}

// ───────────── barra de formato ─────────────

type BarProps = {
  deck: Deck;
  slide: Slide;
  selected: SlideElement | null;
  /** Cuántos elementos hay seleccionados. */
  count: number;
  cell: { r: number; c: number } | null;
  editing: Editor | null;
  onAddSlide: (layout?: LayoutId) => void;
  onAlign: (kind: "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom") => void;
  onDistribute: (axis: "x" | "y") => void;
  onTable: (rows: number, cols: number) => void;
  onTableOp: (op: "rowAbove" | "rowBelow" | "colLeft" | "colRight" | "deleteRow" | "deleteCol" | "toggleHeader") => void;
  onCellFill: (color: string) => void;
  onLayout: (layout: LayoutId) => void;
  onBackgroundImage: () => void;
  onClearBackgroundImage: () => void;
  onSize: (width: number, height: number) => void;
  onTheme: (theme: Deck["theme"]) => void;
  onBackground: (color: string) => void;
  onTextBox: () => void;
  onShape: (geom: string) => void;
  onImage: () => void;
  onChart: () => void;
  onEditChart: () => void;
  onTransition: (t: Transition | null, all?: boolean) => void;
  onPreviewTransition: () => void;
  onAnimation: (target: string, anim: Animation | null) => void;
  onMoveAnimation: (id: string, delta: number) => void;
  onPreviewAnimation: (id?: string) => void;
  formatRuns: (fn: (r: Run) => Run, tiptap: (ed: Editor) => void) => void;
  formatParas: (fn: (p: Para) => Para, tiptap: (ed: Editor) => void) => void;
  onFill: (color: string) => void;
  onLine: (line: ShapeElement["line"]) => void;
  onReorder: (direction: "front" | "back" | "forward" | "backward") => void;
  onDuplicate: () => void;
  onDelete: () => void;
};

function PresentBar(props: BarProps) {
  const { deck, selected, editing } = props;
  const shape = selected?.kind === "shape" ? selected : null;
  const table = selected?.kind === "table" ? selected : null;
  const textTarget = editing || (shape && !isLine(shape.geom) && shape.text) || table ? true : false;
  const defaults = textDefaults(shape, deck);

  // Estado del formato: del texto seleccionado (si se escribe) o de todo el cuadro.
  const live = useEditorState({
    editor: editing,
    selector: ({ editor: e }) =>
      e
        ? {
            bold: e.isActive("bold"),
            italic: e.isActive("italic"),
            underline: e.isActive("underline"),
            strike: e.isActive("strike"),
            color: (e.getAttributes("textStyle").color as string | undefined) ?? null,
            size: (e.getAttributes("textStyle").fontSize as string | undefined) ?? null,
            font: (e.getAttributes("textStyle").fontFamily as string | undefined) ?? null,
            align: (e.isActive({ textAlign: "center" }) ? "center" : e.isActive({ textAlign: "right" }) ? "right" : e.isActive({ textAlign: "justify" }) ? "justify" : "left") as string,
            bullet: (e.getAttributes("paragraph").bullet as string | null) ?? null,
          }
        : null,
  });
  const text = shape?.text ?? (table ? table.rows[props.cell?.r ?? 0]?.cells[props.cell?.c ?? 0]?.text : undefined);
  const firstRun = text?.paras.flatMap((p) => p.runs).find((r) => r.text);
  const state = live ?? {
    bold: allRuns(text, (r) => Boolean(r.bold)),
    italic: allRuns(text, (r) => Boolean(r.italic)),
    underline: allRuns(text, (r) => Boolean(r.underline)),
    strike: allRuns(text, (r) => Boolean(r.strike)),
    color: firstRun?.color ?? null,
    size: firstRun?.size ? `${firstRun.size}pt` : null,
    font: firstRun?.font ?? null,
    align: text?.paras[0]?.align ?? "left",
    bullet: text?.paras[0]?.bullet ?? null,
  };
  const size = state.size ? Math.round(parseFloat(state.size) * (state.size.endsWith("px") ? 0.75 : 1)) : Math.round(defaults.size);
  const sizes = SIZES.includes(size) ? SIZES : [...SIZES, size].sort((a, b) => a - b);
  const font = (state.font ?? defaults.font).split(",")[0].replace(/["']/g, "").trim();
  const fonts = FONTS.includes(font) ? FONTS : [font, ...FONTS];

  const toggle = (key: "bold" | "italic" | "underline" | "strike", cmd: (ed: Editor) => void) =>
    props.formatRuns((r) => ({ ...r, [key]: !state[key] || undefined }), cmd);

  return (
    <div className="format-bar present-bar" role="toolbar" aria-label="Diapositivas">
      <div className="fb-split">
        <button type="button" className="fb-button present-new" title={keys("Nueva diapositiva (⌘M)")} onMouseDown={(e) => e.preventDefault()} onClick={() => props.onAddSlide()}>
          + Diapositiva
        </button>
        <Popover
          button={(toggleOpen, open) => (
            <button type="button" className={`fb-button fb-caret${open ? " pressed" : ""}`} aria-label="Elegir el diseño de la diapositiva nueva" onClick={toggleOpen}>
              ▾
            </button>
          )}
        >
          {(close) => (
            <div className="present-layouts">
              {LAYOUTS.map((l) => (
                <button key={l.id} type="button" onClick={() => (props.onAddSlide(l.id), close())}>
                  <LayoutPreview id={l.id} />
                  <span>{l.name}</span>
                </button>
              ))}
            </div>
          )}
        </Popover>
      </div>
      <Popover
        button={(toggleOpen, open) => (
          <button type="button" className={`fb-button present-theme-btn${open ? " pressed" : ""}`} onClick={toggleOpen} title="Tema de la presentación">
            Tema ▾
          </button>
        )}
      >
        {(close) => (
          <div className="present-themes">
            {THEMES.map((t) => (
              <button key={t.id} type="button" className={deck.theme.id === t.id ? "current" : ""} onClick={() => (props.onTheme(t), close())}>
                <span className="present-theme-swatch" style={{ background: t.background, color: t.title, fontFamily: `"${t.fonts.major}"` }}>
                  Aa
                  <span className="present-theme-colors">
                    {[t.colors.accent1, t.colors.accent2, t.colors.accent3, t.colors.accent4].map((c) => (
                      <i key={c} style={{ background: c }} />
                    ))}
                  </span>
                </span>
                <span>{t.name}</span>
              </button>
            ))}
          </div>
        )}
      </Popover>
      <ColorButton
        label="Fondo de la diapositiva"
        current={props.slide.background}
        emptyLabel="El del tema"
        onPick={props.onBackground}
        icon={
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
            <rect x="3" y="5" width="18" height="14" rx="1.5" />
            <path d="M3 15l5-5 4 4 3-3 6 6" />
          </svg>
        }
      />
      <Popover
        button={(toggleOpen, open) => (
          <button type="button" className={`fb-button present-theme-btn${open ? " pressed" : ""}`} onClick={toggleOpen} title="Diapositiva: diseño, imagen de fondo y tamaño">
            Diapositiva ▾
          </button>
        )}
      >
        {(close) => (
          <div className="present-slide-menu">
            <p className="present-menu-title">Cambiar el diseño</p>
            <div className="present-layouts">
              {LAYOUTS.map((l) => (
                <button key={l.id} type="button" className={props.slide.layout === l.id ? "current" : ""} onClick={() => (props.onLayout(l.id), close())}>
                  <LayoutPreview id={l.id} />
                  <span>{l.name}</span>
                </button>
              ))}
            </div>
            <p className="present-menu-title">Fondo</p>
            <div className="present-menu-row">
              <button type="button" className="btn" onClick={() => (props.onBackgroundImage(), close())}>
                Imagen de fondo…
              </button>
              {props.slide.backgroundImage && (
                <button type="button" className="btn" onClick={() => (props.onClearBackgroundImage(), close())}>
                  Quitar imagen
                </button>
              )}
            </div>
            <p className="present-menu-title">Tamaño de las diapositivas</p>
            <div className="present-menu-row">
              <button type="button" className={`btn${deck.width / deck.height > 1.5 ? " btn-primary" : ""}`} onClick={() => (props.onSize(1280, 720), close())}>
                Panorámica 16:9
              </button>
              <button type="button" className={`btn${deck.width / deck.height < 1.5 ? " btn-primary" : ""}`} onClick={() => (props.onSize(960, 720), close())}>
                Estándar 4:3
              </button>
            </div>
          </div>
        )}
      </Popover>
      <Separator />
      <ToolButton label="Cuadro de texto" onClick={props.onTextBox}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
          <rect x="3" y="4" width="18" height="16" rx="1.5" strokeDasharray="3 2" />
          <path d="M8 9h8M12 9v7" />
        </svg>
      </ToolButton>
      <Popover
        button={(toggleOpen, open) => (
          <ToolButton label="Formas" pressed={open} onClick={toggleOpen}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
              <circle cx="8" cy="9" r="5" />
              <rect x="11" y="11" width="10" height="10" rx="1" />
            </svg>
          </ToolButton>
        )}
      >
        {(close) => (
          <div className="present-shapes">
            {SHAPES.map((s) => (
              <button key={s.geom} type="button" title={s.name} aria-label={s.name} onClick={() => (props.onShape(s.geom), close())}>
                <svg width="26" height="20" viewBox="-2 -2 30 24" aria-hidden>
                  <path d={shapePath(s.geom, 26, 20).d} fill={isLine(s.geom) ? "none" : "currentColor"} fillOpacity="0.15" stroke="currentColor" strokeWidth="1.5" />
                </svg>
              </button>
            ))}
          </div>
        )}
      </Popover>
      <ToolButton label="Imagen" onClick={props.onImage}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <circle cx="9" cy="10" r="2" />
          <path d="M21 17l-5-5-9 8" />
        </svg>
      </ToolButton>
      <Popover
        button={(toggleOpen, open) => (
          <ToolButton label="Tabla" pressed={open} onClick={toggleOpen}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
              <rect x="3" y="4" width="18" height="16" rx="1.5" />
              <path d="M3 9h18M3 14h18M9 4v16M15 4v16" />
            </svg>
          </ToolButton>
        )}
      >
        {(close) => <TablePicker onPick={(r, c) => (props.onTable(r, c), close())} />}
      </Popover>
      <ToolButton label="Gráfica" onClick={props.onChart}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
          <path d="M4 20h16" />
          <rect x="5.5" y="11" width="3" height="7" />
          <rect x="10.5" y="6" width="3" height="12" />
          <rect x="15.5" y="9" width="3" height="9" />
        </svg>
      </ToolButton>
      <TransitionMenu slide={props.slide} onChange={props.onTransition} onPreview={props.onPreviewTransition} />
      <AnimationMenu slide={props.slide} selected={props.count === 1 ? selected : null} onChange={props.onAnimation} onMove={props.onMoveAnimation} onPreview={props.onPreviewAnimation} />
      {selected?.kind === "chart" && (
        <button type="button" className="fb-button present-theme-btn" onClick={props.onEditChart} title="Tipo, título y datos de la gráfica">
          Datos de la gráfica
        </button>
      )}

      {textTarget && (
        <>
          <Separator />
          <select
            className="fb-select fb-font"
            aria-label="Fuente"
            value={font}
            onChange={(e) => props.formatRuns((r) => ({ ...r, font: e.target.value }), (ed) => ed.chain().focus().setFontFamily(e.target.value).run())}
          >
            {fonts.map((f) => (
              <option key={f} value={f} style={{ fontFamily: f }}>
                {f}
              </option>
            ))}
          </select>
          <select
            className="fb-select fb-size"
            aria-label="Tamaño de letra"
            value={size}
            onChange={(e) => {
              const n = Number(e.target.value);
              props.formatRuns((r) => ({ ...r, size: n }), (ed) => ed.chain().focus().setFontSize(`${n}pt`).run());
            }}
          >
            {sizes.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <ToolButton label={keys("Negrita (⌘B)")} pressed={state.bold} onClick={() => toggle("bold", (ed) => ed.chain().focus().toggleBold().run())}>
            <b>B</b>
          </ToolButton>
          <ToolButton label={keys("Cursiva (⌘I)")} pressed={state.italic} onClick={() => toggle("italic", (ed) => ed.chain().focus().toggleItalic().run())}>
            <i style={{ fontFamily: "Georgia, serif" }}>I</i>
          </ToolButton>
          <ToolButton label={keys("Subrayado (⌘U)")} pressed={state.underline} onClick={() => toggle("underline", (ed) => ed.chain().focus().toggleUnderline().run())}>
            <u>U</u>
          </ToolButton>
          <ToolButton label="Tachado" pressed={state.strike} onClick={() => toggle("strike", (ed) => ed.chain().focus().toggleStrike().run())}>
            <s>S</s>
          </ToolButton>
          <ColorButton
            label="Color de texto"
            current={state.color}
            emptyLabel="Automático"
            onPick={(color) =>
              props.formatRuns(
                (r) => ({ ...r, color: color || undefined }),
                (ed) => (color ? ed.chain().focus().setColor(color).run() : ed.chain().focus().unsetColor().run()),
              )
            }
            icon={<span className="fb-letter">A</span>}
          />
          <Separator />
          {(["left", "center", "right", "justify"] as const).map((a) => (
            <ToolButton
              key={a}
              label={a === "left" ? "Alinear a la izquierda" : a === "center" ? "Centrar" : a === "right" ? "Alinear a la derecha" : "Justificar"}
              pressed={state.align === a}
              onClick={() => props.formatParas((p) => ({ ...p, align: a === "left" ? undefined : a }), (ed) => ed.chain().focus().setTextAlign(a).run())}
            >
              <AlignIcon
                lines={
                  a === "left"
                    ? ["M4 6h16", "M4 10h10", "M4 14h16", "M4 18h10"]
                    : a === "center"
                      ? ["M4 6h16", "M7 10h10", "M4 14h16", "M7 18h10"]
                      : a === "right"
                        ? ["M4 6h16", "M10 10h10", "M4 14h16", "M10 18h10"]
                        : ["M4 6h16", "M4 10h16", "M4 14h16", "M4 18h16"]
                }
              />
            </ToolButton>
          ))}
          {(["bullet", "number"] as const).map((kind) => (
            <ToolButton
              key={kind}
              label={kind === "bullet" ? "Viñetas" : "Numeración"}
              pressed={state.bullet === kind}
              onClick={() =>
                props.formatParas(
                  (p) => ({ ...p, bullet: state.bullet === kind ? null : kind }),
                  (ed) => ed.chain().focus().updateAttributes("paragraph", { bullet: state.bullet === kind ? null : kind }).run(),
                )
              }
            >
              {kind === "bullet" ? (
                <AlignIcon lines={["M9 6h11", "M9 12h11", "M9 18h11", "M4.5 6h.01", "M4.5 12h.01", "M4.5 18h.01"]} />
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                  <path d="M10 6h10M10 12h10M10 18h10" />
                  <text x="2" y="8.5" fontSize="7" fill="currentColor" stroke="none">1</text>
                  <text x="2" y="14.5" fontSize="7" fill="currentColor" stroke="none">2</text>
                  <text x="2" y="20.5" fontSize="7" fill="currentColor" stroke="none">3</text>
                </svg>
              )}
            </ToolButton>
          ))}
        </>
      )}

      {props.count > 0 && !editing && (
        <>
          <Separator />
          {table && (
            <ColorButton
              label="Color de la celda"
              current={text ? (table.rows[props.cell?.r ?? 0]?.cells[props.cell?.c ?? 0]?.fill ?? null) : null}
              emptyLabel="Sin color"
              onPick={props.onCellFill}
              icon={
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
                  <rect x="4" y="4" width="16" height="16" rx="1.5" />
                  <path d="M4 12h16M12 4v16" />
                </svg>
              }
            />
          )}
          {shape && !isLine(shape.geom) && (
            <ColorButton
              label="Relleno"
              current={shape.fill}
              emptyLabel="Sin relleno"
              onPick={props.onFill}
              icon={
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
                  <path d="M5 11l7-7 7 7-7 7z" />
                  <path d="M19 15c0 2 1.5 3 1.5 4.5a1.5 1.5 0 01-3 0C17.5 18 19 17 19 15z" fill="currentColor" />
                </svg>
              }
            />
          )}
          {shape && (
            <>
              <ColorButton
                label="Contorno"
                current={shape.line?.color ?? null}
                emptyLabel="Sin contorno"
                onPick={(color) => props.onLine(color ? { color, width: shape.line?.width ?? 2 } : null)}
                icon={
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
                    <rect x="4" y="4" width="16" height="16" rx="2" />
                  </svg>
                }
              />
              <select
                className="fb-select present-line-width"
                aria-label="Grosor del contorno"
                value={shape.line ? String(Math.round(shape.line.width * 4) / 4) : "0"}
                onChange={(e) => {
                  const width = Number(e.target.value);
                  props.onLine(width ? { color: shape.line?.color ?? deck.theme.text, width, dash: shape.line?.dash } : null);
                }}
              >
                <option value="0">Sin contorno</option>
                {[1, 2, 3, 4, 6, 8, 12].map((w) => (
                  <option key={w} value={w}>
                    {w} px
                  </option>
                ))}
                {shape.line && ![1, 2, 3, 4, 6, 8, 12].includes(Math.round(shape.line.width * 4) / 4) && (
                  <option value={String(Math.round(shape.line.width * 4) / 4)}>{Math.round(shape.line.width * 4) / 4} px</option>
                )}
              </select>
            </>
          )}
          <Separator />
          <Popover
            button={(toggleOpen, open) => (
              <button type="button" className={`fb-button present-theme-btn${open ? " pressed" : ""}`} onClick={toggleOpen} title="Alinear, repartir y ordenar">
                Organizar ▾
              </button>
            )}
          >
            {(close) => (
              <div className="present-arrange">
                <p className="present-menu-title">{props.count > 1 ? "Alinear entre sí" : "Alinear en la diapositiva"}</p>
                <div className="present-menu-grid">
                  {(
                    [
                      ["left", "Izquierda", ["M4 3v18", "M8 7h10v4H8z", "M8 14h6v4H8z"]],
                      ["hcenter", "Centro", ["M12 3v18", "M6 7h12v4H6z", "M8 14h8v4H8z"]],
                      ["right", "Derecha", ["M20 3v18", "M6 7h10v4H6z", "M10 14h6v4h-6z"]],
                      ["top", "Arriba", ["M3 4h18", "M7 8v10h4V8z", "M14 8v6h4V8z"]],
                      ["vcenter", "Medio", ["M3 12h18", "M7 6v12h4V6z", "M14 8v8h4V8z"]],
                      ["bottom", "Abajo", ["M3 20h18", "M7 6v10h4V6z", "M14 10v6h4v-6z"]],
                    ] as const
                  ).map(([kind, label, d]) => (
                    <button key={kind} type="button" onClick={() => (props.onAlign(kind), close())}>
                      <AlignIcon lines={[...d]} />
                      {label}
                    </button>
                  ))}
                </div>
                <p className="present-menu-title">Repartir (3 o más)</p>
                <div className="present-menu-grid two">
                  <button type="button" disabled={props.count < 3} onClick={() => (props.onDistribute("x"), close())}>
                    Horizontalmente
                  </button>
                  <button type="button" disabled={props.count < 3} onClick={() => (props.onDistribute("y"), close())}>
                    Verticalmente
                  </button>
                </div>
                <p className="present-menu-title">Ordenar</p>
                <div className="present-menu-grid two">
                  <button type="button" onClick={() => (props.onReorder("front"), close())}>
                    Traer al frente
                  </button>
                  <button type="button" onClick={() => (props.onReorder("forward"), close())}>
                    Traer adelante
                  </button>
                  <button type="button" onClick={() => (props.onReorder("back"), close())}>
                    Enviar al fondo
                  </button>
                  <button type="button" onClick={() => (props.onReorder("backward"), close())}>
                    Enviar atrás
                  </button>
                </div>
              </div>
            )}
          </Popover>
          <ToolButton label="Traer al frente" onClick={() => props.onReorder("front")}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
              <rect x="3" y="3" width="11" height="11" rx="1" strokeDasharray="2 2" />
              <rect x="10" y="10" width="11" height="11" rx="1" fill="currentColor" fillOpacity="0.25" />
            </svg>
          </ToolButton>
          <ToolButton label="Enviar al fondo" onClick={() => props.onReorder("back")}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
              <rect x="3" y="3" width="11" height="11" rx="1" fill="currentColor" fillOpacity="0.25" />
              <rect x="10" y="10" width="11" height="11" rx="1" strokeDasharray="2 2" />
            </svg>
          </ToolButton>
          <ToolButton label={keys("Duplicar (⌘D)")} onClick={props.onDuplicate}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
              <rect x="8" y="8" width="12" height="12" rx="1.5" />
              <path d="M16 8V5a1 1 0 00-1-1H5a1 1 0 00-1 1v10a1 1 0 001 1h3" />
            </svg>
          </ToolButton>
          <ToolButton label="Eliminar (⌫)" onClick={props.onDelete}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
              <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
            </svg>
          </ToolButton>
        </>
      )}
      {table && props.count === 1 && (
        <div className="present-table-tools" role="group" aria-label="Tabla">
          <span className="write-table-label">Tabla:</span>
          {(
            [
              ["rowAbove", "+ Fila arriba"],
              ["rowBelow", "+ Fila abajo"],
              ["colLeft", "+ Columna izq."],
              ["colRight", "+ Columna der."],
              ["deleteRow", "− Fila"],
              ["deleteCol", "− Columna"],
              ["toggleHeader", table.header ? "Sin encabezado" : "Con encabezado"],
            ] as const
          ).map(([op, label]) => (
            <button key={op} type="button" className="btn write-table-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => props.onTableOp(op)}>
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Cuadrícula para elegir cuántas filas y columnas tiene la tabla nueva. */
/** Transición de la diapositiva: efecto, dirección, duración y si pasa sola. */
function TransitionMenu({ slide, onChange, onPreview }: { slide: Slide; onChange: (t: Transition | null, all?: boolean) => void; onPreview: () => void }) {
  const t = slide.transition ?? null;
  const kind = t?.kind ?? "none";
  const info = TRANSITIONS.find((x) => x.id === kind);
  const base = (patch: Partial<Transition>): Transition => ({ kind, duration: t?.duration ?? 700, direction: t?.direction, advanceAfter: t?.advanceAfter ?? null, ...patch });
  const clean = (next: Transition): Transition | null => (next.kind === "none" && !next.advanceAfter ? null : next);
  return (
    <Popover
      button={(toggleOpen, open) => (
        <button type="button" className={`fb-button present-theme-btn${open ? " pressed" : ""}`} onClick={toggleOpen} title="Cómo entra esta diapositiva al presentar">
          Transición{t && t.kind !== "none" ? `: ${transitionName(t)}` : ""} ▾
        </button>
      )}
    >
      {() => (
        <div className="present-transitions">
          <p className="present-menu-title">Efecto al entrar a esta diapositiva</p>
          <div className="present-transition-grid" role="radiogroup" aria-label="Transición">
            {TRANSITIONS.map((x) => (
              <button
                key={x.id}
                type="button"
                role="radio"
                aria-checked={kind === x.id}
                className={kind === x.id ? "current" : ""}
                onClick={() => onChange(clean(base({ kind: x.id, direction: x.directions ? (t?.direction ?? "left") : undefined })))}
              >
                <TransitionIcon kind={x.id} />
                <span>{x.name}</span>
              </button>
            ))}
          </div>
          {kind !== "none" && (
            <div className="present-menu-row">
              {info?.directions && (
                <label className="field">
                  Dirección
                  <select className="input" value={t?.direction ?? "left"} onChange={(e) => onChange(base({ direction: e.target.value as Transition["direction"] }))}>
                    {DIRECTIONS.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="field">
                Duración
                <select className="input" value={t?.duration ?? 700} onChange={(e) => onChange(base({ duration: Number(e.target.value) }))}>
                  {[...new Set([...DURATIONS, t?.duration ?? 700])].sort((a, b) => a - b).map((ms) => (
                    <option key={ms} value={ms}>
                      {(ms / 1000).toLocaleString("es-MX")} s
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
          <label className="radio present-advance">
            <input
              type="checkbox"
              checked={Boolean(t?.advanceAfter)}
              onChange={(e) => onChange(clean(base({ advanceAfter: e.target.checked ? 5000 : null })))}
            />
            Pasar sola a la siguiente después de
            <input
              type="number"
              className="input"
              min={1}
              max={600}
              step={1}
              aria-label="Segundos antes de pasar sola"
              disabled={!t?.advanceAfter}
              value={t?.advanceAfter ? Math.round(t.advanceAfter / 1000) : 5}
              onChange={(e) => onChange(base({ advanceAfter: Math.max(1, Number(e.target.value) || 1) * 1000 }))}
            />
            s
          </label>
          <div className="present-menu-row">
            <button type="button" className="btn" disabled={kind === "none"} onClick={onPreview}>
              Vista previa
            </button>
            <button type="button" className="btn" onClick={() => onChange(t, true)}>
              Aplicar a todas
            </button>
          </div>
        </div>
      )}
    </Popover>
  );
}

/** Animación de entrada del elemento elegido y el orden de todas las de la diapositiva. */
function AnimationMenu({
  slide,
  selected,
  onChange,
  onMove,
  onPreview,
}: {
  slide: Slide;
  selected: SlideElement | null;
  onChange: (target: string, anim: Animation | null) => void;
  onMove: (id: string, delta: number) => void;
  onPreview: (id?: string) => void;
}) {
  const list = slide.animations ?? [];
  const anim = selected ? (list.find((a) => a.target === selected.id) ?? null) : null;
  const info = EFFECTS.find((e) => e.id === (anim?.effect ?? null));
  const paragraphs = textParagraphs(selected ?? undefined).length;
  const set = (patch: Partial<Animation>) => selected && anim && onChange(selected.id, { ...anim, ...patch });
  const label = (a: Animation) => {
    const el = slide.elements.find((e) => e.id === a.target);
    const text = el?.kind === "shape" ? el.text?.paras.map((p) => p.runs.map((r) => r.text).join("")).join(" ").trim() : "";
    const kind = el?.kind === "image" ? "Imagen" : el?.kind === "table" ? "Tabla" : el?.kind === "chart" ? "Gráfica" : "Forma";
    return text ? (text.length > 26 ? `${text.slice(0, 25)}…` : text) : (el?.name ?? kind);
  };
  return (
    <Popover
      button={(toggleOpen, open) => (
        <button type="button" className={`fb-button present-theme-btn${open ? " pressed" : ""}`} onClick={toggleOpen} title="Cómo entra el elemento elegido al presentar">
          Animación{anim ? `: ${effectName(anim.effect)}` : ""} ▾
        </button>
      )}
    >
      {() => (
        <div className="present-transitions present-animations">
          {selected ? (
            <>
              <p className="present-menu-title">Entrada del elemento elegido</p>
              <div className="present-transition-grid" role="radiogroup" aria-label="Animación">
                {EFFECTS.map((e) => (
                  <button
                    key={e.id ?? "none"}
                    type="button"
                    role="radio"
                    aria-checked={(anim?.effect ?? null) === e.id}
                    className={(anim?.effect ?? null) === e.id ? "current" : ""}
                    onClick={() => {
                      if (!e.id) return onChange(selected.id, null);
                      const base = anim ? { ...anim, effect: e.id as AnimEffect } : newAnimation(selected.id, e.id as AnimEffect);
                      onChange(selected.id, {
                        ...base,
                        direction: e.directions ? (base.direction ?? "up") : undefined,
                        duration: e.id === "appear" ? 0 : base.duration || 500,
                      });
                    }}
                  >
                    <AnimationIcon effect={e.id} />
                    <span>{e.name}</span>
                  </button>
                ))}
              </div>
              {anim && (
                <>
                  <div className="present-menu-row">
                    <label className="field">
                      Empieza
                      <select className="input" value={anim.trigger} onChange={(e) => set({ trigger: e.target.value as Animation["trigger"] })}>
                        {TRIGGERS.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    {info?.directions && (
                      <label className="field">
                        Dirección
                        <select className="input" value={anim.direction ?? "up"} onChange={(e) => set({ direction: e.target.value as Animation["direction"] })}>
                          {ANIM_DIRECTIONS.map((d) => (
                            <option key={d.id} value={d.id}>
                              {d.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                  </div>
                  <div className="present-menu-row">
                    {anim.effect !== "appear" && (
                      <label className="field">
                        Duración
                        <select className="input" value={anim.duration} onChange={(e) => set({ duration: Number(e.target.value) })}>
                          {[...new Set([250, 500, 750, 1000, 1500, 2000, anim.duration])].sort((a, b) => a - b).map((ms) => (
                            <option key={ms} value={ms}>
                              {(ms / 1000).toLocaleString("es-MX")} s
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    <label className="field">
                      Retraso (s)
                      <input
                        type="number"
                        className="input"
                        min={0}
                        max={60}
                        step={0.25}
                        value={anim.delay / 1000}
                        aria-label="Retraso en segundos"
                        onChange={(e) => set({ delay: Math.max(0, Number(e.target.value) || 0) * 1000 })}
                      />
                    </label>
                  </div>
                  {paragraphs > 1 && (
                    <label className="radio">
                      <input type="checkbox" checked={Boolean(anim.byParagraph)} onChange={(e) => set({ byParagraph: e.target.checked || undefined })} /> Por párrafo (un clic para cada uno)
                    </label>
                  )}
                </>
              )}
            </>
          ) : (
            <p className="hint">Elige un elemento de la diapositiva para darle una animación de entrada.</p>
          )}
          {list.length > 0 && (
            <>
              <p className="present-menu-title">Orden en esta diapositiva</p>
              <ol className="present-anim-list">
                {list.map((a, i) => (
                  <li key={a.id} className={a.target === selected?.id ? "current" : ""}>
                    <span className="present-anim-when">{TRIGGERS.find((t) => t.id === a.trigger)?.name}</span>
                    <span className="present-anim-name">
                      {effectName(a.effect)} · {label(a)}
                    </span>
                    <button type="button" aria-label="Subir" title="Antes" disabled={i === 0} onClick={() => onMove(a.id, -1)}>
                      ↑
                    </button>
                    <button type="button" aria-label="Bajar" title="Después" disabled={i === list.length - 1} onClick={() => onMove(a.id, 1)}>
                      ↓
                    </button>
                    <button type="button" aria-label="Quitar la animación" title="Quitar" onClick={() => onChange(a.target, null)}>
                      ×
                    </button>
                  </li>
                ))}
              </ol>
            </>
          )}
          <div className="present-menu-row">
            <button type="button" className="btn" disabled={!anim} onClick={() => anim && onPreview(anim.id)}>
              Vista previa
            </button>
            <button type="button" className="btn" disabled={!list.length} onClick={() => onPreview()}>
              Ver todas
            </button>
          </div>
        </div>
      )}
    </Popover>
  );
}

function AnimationIcon({ effect }: { effect: AnimEffect | null }) {
  const star = <path d="M18 6l2.2 4.6 5 .7-3.6 3.5.9 5-4.5-2.4-4.5 2.4.9-5-3.6-3.5 5-.7z" fill="currentColor" />;
  const extra: Record<string, ReactNode> = {
    none: <path d="M10 9l16 10M26 9L10 19" stroke="currentColor" strokeWidth="1.4" opacity="0.5" />,
    appear: star,
    fade: <g opacity="0.45">{star}</g>,
    fly: (
      <g>
        {star}
        <path d="M18 25v-3M14 25v-2M22 25v-2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </g>
    ),
    zoom: <g transform="translate(18 14) scale(0.6) translate(-18 -14)">{star}</g>,
    wipe: (
      <g>
        <clipPath id="wipe-icon">
          <rect x="3" y="14" width="30" height="12" />
        </clipPath>
        <g clipPath="url(#wipe-icon)">{star}</g>
      </g>
    ),
  };
  return (
    <svg width="36" height="28" viewBox="0 0 36 28" aria-hidden>
      {extra[effect ?? "none"]}
    </svg>
  );
}

/** Numeritos junto a cada elemento animado (en qué clic entra), como en PowerPoint. */
function AnimationBadges({ slide, scale }: { slide: Slide; scale: number }) {
  const steps = animationSteps(slide);
  if (!steps.length) return null;
  const auto = steps[0]?.auto;
  const byTarget = new Map<string, number[]>();
  steps.forEach((st, i) => {
    const n = auto ? i : i + 1;
    for (const item of st.items) {
      const list = byTarget.get(item.anim.target) ?? [];
      if (!list.includes(n)) list.push(n);
      byTarget.set(item.anim.target, list);
    }
  });
  return (
    <>
      {[...byTarget.entries()].map(([id, numbers]) => {
        const el = slide.elements.find((e) => e.id === id);
        if (!el) return null;
        const text = numbers.length > 3 ? `${numbers[0]}–${numbers[numbers.length - 1]}` : numbers.join(", ");
        return (
          <span key={id} className="present-anim-badge" style={{ left: el.x, top: el.y, transform: `scale(${1 / scale})`, transformOrigin: "top left" }} aria-hidden>
            {text}
          </span>
        );
      })}
    </>
  );
}

/** Dibujito de cada transición en el menú. */
function TransitionIcon({ kind }: { kind: Transition["kind"] }) {
  const frame = <rect x="3" y="5" width="30" height="18" rx="2" fill="none" stroke="currentColor" strokeWidth="1.4" />;
  const inner: Record<Transition["kind"], ReactNode> = {
    none: <path d="M10 9l16 10M26 9L10 19" stroke="currentColor" strokeWidth="1.4" opacity="0.5" />,
    fade: <rect x="3" y="5" width="30" height="18" rx="2" fill="currentColor" opacity="0.25" />,
    push: <path d="M24 14H8m4-4l-4 4 4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />,
    wipe: <rect x="18" y="5" width="15" height="18" fill="currentColor" opacity="0.35" />,
    cover: <rect x="12" y="8" width="21" height="15" fill="currentColor" opacity="0.35" />,
    zoom: <rect x="12" y="10" width="12" height="8" fill="currentColor" opacity="0.35" />,
    split: <rect x="13" y="5" width="10" height="18" fill="currentColor" opacity="0.35" />,
  };
  return (
    <svg width="36" height="28" viewBox="0 0 36 28" aria-hidden>
      {inner[kind]}
      {frame}
    </svg>
  );
}

function TablePicker({ onPick }: { onPick: (rows: number, cols: number) => void }) {
  const [hover, setHover] = useState({ r: 2, c: 3 });
  return (
    <div className="present-table-picker">
      <div className="present-table-grid" onMouseLeave={() => setHover({ r: 2, c: 3 })}>
        {Array.from({ length: 8 }, (_, r) =>
          Array.from({ length: 8 }, (_, c) => (
            <button
              key={`${r}-${c}`}
              type="button"
              className={r <= hover.r && c <= hover.c ? "on" : ""}
              aria-label={`${r + 1} × ${c + 1}`}
              onMouseEnter={() => setHover({ r, c })}
              onClick={() => onPick(r + 1, c + 1)}
            />
          )),
        )}
      </div>
      <span>
        {hover.r + 1} filas × {hover.c + 1} columnas
      </span>
    </div>
  );
}

/** Dibujito del diseño de una diapositiva (en el menú de nueva diapositiva). */
function LayoutPreview({ id }: { id: LayoutId }) {
  const boxes = useMemo(() => {
    const W = 64;
    const H = 36;
    const m = W * 0.0625;
    const r = (x: number, y: number, w: number, h: number, kind: "t" | "b") => ({ x, y, w, h, kind });
    switch (id) {
      case "title":
        return [r(m * 1.5, H * 0.25, W - m * 3, H * 0.28, "t"), r(m * 3, H * 0.6, W - m * 6, H * 0.12, "b")];
      case "titleContent":
        return [r(m, H * 0.07, W - m * 2, H * 0.16, "t"), r(m, H * 0.3, W - m * 2, H * 0.6, "b")];
      case "twoContent":
        return [r(m, H * 0.07, W - m * 2, H * 0.16, "t"), r(m, H * 0.3, W / 2 - m - 2, H * 0.6, "b"), r(W / 2 + 2, H * 0.3, W / 2 - m - 2, H * 0.6, "b")];
      case "section":
        return [r(m, H * 0.4, W - m * 2, H * 0.22, "t"), r(m, H * 0.68, W - m * 2, H * 0.1, "b")];
      case "titleOnly":
        return [r(m, H * 0.07, W - m * 2, H * 0.16, "t")];
      default:
        return [];
    }
  }, [id]);
  return (
    <svg width="64" height="36" viewBox="0 0 64 36" className="present-layout-preview" aria-hidden>
      <rect x="0.5" y="0.5" width="63" height="35" rx="2" fill="#fff" stroke="currentColor" strokeOpacity="0.3" />
      {boxes.map((b, i) => (
        <rect key={i} x={b.x} y={b.y} width={b.w} height={b.h} rx="1" fill={b.kind === "t" ? "currentColor" : "none"} fillOpacity={0.35} stroke="currentColor" strokeOpacity={0.4} strokeDasharray={b.kind === "b" ? "2 1" : undefined} />
      ))}
    </svg>
  );
}


/** Opciones antes de imprimir: solo diapositivas, o con sus notas. */
