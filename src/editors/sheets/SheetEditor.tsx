import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { save } from "@tauri-apps/plugin-dialog";
import EditorToolbar from "../../components/EditorToolbar";
import { extensionOf, fileNameOf } from "../../lib/documents";
import type { Cell, SheetView } from "../../lib/spreadsheet";
import { cellName, columnName, rangeOf, sheetApi } from "../../lib/spreadsheet";
import "./SheetEditor.css";

const ROW_HEIGHT = 24;
const COL_WIDTH = 110;
const HEADER_WIDTH = 50;
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

  // Solo se dibujan las filas y columnas visibles. `paddingStart` deja sitio
  // para los encabezados fijos (fila de letras y columna de números).
  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    paddingStart: ROW_HEIGHT,
    scrollPaddingStart: ROW_HEIGHT,
    overscan: 10,
  });
  const colVirtualizer = useVirtualizer({
    horizontal: true,
    count: colCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => COL_WIDTH,
    paddingStart: HEADER_WIDTH,
    scrollPaddingStart: HEADER_WIDTH,
    overscan: 4,
  });
  const scrollX = colVirtualizer.scrollOffset ?? 0;

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
    run(async () => {
      const result = await sheetApi.clear(sheet, selection);
      markDirty();
      return result;
    });
  }

  function undo() {
    run(async () => {
      const result = await sheetApi.undo(sheet);
      markDirty();
      return result;
    });
  }

  function redo() {
    run(async () => {
      const result = await sheetApi.redo(sheet);
      markDirty();
      return result;
    });
  }

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
    // se guardan como un archivo nuevo para no dañar el original.
    if (!saveAs && path && (ext === "xlsx" || ext === "csv")) {
      await run(() => saveTo(path));
      return;
    }
    const base = fileName.replace(/\.[^.]+$/, "") || "Sin título";
    const target = await save({
      defaultPath: `${base}.xlsx`,
      filters: [
        { name: "Libro de Excel (.xlsx)", extensions: ["xlsx"] },
        { name: "CSV (.csv)", extensions: ["csv"] },
      ],
    });
    if (!target) return;
    const finalPath = /\.(xlsx|csv)$/i.test(target) ? target : `${target}.xlsx`;
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
      if (key === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (key === "y") {
        e.preventDefault();
        redo();
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
              </div>
              {colVirtualizer.getVirtualItems().map((col) => {
                const [text, numeric] = rows[row.index]?.[col.index] ?? ["", false];
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
                    style={{ top: row.start, left: col.start, width: col.size, height: row.size }}
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
                    {text}
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
                top: ROW_HEIGHT + editing.cell.r * ROW_HEIGHT,
                left: HEADER_WIDTH + editing.cell.c * COL_WIDTH,
                height: ROW_HEIGHT,
                width: Math.max(COL_WIDTH, editing.value.length * 7.5 + 20),
              }}
              onChange={(e) => setEditing({ ...editing, value: e.target.value })}
              onKeyDown={onEditorKeyDown}
              onBlur={() => commit()}
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
