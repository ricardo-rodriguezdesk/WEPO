import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { save } from "@tauri-apps/plugin-dialog";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import EditorToolbar from "../../components/EditorToolbar";
import { extensionOf, fileNameOf } from "../../lib/documents";
import type { BorderKind, Cell, Range, SheetView } from "../../lib/spreadsheet";
import { cellName, columnName, rangeOf, sheetApi } from "../../lib/spreadsheet";
import FormatBar from "./FormatBar";
import { cellCss } from "./cellStyle";
import { Axis, DEFAULT_COL_WIDTH, DEFAULT_ROW_HEIGHT, HEADER_HEIGHT, HEADER_WIDTH } from "./layout";
import "./SheetEditor.css";

const MIN_ROWS = 100;
const MIN_COLS = 26;
const MAX_ROW = 1_048_575; // límites de Excel (base 0)
const MAX_COL = 16_383;

type Props = {
  initialView: SheetView;
  path: string | null;
  fileName: string;
  onHome: () => void;
  onOpen: () => void;
  onDirtyChange: (dirty: boolean) => void;
};

/**
 * Celda en edición.
 * - `source`: dónde se escribe (en la celda o en la barra de fórmulas).
 * - `quick`: la edición empezó tecleando sobre la celda; como en Excel,
 *   las flechas confirman y mueven en lugar de mover el cursor del texto.
 * - `cell`: se guarda aparte porque, si haces clic en otra celda mientras
 *   escribes, el cambio debe ir a la celda original y no a la nueva.
 */
type Editing = {
  value: string;
  source: "cell" | "bar";
  quick: boolean;
  /** Celda que se está editando y su contenido original. */
  cell: Cell;
  original: string;
};

type Status = { text: string; error?: boolean };

/** Ajuste de tamaño en curso al arrastrar el borde de un encabezado. */
type Resize = { axis: "col" | "row"; index: number; startPos: number; startSize: number; size: number };

