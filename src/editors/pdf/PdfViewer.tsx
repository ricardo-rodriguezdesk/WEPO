import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnnotationMode, TextLayer } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFPageProxy, RenderTask } from "pdfjs-dist/legacy/build/pdf.mjs";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save } from "@tauri-apps/plugin-dialog";
import EditorToolbar from "../../components/EditorToolbar";
import ContextMenu from "../../components/ContextMenu";
import type { MenuItem } from "../../components/ContextMenu";
import ZoomControl from "../sheets/ZoomControl";
import { clampZoom, stepZoom } from "../sheets/layout";
import { ColorButton, Popover, Separator, ToolButton } from "../sheets/FormatBar";
import { loadPdf, readPdf } from "../../lib/pdf";
import { fileNameOf } from "../../lib/documents";
import { onCommand, runCommand } from "../../lib/commands";
import { hasModifier, keys } from "../../lib/platform";
import { loadZoom, saveZoom } from "../../lib/zoom";
import type { Annotation, FormValues, Highlight, PageRef, Source, Watermark } from "./pdfEdit";
import { addOcrText, charOffsets, mergeLines, pagesOf, pid, savePdf, shownSize } from "./pdfEdit";
import type { OcrText } from "./pdfEdit";
import AnnotationLayer, { SignatureDialog, loadSignature } from "./Annotations";
import { convertPdf } from "../../lib/pdfConvert";
import PasswordDialog, { OpenPasswordDialog } from "./PasswordDialog";
import WatermarkDialog from "./WatermarkDialog";
import type { Converted } from "../../lib/pdfConvert";
import type { FileNote, FormField, Tool, ToolStyle } from "./Annotations";
import "../sheets/FormatBar.css";
import "./PdfViewer.css";

type Props = {
  data: Uint8Array;
  path: string | null;
  fileName: string;
  onHome: () => void;
  onOpen: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onSaved: (path: string) => void;
  /** Convertir a un documento editable (Write) o sus tablas a una hoja (Sheets). */
  onConvert?: (kind: "write" | "sheets", converted: Converted, name: string) => Promise<void>;
};

/** 100 % es el tamaño real: un punto del PDF mide 96/72 píxeles de pantalla. */
const CSS_PER_PT = 96 / 72;
const PAGE_GAP = 16;

/** Herramientas para anotar: con ellas se dibuja encima de las páginas. */
const TOOLS: { id: Tool; label: string; icon: string[] }[] = [
  { id: "select", label: "Seleccionar y mover", icon: ["M5 3l14 8-6 2-2 6z"] },
  { id: "highlight", label: "Resaltar (elige el texto o arrastra un recuadro)", icon: ["M9 11l-4 4v3h3l4-4", "M9 11l5-5 4 4-5 5", "M9 11l4 4"] },
  { id: "text", label: "Agregar texto (clic donde va)", icon: ["M5 6V4h14v2", "M12 4v16", "M9 20h6"] },
  { id: "draw", label: "Dibujar a mano", icon: ["M4 20c3-1 4-4 7-7s6-4 7-7", "M15 4l5 5"] },
  { id: "note", label: "Nota adhesiva (clic donde va)", icon: ["M4 5h16v11H9l-5 4z"] },
  { id: "sign", label: "Firmar (clic donde va la firma)", icon: ["M3 17c2-4 4-9 6-9s-1 9 1 9 3-5 5-5 1 4 3 4h3", "M3 21h18"] },
  { id: "redact", label: "Tachar información (arrastra un recuadro; al guardar se borra de verdad)", icon: ["M4 9h16v6H4z", "M4 12h16", "M7 9v6M11 9v6M15 9v6M19 9v6"] },
];

const HIGHLIGHTS = ["#FFE14D", "#7EE787", "#FF9ECF", "#7CC4FF", "#FFB366"];

/** Lo que se puede deshacer: las páginas, las anotaciones y los campos del formulario. */
type Snapshot = { pages: PageRef[]; annotations: Annotation[]; form: FormValues };

/** WEPO PDF: ver un PDF y editar sus páginas (ordenar, girar, quitar, combinar con otro PDF). */
/** Las páginas (de la lista) que no tienen texto: escaneos o imágenes. */
async function withoutText(source: Source, pages: PageRef[]): Promise<PageRef[]> {
  const out: PageRef[] = [];
  for (const p of pages) {
    const page = await source.doc.getPage(p.index + 1);
    const content = await page.getTextContent();
    const letters = content.items.reduce((n, it) => n + ("str" in it ? it.str.trim().length : 0), 0);
    if (letters < 3) out.push(p);
  }
  return out;
}

type OcrLine = { text: string; x: number; y: number; w: number; h: number };

/** Dibuja la página (con su giro del archivo), la manda al OCR del sistema y pasa los renglones a puntos del PDF. */
async function ocrPage(source: Source, index: number): Promise<OcrText[]> {
  const page = await source.doc.getPage(index + 1);
  const base = page.getViewport({ scale: 1 });
  // Unos 200 puntos por pulgada, sin pasar de lo que acepta el OCR de Windows.
  const scale = Math.min(200 / 72, 2400 / Math.max(base.width, base.height));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, viewport }).promise;
  const image = canvas.toDataURL("image/png").split(",")[1];
  const lines = await invoke<OcrLine[]>("ocr_image", { image, langs: ["es", "en"] });
  const W = canvas.width;
  const H = canvas.height;
  return lines.map((l) => {
    // La línea base queda un poco arriba del borde de abajo (por las letras que bajan, como la g o la p).
    const baseY = (l.y + l.h * 0.8) * H;
    const [x0, y0] = viewport.convertToPdfPoint(l.x * W, baseY);
    const [x1, y1] = viewport.convertToPdfPoint((l.x + l.w) * W, baseY);
    const [tx, ty] = viewport.convertToPdfPoint(l.x * W, l.y * H);
    const [bx, by] = viewport.convertToPdfPoint(l.x * W, (l.y + l.h) * H);
    return { text: l.text, x0, y0, x1, y1, height: Math.hypot(tx - bx, ty - by) };
  });
}

/** pdf.js: permiso de modificar el contenido (bit 4 de /P). */
const PERMISSION_MODIFY = 8;
const LOCKED_TEXT = "El autor de este PDF no permite modificarlo (permisos del archivo): WEPO lo muestra, pero no lo edita, convierte ni guarda.";

