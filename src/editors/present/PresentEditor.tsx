import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
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
import type { Deck, LayoutId, Para, Run, ShapeElement, Slide, SlideElement, TextBody } from "./model";
import { LAYOUTS, THEMES, cloneElement, cloneSlide, newSlide, placeholderHint, slideTitle, uid } from "./model";
import { SHAPES, isLine, shapePath } from "./geometry";
import SlideView, { textDefaults } from "./SlideView";
import { SlideParagraph, allRuns, fromEditor, mapParas, mapRuns, toEditor } from "./slideText";
import { savePresentation } from "../../lib/present";
import { imageDataUrl } from "../../lib/write";
import { extensionOf, fileNameOf } from "../../lib/documents";
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

const SIZES = [8, 10, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 44, 48, 54, 60, 66, 72, 80, 96];
const HISTORY_LIMIT = 100;
const SNAP = 6;

type Drag =
  | { kind: "move"; id: string; startX: number; startY: number; orig: SlideElement; snapshot: Deck; moved: boolean }
  | { kind: "resize"; id: string; handle: string; startX: number; startY: number; orig: SlideElement; snapshot: Deck; moved: boolean };

const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/** WEPO Present: diapositivas con texto, formas, imágenes y tablas, que se abren y guardan como .pptx. */
export default function PresentEditor(props: Props) {
  const { initial, onHome, onOpen, onDirtyChange, onSaved } = props;
  const [deck, setDeckState] = useState<Deck>(initial);
  const deckRef = useRef(deck);
  deckRef.current = deck;
  const history = useRef<{ past: Deck[]; future: Deck[] }>({ past: [], future: [] });
  const [current, setCurrent] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [textEditor, setTextEditor] = useState<Editor | null>(null);
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
  const drag = useRef<Drag | null>(null);
  const clipboard = useRef<SlideElement | null>(null);
  const stage = useRef<HTMLDivElement>(null);

  const slide = deck.slides[Math.min(current, deck.slides.length - 1)];
  const scale = zoom ?? fit;
  const selectedEl = slide.elements.find((e) => e.id === selected) ?? null;

  // ───────────── cambios e historial ─────────────

  function markDirty() {
    setDirty(true);
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
    if (!selected) return;
    commit(withSlide(deckRef.current, current, (s) => ({ ...s, elements: s.elements.filter((e) => e.id !== selected) })));
    setSelected(null);
    setEditing(null);
  }

  function duplicateSelected() {
    if (!selectedEl) return;
    const copy = cloneElement(selectedEl, 20, 20);
    if (copy.kind === "shape") delete copy.placeholder;
    addElement(copy);
  }

  function reorder(direction: "front" | "back" | "forward" | "backward") {
    if (!selected) return;
    commit(
      withSlide(deckRef.current, current, (s) => {
        const list = [...s.elements];
        const i = list.findIndex((e) => e.id === selected);
        const [el] = list.splice(i, 1);
        const to = direction === "front" ? list.length : direction === "back" ? 0 : direction === "forward" ? Math.min(list.length, i + 1) : Math.max(0, i - 1);
        list.splice(to, 0, el);
        return { ...s, elements: list };
      }),
    );
  }

  function nudge(dx: number, dy: number) {
    if (!selected) return;
    updateElement(selected, (e) => ({ ...e, x: e.x + dx, y: e.y + dy }));
  }

  // ───────────── arrastrar y cambiar tamaño ─────────────

  function onSlidePointerDown(e: ReactPointerEvent) {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    const handle = target.closest("[data-handle]") as HTMLElement | null;
    const elNode = target.closest("[data-el]") as HTMLElement | null;
    const id = handle ? selected : (elNode?.dataset.el ?? null);
    // Dentro del cuadro que se está escribiendo, el clic es para el texto.
    if (editing && id === editing && !handle) return;
    if (editing) setEditing(null);
    if (!id) {
      setSelected(null);
      return;
    }
    const el = slide.elements.find((x) => x.id === id);
    if (!el) return;
    e.preventDefault();
    setSelected(id);
    const start = { startX: e.clientX, startY: e.clientY, orig: structuredClone(el), snapshot: deckRef.current, moved: false };
    drag.current = handle ? { kind: "resize", id, handle: handle.dataset.handle!, ...start } : { kind: "move", id, ...start };
  }

  useEffect(() => {
    function onMove(e: PointerEvent) {
      const g = drag.current;
      if (!g) return;
      const dx = (e.clientX - g.startX) / scale;
      const dy = (e.clientY - g.startY) / scale;
      if (!g.moved && Math.abs(dx) * scale < 3 && Math.abs(dy) * scale < 3) return;
      g.moved = true;
      const o = g.orig;
      let next: SlideElement;
      const lines = { x: [] as number[], y: [] as number[] };
      if (g.kind === "move") {
        let x = o.x + dx;
        let y = o.y + dy;
        if (!e.altKey) {
          // Se pega a los bordes y al centro de la diapositiva y de los demás elementos.
          const d = deckRef.current;
          const others = slide.elements.filter((x) => x.id !== g.id);
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
          x = snap(x, o.w, xs, lines.x);
          y = snap(y, o.h, ys, lines.y);
        }
        next = { ...o, x, y };
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
          if (w < 8) (x = w < 0 ? x + w - 8 + (8 - w) : x), (w = 8);
          if (h < 8) h = 8;
        }
        next = { ...o, x, y, w, h };
      }
      setGuides(lines);
      replace(withElement(deckRef.current, g.id, () => next));
    }
    function onUp() {
      const g = drag.current;
      drag.current = null;
      setGuides({ x: [], y: [] });
      if (g?.moved) commit(deckRef.current, g.snapshot);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [scale, slide, commit]); // eslint-disable-line react-hooks/exhaustive-deps

  function onSlideDoubleClick(e: React.MouseEvent) {
    const elNode = (e.target as HTMLElement).closest("[data-el]") as HTMLElement | null;
    const el = slide.elements.find((x) => x.id === elNode?.dataset.el);
    if (!el || el.kind !== "shape" || isLine(el.geom)) return;
    if (!el.text) updateElement(el.id, (x) => ({ ...x, text: { paras: [{ runs: [], align: "center" }], anchor: "middle", defaultSize: 18 } }) as ShapeElement);
    setSelected(el.id);
    setEditing(el.id);
  }

  // ───────────── texto ─────────────

  const editingEl = (editing ? slide.elements.find((e) => e.id === editing) : null) as ShapeElement | null;
  const editSnapshot = useRef<Deck | null>(null);

  // Toda una sesión de escritura en un cuadro se deshace de una sola vez.
  useEffect(() => {
    if (editing) editSnapshot.current = deckRef.current;
    else if (editSnapshot.current) {
      const before = editSnapshot.current;
      editSnapshot.current = null;
      if (before !== deckRef.current) commit(deckRef.current, before);
    }
  }, [editing]); // eslint-disable-line react-hooks/exhaustive-deps

  function onTextChange(id: string, text: TextBody) {
    replace(withElement(deckRef.current, id, (e) => ({ ...e, text }) as SlideElement));
    markDirty();
  }

  /** Formato de letra: en el texto seleccionado (si se escribe) o en todo el cuadro. */
  function formatRuns(fn: (r: Run) => Run, tiptap: (ed: Editor) => void) {
    if (editing && textEditor) return tiptap(textEditor);
    if (selectedEl?.kind === "shape" && selectedEl.text) updateElement(selectedEl.id, (e) => ({ ...e, text: mapRuns((e as ShapeElement).text!, fn) }) as SlideElement);
  }

  function formatParas(fn: (p: Para) => Para, tiptap: (ed: Editor) => void) {
    if (editing && textEditor) return tiptap(textEditor);
    if (selectedEl?.kind === "shape" && selectedEl.text) updateElement(selectedEl.id, (e) => ({ ...e, text: mapParas((e as ShapeElement).text!, fn) }) as SlideElement);
  }

  // ───────────── guardar ─────────────

  function canOverwrite(target: string | null): target is string {
    return Boolean(target && target !== protectedPath && extensionOf(target) === "pptx");
  }

  async function saveTo(target: string) {
    try {
      setEditing(null);
      await savePresentation(target, deckRef.current, fileNameOf(target).replace(/\.[^.]+$/, ""));
      setPath(target);
      setFileName(fileNameOf(target));
      setDirty(false);
      onDirtyChange(false);
      onSaved(target);
      setStatus({ text: "Guardado" });
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

  useEffect(() => {
    if (!status || status.error) return;
    const timer = setTimeout(() => setStatus(null), 4000);
    return () => clearTimeout(timer);
  }, [status]);

  // ───────────── atajos ─────────────

  const actions = useRef({ saveDocument, undo, redo, deleteSelected, duplicateSelected, nudge, goTo, addSlide, current, selected, editing, selectedEl, scale });
  actions.current = { saveDocument, undo, redo, deleteSelected, duplicateSelected, nudge, goTo, addSlide, current, selected, editing, selectedEl, scale };
  useEffect(() => {
    const stop = onCommand((command) => {
      const a = actions.current;
      if (command === "save") a.saveDocument(false);
      else if (command === "save-as") a.saveDocument(true);
      else if (command === "zoom-in") setZoom(clampZoom(stepZoom(a.scale, 1)));
      else if (command === "zoom-out") setZoom(clampZoom(stepZoom(a.scale, -1)));
      else if (command === "zoom-reset") setZoom(null);
    });
    function onKey(e: KeyboardEvent) {
      const a = actions.current;
      const target = e.target as HTMLElement;
      const typing = Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
      const key = e.key.toLowerCase();
      if (hasModifier(e)) {
        const command = key === "s" ? (e.shiftKey ? "save-as" : "save") : key === "=" || key === "+" ? "zoom-in" : key === "-" ? "zoom-out" : key === "0" ? "zoom-reset" : null;
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
        else if (key === "c" && a.selectedEl) clipboard.current = structuredClone(a.selectedEl);
        else if (key === "x" && a.selectedEl) (clipboard.current = structuredClone(a.selectedEl)), a.deleteSelected();
        else if (key === "v" && clipboard.current) {
          e.preventDefault();
          const copy = cloneElement(clipboard.current, 20, 20);
          if (copy.kind === "shape") delete copy.placeholder;
          clipboard.current = copy;
          actions.current && addElementRef.current(copy);
        }
        return;
      }
      if (typing) {
        if (e.key === "Escape" && a.editing) (e.preventDefault(), setEditing(null));
        return;
      }
      if (e.key === "Escape") setSelected(null);
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
  const addElementRef = useRef(addElement);
  addElementRef.current = addElement;

  // ───────────── menú de las miniaturas ─────────────

  function slideMenu(e: React.MouseEvent, index: number) {
    e.preventDefault();
    setCurrent(index);
    const s = deck.slides[index];
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
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
            <button className="btn" onClick={() => saveDocument()} title={keys("Guardar (⌘S)")}>
              Guardar
            </button>
          </div>
        }
      />
      <PresentBar
        deck={deck}
        slide={slide}
        selected={selectedEl}
        editing={editing ? textEditor : null}
        onAddSlide={addSlide}
        onTheme={(theme) => commit({ ...deckRef.current, theme })}
        onBackground={(color) => commit(withSlide(deckRef.current, current, (s) => ({ ...s, background: color || null, backgroundImage: color ? null : s.backgroundImage })))}
        onTextBox={addTextBox}
        onShape={addShape}
        onImage={addImage}
        formatRuns={formatRuns}
        formatParas={formatParas}
        onFill={(color) => selected && updateElement(selected, (e) => ({ ...e, fill: color || null }) as SlideElement)}
        onLine={(line) => selected && updateElement(selected, (e) => ({ ...e, line }) as SlideElement)}
        onReorder={reorder}
        onDuplicate={duplicateSelected}
        onDelete={deleteSelected}
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
              <SlideView slide={s} deck={deck} scale={thumbWidth / deck.width} />
            </div>
          ))}
          <button type="button" className="present-add-slide" onClick={() => addSlide()}>
            + Nueva diapositiva
          </button>
        </nav>

        <div className="present-center">
          <div className="present-stage" ref={stage} onPointerDown={(e) => e.target === e.currentTarget && (setSelected(null), setEditing(null))}>
            <div className="present-main-slide" onPointerDown={onSlidePointerDown} onDoubleClick={onSlideDoubleClick}>
              <SlideView
                slide={slide}
                deck={deck}
                scale={scale}
                hints
                interactive
                editingId={editing}
                editingSlot={editingEl?.text ? <BoxEditor key={editingEl.id} el={editingEl} deck={deck} onChange={(t) => onTextChange(editingEl.id, t)} onEditor={setTextEditor} /> : null}
              >
                {selectedEl && <SelectionBox el={selectedEl} scale={scale} editing={editing === selectedEl.id} />}
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
    </div>
  );
}

/** Marco de selección con sus agarraderas (de tamaño fijo en la pantalla). */
function SelectionBox({ el, scale, editing }: { el: SlideElement; scale: number; editing: boolean }) {
  const size = 9 / scale;
  const line = el.kind === "shape" && isLine(el.geom);
  const handles = line ? ["nw", "se"] : HANDLES;
  const pos = (h: string) => ({
    left: h.includes("w") ? -size / 2 : h.includes("e") ? el.w - size / 2 : el.w / 2 - size / 2,
    top: h.includes("n") ? -size / 2 : h.includes("s") ? el.h - size / 2 : el.h / 2 - size / 2,
  });
  return (
    <div
      className={`present-selection${editing ? " editing" : ""}`}
      style={{ left: el.x, top: el.y, width: Math.max(el.w, 1), height: Math.max(el.h, 1), borderWidth: 1.5 / scale, transform: el.rot ? `rotate(${el.rot}deg)` : undefined }}
    >
      {!editing &&
        handles.map((h) => (
          <span key={h} className={`present-handle h-${h}`} data-handle={h} style={{ ...pos(h), width: size, height: size, borderWidth: 1.5 / scale }} />
        ))}
    </div>
  );
}

/** Editor de texto de un cuadro (mientras se escribe en él). */
function BoxEditor({ el, onChange, onEditor }: { el: ShapeElement; deck: Deck; onChange: (t: TextBody) => void; onEditor: (e: Editor | null) => void }) {
  const base = useRef(el.text!);
  const hint = el.role ? placeholderHint(el.role) : "Escribe aquí";
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
    content: toEditor(el.text!),
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
  editing: Editor | null;
  onAddSlide: (layout?: LayoutId) => void;
  onTheme: (theme: Deck["theme"]) => void;
  onBackground: (color: string) => void;
  onTextBox: () => void;
  onShape: (geom: string) => void;
  onImage: () => void;
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
  const textTarget = editing || (shape && !isLine(shape.geom) && shape.text) ? true : false;
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
  const text = shape?.text;
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

      {selected && !editing && (
        <>
          <Separator />
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