/** WEPO Sheets: hoja de cálculo editable con fórmulas, deshacer y guardado. */
export default function SheetEditor(props: Props) {
  const { initialView, onHome, onOpen, onDirtyChange } = props;

  const [view, setView] = useState(initialView);
  const [path, setPath] = useState(props.path);
  const [fileName, setFileName] = useState(props.fileName);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);

  // `active` es la celda donde se escribe; `end` es el otro extremo de la selección.
  const [active, setActive] = useState<Cell>({ r: 0, c: 0 });
  const [end, setEnd] = useState<Cell>({ r: 0, c: 0 });
  const [input, setInput] = useState(""); // contenido crudo de la celda activa
  const [editing, setEditing] = useState<Editing | null>(null);
  const [copied, setCopied] = useState<{ range: Range; cut: boolean } | null>(null);
  const [resize, setResize] = useState<Resize | null>(null);
  // Ruta del archivo original que tiene gráficas o imágenes: no se sobrescribe.
  const [protectedPath] = useState(initialView.has_drawings ? props.path : null);
  const [showDrawingsNotice, setShowDrawingsNotice] = useState(initialView.has_drawings);

  const scrollRef = useRef<HTMLDivElement>(null);
  const cellEditorRef = useRef<HTMLInputElement>(null);
  const editingRef = useRef<Editing | null>(null);
  editingRef.current = editing;
  const mouseSelecting = useRef(false);

  const sheet = view.sheet;
  const rows = view.rows;
  const selection = rangeOf(active, end);
  const widestRow = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const rowCount = Math.max(MIN_ROWS, rows.length + 50, end.r + 20);
  const colCount = Math.max(MIN_COLS, widestRow + 5, end.c + 5);

  // Anchos y altos: casi todos son los normales; Rust manda solo las excepciones.
  const colAxis = useMemo(() => new Axis(DEFAULT_COL_WIDTH, view.col_widths), [view.col_widths]);
  const rowAxis = useMemo(() => new Axis(DEFAULT_ROW_HEIGHT, view.row_heights), [view.row_heights]);

  // Solo se dibujan las filas y columnas visibles. `paddingStart` deja sitio
  // para los encabezados fijos (fila de letras y columna de números).
  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => rowAxis.size(i),
    paddingStart: HEADER_HEIGHT,
    scrollPaddingStart: HEADER_HEIGHT,
    overscan: 10,
  });
  const colVirtualizer = useVirtualizer({
    horizontal: true,
    count: colCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => colAxis.size(i),
    paddingStart: HEADER_WIDTH,
    scrollPaddingStart: HEADER_WIDTH,
    overscan: 4,
  });
  const scrollX = colVirtualizer.scrollOffset ?? 0;

  // Cuando cambia algún ancho o alto, el virtualizador debe volver a medir.
  const colSignature = colAxis.signature();
  const rowSignature = rowAxis.signature();
  useEffect(() => colVirtualizer.measure(), [colSignature]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => rowVirtualizer.measure(), [rowSignature]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Rectángulo en píxeles de un rango, dentro del lienzo de la cuadrícula. */
  function rangeBox(range: Range) {
    const left = HEADER_WIDTH + colAxis.start(range.c1);
    const top = HEADER_HEIGHT + rowAxis.start(range.r1);
    return {
      left,
      top,
      width: HEADER_WIDTH + colAxis.start(range.c2 + 1) - left,
      height: HEADER_HEIGHT + rowAxis.start(range.r2 + 1) - top,
    };
  }

  const activeStyle = view.styles[rows[active.r]?.[active.c]?.[2] ?? 0] ?? view.styles[0];

  // ───────────── utilidades ─────────────

  function markDirty() {
    setDirty(true);
    onDirtyChange(true);
  }

  function showStatus(next: Status) {
    setStatus(next);
  }

  /** Ejecuta una operación de Rust y muestra la hoja que devuelve (o el error). */
  async function run(task: () => Promise<SheetView | void>) {
    try {
      const result = await task();
      if (result) setView(result);
    } catch (e) {
      showStatus({ text: String(e), error: true });
    }
  }

  /** Igual que `run`, pero para operaciones que cambian el documento. */
  function mutate(task: () => Promise<SheetView>) {
    return run(async () => {
      const result = await task();
      markDirty();
      return result;
    });
  }

  function focusGrid() {
    scrollRef.current?.focus({ preventScroll: true });
  }

  // Los mensajes normales desaparecen solos; los errores se quedan.
  useEffect(() => {
    if (!status || status.error) return;
    const timer = setTimeout(() => setStatus(null), 4000);
    return () => clearTimeout(timer);
  }, [status]);

  // Contenido crudo (fórmula o valor) de la celda activa, para la barra de fórmulas.
  useEffect(() => {
    let cancelled = false;
    sheetApi
      .cellInput(sheet, active.r, active.c)
      .then((value) => !cancelled && setInput(value))
      .catch(() => !cancelled && setInput(""));
    return () => {
      cancelled = true;
    };
  }, [sheet, active.r, active.c, view]);

  // Al empezar a editar en la celda, el cursor va al final del texto.
  useEffect(() => {
    if (editing?.source === "cell") {
      const el = cellEditorRef.current;
      el?.focus();
      el?.setSelectionRange(el.value.length, el.value.length);
    }
  }, [editing?.source]);

  // Terminar la selección con el mouse aunque se suelte fuera de la cuadrícula.
  useEffect(() => {
    const stop = () => (mouseSelecting.current = false);
    window.addEventListener("mouseup", stop);
    return () => window.removeEventListener("mouseup", stop);
  });

  // ───────────── selección ─────────────

  function clamp(cell: Cell): Cell {
    return {
      r: Math.min(MAX_ROW, Math.max(0, cell.r)),
      c: Math.min(MAX_COL, Math.max(0, cell.c)),
    };
  }

  function select(cell: Cell, extend = false) {
    const target = clamp(cell);
    if (extend) {
      setEnd(target);
    } else {
      setActive(target);
      setEnd(target);
    }
    rowVirtualizer.scrollToIndex(target.r);
    colVirtualizer.scrollToIndex(target.c);
  }

  function move(dr: number, dc: number, extend = false) {
    const from = extend ? end : active;
    select({ r: from.r + dr, c: from.c + dc }, extend);
  }

  // ───────────── edición ─────────────

  function startEditing(value: string, quick: boolean, source: "cell" | "bar" = "cell") {
    const next: Editing = { value, source, quick, cell: active, original: input };
    editingRef.current = next;
    setEditing(next);
  }

  /** Confirma lo que se escribió y opcionalmente se mueve a otra celda. */
  async function commit(dr = 0, dc = 0) {
    const current = editingRef.current;
    if (!current) return;
    editingRef.current = null;
    setEditing(null);
    const target = current.cell;
    if (dr || dc) move(dr, dc);
    focusGrid();
    if (current.value !== current.original) {
      await run(async () => {
        const result = await sheetApi.setCell(sheet, target.r, target.c, current.value);
        markDirty();
        return result;
      });
    }
  }

  function cancelEditing() {
    editingRef.current = null;
    setEditing(null);
    focusGrid();
  }

  function clearSelection() {
    mutate(() => sheetApi.clear(sheet, selection));
  }

  function undo() {
    mutate(() => sheetApi.undo(sheet));
  }

  function redo() {
    mutate(() => sheetApi.redo(sheet));
  }

  // ───────────── formato ─────────────

  function applyStyle(path: string, value: string) {
    mutate(() => sheetApi.style(sheet, selection, path, value));
  }

  function applyBorder(kind: BorderKind, lineStyle: string, color: string) {
    mutate(() => sheetApi.border(sheet, selection, kind, lineStyle, color));
    focusGrid();
  }

  // ───────────── copiar y pegar ─────────────

  /** Texto separado por tabuladores de la selección, calculado al momento. */
  function selectionText(): string {
    const lines: string[] = [];
    for (let r = selection.r1; r <= selection.r2; r++) {
      const cells: string[] = [];
      for (let c = selection.c1; c <= selection.c2; c++) cells.push(rows[r]?.[c]?.[0] ?? "");
      lines.push(cells.join("\t"));
    }
    return lines.join("\n");
  }

  async function copySelection(cut: boolean, clipboard?: DataTransfer | null) {
    // Desde el menú Edición, el sistema pide el texto en el momento.
    clipboard?.setData("text/plain", selectionText());
    try {
      const text = await sheetApi.copy(sheet, selection, cut);
      if (!clipboard) await writeText(text);
      setCopied({ range: selection, cut });
      showStatus({ text: cut ? "Cortado: elige dónde pegar" : "Copiado" });
    } catch (e) {
      showStatus({ text: String(e), error: true });
    }
  }

  async function pasteText(text: string | null) {
    if (!text) return;
    const target = active;
    const lines = text.replace(/\n$/, "").split("\n");
    const width = Math.max(...lines.map((l) => l.split("\t").length));
    await mutate(() => sheetApi.paste(sheet, target.r, target.c, text));
    // Selecciona lo pegado: al pegar algo copiado en WEPO, toma el tamaño original.
    const size = copied
      ? { r: copied.range.r2 - copied.range.r1, c: copied.range.c2 - copied.range.c1 }
      : { r: lines.length - 1, c: width - 1 };
    setEnd({ r: target.r + size.r, c: target.c + size.c });
    if (copied?.cut) setCopied(null);
  }

  async function pasteFromSystem() {
    try {
      await pasteText(await readText());
    } catch (e) {
      showStatus({ text: `No se pudo leer el portapapeles: ${e}`, error: true });
    }
  }

  // Si el menú Edición de macOS se adelanta al teclado, llegan estos eventos.
  const clipboardHandlers = useRef({ copySelection, pasteText });
  clipboardHandlers.current = { copySelection, pasteText };
  useEffect(() => {
    // Solo cuando la cuadrícula tiene el foco y no se está escribiendo en una celda.
    const gridFocused = () => document.activeElement === scrollRef.current && !editingRef.current;
    const onCopy = (e: ClipboardEvent) => {
      if (!gridFocused()) return;
      e.preventDefault();
      clipboardHandlers.current.copySelection(e.type === "cut", e.clipboardData);
    };
    const onPaste = (e: ClipboardEvent) => {
      if (!gridFocused()) return;
      e.preventDefault();
      clipboardHandlers.current.pasteText(e.clipboardData?.getData("text/plain") ?? null);
    };
    document.addEventListener("copy", onCopy);
    document.addEventListener("cut", onCopy);
    document.addEventListener("paste", onPaste);
    return () => {
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("cut", onCopy);
      document.removeEventListener("paste", onPaste);
    };
  }, []);

  // ───────────── ancho de columnas y alto de filas ─────────────

  function startResize(e: ReactMouseEvent, axis: "col" | "row", index: number) {
    e.preventDefault();
    e.stopPropagation();
    const startSize = axis === "col" ? colAxis.size(index) : rowAxis.size(index);
    const startPos = axis === "col" ? e.clientX : e.clientY;
    setResize({ axis, index, startPos, startSize, size: startSize });
  }

  useEffect(() => {
    if (!resize) return;
    const onMove = (e: MouseEvent) => {
      const delta = (resize.axis === "col" ? e.clientX : e.clientY) - resize.startPos;
      setResize({ ...resize, size: Math.max(12, Math.round(resize.startSize + delta)) });
    };
    const onUp = () => {
      const { axis, index, size, startSize } = resize;
      setResize(null);
      if (size === startSize) return;
      // Si la columna (o fila) es parte de la selección, se ajustan todas las seleccionadas.
      const [from, to] =
        axis === "col"
          ? index >= selection.c1 && index <= selection.c2 ? [selection.c1, selection.c2] : [index, index]
          : index >= selection.r1 && index <= selection.r2 ? [selection.r1, selection.r2] : [index, index];
      mutate(() =>
        axis === "col" ? sheetApi.columnWidth(sheet, from, to, size) : sheetApi.rowHeight(sheet, from, to, size),
      );
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  });

  // ───────────── hojas ─────────────

  function resetSelection() {
    setActive({ r: 0, c: 0 });
    setEnd({ r: 0, c: 0 });
    scrollRef.current?.scrollTo(0, 0);
  }

  function switchSheet(index: number) {
    if (index === sheet) return;
    resetSelection();
    run(() => sheetApi.view(index));
  }

  function addSheet() {
    resetSelection();
    run(async () => {
      const result = await sheetApi.addSheet();
      markDirty();
      return result;
    });
  }

  // ───────────── guardar ─────────────

  async function saveTo(target: string) {
    await sheetApi.save(target, sheet);
    setPath(target);
    setFileName(fileNameOf(target));
    setDirty(false);
    onDirtyChange(false);
    const csvNote =
      extensionOf(target) === "csv" && view.sheet_names.length > 1
        ? " (el CSV solo contiene la hoja actual)"
        : "";
    showStatus({ text: `Guardado${csvNote}` });
  }

  async function saveDocument(saveAs = false) {
    await commit();
    const ext = path ? extensionOf(path) : "";
    // Solo se sobrescribe directamente lo que sabemos escribir; .xls u .ods
    // se guardan como un archivo nuevo para no dañar el original. Lo mismo un
    // archivo con gráficas o imágenes, que se perderían al guardarlo.
    const canOverwrite = path !== protectedPath && (ext === "xlsx" || ext === "csv");
    if (!saveAs && path && canOverwrite) {
      await run(() => saveTo(path));
      return;
    }
    const base = (fileName.replace(/\.[^.]+$/, "") || "Sin título") + (protectedPath && path === protectedPath ? " (copia)" : "");
    const target = await save({
      defaultPath: `${base}.xlsx`,
      filters: [
        { name: "Libro de Excel (.xlsx)", extensions: ["xlsx"] },
        { name: "CSV (.csv)", extensions: ["csv"] },
      ],
    });
    if (!target) return;
    const finalPath = /\.(xlsx|csv)$/i.test(target) ? target : `${target}.xlsx`;
    if (finalPath === protectedPath) {
      showStatus({ text: "Elige otro nombre: así no se pierden las gráficas del original.", error: true });
      return;
    }
    await run(() => saveTo(finalPath));
  }

  // ⌘S y ⌘⇧S funcionan desde cualquier parte de la ventana.
  const saveRef = useRef(saveDocument);
  saveRef.current = saveDocument;
  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.metaKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        saveRef.current(e.shiftKey);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ───────────── teclado ─────────────

  function onGridKeyDown(e: KeyboardEvent) {
    if (editing) return;
    const extend = e.shiftKey;

    if (e.metaKey || e.ctrlKey) {
      const key = e.key.toLowerCase();
      const shortcuts: Record<string, () => void> = {
        z: () => (e.shiftKey ? redo() : undo()),
        y: redo,
        c: () => copySelection(false),
        x: () => copySelection(true),
        v: pasteFromSystem,
        b: () => applyStyle("font.b", String(!activeStyle.b)),
        i: () => applyStyle("font.i", String(!activeStyle.i)),
        u: () => applyStyle("font.u", String(!activeStyle.u)),
      };
      if (shortcuts[key]) {
        e.preventDefault();
        shortcuts[key]();
      }
      return;
    }

    switch (e.key) {
      case "ArrowUp":
        e.preventDefault();
        return move(-1, 0, extend);
      case "ArrowDown":
        e.preventDefault();
        return move(1, 0, extend);
      case "ArrowLeft":
        e.preventDefault();
        return move(0, -1, extend);
      case "ArrowRight":
        e.preventDefault();
        return move(0, 1, extend);
      case "Enter":
        e.preventDefault();
        return move(e.shiftKey ? -1 : 1, 0);
      case "Tab":
        e.preventDefault();
        return move(0, e.shiftKey ? -1 : 1);
      case "Backspace":
      case "Delete":
        e.preventDefault();
        return clearSelection();
      case "F2":
        e.preventDefault();
        return startEditing(input, false);
      case "Escape":
        setCopied(null);
        return setEnd(active);
    }

    // Cualquier carácter imprimible empieza a escribir y reemplaza la celda.
    if (e.key.length === 1 && !e.altKey) {
      e.preventDefault();
      startEditing(e.key, true);
    }
  }

  function onEditorKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    const quick = editing?.quick;
    switch (e.key) {
      case "Enter":
        e.preventDefault();
        return void commit(e.shiftKey ? -1 : 1, 0);
      case "Tab":
        e.preventDefault();
        return void commit(0, e.shiftKey ? -1 : 1);
      case "Escape":
        e.preventDefault();
        return cancelEditing();
      case "ArrowUp":
      case "ArrowDown":
        if (quick || editing?.source === "cell") {
          e.preventDefault();
          return void commit(e.key === "ArrowUp" ? -1 : 1, 0);
        }
        return;
      case "ArrowLeft":
      case "ArrowRight":
        if (quick) {
          e.preventDefault();
          return void commit(0, e.key === "ArrowLeft" ? -1 : 1);
        }
    }
  }

  // ───────────── dibujo ─────────────

  const isMultiSelection = selection.r1 !== selection.r2 || selection.c1 !== selection.c2;
  const selectionLabel = isMultiSelection
    ? `${cellName({ r: selection.r1, c: selection.c1 })}:${cellName({ r: selection.r2, c: selection.c2 })}`
    : cellName(active);

  const toolbarActions = (
    <div className="toolbar-group">
      <button className="btn btn-icon" onClick={undo} title="Deshacer (⌘Z)" aria-label="Deshacer">
        ↶
      </button>
      <button className="btn btn-icon" onClick={redo} title="Rehacer (⌘⇧Z)" aria-label="Rehacer">
        ↷
      </button>
      <button className="btn" onClick={() => saveDocument()} title="Guardar (⌘S)">
        Guardar
      </button>
    </div>
  );

  return (
    <div className="editor kind-sheets">
      <EditorToolbar
        kind="sheets"
        fileName={fileName}
        dirty={dirty}
        onHome={onHome}
        onOpen={onOpen}
        actions={toolbarActions}
      />

      <FormatBar style={activeStyle} onStyle={applyStyle} onBorder={applyBorder} onDone={focusGrid} />

      {showDrawingsNotice && (
        <div className="sheet-notice" role="status">
          <span>
            Este archivo tiene gráficas o imágenes. WEPO todavía no las muestra, así que al guardar se crea una copia y
            el original queda intacto.
          </span>
          <button className="btn btn-icon" aria-label="Cerrar aviso" onClick={() => setShowDrawingsNotice(false)}>
            ×
          </button>
        </div>
      )}

      <div className="formula-bar">
        <span className="cell-ref">{selectionLabel}</span>
        <span className="fx" aria-hidden>
          fx
        </span>
        <input
          aria-label="Contenido de la celda"
          spellCheck={false}
          value={editing ? editing.value : input}
          onFocus={() => {
            if (!editingRef.current) startEditing(input, false, "bar");
          }}
          onChange={(e) => {
            const value = e.target.value;
            setEditing((prev) =>
              prev
                ? { ...prev, value }
                : { value, source: "bar", quick: false, cell: active, original: input },
            );
          }}
          onKeyDown={onEditorKeyDown}
          onBlur={() => editing?.source === "bar" && commit()}
        />
      </div>

      <div
        className="grid-scroll"
        ref={scrollRef}
        tabIndex={0}
        onKeyDown={onGridKeyDown}
        aria-label="Cuadrícula de la hoja"
      >
        <div
          className="grid-canvas"
          style={{ width: colVirtualizer.getTotalSize(), height: rowVirtualizer.getTotalSize() }}
        >
          {/* Encabezados de columna (A, B, C…) fijos arriba */}
          <div className="col-headers" style={{ width: colVirtualizer.getTotalSize() }}>
            <div className="corner" style={{ left: scrollX, width: HEADER_WIDTH }} />
            {colVirtualizer.getVirtualItems().map((col) => (
              <div
                key={col.key}
                className={`col-header ${col.index >= selection.c1 && col.index <= selection.c2 ? "active" : ""}`}
                style={{ left: col.start, width: col.size }}
              >
                {columnName(col.index)}
                <span
                  className="col-resize"
                  title="Arrastra para cambiar el ancho"
                  onMouseDown={(e) => startResize(e, "col", col.index)}
                />
              </div>
            ))}
          </div>

          {rowVirtualizer.getVirtualItems().map((row) => (
            <div key={row.key}>
              {/* Número de fila fijo a la izquierda */}
              <div
                className={`row-header ${row.index >= selection.r1 && row.index <= selection.r2 ? "active" : ""}`}
                style={{ top: row.start, left: scrollX, height: row.size, width: HEADER_WIDTH }}
              >
                {row.index + 1}
                <span
                  className="row-resize"
                  title="Arrastra para cambiar el alto"
                  onMouseDown={(e) => startResize(e, "row", row.index)}
                />
              </div>
              {colVirtualizer.getVirtualItems().map((col) => {
                const [text, numeric, styleId] = rows[row.index]?.[col.index] ?? ["", false, 0];
                const cellStyle = view.styles[styleId] ?? view.styles[0];
                const isActive = row.index === active.r && col.index === active.c;
                const inRange =
                  isMultiSelection &&
                  row.index >= selection.r1 &&
                  row.index <= selection.r2 &&
                  col.index >= selection.c1 &&
                  col.index <= selection.c2;
                return (
                  <div
                    key={col.key}
                    className={`cell${numeric ? " number" : ""}${isActive ? " active" : ""}${inRange ? " in-range" : ""}`}
                    style={{
                      ...cellCss(cellStyle, numeric),
                      top: row.start,
                      left: col.start,
                      width: col.size,
                      height: row.size,
                    }}
                    onMouseDown={(e) => {
                      if (e.button !== 0) return;
                      mouseSelecting.current = true;
                      select({ r: row.index, c: col.index }, e.shiftKey);
                    }}
                    onMouseEnter={() => {
                      if (mouseSelecting.current) setEnd({ r: row.index, c: col.index });
                    }}
                    onDoubleClick={() => startEditing(input, false)}
                    title={text}
                  >
                    <span className="cell-text">{text}</span>
                  </div>
                );
              })}
            </div>
          ))}

          {editing?.source === "cell" && (
            <input
              ref={cellEditorRef}
              className="cell-editor"
              spellCheck={false}
              value={editing.value}
              style={{
                ...cellCss(activeStyle, false),
                top: HEADER_HEIGHT + rowAxis.start(editing.cell.r),
                left: HEADER_WIDTH + colAxis.start(editing.cell.c),
                height: Math.max(rowAxis.size(editing.cell.r), DEFAULT_ROW_HEIGHT),
                width: Math.max(colAxis.size(editing.cell.c), editing.value.length * 8 + 20),
                background: activeStyle.fill ?? undefined,
                // El borde de la caja de edición es el del editor, no el de la celda.
                borderTop: undefined,
                borderRight: undefined,
                borderBottom: undefined,
                borderLeft: undefined,
              }}
              onChange={(e) => setEditing({ ...editing, value: e.target.value })}
              onKeyDown={onEditorKeyDown}
              onBlur={() => commit()}
            />
          )}

          {/* Contorno punteado de lo que se copió o cortó */}
          {copied && copied.range && <div className="copy-outline" style={rangeBox(copied.range)} />}

          {/* Guía mientras se arrastra el borde de una columna o fila */}
          {resize && (
            <div
              className={`resize-guide ${resize.axis}`}
              style={
                resize.axis === "col"
                  ? { left: HEADER_WIDTH + colAxis.start(resize.index) + resize.size }
                  : { top: HEADER_HEIGHT + rowAxis.start(resize.index) + resize.size }
              }
            />
          )}
        </div>
      </div>

      <footer className="sheet-tabs">
        {view.sheet_names.map((name, i) => (
          <button
            key={`${i}-${name}`}
            className={`btn ${i === sheet ? "active" : ""}`}
            onClick={() => switchSheet(i)}
          >
            {name}
          </button>
        ))}
        <button className="btn btn-icon" onClick={addSheet} title="Agregar hoja" aria-label="Agregar hoja">
          +
        </button>
        {status && (
          <span className={`sheet-status ${status.error ? "error" : ""}`} role="status">
            {status.text}
          </span>
        )}
      </footer>
    </div>
  );
}