export default function PdfViewer({ data, path: initialPath, fileName: initialName, onHome, onOpen, onDirtyChange, onSaved, onConvert }: Props) {
  const [sources, setSources] = useState<Source[]>([]);
  const [pages, setPagesState] = useState<PageRef[]>([]);
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const annotationsRef = useRef(annotations);
  annotationsRef.current = annotations;
  const [form, setForm] = useState<FormValues>({});
  const formRef = useRef(form);
  formRef.current = form;
  const [fields, setFields] = useState<Record<string, FormField[]>>({});
  const [fileNotes, setFileNotes] = useState<Record<string, FileNote[]>>({});
  /** El PDF parece escaneado (sus primeras páginas no tienen texto): se ofrece reconocerlo. */
  const [scanned, setScanned] = useState(false);
  const [recognizing, setRecognizing] = useState(false);
  const [tool, setTool] = useState<Tool>("select");
  const [toolStyle, setToolStyle] = useState<ToolStyle>({ highlight: HIGHLIGHTS[0], ink: "#C42B45", inkWidth: 2, textColor: "#1D1D1F", textSize: 14 });
  const [selectedAnnot, setSelectedAnnot] = useState<string | null>(null);
  const [signature, setSignature] = useState(loadSignature);
  const [signDialog, setSignDialog] = useState(false);
  const history = useRef<{ past: Snapshot[]; future: Snapshot[] }>({ past: [], future: [] });
  const [error, setError] = useState<string | null>(null);
  const [needsPassword, setNeedsPassword] = useState<"ask" | "wrong" | null>(null);
  const [password, setPassword] = useState("");
  /** Con contraseña, el PDF solo se puede ver: pdf-lib no guarda PDF cifrados. */
  /** El autor del PDF no permite cambiarlo (permisos): se ve, pero no se edita. */
  const [locked, setLocked] = useState(false);
  /** Contraseña con la que se va a guardar (la que tenía al abrirlo, una nueva o ninguna). */
  const [protection, setProtection] = useState<string | null>(null);
  /** Marca de agua que se agrega al guardar (y ya se ve en las páginas). */
  const [watermark, setWatermark] = useState<Watermark | null>(null);
  const [watermarkDialog, setWatermarkDialog] = useState(false);
  /** Texto para «Tachar todas las veces que aparece». */
  const [redactTerm, setRedactTerm] = useState("");
  const [passwordDialog, setPasswordDialog] = useState(false);
  /** Otro PDF con contraseña que se quiere agregar (combinar). */
  const [insertAsk, setInsertAsk] = useState<{ bytes: Uint8Array; name: string; after: number; wrong: boolean } | null>(null);
  const [path, setPath] = useState(initialPath);
  const [fileName, setFileName] = useState(initialName);
  const [dirty, setDirty] = useState(false);
  const [zoom, setZoomState] = useState<number | null>(() => (initialPath ? loadZoom(`pdf:${initialPath}`, 0) || null : null));
  const [current, setCurrent] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sidebar, setSidebar] = useState(true);
  const [status, setStatus] = useState<{ text: string; error?: boolean } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  // ───────────── abrir ─────────────

  const open = useCallback(
    async (pass?: string) => {
      try {
        const doc = await loadPdf(data, pass);
        const source: Source = { id: "original", name: initialName, data, doc, password: pass };
        setNeedsPassword(null);
        // Permisos del autor: si no deja modificar el contenido, WEPO solo lo muestra.
        const permissions = await doc.getPermissions().catch(() => null);
        setLocked(Boolean(permissions && !permissions.has(PERMISSION_MODIFY)));
        setProtection(pass ?? null);
        setSources([source]);
        const list = await pagesOf(source);
        setPagesState(list);
        // Campos de formulario (solo los del PDF original).
        const found: Record<string, FormField[]> = {};
        for (const p of list) {
          const page = await doc.getPage(p.index + 1);
          const items = (await page.getAnnotations({ intent: "display" })) as Record<string, unknown>[];
          const widgets = items.filter((a) => a.subtype === "Widget" && a.fieldName && a.fieldType && !a.pushButton && !a.hidden).map(widgetField).filter(Boolean) as FormField[];
          if (widgets.length) found[p.id] = widgets;
        }
        setFields(found);
        setFileNotes(await notesOf(source, list));
        setScanned(await withoutText(source, list.slice(0, 3)).then((empty) => empty.length === Math.min(3, list.length) && list.length > 0));
      } catch (e) {
        const name = (e as { name?: string })?.name;
        if (name === "PasswordException") setNeedsPassword(pass ? "wrong" : "ask");
        else setError(`No se pudo abrir el PDF: ${(e as Error)?.message ?? e}`);
      }
    },
    [data, initialName],
  );

  useEffect(() => {
    open();
  }, [open]);

  // Los PDF abiertos se cierran al salir del editor (no al agregar otro).
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;
  useEffect(() => () => sourcesRef.current.forEach((s) => void s.doc.loadingTask.destroy()), []);

  // Sin zoom guardado, la página cabe a lo ancho (hasta 125 %).
  useEffect(() => {
    if (!pages.length || zoom !== null || !scroller.current) return;
    setZoomState(fitWidth(1.25));
  }, [pages.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const sizes = useMemo(() => pages.map(shownSize), [pages]);

  function fitWidth(max = 4) {
    const widest = Math.max(...sizes.map((s) => s.width), 1);
    const room = (scroller.current?.clientWidth ?? 800) - 48;
    return clampZoom(Math.min(max, room / (widest * CSS_PER_PT)));
  }

  const scale = (zoom ?? 1) * CSS_PER_PT;

  function setZoom(next: number) {
    const value = clampZoom(next);
    const page = current;
    setZoomState(value);
    if (path) saveZoom(`pdf:${path}`, value);
    requestAnimationFrame(() => goTo(page, "auto"));
  }

  // ───────────── páginas ─────────────

  const tops = useMemo(() => {
    const out: number[] = [];
    let y = PAGE_GAP;
    for (const s of sizes) {
      out.push(y);
      y += s.height * scale + PAGE_GAP;
    }
    return out;
  }, [sizes, scale]);

  function goTo(page: number, behavior: ScrollBehavior = "smooth") {
    const n = Math.min(Math.max(1, page), pagesRef.current.length);
    scroller.current?.scrollTo({ top: (tops[n - 1] ?? 0) - PAGE_GAP / 2, behavior });
    setCurrent(n);
    setPageInput(String(n));
  }

  function onScroll() {
    const el = scroller.current;
    if (!el || !tops.length) return;
    const middle = el.scrollTop + el.clientHeight / 3;
    let page = 1;
    for (let i = 0; i < tops.length; i++) if (tops[i] <= middle) page = i + 1;
    if (page !== current) {
      setCurrent(page);
      setPageInput(String(page));
    }
  }

  // ───────────── editar páginas (con deshacer) ─────────────

  const snapshot = (): Snapshot => ({ pages: pagesRef.current, annotations: annotationsRef.current, form: formRef.current });

  function restore(s: Snapshot) {
    setPagesState(s.pages);
    setAnnotations(s.annotations);
    setForm(s.form);
    setDirty(true);
    onDirtyChange(true);
  }

  /** Cambia el documento y lo anota para deshacer (`record` = false: cambio en curso, sin anotar). */
  function change(next: Partial<Snapshot>, record = true, before?: Snapshot) {
    if (locked) {
      setStatus({ text: LOCKED_TEXT });
      return;
    }
    if (record) {
      history.current.past.push(before ?? snapshot());
      history.current.future = [];
    }
    if (next.pages) setPagesState(next.pages);
    if (next.annotations) (annotationsRef.current = next.annotations), setAnnotations(next.annotations);
    if (next.form) (formRef.current = next.form), setForm(next.form);
    setDirty(true);
    onDirtyChange(true);
  }

  function commit(next: PageRef[]) {
    change({ pages: next });
  }

  function undo() {
    const prev = history.current.past.pop();
    if (!prev) return;
    history.current.future.push(snapshot());
    restore(prev);
  }

  function redo() {
    const next = history.current.future.pop();
    if (!next) return;
    history.current.past.push(snapshot());
    restore(next);
  }

  // ───────────── anotaciones ─────────────

  /** Estado antes de un arrastre (para deshacerlo completo). */
  const dragStart = useRef<Snapshot | null>(null);

  function addAnnotation(a: Annotation) {
    if (a.kind === "highlight") {
      // Resaltar otra vez lo mismo (o un pedazo que se encima) con el mismo color
      // junta los dos en uno: el color no se oscurece con cada clic.
      const touching = annotationsRef.current.filter(
        (x): x is Highlight => x.kind === "highlight" && x.page === a.page && x.color === a.color && overlaps(x.rects, a.rects),
      );
      if (touching.length) {
        const keep = touching[0];
        const merged: Highlight = { ...keep, rects: mergeLines([...touching.flatMap((x) => x.rects), ...a.rects]) };
        const drop = new Set(touching.map((x) => x.id));
        change({ annotations: annotationsRef.current.filter((x) => x.id === keep.id || !drop.has(x.id)).map((x) => (x.id === keep.id ? merged : x)) });
        setSelectedAnnot(keep.id);
        return;
      }
    }
    change({ annotations: [...annotationsRef.current, a] });
    setSelectedAnnot(a.id);
  }

  function updateAnnotation(a: Annotation, record = true) {
    if (!record && !dragStart.current) dragStart.current = snapshot();
    const next = annotationsRef.current.map((x) => (x.id === a.id ? a : x));
    if (record) {
      const before = dragStart.current ?? undefined;
      dragStart.current = null;
      change({ annotations: next }, true, before);
    } else change({ annotations: next }, false);
  }

  function deleteAnnotation(id: string) {
    change({ annotations: annotationsRef.current.filter((a) => a.id !== id) });
    setSelectedAnnot(null);
  }

  // ───────────── convertir ─────────────

  const [converting, setConverting] = useState(false);
  // ───────────── reconocer texto (OCR) ─────────────

  /**
   * Reconoce el texto de las páginas escaneadas (las que no tienen texto) con el
   * OCR del sistema y lo agrega invisible encima: así se busca, se selecciona,
   * se resalta y se convierte. El PDF cambia (se guarda con ese texto).
   */
  async function recognizeText() {
    if (locked) return setStatus({ text: LOCKED_TEXT });
    if (recognizing) return;
    const list = pagesRef.current;
    const todo: PageRef[] = [];
    for (const p of list) if ((await withoutText(docs.get(p.source)!, [p])).length) todo.push(p);
    if (!todo.length) {
      setStatus({ text: "Este PDF ya tiene texto en todas sus páginas: no hace falta reconocerlo." });
      return;
    }
    setRecognizing(true);
    try {
      const found = new Map<string, { index: number; lines: OcrText[] }[]>();
      let count = 0;
      for (const [k, p] of todo.entries()) {
        setStatus({ text: `Reconociendo texto… página ${k + 1} de ${todo.length}` });
        const lines = await ocrPage(docs.get(p.source)!, p.index);
        count += lines.length;
        found.set(p.source, [...(found.get(p.source) ?? []), { index: p.index, lines }]);
      }
      if (!count) {
        setStatus({ text: "No se encontró texto en las páginas escaneadas.", error: true });
        return;
      }
      // Cada PDF con texto nuevo se vuelve a abrir (las páginas, giros y anotaciones siguen igual).
      const next = await Promise.all(
        sources.map(async (src) => {
          const pages = found.get(src.id);
          if (!pages) return src;
          const data = await addOcrText(src, pages);
          return { ...src, data, doc: await loadPdf(data), password: undefined };
        }),
      );
      for (const src of sources) if (!next.includes(src)) void src.doc.loadingTask.destroy();
      setSources(next);
      setScanned(false);
      setDirty(true);
      onDirtyChange(true);
      setStatus({ text: `Listo: se reconoció el texto de ${todo.length} ${todo.length === 1 ? "página" : "páginas"}. Ya se puede buscar, seleccionar y convertir; guárdalo para conservarlo.` });
    } catch (e) {
      setStatus({ text: `No se pudo reconocer el texto: ${e}`, error: true });
    } finally {
      setRecognizing(false);
    }
  }

  async function convert(kind: "write" | "sheets") {
    if (!onConvert) return;
    if (locked) {
      setStatus({ text: LOCKED_TEXT });
      return;
    }
    setConverting(true);
    setStatus({ text: "Convirtiendo…" });
    try {
      const inputs = pagesRef.current.map((p) => ({ doc: docs.get(p.source)!.doc, index: p.index, rotation: p.rotation }));
      const converted = await convertPdf(inputs, (done, total) => setStatus({ text: `Convirtiendo… página ${done} de ${total}` }));
      const hasTables = converted.blocks.some((b) => b.kind === "table" && !b.boxes);
      if (!converted.blocks.length) setStatus({ text: "Este PDF no tiene texto que se pueda convertir (parece un escaneo): primero usa «Reconocer texto».", error: true });
      else if (kind === "sheets" && !hasTables) setStatus({ text: "No se encontraron tablas con bordes en este PDF.", error: true });
      else {
        setStatus(null);
        await onConvert(kind, converted, fileName);
      }
    } catch (e) {
      setStatus({ text: `No se pudo convertir: ${e}`, error: true });
    } finally {
      setConverting(false);
    }
  }

  function chooseTool(t: Tool) {
    if (locked) {
      setStatus({ text: LOCKED_TEXT });
      return;
    }
    if (t === "sign" && !signature) setSignDialog(true);
    if (t === "redact")
      setStatus({ text: "Arrastra un recuadro sobre lo que quieras tachar (o búscalo arriba). Al guardar se borra de verdad: esas páginas se guardan como imagen, con su texto para buscar, menos lo tachado." });
    setTool(t);
    setSelectedAnnot(null);
  }

  /** Después de qué página se insertan otras: la última elegida en las miniaturas, o la que se ve. */
  function anchorIndex(): number {
    const list = pagesRef.current;
    const chosen = list.map((p, i) => (selected.has(p.id) ? i : -1)).filter((i) => i >= 0);
    return chosen.length ? Math.max(...chosen) : current - 1;
  }

  /** Las páginas a las que se aplica una acción: las elegidas, o la actual. */
  function targets(): Set<string> {
    if (selected.size) return selected;
    const page = pagesRef.current[current - 1];
    return new Set(page ? [page.id] : []);
  }

  function rotate(delta: 90 | -90) {
    const ids = targets();
    commit(pagesRef.current.map((p) => (ids.has(p.id) ? { ...p, rotation: (p.rotation + delta + 360) % 360 } : p)));
  }

  function remove() {
    const ids = targets();
    if (ids.size >= pagesRef.current.length) {
      setStatus({ text: "El PDF necesita al menos una página" });
      return;
    }
    commit(pagesRef.current.filter((p) => !ids.has(p.id)));
    setSelected(new Set());
    setStatus({ text: ids.size === 1 ? "Página eliminada" : `${ids.size} páginas eliminadas` });
  }

  function move(from: number, to: number) {
    if (from === to) return;
    const list = [...pagesRef.current];
    const [p] = list.splice(from, 1);
    list.splice(to, 0, p);
    commit(list);
    setCurrent(to + 1);
    setPageInput(String(to + 1));
  }

  /** Combinar: las páginas de otro PDF entran después de `after` (o al final). */
  async function insertPdf(after = pagesRef.current.length - 1) {
    if (locked) {
      setStatus({ text: LOCKED_TEXT });
      return;
    }
    const file = await openDialog({ multiple: false, filters: [{ name: "PDF", extensions: ["pdf"] }] });
    if (!file) return;
    try {
      await addSource(await readPdf(file), fileNameOf(file), after);
    } catch (e) {
      setStatus({ text: `No se pudo agregar el PDF: ${e}`, error: true });
    }
  }

  /** Agrega las páginas de otro PDF (si tiene contraseña, primero la pide). */
  async function addSource(bytes: Uint8Array, name: string, after: number, password?: string) {
    try {
      const doc = await loadPdf(bytes, password);
      setInsertAsk(null);
      const source: Source = { id: pid("s"), name, data: bytes, doc, password };
      const added = await pagesOf(source);
      const notes = await notesOf(source, added);
      setFileNotes((known) => ({ ...known, ...notes }));
      setSources((list) => [...list, source]);
      const list = [...pagesRef.current];
      list.splice(after + 1, 0, ...added);
      commit(list);
      setStatus({ text: `Se agregaron ${added.length} ${added.length === 1 ? "página" : "páginas"} de ${source.name}` });
    } catch (e) {
      if ((e as { name?: string })?.name === "PasswordException") setInsertAsk({ bytes, name, after, wrong: password !== undefined });
      else throw e;
    }
  }

  // ───────────── tachar y marca de agua ─────────────

  /** Tacha todas las veces que aparece un texto (en todas las páginas). */
  async function redactAll(term: string) {
    const needle = term.trim().toLocaleLowerCase("es");
    if (!needle) return;
    const added: Annotation[] = [];
    let count = 0;
    for (const p of pagesRef.current) {
      const source = docs.get(p.source);
      if (!source) continue;
      const page = await source.doc.getPage(p.index + 1);
      const content = await page.getTextContent();
      const rects: [number, number, number, number][] = [];
      for (const item of content.items) {
        if (!("str" in item) || !item.str) continue;
        const [a, b, , d, e, f] = item.transform as number[];
        // Solo texto derecho (el torcido es raro en documentos).
        if (Math.abs(b) > 0.01 * Math.abs(a) || !item.width) continue;
        const text = item.str.toLocaleLowerCase("es");
        const height = item.height || Math.abs(d);
        const offsets = charOffsets(item.str, item.width, content.styles[item.fontName]?.fontFamily);
        for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) {
          const from = [...item.str.slice(0, at)].length;
          const to = from + [...item.str.slice(at, at + needle.length)].length;
          // Con un poco de orilla: mejor tachar de más que dejar asomar una letra.
          const pad = height * 0.12;
          rects.push([e + offsets[from] - pad, f - height * 0.25, offsets[to] - offsets[from] + 2 * pad, height * 1.3]);
          count++;
        }
      }
      if (rects.length) added.push({ id: pid("a"), page: p.id, kind: "redact", rects });
    }
    if (!count) return setStatus({ text: `No se encontró «${term.trim()}» en el texto del PDF` });
    change({ annotations: [...annotationsRef.current, ...added] });
    setRedactTerm("");
    setStatus({ text: `Se tachó ${count === 1 ? "1 vez" : `${count} veces`} «${term.trim()}». Revísalo y guarda para borrarlo de verdad.` });
  }

  // ───────────── guardar ─────────────

  async function saveTo(target: string, only?: PageRef[]) {
    if (!sources.length) {
      setStatus({ text: "El PDF todavía se está abriendo" });
      return false;
    }
    try {
      const redacted = annotationsRef.current.some((a) => a.kind === "redact");
      if (redacted) setStatus({ text: "Guardando… borrando lo tachado" });
      const bytes = await savePdf(sources, only ?? pagesRef.current, annotationsRef.current, formRef.current, protection, watermark);
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      await invoke("file_write", { path: target, data: btoa(binary) });
      if (!only) {
        setPath(target);
        setFileName(fileNameOf(target));
        setDirty(false);
        onDirtyChange(false);
        onSaved(target);
      }
      setStatus({ text: only ? `Se guardaron ${only.length} ${only.length === 1 ? "página" : "páginas"} en ${fileNameOf(target)}` : "Guardado" });
      return true;
    } catch (e) {
      setStatus({ text: `No se pudo guardar: ${e}`, error: true });
      return false;
    }
  }

  async function saveDocument(saveAs = false) {
    if (locked) {
      setStatus({ text: LOCKED_TEXT });
      return false;
    }
    if (!saveAs && path) return saveTo(path);
    const target = await save({ defaultPath: fileName.replace(/\.pdf$/i, "") + (saveAs ? " (editado)" : "") + ".pdf", filters: [{ name: "PDF", extensions: ["pdf"] }] });
    if (!target) return false;
    return saveTo(/\.pdf$/i.test(target) ? target : `${target}.pdf`);
  }

  /** Guarda las páginas elegidas en un PDF nuevo (el documento abierto no cambia). */
  async function extract() {
    const ids = targets();
    const chosen = pagesRef.current.filter((p) => ids.has(p.id));
    if (!chosen.length) return;
    const target = await save({ defaultPath: `${fileName.replace(/\.pdf$/i, "")} (páginas).pdf`, filters: [{ name: "PDF", extensions: ["pdf"] }] });
    if (target) await saveTo(/\.pdf$/i.test(target) ? target : `${target}.pdf`, chosen);
  }

  useEffect(() => {
    if (!status || status.error) return;
    const timer = setTimeout(() => setStatus(null), 5000);
    return () => clearTimeout(timer);
  }, [status]);


  // ───────────── miniaturas: elegir, arrastrar y menú ─────────────

  function onThumbClick(e: React.MouseEvent, index: number) {
    const id = pages[index].id;
    if (hasModifier(e)) {
      const next = new Set(selected);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setSelected(next);
    } else if (e.shiftKey && selected.size) {
      const last = pages.findIndex((p) => selected.has(p.id));
      const [a, b] = last < index ? [last, index] : [index, last];
      setSelected(new Set(pages.slice(a, b + 1).map((p) => p.id)));
    } else {
      setSelected(new Set([id]));
    }
    goTo(index + 1);
  }

  function thumbMenu(e: React.MouseEvent, index: number) {
    e.preventDefault();
    if (!selected.has(pages[index].id)) setSelected(new Set([pages[index].id]));
    setCurrent(index + 1);
    const many = selected.size > 1 && selected.has(pages[index].id);
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: "Girar a la derecha", action: () => rotate(90) },
        { label: "Girar a la izquierda", action: () => rotate(-90) },
        "separator",
        { label: "Insertar páginas de otro PDF aquí…", action: () => insertPdf(index) },
        { label: many ? "Guardar estas páginas como PDF nuevo…" : "Guardar esta página como PDF nuevo…", action: extract },
        "separator",
        { label: many ? "Eliminar páginas" : "Eliminar página", danger: true, action: remove },
      ],
    });
  }

  // ───────────── atajos ─────────────

  const actions = useRef({ setZoom, zoom: zoom ?? 1, goTo, current, saveDocument, undo, redo, remove, selected, selectedAnnot, deleteAnnotation });
  actions.current = { setZoom, zoom: zoom ?? 1, goTo, current, saveDocument, undo, redo, remove, selected, selectedAnnot, deleteAnnotation };
  useEffect(() => {
    const stop = onCommand((command) => {
      const c = actions.current;
      if (command === "zoom-in") c.setZoom(stepZoom(c.zoom, 1));
      else if (command === "zoom-out") c.setZoom(stepZoom(c.zoom, -1));
      else if (command === "zoom-reset") c.setZoom(1);
      else if (command === "save") c.saveDocument(false);
      else if (command === "save-as") c.saveDocument(true);
    });
    function onKey(e: KeyboardEvent) {
      const c = actions.current;
      if (hasModifier(e)) {
        const key = e.key.toLowerCase();
        const command =
          key === "=" || key === "+" ? "zoom-in" : key === "-" ? "zoom-out" : key === "0" ? "zoom-reset" : key === "s" ? (e.shiftKey ? "save-as" : "save") : null;
        if (command) {
          e.preventDefault();
          runCommand(command);
        } else if (key === "z" && !(e.target as HTMLElement).closest("input, textarea")) {
          e.preventDefault();
          if (e.shiftKey) c.redo();
          else c.undo();
        }
        return;
      }
      // Las flechas mueven de página, salvo cuando se escribe en un campo.
      if ((e.target as HTMLElement).closest("input, textarea, select")) return;
      if (e.key === "ArrowRight" || (e.key === "PageDown" && e.altKey)) (e.preventDefault(), c.goTo(c.current + 1));
      else if (e.key === "ArrowLeft" || (e.key === "PageUp" && e.altKey)) (e.preventDefault(), c.goTo(c.current - 1));
      else if (e.key === "Home" && !e.shiftKey) (e.preventDefault(), c.goTo(1));
      else if (e.key === "End" && !e.shiftKey) (e.preventDefault(), c.goTo(Number.MAX_SAFE_INTEGER));
      else if ((e.key === "Delete" || e.key === "Backspace") && c.selectedAnnot) (e.preventDefault(), c.deleteAnnotation(c.selectedAnnot));
      else if ((e.key === "Delete" || e.key === "Backspace") && c.selected.size) (e.preventDefault(), c.remove());
      else if (e.key === "Escape") (setTool("select"), setSelectedAnnot(null));
    }
    window.addEventListener("keydown", onKey);
    return () => {
      stop();
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const total = pages.length;
  const paper = sizes[0] ? paperName(sizes[0]) : "";
  const docs = useMemo(() => new Map(sources.map((s) => [s.id, s])), [sources]);
  const ready = total > 0 && sources.length > 0;

  return (
    <div className="editor kind-pdf pdf-viewer">
      <EditorToolbar
        kind="pdf"
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
            <button className="btn" onClick={() => saveDocument()} title={keys("Guardar (⌘S)")} disabled={locked}>
              Guardar
            </button>
          </div>
        }
      />

      <div className="format-bar pdf-bar" role="toolbar" aria-label="PDF">
        <button
          type="button"
          className={`fb-button${sidebar ? " pressed" : ""}`}
          title="Miniaturas"
          aria-label="Miniaturas"
          aria-pressed={sidebar}
          onClick={() => setSidebar((v) => !v)}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
            <rect x="3" y="4" width="18" height="16" rx="1.5" />
            <path d="M9 4v16" />
          </svg>
        </button>
        <Separator />
        <button type="button" className="fb-button" title="Página anterior (←)" aria-label="Página anterior" onClick={() => goTo(current - 1)} disabled={current <= 1}>
          ‹
        </button>
        <form
          className="pdf-page-nav"
          onSubmit={(e) => {
            e.preventDefault();
            const n = Number(pageInput);
            if (Number.isFinite(n) && n >= 1) goTo(n);
            else setPageInput(String(current));
          }}
        >
          <input className="pdf-page-input" value={pageInput} onChange={(e) => setPageInput(e.target.value)} aria-label="Ir a la página" inputMode="numeric" />
          <span>de {total || "…"}</span>
        </form>
        <button type="button" className="fb-button" title="Página siguiente (→)" aria-label="Página siguiente" onClick={() => goTo(current + 1)} disabled={current >= total}>
          ›
        </button>
        <Separator />
        <button type="button" className="btn pdf-fit" onClick={() => setZoom(fitWidth())} disabled={!total}>
          Ajustar al ancho
        </button>
        <Separator />
        <span className="pdf-future-label">Páginas:</span>
        <ToolButton label="Girar a la izquierda" onClick={() => rotate(-90)}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
            <path d="M4 4v5h5" />
            <path d="M4.5 9A8 8 0 1112 20" />
          </svg>
        </ToolButton>
        <ToolButton label="Girar a la derecha" onClick={() => rotate(90)}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
            <path d="M20 4v5h-5" />
            <path d="M19.5 9A8 8 0 1012 20" />
          </svg>
        </ToolButton>
        <ToolButton label="Eliminar página (⌫)" onClick={remove}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
            <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
          </svg>
        </ToolButton>
        <ToolButton label="Combinar: agregar páginas de otro PDF" onClick={() => insertPdf(anchorIndex())}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
            <path d="M7 3h8l4 4v10H7z" />
            <path d="M3 7v14h12" />
            <path d="M13 9v6M10 12h6" />
          </svg>
        </ToolButton>
        <ToolButton label="Guardar las páginas elegidas como PDF nuevo" onClick={extract}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
            <path d="M6 3h8l4 4v14H6z" />
            <path d="M12 10v7M9 14l3 3 3-3" />
          </svg>
        </ToolButton>
        <ToolButton label={protection ? "Contraseña: el PDF se guarda protegido" : "Proteger con contraseña"} pressed={Boolean(protection)} onClick={() => (locked ? setStatus({ text: LOCKED_TEXT }) : setPasswordDialog(true))}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
            <rect x="5" y="11" width="14" height="10" rx="2" />
            <path d={protection ? "M8 11V7a4 4 0 018 0v4" : "M8 11V7a4 4 0 017.5-2"} />
          </svg>
        </ToolButton>
        <ToolButton label={watermark ? `Marca de agua: «${watermark.text}»` : "Marca de agua"} pressed={Boolean(watermark)} onClick={() => (locked ? setStatus({ text: LOCKED_TEXT }) : setWatermarkDialog(true))}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
            <rect x="4" y="3" width="16" height="18" rx="1.5" />
            <path d="M8 16l8-8M9 9h.01M15 15h.01" />
          </svg>
        </ToolButton>
        <Separator />
        <ToolButton label={recognizing ? "Reconociendo texto…" : "Reconocer texto (OCR): para buscar, seleccionar y convertir un escaneo"} pressed={recognizing} onClick={() => void recognizeText()}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
            <path d="M4 8V5a1 1 0 011-1h3M16 4h3a1 1 0 011 1v3M20 16v3a1 1 0 01-1 1h-3M8 20H5a1 1 0 01-1-1v-3" />
            <path d="M9 15l3-7 3 7M10.2 12.5h3.6" />
          </svg>
        </ToolButton>
        <span className="pdf-future-label">Convertir:</span>
        <button type="button" className="fb-button pdf-convert" disabled={converting || !onConvert || !total} onClick={() => void convert("write")} title="Abrir en WEPO Write para editarlo (títulos, párrafos, listas, tablas e imágenes)">
          Write
        </button>
        <button type="button" className="fb-button pdf-convert" disabled={converting || !onConvert || !total} onClick={() => void convert("sheets")} title="Pasar las tablas del PDF a WEPO Sheets (una hoja por tabla)">
          Sheets
        </button>
        <Separator />
        <span className="pdf-future-label">Anotar:</span>
        {TOOLS.map((t) => (
          <ToolButton key={t.id} label={t.label} pressed={tool === t.id} onClick={() => chooseTool(t.id)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              {t.icon.map((d) => (
                <path key={d} d={d} />
              ))}
            </svg>
          </ToolButton>
        ))}
        {tool === "highlight" && (
          <span className="pdf-swatches" role="radiogroup" aria-label="Color del resaltado">
            {HIGHLIGHTS.map((c) => (
              <button
                key={c}
                type="button"
                className={toolStyle.highlight === c ? "on" : ""}
                style={{ background: c }}
                aria-label={c}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setToolStyle({ ...toolStyle, highlight: c })}
              />
            ))}
          </span>
        )}
        {tool === "draw" && (
          <>
            <ColorButton label="Color del trazo" current={toolStyle.ink} emptyLabel="Rojo" onPick={(c) => setToolStyle({ ...toolStyle, ink: c || "#C42B45" })} icon={<span className="fb-letter">✎</span>} />
            <select className="fb-select" aria-label="Grosor del trazo" value={toolStyle.inkWidth} onChange={(e) => setToolStyle({ ...toolStyle, inkWidth: Number(e.target.value) })}>
              {[1, 2, 3, 5, 8].map((w) => (
                <option key={w} value={w}>
                  {w} pt
                </option>
              ))}
            </select>
          </>
        )}
        {tool === "text" && (
          <>
            <ColorButton label="Color de texto" current={toolStyle.textColor} emptyLabel="Negro" onPick={(c) => setToolStyle({ ...toolStyle, textColor: c || "#1D1D1F" })} icon={<span className="fb-letter">A</span>} />
            <select className="fb-select" aria-label="Tamaño del texto" value={toolStyle.textSize} onChange={(e) => setToolStyle({ ...toolStyle, textSize: Number(e.target.value) })}>
              {[8, 10, 12, 14, 18, 24, 32].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </>
        )}
        {tool === "redact" && (
          <form
            className="pdf-redact-search"
            onSubmit={(e) => {
              e.preventDefault();
              void redactAll(redactTerm);
            }}
          >
            <input className="fb-input" placeholder="Tachar todas las veces que aparece…" value={redactTerm} aria-label="Texto que se tacha en todo el PDF" onChange={(e) => setRedactTerm(e.target.value)} />
            <button type="submit" className="fb-button" disabled={!redactTerm.trim()}>
              Tachar
            </button>
          </form>
        )}
        {tool === "sign" && signature && (
          <Popover
            button={(toggle, open) => (
              <button type="button" className={`fb-button pdf-sign-btn${open ? " pressed" : ""}`} onClick={toggle} title="Tu firma">
                <img src={signature.src} alt="Tu firma" />
              </button>
            )}
          >
            {(close) => (
              <div className="pdf-sign-menu">
                <img src={signature.src} alt="Tu firma" />
                <button type="button" className="btn" onClick={() => (close(), setSignDialog(true))}>
                  Cambiar firma…
                </button>
              </div>
            )}
          </Popover>
        )}
        {selectedAnnot && (
          <ToolButton label="Borrar anotación (⌫)" onClick={() => deleteAnnotation(selectedAnnot)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </ToolButton>
        )}
      </div>

      {locked && (
        <div className="sheet-notice" role="status">
          {LOCKED_TEXT}
        </div>
      )}
      {scanned && !locked && (
        <div className="sheet-notice pdf-scan-notice" role="status">
          <span>Este PDF parece escaneado: su texto es una imagen y no se puede buscar, seleccionar ni convertir.</span>
          <button type="button" className="btn btn-primary" disabled={recognizing} onClick={() => void recognizeText()}>
            {recognizing ? "Reconociendo…" : "Reconocer texto"}
          </button>
          <button type="button" className="btn btn-icon" aria-label="Cerrar aviso" onClick={() => setScanned(false)}>
            ×
          </button>
        </div>
      )}
      {watermarkDialog && (
        <WatermarkDialog
          current={watermark}
          onSave={(next) => {
            setWatermark(next);
            setDirty(true);
            onDirtyChange(true);
            setStatus({ text: next ? `Marca de agua «${next.text}» en todas las páginas: se agrega al guardar` : "Se quitó la marca de agua" });
          }}
          onClose={() => setWatermarkDialog(false)}
        />
      )}
      {passwordDialog && (
        <PasswordDialog
          current={protection}
          onSave={(next) => {
            setProtection(next);
            setDirty(true);
            onDirtyChange(true);
            setStatus({ text: next ? "Al guardar, el PDF va a pedir la contraseña para abrirse" : "Al guardar, el PDF ya no va a pedir contraseña" });
          }}
          onClose={() => setPasswordDialog(false)}
        />
      )}
      {insertAsk && (
        <OpenPasswordDialog
          key={String(insertAsk.wrong)}
          name={insertAsk.name}
          wrong={insertAsk.wrong}
          onSubmit={(pw) => void addSource(insertAsk.bytes, insertAsk.name, insertAsk.after, pw).catch((e) => setStatus({ text: `No se pudo agregar el PDF: ${e}`, error: true }))}
          onClose={() => setInsertAsk(null)}
        />
      )}

      <div className="pdf-body">
        {sidebar && ready && (
          <nav className="pdf-sidebar" aria-label="Páginas">
            {pages.map((p, i) => (
              <div
                key={p.id}
                role="button"
                tabIndex={0}
                className={`pdf-thumb${current === i + 1 ? " current" : ""}${selected.has(p.id) ? " chosen" : ""}${dragFrom !== null && dragFrom !== i ? " drop" : ""}`}
                draggable={!locked}
                onDragStart={(e) => {
                  setDragFrom(i);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onDragEnd={() => setDragFrom(null)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragFrom !== null) move(dragFrom, i);
                  setDragFrom(null);
                }}
                onClick={(e) => onThumbClick(e, i)}
                onContextMenu={(e) => thumbMenu(e, i)}
                aria-label={`Página ${i + 1}`}
              >
                <Thumbnail page={p} source={docs.get(p.source)!} />
                <span>{i + 1}</span>
              </div>
            ))}
          </nav>
        )}

        <div className={`pdf-scroller tool-${tool}`} ref={scroller} onScroll={onScroll} style={{ ["--pdf-highlight" as string]: toolStyle.highlight }}>
          {error && <div className="pdf-message error">{error}</div>}
          {needsPassword && (
            <form
              className="pdf-message pdf-password"
              onSubmit={(e) => {
                e.preventDefault();
                open(password);
              }}
            >
              <b>Este PDF está protegido con contraseña.</b>
              <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Contraseña" autoFocus aria-label="Contraseña del PDF" />
              {needsPassword === "wrong" && <span className="cf-error">La contraseña no es correcta.</span>}
              <button className="btn btn-primary" type="submit">
                Abrir
              </button>
            </form>
          )}
          {!ready && !error && !needsPassword && <div className="pdf-message">Abriendo…</div>}
          {ready && zoom !== null && (
            <div className="pdf-pages" style={{ paddingTop: PAGE_GAP }}>
              {pages.map((p) => (
                <PageView key={p.id} page={p} source={docs.get(p.source)!} scale={scale} root={scroller} forms={Boolean(fields[p.id])}>
                  <AnnotationLayer
                    page={p}
                    scale={scale}
                    tool={tool}
                    style={toolStyle}
                    annotations={annotations.filter((a) => a.page === p.id)}
                    selected={selectedAnnot}
                    fields={fields[p.id] ?? []}
                    fileNotes={fileNotes[p.id]}
                    form={form}
                    signature={signature}
                    onAdd={addAnnotation}
                    onChange={updateAnnotation}
                    onSelect={setSelectedAnnot}
                    onForm={(name, value) => change({ form: { ...formRef.current, [name]: value } })}
                    onNeedSignature={() => setSignDialog(true)}
                  />
                  {watermark && <WatermarkPreview page={p} scale={scale} mark={watermark} />}
                </PageView>
              ))}
            </div>
          )}
        </div>
      </div>

      <footer className="write-footer pdf-footer">
        <span>
          {total ? `${total} ${total === 1 ? "página" : "páginas"}` : ""}
          {paper ? ` · ${paper}` : ""}
          {selected.size > 1 ? ` · ${selected.size} elegidas` : ""}
        </span>
        <span className="pdf-hint">{keys("⌘ + clic o ⇧ + clic en las miniaturas para elegir varias; arrástralas para ordenarlas")}</span>
        {status && <span className={`sheet-status ${status.error ? "error" : ""}`}>{status.text}</span>}
        <ZoomControl zoom={zoom ?? 1} onChange={setZoom} />
      </footer>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {signDialog && (
        <SignatureDialog
          onDone={(sig) => {
            setSignature(sig);
            setSignDialog(false);
            setTool("sign");
            setStatus({ text: "Haz clic en la página donde va la firma" });
          }}
          onClose={() => {
            setSignDialog(false);
            if (!signature) setTool("select");
          }}
        />
      )}
    </div>
  );
}

/** Un campo de formulario de pdf.js en el formato del editor. */
function widgetField(a: Record<string, unknown>): FormField | null {
  const [x1, y1, x2, y2] = a.rect as number[];
  const rect: FormField["rect"] = [Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1)];
  const base = { name: String(a.fieldName), rect, readOnly: Boolean(a.readOnly) };
  if (a.fieldType === "Tx") return { ...base, type: "text", value: String(a.fieldValue ?? ""), multiline: Boolean(a.multiLine) };
  if (a.fieldType === "Btn" && a.checkBox) return { ...base, type: "checkbox", value: a.fieldValue && a.fieldValue !== "Off" ? true : false, exportValue: String(a.exportValue ?? "Yes") };
  if (a.fieldType === "Btn" && a.radioButton) return { ...base, type: "radio", value: String(a.fieldValue ?? ""), exportValue: String(a.buttonValue ?? "") };
  if (a.fieldType === "Ch") {
    const options = ((a.options as { displayValue?: string; exportValue?: string }[]) ?? []).map((o) => String(o.displayValue ?? o.exportValue ?? ""));
    const value = Array.isArray(a.fieldValue) ? String(a.fieldValue[0] ?? "") : String(a.fieldValue ?? "");
    return { ...base, type: "choice", value, options };
  }
  return null;
}

/** ¿Algún rectángulo de un grupo se encima con alguno del otro? (en puntos del PDF) */
function overlaps(a: [number, number, number, number][], b: [number, number, number, number][]): boolean {
  return a.some(([ax, ay, aw, ah]) =>
    b.some(([bx, by, bw, bh]) => Math.min(ax + aw, bx + bw) - Math.max(ax, bx) > 0.5 && Math.min(ay + ah, by + bh) - Math.max(ay, by) > 0.5),
  );
}

/** Las notas adhesivas que ya trae un PDF, por página. */
async function notesOf(source: Source, pages: PageRef[]): Promise<Record<string, FileNote[]>> {
  const out: Record<string, FileNote[]> = {};
  for (const p of pages) {
    try {
      const page = await source.doc.getPage(p.index + 1);
      const items = (await page.getAnnotations({ intent: "display" })) as Record<string, unknown>[];
      const notes = items
        .filter((a) => a.subtype === "Text" && !a.hidden)
        .map((a, i): FileNote => {
          const [x1, y1, x2, y2] = a.rect as number[];
          const str = (o: unknown) => String((o as { str?: string } | undefined)?.str ?? "");
          return { id: `${p.id}-n${i}`, rect: [x1, y1, x2 - x1, y2 - y1], text: str(a.contentsObj), author: str(a.titleObj), drawn: Boolean(a.hasAppearance) };
        });
      if (notes.length) out[p.id] = notes;
    } catch {
      // Sin notas legibles en esta página.
    }
  }
  return out;
}

/** "Carta", "A4"… según el tamaño de la página (con un margen de error de unos milímetros). */
function paperName({ width, height }: { width: number; height: number }): string {
  const [w, h] = [Math.min(width, height), Math.max(width, height)];
  const sizes: [string, number, number][] = [
    ["Carta", 612, 792],
    ["Oficio", 612, 1008],
    ["A4", 595, 842],
    ["A3", 842, 1191],
    ["A5", 420, 595],
    ["Tabloide", 792, 1224],
  ];
  const found = sizes.find(([, a, b]) => Math.abs(a - w) < 6 && Math.abs(b - h) < 6);
  const orientation = width > height ? " horizontal" : "";
  return found ? `${found[0]}${orientation}` : `${Math.round((width / 72) * 25.4)} × ${Math.round((height / 72) * 25.4)} mm`;
}

/** Una página: se dibuja solo cuando está cerca de la vista (los PDF largos no se dibujan enteros). */
function PageView({
  page,
  source,
  scale,
  root,
  forms,
  children,
}: {
  page: PageRef;
  source: Source;
  scale: number;
  root: React.RefObject<HTMLDivElement | null>;
  forms: boolean;
  children?: React.ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const size = shownSize(page);
  const width = Math.round(size.width * scale);
  const height = Math.round(size.height * scale);
  const rotation = (page.baseRotation + page.rotation) % 360;

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { root: root.current, rootMargin: "800px 0px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, [root]);

  useEffect(() => {
    if (!visible) return;
    let task: RenderTask | null = null;
    let layer: TextLayer | null = null;
    let cancelled = false;
    (async () => {
      const p: PDFPageProxy = await source.doc.getPage(page.index + 1);
      if (cancelled || !canvas.current || !text.current) return;
      const viewport = p.getViewport({ scale, rotation });
      // Más píxeles en pantallas Retina para que el texto se vea nítido.
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const c = canvas.current;
      c.width = Math.floor(viewport.width * ratio);
      c.height = Math.floor(viewport.height * ratio);
      // Con formulario, los campos los dibuja WEPO encima (así se pueden escribir).
      task = p.render({ canvas: c, viewport, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined, annotationMode: forms ? AnnotationMode.ENABLE_FORMS : AnnotationMode.ENABLE });
      try {
        await task.promise;
      } catch {
        return; // se canceló (cambió el zoom o la página salió de la vista)
      }
      if (cancelled || !text.current) return;
      text.current.replaceChildren();
      layer = new TextLayer({ textContentSource: p.streamTextContent(), container: text.current, viewport });
      await layer.render().catch(() => {});
      if (cancelled || !text.current) return;
      // La capa de texto mide la página sin girar (luego el CSS la gira). Se fija en
      // píxeles: la fórmula de pdf.js depende de variables de su propio visor.
      const flat = p.getViewport({ scale, rotation: 0 });
      text.current.style.width = `${flat.width}px`;
      text.current.style.height = `${flat.height}px`;
    })();
    return () => {
      cancelled = true;
      task?.cancel();
      layer?.cancel();
    };
  }, [visible, source, page.index, scale, rotation, forms]);

  return (
    <div
      ref={box}
      className="pdf-page"
      data-page={page.id}
      style={{ width, height, marginBottom: PAGE_GAP, ["--total-scale-factor" as string]: scale, ["--scale-factor" as string]: scale }}
    >
      <canvas ref={canvas} style={{ width, height }} aria-label={`Página ${page.index + 1}`} />
      <div ref={text} className="textLayer" />
      {visible && children}
    </div>
  );
}

/** Miniatura de una página en la barra lateral. */
function Thumbnail({ page, source }: { page: PageRef; source: Source }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const size = shownSize(page);
  const width = 120;
  const scale = width / size.width;
  const height = Math.round(size.height * scale);
  const rotation = (page.baseRotation + page.rotation) % 360;

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) => entry.isIntersecting && setVisible(true), { rootMargin: "400px 0px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let task: RenderTask | null = null;
    (async () => {
      const p = await source.doc.getPage(page.index + 1);
      if (!canvas.current) return;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const viewport = p.getViewport({ scale: scale * ratio, rotation });
      canvas.current.width = Math.floor(viewport.width);
      canvas.current.height = Math.floor(viewport.height);
      task = p.render({ canvas: canvas.current, viewport });
      await task.promise.catch(() => {});
    })();
    return () => task?.cancel();
  }, [visible, source, page.index, scale, rotation]);

  return <canvas ref={canvas} style={{ width, height }} />;
}

/** Cómo se verá la marca de agua (la de verdad se agrega al guardar). */
function WatermarkPreview({ page, scale, mark }: { page: PageRef; scale: number; mark: Watermark }) {
  const shown = shownSize(page);
  const angle = mark.diagonal ? (Math.atan2(shown.height, shown.width) * 180) / Math.PI : 0;
  const span = mark.diagonal ? Math.hypot(shown.width, shown.height) * 0.7 : shown.width * 0.8;
  // Helvetica en negritas mide, en promedio, unos 0.62 de su tamaño por letra.
  const size = Math.max(14, Math.min(220, span / Math.max(1, mark.text.length * 0.62), shown.height * 0.3));
  return (
    <div className="pdf-watermark" aria-hidden="true">
      <span style={{ fontSize: size * scale, color: mark.color, opacity: mark.opacity, transform: `translate(-50%, -50%) rotate(${-angle}deg)` }}>{mark.text}</span>
    </div>
  );
}
