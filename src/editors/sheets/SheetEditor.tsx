import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { open as openDialog, save } from "@tauri-apps/plugin-dialog";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import EditorToolbar from "../../components/EditorToolbar";
import ContextMenu from "../../components/ContextMenu";
import type { MenuItem } from "../../components/ContextMenu";
import { extensionOf, fileNameOf } from "../../lib/documents";
import type {
  BorderKind,
  Cell,
  ChartType,
  Decoration,
  DrawingPatch,
  FindMatch,
  FindOptions,
  LinkView,
  ListSource,
  NoteView,
  PasteMode,
  Range,
  SelectionStats,
  SheetView,
  TableStyle,
  TableView,
} from "../../lib/spreadsheet";
import { cellName, columnName, rangeOf, sheetApi } from "../../lib/spreadsheet";
import FormatBar, { Separator, ToolButton } from "./FormatBar";
import FindBar from "./FindBar";
import FilterMenu from "./FilterMenu";
import SheetTabs from "./SheetTabs";
import { ICON_GLYPHS, cellCss } from "./cellStyle";
import FormulaInput from "./FormulaInput";
import ConditionalFormatDialog from "./ConditionalFormatDialog";
import ValidationDialog from "./ValidationDialog";
import DrawingLayer from "./DrawingLayer";
import ChartPanel, { CHART_TYPES } from "./ChartPanel";
import PrintDialog, { loadOptions, pageForm } from "./PrintDialog";
import type { PageForm } from "./PrintDialog";
import LinkDialog from "./LinkDialog";
import TableDialog from "./TableDialog";
import FunctionDialog from "./FunctionDialog";
import DuplicatesDialog from "./DuplicatesDialog";
import type { ColumnSpec } from "./FilterMenu";
import { conditionHolds } from "./FilterMenu";
import { tableAt, tableRegion, withTableStyle } from "./tables";
import SortDialog from "./SortDialog";
import type { SortLevel } from "./SortDialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { recoveryApi } from "../../lib/recovery";
import PrintSheet, { fillPageFields, usedRange } from "./PrintSheet";
import type { PrintJob, PrintOptions } from "./PrintSheet";
import { invoke } from "@tauri-apps/api/core";
import { onCommand, runCommand } from "../../lib/commands";
import { hasModifier, keys } from "../../lib/platform";
import { lineHeight, textWidth, wrappedLines } from "./measure";
import FormulaAssist from "./FormulaAssist";
import type { FunctionInfo } from "./functions";
import { findFunction, suggestFunctions } from "./functions";
import { canPointAt, cycleReference, findRefs } from "./formulaRefs";
import type { FormulaLanguage } from "../../lib/preferences";
import { getFormulaLanguage, setFormulaLanguage } from "../../lib/preferences";
import {
  Axis,
  DEFAULT_COL_WIDTH,
  DEFAULT_ROW_HEIGHT,
  HEADER_HEIGHT,
  HEADER_WIDTH,
  clampZoom,
  stepZoom,
} from "./layout";
import ZoomControl from "./ZoomControl";
import { loadZoom, saveZoom } from "../../lib/zoom";
import { askPdfPath, printReady, writePdf } from "../../lib/exportPdf";
import { layoutPages, pageSize, parseRange } from "./printLayout";
import {
  MAX_COL,
  MAX_ROW,
  MergedCells,
  clampToData,
  currentRegion,
  looksLikeHeader,
} from "./regions";
import "./SheetEditor.css";

const MIN_ROWS = 100;
const MIN_COLS = 26;

type Props = {
  initialView: SheetView;
  path: string | null;
  fileName: string;
  onHome: () => void;
  onOpen: () => void;
  onDirtyChange: (dirty: boolean) => void;
  /** Se guardó en esta ruta (para la lista de recientes). */
  onSaved: (path: string) => void;
  /** El documento viene de una copia de recuperación: empieza con cambios sin guardar. */
  recovered?: boolean;
  /** Mensaje al abrir (en lugar del de "documento recuperado"). */
  notice?: string;
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
type Resize = {
  axis: "col" | "row";
  index: number;
  startPos: number;
  startSize: number;
  size: number;
};

type Menu = { x: number; y: number; kind: "cell" | "row" | "col" };

/** Ayuda mientras se escribe una fórmula: funciones sugeridas o argumentos de la función actual. */
type Assist = {
  suggestions: FunctionInfo[];
  selected: number;
  /** Desde dónde se reemplaza el texto al elegir una sugerencia. */
  replaceStart: number;
  signature: { fn: FunctionInfo; arg: number } | null;
  /** El texto para el que se calcularon (el motor contesta un poco después de cada tecla). */
  value: string;
};

/** Referencia insertada con el mouse o las flechas mientras se escribe una fórmula. */
type Pointing = { start: number; end: number; anchor: Cell; focus: Cell };

/** Filtro activo: la tabla filtrada, la columna y los valores visibles. */
function isMultiSelectionRange(range: Range) {
  return range.r1 !== range.r2 || range.c1 !== range.c2;
}

/** Filtros activos sobre una tabla: por cada columna filtrada, los valores visibles. */
type Filter = { region: Range; cols: Record<number, ColumnSpec> };

/** ¿El texto de la celda pasa el filtro de su columna? */
function passes(spec: ColumnSpec, text: string) {
  if (spec.keep) return spec.keep.includes(text);
  if (spec.condition) return conditionHolds(spec.condition, text);
  return true;
}

/** Nota que se está editando o que se muestra al pasar el mouse. */
type NoteTarget = { r: number; c: number };

const AUTOSAVE_KEY = "wepo.autosave";
function loadAutosave(): boolean {
  try {
    return localStorage.getItem(AUTOSAVE_KEY) === "1";
  } catch {
    return false;
  }
}

/** ¿Se ven en la hoja las líneas donde corta cada página al imprimir? */
const BREAKS_KEY = "wepo.sheets.pageBreaks";
const BREAK_VIEW_KEY = "wepo.sheets.breakView";
function loadBreaks(): boolean {
  try {
    return localStorage.getItem(BREAKS_KEY) === "1";
  } catch {
    return false;
  }
}

const statsFormat = new Intl.NumberFormat("es-MX", {
  maximumFractionDigits: 4,
});

/** WEPO Sheets: hoja de cálculo editable con fórmulas, formato y herramientas de datos. */
export default function SheetEditor(props: Props) {
  const { initialView, onHome, onOpen, onDirtyChange, onSaved } = props;

  const [view, setView] = useState(initialView);
  const [path, setPath] = useState(props.path);
  const [fileName, setFileName] = useState(props.fileName);
  const [dirty, setDirty] = useState(Boolean(props.recovered));
  const [status, setStatus] = useState<Status | null>(null);

  // `active` es la celda donde se escribe; `end` es el otro extremo de la selección.
  const [active, setActive] = useState<Cell>({ r: 0, c: 0 });
  const [end, setEnd] = useState<Cell>({ r: 0, c: 0 });
  const [input, setInput] = useState(""); // contenido crudo de la celda activa
  const [editing, setEditing] = useState<Editing | null>(null);
  const [caret, setCaret] = useState(0);
  const [assist, setAssist] = useState<Assist | null>(null);
  const [assistDismissed, setAssistDismissed] = useState(false);
  const [pointing, setPointing] = useState<Pointing | null>(null);
  const [language, setLanguage] = useState<FormulaLanguage>(getFormulaLanguage);
  const [dialog, setDialog] = useState<
    "conditional" | "validation" | "print" | null
  >(null);
  const [printJob, setPrintJob] = useState<PrintJob | null>(null);
  /** Con "Exportar PDF", dónde se guarda (si no, se abre el diálogo de impresión). */
  const pdfTarget = useRef<string | null>(null);
  const [pdfDialog, setPdfDialog] = useState(false);
  // Copiar formato (brocha): el rango de origen; `sticky` si se usa varias veces (doble clic).
  const [painter, setPainter] = useState<{
    source: Range;
    sticky: boolean;
  } | null>(null);
  const [noteEdit, setNoteEdit] = useState<
    (NoteTarget & { text: string }) | null
  >(null);
  const [hoverNote, setHoverNote] = useState<NoteTarget | null>(null);
  const [linkDialog, setLinkDialog] = useState<NoteTarget | null>(null);
  const [sortDialog, setSortDialog] = useState<Range | null>(null);
  const [tableDialog, setTableDialog] = useState<{
    range: Range;
    table: TableView | null;
  } | null>(null);
  const [fnDialog, setFnDialog] = useState(false);
  const [dupDialog, setDupDialog] = useState<Range | null>(null);
  const [stats, setStats] = useState<SelectionStats | null>(null);
  const [autosave, setAutosave] = useState(loadAutosave);
  // Cuenta los cambios: sirve para saber si hay algo nuevo que autoguardar o recuperar.
  const [changes, setChanges] = useState(0);
  // Zoom de la hoja (1 = 100 %). Solo cambia cómo se ve, no el archivo.
  const [zoom, setZoomState] = useState(() => loadZoom(props.path));
  const [listOpen, setListOpen] = useState(false);
  // Gráfica o imagen seleccionada, y si su panel de edición está abierto.
  const [selectedDrawing, setSelectedDrawing] = useState<number | null>(null);
  const [chartPanel, setChartPanel] = useState<number | null>(null);
  const [chartMenu, setChartMenu] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [copied, setCopied] = useState<{ range: Range; cut: boolean } | null>(
    null,
  );
  const [resize, setResize] = useState<Resize | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [filter, setFilter] = useState<Filter | null>(null);
  const [filterMenu, setFilterMenu] = useState<{
    x: number;
    y: number;
    col: number;
    region: Range;
  } | null>(null);
  // Autollenado: hasta qué celda se arrastró la esquina de la selección.
  const [fillTo, setFillTo] = useState<Cell | null>(null);
  // Ruta del archivo original que tiene gráficas o imágenes: no se sobrescribe.
  const [protectedPath] = useState(
    initialView.has_drawings ? props.path : null,
  );
  const [showDrawingsNotice, setShowDrawingsNotice] = useState(
    initialView.has_drawings,
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const cellEditorRef = useRef<HTMLInputElement>(null);
  const barInputRef = useRef<HTMLInputElement>(null);
  const editingRef = useRef<Editing | null>(null);
  editingRef.current = editing;
  const mouseSelecting = useRef<"cells" | "rows" | "cols" | "ref" | null>(null);

  const sheet = view.sheet;
  const rows = view.rows;
  const merged = useMemo(() => new MergedCells(view.merged), [view.merged]);
  const rawSelection = rangeOf(active, end);
  const wholeCols = rawSelection.r1 === 0 && rawSelection.r2 >= MAX_ROW;
  const wholeRows = rawSelection.c1 === 0 && rawSelection.c2 >= MAX_COL;
  // Un rango de celdas se amplía para no cortar celdas combinadas; filas o columnas completas, no.
  const selection =
    wholeCols || wholeRows ? rawSelection : merged.expand(rawSelection);
  const frozenRows = view.frozen_rows;
  const frozenCols = view.frozen_cols;

  const widestRow = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const rowCount = Math.max(
    MIN_ROWS,
    rows.length + 50,
    (wholeCols ? active.r : end.r) + 20,
    active.r + 20,
  );
  const colCount = Math.max(
    MIN_COLS,
    widestRow + 5,
    (wholeRows ? active.c : end.c) + 5,
    active.c + 5,
  );

  // Anchos y altos: casi todos son los normales; Rust manda solo las excepciones.
  // Las filas y columnas ocultas miden 0.
  // `baseCols` y `baseRows` son las medidas reales (las del archivo y la impresión);
  // `colAxis` y `rowAxis`, las mismas con el zoom aplicado, para dibujar.
  const colCustom = useMemo(
    () => [
      ...view.col_widths,
      ...view.hidden_cols.map((c) => [c, 0] as [number, number]),
    ],
    [view.col_widths, view.hidden_cols],
  );
  const baseCols = useMemo(
    () => new Axis(DEFAULT_COL_WIDTH, colCustom),
    [colCustom],
  );
  const colAxis = useMemo(
    () => new Axis(DEFAULT_COL_WIDTH, colCustom, zoom),
    [colCustom, zoom],
  );
  // Alto automático: filas con letra más grande o texto en varias líneas crecen
  // solas, como en Excel, salvo que el alto se haya fijado a mano.
  const autoHeights = useMemo(() => {
    const fixed = new Set([
      ...view.row_heights.map(([r]) => r - 1),
      ...view.hidden_rows.map((r) => r - 1),
    ]);
    const baseSize = view.styles[0]?.size ?? 11;
    const result: [number, number][] = [];
    rows.forEach((row, r) => {
      if (!row || fixed.has(r)) return;
      let height = DEFAULT_ROW_HEIGHT;
      row.forEach(([text, , styleId], c) => {
        const style = view.styles[styleId];
        if (!style || !text || (style.size <= baseSize && !style.wrap)) return;
        const lines = style.wrap
          ? wrappedLines(text, style, baseCols.size(c) - 12)
          : 1;
        height = Math.max(height, lines * lineHeight(style) + 6);
      });
      if (height > DEFAULT_ROW_HEIGHT) result.push([r + 1, height]);
    });
    return result;
  }, [rows, view.styles, view.row_heights, view.hidden_rows, baseCols]);
  const rowCustom = useMemo(
    () => [
      ...autoHeights,
      ...view.row_heights,
      ...view.hidden_rows.map((r) => [r, 0] as [number, number]),
    ],
    [autoHeights, view.row_heights, view.hidden_rows],
  );
  const baseRows = useMemo(
    () => new Axis(DEFAULT_ROW_HEIGHT, rowCustom),
    [rowCustom],
  );
  const rowAxis = useMemo(
    () => new Axis(DEFAULT_ROW_HEIGHT, rowCustom, zoom),
    [rowCustom, zoom],
  );

  // Barras de datos, íconos y calificaciones, por celda.
  const decorations = useMemo(() => {
    const map = new Map<string, Decoration>();
    for (const d of view.decorations) map.set(`${d.row - 1},${d.col - 1}`, d);
    return map;
  }, [view.decorations]);
  // Notas y vínculos, por celda ("fila,columna" desde 0).
  const notes = useMemo(() => {
    const map = new Map<string, NoteView>();
    for (const n of view.notes ?? []) map.set(`${n.row - 1},${n.col - 1}`, n);
    return map;
  }, [view.notes]);
  const links = useMemo(() => {
    const map = new Map<string, LinkView>();
    for (const l of view.links ?? []) map.set(`${l.row - 1},${l.col - 1}`, l);
    return map;
  }, [view.links]);
  const frozenHeight = rowAxis.start(frozenRows);
  const frozenWidth = colAxis.start(frozenCols);

  // Solo se dibujan las filas y columnas visibles. `paddingStart` deja sitio
  // para los encabezados fijos (fila de letras y columna de números).
  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => rowAxis.size(i),
    paddingStart: HEADER_HEIGHT,
    scrollPaddingStart: HEADER_HEIGHT + frozenHeight,
    overscan: 10,
  });
  const colVirtualizer = useVirtualizer({
    horizontal: true,
    count: colCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => colAxis.size(i),
    paddingStart: HEADER_WIDTH,
    scrollPaddingStart: HEADER_WIDTH + frozenWidth,
    overscan: 4,
  });
  const scrollX = colVirtualizer.scrollOffset ?? 0;
  const scrollY = rowVirtualizer.scrollOffset ?? 0;

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
      width:
        HEADER_WIDTH + colAxis.start(Math.min(range.c2, colCount) + 1) - left,
      height:
        HEADER_HEIGHT + rowAxis.start(Math.min(range.r2, rowCount) + 1) - top,
    };
  }

  const activeStyle =
    view.styles[rows[active.r]?.[active.c]?.[2] ?? 0] ?? view.styles[0];
  // Lista desplegable de la celda activa, si tiene.
  const activeValidation =
    view.validations.find(
      (v) =>
        active.r + 1 >= v.row1 &&
        active.r + 1 <= v.row2 &&
        active.c + 1 >= v.col1 &&
        active.c + 1 <= v.col2,
    ) ?? null;

  // ───────────── utilidades ─────────────

  function markDirty() {
    setDirty(true);
    onDirtyChange(true);
    setChanges((n) => n + 1);
  }

  function showStatus(next: Status) {
    setStatus(next);
  }

  /** Ejecuta una operación de Rust y muestra la hoja que devuelve (o el error). */
  async function run(task: () => Promise<SheetView | void>) {
    try {
      const result = await task();
      if (result) setView(result);
      return true;
    } catch (e) {
      showStatus({ text: String(e), error: true });
      return false;
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

  // La lista desplegable se cierra al moverse a otra celda.
  useEffect(() => setListOpen(false), [active.r, active.c, sheet]);

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

  // Idioma de las funciones (SUMA o SUM): se aplica al abrir y al cambiarlo.
  useEffect(() => {
    run(() => sheetApi.setLanguage(sheet, language));
  }, [language]); // eslint-disable-line react-hooks/exhaustive-deps

  function toggleLanguage() {
    const next = language === "es" ? "en" : "es";
    setFormulaLanguage(next);
    setLanguage(next);
    showStatus({
      text:
        next === "es"
          ? "Funciones en español (SUMA, SI, BUSCARV…)"
          : "Funciones en inglés (SUM, IF, VLOOKUP…)",
    });
  }

  // Autocompletado: el motor dice si en el cursor va un nombre de función o un argumento.
  useEffect(() => {
    if (!editing || !editing.value.startsWith("=") || assistDismissed) {
      setAssist(null);
      return;
    }
    let cancelled = false;
    sheetApi
      .complete(sheet, editing.cell.r, editing.cell.c, editing.value, caret)
      .then((ctx) => {
        if (cancelled) return;
        let suggestions: FunctionInfo[] = [];
        let signature: Assist["signature"] = null;
        for (const token of ctx.expecting) {
          if (typeof token === "object" && "FunctionName" in token) {
            suggestions = suggestFunctions(token.FunctionName, language);
          } else if (typeof token === "object" && "Argument" in token) {
            const fn = findFunction(token.Argument[0]);
            if (fn) signature = { fn, arg: Math.max(0, token.Argument[1] - 1) };
          }
        }
        // Las posiciones del motor no cuentan el "=" inicial.
        setAssist({
          suggestions,
          selected: 0,
          replaceStart: ctx.replace_from + 1,
          signature,
          value: editing.value,
        });
      })
      .catch(() => !cancelled && setAssist(null));
    return () => {
      cancelled = true;
    };
  }, [editing?.value, caret, language, assistDismissed]); // eslint-disable-line react-hooks/exhaustive-deps

  /** El campo donde se está escribiendo (la celda o la barra de fórmulas). */
  function activeInput(): HTMLInputElement | null {
    return editingRef.current?.source === "bar"
      ? barInputRef.current
      : cellEditorRef.current;
  }

  /** Cambia el texto en edición y deja el cursor en `nextCaret`. */
  function setEditValue(value: string, nextCaret: number) {
    setEditing((prev) => (prev ? { ...prev, value } : prev));
    if (editingRef.current)
      editingRef.current = { ...editingRef.current, value };
    setCaret(nextCaret);
    requestAnimationFrame(() => {
      const el = activeInput();
      if (el && document.activeElement === el)
        el.setSelectionRange(nextCaret, nextCaret);
    });
  }

  function acceptSuggestion(fn: FunctionInfo) {
    const current = editingRef.current;
    if (!current || !assist) return;
    const name = `${fn[language]}(`;
    const value =
      current.value.slice(0, assist.replaceStart) +
      name +
      current.value.slice(caret);
    setEditValue(value, assist.replaceStart + name.length);
    setPointing(null);
  }

  /** Inserta (o cambia) la referencia que se está señalando con el mouse o las flechas. */
  function pointTo(anchor: Cell, focus: Cell) {
    const current = editingRef.current;
    if (!current) return;
    const range = rangeOf(anchor, focus);
    const text =
      range.r1 === range.r2 && range.c1 === range.c2
        ? cellName(anchor)
        : `${cellName({ r: range.r1, c: range.c1 })}:${cellName({ r: range.r2, c: range.c2 })}`;
    const [start, end] = pointing
      ? [pointing.start, pointing.end]
      : [caret, caret];
    const value =
      current.value.slice(0, start) + text + current.value.slice(end);
    setPointing({ start, end: start + text.length, anchor, focus });
    setEditValue(value, start + text.length);
  }

  /** ¿Un clic en una celda debe insertar una referencia en la fórmula en vez de terminar la edición? */
  function wantsReference(): boolean {
    const current = editingRef.current;
    if (!current || !current.value.startsWith("=")) return false;
    return (
      (pointing !== null && caret === pointing.end) ||
      canPointAt(current.value, caret)
    );
  }

  // Al empezar a editar en la celda, el cursor va al final del texto.
  useEffect(() => {
    if (editing?.source === "cell") {
      const el = cellEditorRef.current;
      el?.focus();
      el?.setSelectionRange(el.value.length, el.value.length);
    }
  }, [editing?.source]);

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
      // Una celda combinada se selecciona completa.
      const block = merged.at(target.r, target.c);
      setActive(block ? { r: block.r1, c: block.c1 } : target);
      setEnd(block ? { r: block.r2, c: block.c2 } : target);
    }
    if (target.r < MAX_ROW) rowVirtualizer.scrollToIndex(target.r);
    if (target.c < MAX_COL) colVirtualizer.scrollToIndex(target.c);
  }

  function move(dr: number, dc: number, extend = false) {
    let from = extend ? end : active;
    // Al salir de una celda combinada se parte de su borde.
    const block = !extend && merged.at(active.r, active.c);
    if (block)
      from = {
        r: dr > 0 ? block.r2 : block.r1,
        c: dc > 0 ? block.c2 : block.c1,
      };
    // Saltar filas y columnas ocultas.
    let next = { r: from.r + dr, c: from.c + dc };
    for (let i = 0; i < 1000 && rowAxis.size(next.r) === 0 && dr !== 0; i++)
      next = { ...next, r: next.r + dr };
    for (let i = 0; i < 1000 && colAxis.size(next.c) === 0 && dc !== 0; i++)
      next = { ...next, c: next.c + dc };
    select(next, extend);
  }

  function selectColumns(c1: number, c2: number) {
    setActive({ r: 0, c: c1 });
    setEnd({ r: MAX_ROW, c: c2 });
  }

  function selectRows(r1: number, r2: number) {
    setActive({ r: r1, c: 0 });
    setEnd({ r: r2, c: MAX_COL });
  }

  /** La selección, recortada a la zona con datos (para copiar o borrar columnas enteras). */
  function usedSelection(): Range {
    return wholeCols || wholeRows ? clampToData(rows, selection) : selection;
  }

  // Terminar la selección con el mouse aunque se suelte fuera de la cuadrícula.
  // Con la brocha activa, al soltar se aplica el formato a lo seleccionado.
  const finishSelection = useRef<() => void>(() => {});
  finishSelection.current = () => {
    if (painter && mouseSelecting.current === "cells") applyPainter();
  };
  useEffect(() => {
    const stop = () => {
      finishSelection.current();
      mouseSelecting.current = null;
    };
    window.addEventListener("mouseup", stop);
    return () => window.removeEventListener("mouseup", stop);
  }, []);

  // ───────────── edición ─────────────

  function startEditing(
    value: string,
    quick: boolean,
    source: "cell" | "bar" = "cell",
  ) {
    const next: Editing = {
      value,
      source,
      quick,
      cell: active,
      original: input,
    };
    editingRef.current = next;
    setEditing(next);
    setCaret(value.length);
    setPointing(null);
    setAssistDismissed(false);
  }

  /** Confirma lo que se escribió y opcionalmente se mueve a otra celda. */
  async function commit(dr = 0, dc = 0) {
    const current = editingRef.current;
    if (!current) return;
    editingRef.current = null;
    setEditing(null);
    setPointing(null);
    setAssist(null);
    const target = current.cell;
    if (dr || dc) move(dr, dc);
    focusGrid();
    if (current.value !== current.original) {
      await mutate(() =>
        sheetApi.setCell(sheet, target.r, target.c, current.value),
      );
    }
  }

  function cancelEditing() {
    editingRef.current = null;
    setEditing(null);
    setPointing(null);
    setAssist(null);
    focusGrid();
  }

  function clearSelection() {
    mutate(() => sheetApi.clear(sheet, usedSelection()));
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
    const range = usedSelection();
    const lines: string[] = [];
    for (let r = range.r1; r <= range.r2; r++) {
      const cells: string[] = [];
      for (let c = range.c1; c <= range.c2; c++)
        cells.push(rows[r]?.[c]?.[0] ?? "");
      lines.push(cells.join("\t"));
    }
    return lines.join("\n");
  }

  async function copySelection(cut: boolean, clipboard?: DataTransfer | null) {
    // Desde el menú Edición, el sistema pide el texto en el momento.
    clipboard?.setData("text/plain", selectionText());
    const range = usedSelection();
    try {
      const text = await sheetApi.copy(sheet, range, cut);
      if (!clipboard) await writeText(text);
      setCopied({ range, cut });
      showStatus({ text: cut ? "Cortado: elige dónde pegar" : "Copiado" });
    } catch (e) {
      showStatus({ text: String(e), error: true });
    }
  }

  async function pasteText(text: string | null) {
    if (!text) return;
    const target = active;
    const lines = text.replace(/\n$/, "").split("\n");
    const width = lines.reduce(
      (max, l) => Math.max(max, l.split("\t").length),
      1,
    );
    await mutate(() => sheetApi.paste(sheet, target.r, target.c, text));
    // Selecciona lo pegado: al pegar algo copiado en WEPO, toma el tamaño original.
    const size = copied
      ? {
          r: copied.range.r2 - copied.range.r1,
          c: copied.range.c2 - copied.range.c1,
        }
      : { r: lines.length - 1, c: width - 1 };
    setEnd({ r: target.r + size.r, c: target.c + size.c });
    if (copied?.cut) setCopied(null);
  }

  async function pasteFromSystem() {
    try {
      await pasteText(await readText());
    } catch (e) {
      showStatus({
        text: `No se pudo leer el portapapeles: ${e}`,
        error: true,
      });
    }
  }

  // Si el menú Edición de macOS se adelanta al teclado, llegan estos eventos.
  const clipboardHandlers = useRef({ copySelection, pasteText });
  clipboardHandlers.current = { copySelection, pasteText };
  useEffect(() => {
    // Solo cuando la cuadrícula tiene el foco y no se está escribiendo en una celda.
    const gridFocused = () =>
      document.activeElement === scrollRef.current && !editingRef.current;
    const onCopy = (e: ClipboardEvent) => {
      if (!gridFocused()) return;
      e.preventDefault();
      clipboardHandlers.current.copySelection(
        e.type === "cut",
        e.clipboardData,
      );
    };
    const onPaste = (e: ClipboardEvent) => {
      if (!gridFocused()) return;
      e.preventDefault();
      clipboardHandlers.current.pasteText(
        e.clipboardData?.getData("text/plain") ?? null,
      );
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
    const startSize =
      axis === "col" ? colAxis.size(index) : rowAxis.size(index);
    const startPos = axis === "col" ? e.clientX : e.clientY;
    setResize({ axis, index, startPos, startSize, size: startSize });
  }

  useEffect(() => {
    if (!resize) return;
    const onMove = (e: MouseEvent) => {
      const delta =
        (resize.axis === "col" ? e.clientX : e.clientY) - resize.startPos;
      setResize({
        ...resize,
        size: Math.max(12 * zoom, Math.round(resize.startSize + delta)),
      });
    };
    const onUp = () => {
      const { axis, index, size, startSize } = resize;
      setResize(null);
      if (size === startSize) return;
      // Si la columna (o fila) es parte de la selección, se ajustan todas las seleccionadas.
      const [from, to] =
        axis === "col"
          ? index >= selection.c1 && index <= selection.c2 && wholeCols
            ? [selection.c1, selection.c2]
            : [index, index]
          : index >= selection.r1 && index <= selection.r2 && wholeRows
            ? [selection.r1, selection.r2]
            : [index, index];
      // La guía se arrastra con zoom; al archivo va la medida real.
      const real = Math.max(1, Math.round(size / zoom));
      mutate(() =>
        axis === "col"
          ? sheetApi.columnWidth(sheet, from, to, real)
          : sheetApi.rowHeight(sheet, from, to, real),
      );
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  });

  /** Doble clic en el borde de un encabezado: la columna se ajusta a su texto más largo. */
  function autofitColumn(col: number) {
    let width = 30;
    rows.forEach((row) => {
      const cell = row?.[col];
      if (!cell || !cell[0]) return;
      const style = view.styles[cell[2]] ?? view.styles[0];
      width = Math.max(width, textWidth(cell[0], style) + 16);
    });
    const [from, to] =
      wholeCols && col >= selection.c1 && col <= selection.c2
        ? [selection.c1, selection.c2]
        : [col, col];
    mutate(() =>
      sheetApi.columnWidth(sheet, from, to, Math.min(600, Math.ceil(width))),
    );
  }

  // ───────────── formato condicional y listas ─────────────

  async function addConditionalRule(rule: object | { iconSet: string }) {
    const range = usedSelection();
    return mutate(() =>
      "iconSet" in rule
        ? sheetApi.addIconSet(sheet, range, rule.iconSet)
        : sheetApi.addConditionalRule(sheet, range, rule),
    );
  }

  async function saveValidation(source: ListSource | null, message = "") {
    const range =
      activeValidation && !isMultiSelection
        ? {
            r1: activeValidation.row1 - 1,
            c1: activeValidation.col1 - 1,
            r2: activeValidation.row2 - 1,
            c2: activeValidation.col2 - 1,
          }
        : usedSelection();
    const ok = await mutate(() =>
      sheetApi.setValidation(sheet, range, source, message),
    );
    if (ok)
      showStatus({
        text: source ? "Validación guardada" : "Validación quitada",
      });
    return ok;
  }

  async function pickFromList(value: string) {
    setListOpen(false);
    focusGrid();
    await mutate(() => sheetApi.setCell(sheet, active.r, active.c, value));
  }

  // ───────────── gráficas e imágenes ─────────────

  /** Inserta una gráfica con los datos seleccionados (o la tabla alrededor de la celda). */
  async function insertChart(kind: ChartType) {
    const range = isMultiSelection
      ? usedSelection()
      : currentRegion(rows, active);
    try {
      const { id, view: next } = await sheetApi.addChart(sheet, range, kind);
      setView(next);
      markDirty();
      setSelectedDrawing(id);
      setChartPanel(id);
    } catch (e) {
      showStatus({ text: String(e), error: true });
    }
  }

  async function insertImage() {
    const path = await openDialog({
      multiple: false,
      filters: [
        { name: "Imágenes", extensions: ["png", "jpg", "jpeg", "gif"] },
      ],
    });
    if (!path) return;
    try {
      const x = Math.max(0, Math.round((scrollX + 40) / zoom));
      const y = Math.max(0, Math.round((scrollY + 40) / zoom));
      const { id, view: next } = await sheetApi.addImage(sheet, path, x, y);
      setView(next);
      markDirty();
      setSelectedDrawing(id);
    } catch (e) {
      showStatus({ text: String(e), error: true });
    }
  }

  function updateDrawing(id: number, patch: DrawingPatch) {
    mutate(() => sheetApi.updateDrawing(sheet, id, patch));
  }

  function deleteDrawing(id: number) {
    setSelectedDrawing(null);
    setChartPanel(null);
    mutate(() => sheetApi.deleteDrawing(sheet, id));
    focusGrid();
  }

  // ───────────── autollenado ─────────────

  /** Rango que cubriría el autollenado si se suelta en `to`: crece en una sola dirección. */
  function fillRange(to: Cell): Range {
    const down = to.r - selection.r2;
    const up = selection.r1 - to.r;
    const right = to.c - selection.c2;
    const left = selection.c1 - to.c;
    const vertical = Math.max(down, up);
    const horizontal = Math.max(right, left);
    if (vertical <= 0 && horizontal <= 0) return selection;
    if (vertical >= horizontal) {
      return down > 0 ? { ...selection, r2: to.r } : { ...selection, r1: to.r };
    }
    return right > 0 ? { ...selection, c2: to.c } : { ...selection, c1: to.c };
  }

  async function autofill(target: Range, source: Range = selection) {
    if (
      target.r1 === source.r1 &&
      target.r2 === source.r2 &&
      target.c1 === source.c1 &&
      target.c2 === source.c2
    )
      return;
    const ok = await mutate(() => sheetApi.autofill(sheet, source, target));
    if (ok) {
      setActive({ r: target.r1, c: target.c1 });
      setEnd({ r: target.r2, c: target.c2 });
    }
  }

  /** Doble clic en la esquina: llena hacia abajo hasta donde llegan los datos de la columna vecina. */
  function autofillDown() {
    const neighbor = selection.c1 > 0 ? selection.c1 - 1 : selection.c2 + 1;
    let last = selection.r2;
    while ((rows[last + 1]?.[neighbor]?.[0] ?? "") !== "") last++;
    if (last > selection.r2) autofill({ ...selection, r2: last });
  }

  useEffect(() => {
    if (!fillTo) return;
    const onUp = () => {
      const target = fillRange(fillTo);
      setFillTo(null);
      autofill(target);
    };
    window.addEventListener("mouseup", onUp);
    return () => window.removeEventListener("mouseup", onUp);
  });

  // ───────────── filas, columnas y estructura ─────────────

  const rowSpan = selection.r2 - selection.r1 + 1;
  const colSpan = selection.c2 - selection.c1 + 1;

  function insertRows(below: boolean) {
    const count = wholeRows ? rowSpan : 1;
    mutate(() =>
      sheetApi.insertRows(
        sheet,
        below ? selection.r2 + 1 : selection.r1,
        count,
      ),
    );
  }

  function insertColumns(right: boolean) {
    const count = wholeCols ? colSpan : 1;
    mutate(() =>
      sheetApi.insertColumns(
        sheet,
        right ? selection.c2 + 1 : selection.c1,
        count,
      ),
    );
  }

  function deleteRows() {
    mutate(() => sheetApi.deleteRows(sheet, selection.r1, rowSpan));
  }

  function deleteColumns() {
    mutate(() => sheetApi.deleteColumns(sheet, selection.c1, colSpan));
  }

  function setRowsHidden(hidden: boolean) {
    // Para mostrar, se incluyen las filas vecinas: así se recuperan las ocultas entre ellas.
    const [r1, r2] = hidden
      ? [selection.r1, selection.r2]
      : [Math.max(0, selection.r1 - 1), selection.r2 + 1];
    mutate(() => sheetApi.hideRows(sheet, r1, r2, hidden));
  }

  function setColumnsHidden(hidden: boolean) {
    const [c1, c2] = hidden
      ? [selection.c1, selection.c2]
      : [Math.max(0, selection.c1 - 1), selection.c2 + 1];
    mutate(() => sheetApi.hideColumns(sheet, c1, c2, hidden));
  }

  const activeMerged = merged.at(active.r, active.c);

  function toggleMerge() {
    if (activeMerged) mutate(() => sheetApi.merge(sheet, activeMerged, false));
    else mutate(() => sheetApi.merge(sheet, usedSelection(), true));
  }

  function freezeAtSelection(rowsToo = true, colsToo = true) {
    mutate(() =>
      sheetApi.freeze(sheet, rowsToo ? active.r : 0, colsToo ? active.c : 0),
    );
  }

  function unfreeze() {
    mutate(() => sheetApi.freeze(sheet, 0, 0));
  }

  // ───────────── ordenar y filtrar ─────────────

  /** Tabla sobre la que se ordena o filtra: la selección, o la región alrededor de la celda. */
  function dataRegion(col: number): Range {
    // Dentro de una tabla, la tabla (sin su fila de totales).
    const table = tableAt(view.tables ?? [], active.r, col);
    if (table) return tableRegion(table);
    if (isMultiSelection && !wholeCols && !wholeRows) return selection;
    const start = wholeCols
      ? { r: firstDataRow(col), c: col }
      : { r: active.r, c: col };
    return currentRegion(rows, start);
  }

  function firstDataRow(col: number): number {
    const r = rows.findIndex((row) => (row?.[col]?.[0] ?? "") !== "");
    return r === -1 ? 0 : r;
  }

  async function sortBy(col: number, ascending: boolean) {
    const region = dataRegion(col);
    if (region.r2 <= region.r1)
      return showStatus({ text: "No hay datos para ordenar aquí" });
    const header = looksLikeHeader(rows, region);
    const ok = await mutate(() =>
      sheetApi.sort(sheet, region, [{ col, ascending }], header),
    );
    if (ok)
      showStatus({
        text: `Ordenado por la columna ${columnName(col)} ${ascending ? "(A → Z)" : "(Z → A)"}`,
      });
  }

  /** Ordenar por varias columnas: abre el diálogo sobre la tabla de la celda activa. */
  function openSortDialog() {
    const region = dataRegion(active.c);
    if (region.r2 <= region.r1)
      return showStatus({ text: "No hay datos para ordenar aquí" });
    setSortDialog(region);
  }

  async function sortByLevels(
    region: Range,
    levels: SortLevel[],
    header: boolean,
  ) {
    const ok = await mutate(() => sheetApi.sort(sheet, region, levels, header));
    if (ok)
      showStatus({
        text: `Ordenado por ${levels.map((l) => columnName(l.col)).join(", luego ")}`,
      });
  }

  function openFilter(col: number, x: number, y: number, tableRange?: Range) {
    const region =
      tableRange ??
      (filter && col >= filter.region.c1 && col <= filter.region.c2
        ? filter.region
        : dataRegion(col));
    if (region.r2 <= region.r1)
      return showStatus({
        text: "Pon el cursor dentro de una tabla con encabezados para filtrar",
      });
    setFilterMenu({ x, y, col, region });
  }

  /**
   * Valores que se pueden elegir en el filtro de `col`: los de las filas que pasan
   * los filtros de las demás columnas (como en Excel, los filtros se combinan).
   */
  function filterValues(region: Range, col: number): string[] {
    const others = Object.entries(filter?.cols ?? {}).filter(
      ([c]) => Number(c) !== col,
    );
    const values = new Set<string>();
    for (let r = region.r1 + 1; r <= region.r2; r++) {
      if (
        others.some(
          ([c, spec]) => !passes(spec, rows[r]?.[Number(c)]?.[0] ?? ""),
        )
      )
        continue;
      values.add(rows[r]?.[col]?.[0] ?? "");
    }
    return [...values].sort((a, b) =>
      a.localeCompare(b, "es", { numeric: true }),
    );
  }

  /** Cambia el filtro de una columna (`null` lo quita) y aplica todos juntos. */
  async function applyFilter(
    region: Range,
    col: number,
    spec: ColumnSpec | null,
  ) {
    const sameTable =
      filter &&
      filter.region.r1 === region.r1 &&
      filter.region.c1 === region.c1;
    const cols = { ...(sameTable ? filter.cols : {}) };
    if (spec) cols[col] = spec;
    else delete cols[col];
    const list = Object.entries(cols).map(([c, spec]) => ({
      col: Number(c),
      ...spec,
    }));
    const ok = await mutate(() => sheetApi.filter(sheet, region, list));
    if (ok) setFilter(list.length ? { region, cols } : null);
  }

  function clearAllFilters() {
    if (!filter) return;
    const region = filter.region;
    mutate(() => sheetApi.filter(sheet, region, [])).then(
      (ok) => ok && setFilter(null),
    );
  }

  // ───────────── tablas, funciones y duplicados ─────────────

  const tables = view.tables ?? [];
  const activeTable = tableAt(tables, active.r, active.c);

  /** Dar formato como tabla (o abrir las opciones de la tabla de la celda activa). */
  function openTableDialog() {
    if (activeTable)
      return setTableDialog({
        range: tableRegion(activeTable),
        table: activeTable,
      });
    const range =
      isMultiSelection && !wholeCols && !wholeRows
        ? selection
        : currentRegion(rows, active);
    if (range.r2 <= range.r1)
      return showStatus({
        text: "Selecciona los encabezados y los datos de la tabla",
        error: true,
      });
    setTableDialog({ range, table: null });
  }

  async function saveTable(
    style: TableStyle,
    banded: boolean,
    totals: boolean,
  ) {
    if (!tableDialog) return;
    const { range, table } = tableDialog;
    const ok = table
      ? await mutate(() =>
          sheetApi.updateTable(sheet, table.name, style, banded, totals),
        )
      : await mutate(() =>
          sheetApi.createTable(sheet, range, style, banded, totals),
        );
    if (ok)
      showStatus({
        text: table
          ? "Tabla actualizada"
          : "Tabla creada: usa las flechas de los encabezados para filtrar",
      });
  }

  function removeTable() {
    const table = tableDialog?.table;
    setTableDialog(null);
    if (table)
      mutate(() =>
        sheetApi.updateTable(
          sheet,
          table.name,
          table.style,
          table.banded,
          table.totals,
          true,
        ),
      );
  }

  /** Inserta la función elegida en la fórmula que se escribe, o empieza una en la celda activa. */
  function insertFunction(fn: FunctionInfo) {
    setFnDialog(false);
    const name = `${fn[language]}(`;
    const current = editingRef.current;
    if (current) {
      // En una celda vacía la fórmula empieza con "=".
      const before = current.value.slice(0, caret) || "=";
      setEditValue(
        before + name + current.value.slice(caret),
        before.length + name.length,
      );
      requestAnimationFrame(() => activeInput()?.focus());
      return;
    }
    startEditing(`=${name}`, false);
  }

  function openDuplicates() {
    const region = dataRegion(active.c);
    if (region.r2 <= region.r1)
      return showStatus({
        text: "Pon el cursor dentro de una tabla de datos",
        error: true,
      });
    setDupDialog(region);
  }

  async function removeDuplicates(
    region: Range,
    cols: number[],
    header: boolean,
  ) {
    try {
      const { removed, view: next } = await sheetApi.removeDuplicates(
        sheet,
        region,
        cols,
        header,
      );
      setView(next);
      if (removed) markDirty();
      showStatus({
        text: removed
          ? `Se quitaron ${removed} ${removed === 1 ? "fila repetida" : "filas repetidas"}`
          : "No hay filas repetidas",
      });
    } catch (e) {
      showStatus({ text: String(e), error: true });
    }
  }

  // ───────────── pegado especial y copiar formato ─────────────

  async function pasteSpecial(mode: PasteMode) {
    if (!copied) {
      // Lo copiado viene de otra app: el texto ya son solo valores.
      if (mode === "values") return pasteFromSystem();
      return showStatus({
        text: "Primero copia algo dentro de WEPO",
        error: true,
      });
    }
    const target = active;
    const ok = await mutate(() =>
      sheetApi.pasteSpecial(sheet, target.r, target.c, mode),
    );
    if (!ok) return;
    const h = copied.range.r2 - copied.range.r1;
    const w = copied.range.c2 - copied.range.c1;
    setEnd(
      mode === "transpose"
        ? { r: target.r + w, c: target.c + h }
        : { r: target.r + h, c: target.c + w },
    );
    showStatus({
      text: {
        values: "Pegados solo los valores",
        formats: "Pegado solo el formato",
        transpose: "Pegado transpuesto",
      }[mode],
    });
  }

  /** Brocha: un clic la usa una vez; doble clic la deja activa hasta Esc. */
  function startPainter(sticky: boolean) {
    if (painter && !sticky) {
      setPainter(null);
      return;
    }
    setPainter({ source: usedSelection(), sticky });
    showStatus({
      text: sticky
        ? "Copiar formato: selecciona las celdas (Esc para terminar)"
        : "Copiar formato: selecciona dónde aplicarlo",
    });
    focusGrid();
  }

  function applyPainter() {
    if (!painter) return;
    const target = selection;
    mutate(() => sheetApi.pasteFormat(sheet, painter.source, target));
    if (!painter.sticky) setPainter(null);
  }

  // ───────────── notas y vínculos ─────────────

  function anchorOf(cell: Cell): Cell {
    const m = merged.at(cell.r, cell.c);
    return m ? { r: m.r1, c: m.c1 } : cell;
  }

  // La nota aparece al dejar el mouse un momento sobre la celda, como en Excel.
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function showNoteSoon(cell: NoteTarget | null) {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    if (!cell) {
      hoverTimer.current = setTimeout(() => setHoverNote(null), 150);
      return;
    }
    if (mouseSelecting.current) return;
    hoverTimer.current = setTimeout(() => setHoverNote(cell), 350);
  }

  function editNote(cell: Cell = active) {
    const at = anchorOf(cell);
    setHoverNote(null);
    setNoteEdit({ ...at, text: notes.get(`${at.r},${at.c}`)?.text ?? "" });
  }

  async function saveNote(text: string) {
    if (!noteEdit) return;
    const { r, c } = noteEdit;
    const before = notes.get(`${r},${c}`)?.text ?? "";
    setNoteEdit(null);
    focusGrid();
    if (text.trim() === before.trim()) return;
    await mutate(() => sheetApi.setNote(sheet, r, c, text));
  }

  function deleteNote(cell: Cell = active) {
    const at = anchorOf(cell);
    mutate(() => sheetApi.setNote(sheet, at.r, at.c, ""));
  }

  /** Abre un vínculo: una página o correo en el navegador, o una celda de este libro. */
  async function openLink(link: LinkView) {
    if (!link.internal) {
      try {
        await openUrl(link.target);
      } catch (e) {
        showStatus({ text: `No se pudo abrir el vínculo: ${e}`, error: true });
      }
      return;
    }
    const match = /^(?:'?([^'!]+)'?!)?\$?([A-Za-z]{1,3})\$?(\d+)/.exec(
      link.target.replace(/^#/, ""),
    );
    if (!match)
      return showStatus({
        text: `No se encontró «${link.target}» en el libro`,
        error: true,
      });
    const [, sheetName, letters, digits] = match;
    const col =
      [...letters.toUpperCase()].reduce(
        (n, ch) => n * 26 + ch.charCodeAt(0) - 64,
        0,
      ) - 1;
    const cell = { r: Number(digits) - 1, c: col };
    const index = sheetName ? view.sheet_names.indexOf(sheetName) : sheet;
    if (index === -1)
      return showStatus({
        text: `No existe la hoja «${sheetName}»`,
        error: true,
      });
    await goToMatch({ sheet: index, row: cell.r, col: cell.c });
  }

  async function saveLink(target: string, text: string) {
    if (!linkDialog) return false;
    const { r, c } = linkDialog;
    const current = rows[r]?.[c]?.[0] ?? "";
    // El texto solo se cambia si se escribió otro; una celda vacía muestra la dirección.
    const label =
      text.trim() && text !== current ? text : current ? undefined : target;
    return mutate(() => sheetApi.setLink(sheet, r, c, target, label));
  }

  function removeLink(cell: Cell = active) {
    const at = anchorOf(cell);
    setLinkDialog(null);
    mutate(() => sheetApi.setLink(sheet, at.r, at.c, null));
  }

  // ───────────── barra de estado ─────────────

  // Suma, promedio y recuento de la selección (como en Excel), sin frenar al seleccionar.
  const statsRange =
    isMultiSelectionRange(selection) && !editing ? usedSelection() : null;
  const statsKey = statsRange
    ? `${sheet}:${statsRange.r1},${statsRange.c1},${statsRange.r2},${statsRange.c2}`
    : "";
  useEffect(() => {
    if (!statsRange) {
      setStats(null);
      return;
    }
    const timer = setTimeout(() => {
      sheetApi.stats(sheet, statsRange).then(setStats, () => setStats(null));
    }, 120);
    return () => clearTimeout(timer);
  }, [statsKey, view]); // eslint-disable-line react-hooks/exhaustive-deps

  // ───────────── buscar y reemplazar ─────────────

  async function goToMatch(match: FindMatch) {
    if (match.sheet !== sheet) {
      setActive({ r: match.row, c: match.col });
      setEnd({ r: match.row, c: match.col });
      await run(() => sheetApi.view(match.sheet));
      requestAnimationFrame(() => select({ r: match.row, c: match.col }));
      return;
    }
    select({ r: match.row, c: match.col });
  }

  async function replaceAll(
    query: string,
    replacement: string,
    options: FindOptions,
  ) {
    try {
      const { count, view: next } = await sheetApi.replaceAll(
        sheet,
        query,
        replacement,
        options,
      );
      setView(next);
      if (count) markDirty();
      return count;
    } catch (e) {
      showStatus({ text: String(e), error: true });
      return 0;
    }
  }

  // ───────────── hojas ─────────────

  function resetSelection() {
    setActive({ r: 0, c: 0 });
    setEnd({ r: 0, c: 0 });
    setFilter(null);
    scrollRef.current?.scrollTo(0, 0);
  }

  function switchSheet(index: number) {
    if (index === sheet) return;
    resetSelection();
    run(() => sheetApi.view(index));
  }

  function addSheet() {
    resetSelection();
    mutate(() => sheetApi.addSheet());
  }

  // ───────────── guardar ─────────────

  async function saveTo(target: string, quiet = false) {
    const saving = changes;
    await sheetApi.save(target, sheet);
    setPath(target);
    setFileName(fileNameOf(target));
    savedAt.current = saving;
    // Si hubo cambios mientras se guardaba, siguen pendientes.
    if (changesRef.current === saving) {
      setDirty(false);
      onDirtyChange(false);
      recoveryApi.clear();
    }
    onSaved(target);
    const csvNote =
      extensionOf(target) === "csv" && view.sheet_names.length > 1
        ? " (el CSV solo contiene la hoja actual)"
        : "";
    if (!quiet || csvNote) showStatus({ text: `Guardado${csvNote}` });
  }

  /** ¿Se puede escribir directamente sobre el archivo abierto? (.xls u .ods se guardan como copia) */
  function canOverwrite(target: string | null): target is string {
    const ext = target ? extensionOf(target) : "";
    return (
      Boolean(target) &&
      target !== protectedPath &&
      (ext === "xlsx" || ext === "csv")
    );
  }

  /** Guarda; devuelve la ruta donde quedó (o null si se canceló o falló). */
  async function saveDocument(saveAs = false): Promise<string | null> {
    await commit();
    // Solo se sobrescribe directamente lo que sabemos escribir; .xls u .ods
    // se guardan como un archivo nuevo para no dañar el original. Lo mismo un
    // archivo con gráficas o imágenes, que se perderían al guardarlo.
    if (!saveAs && canOverwrite(path)) {
      return (await run(() => saveTo(path))) ? path : null;
    }
    const base =
      (fileName.replace(/\.[^.]+$/, "") || "Sin título") +
      (protectedPath && path === protectedPath ? " (copia)" : "");
    const target = await save({
      defaultPath: `${base}.xlsx`,
      filters: [
        { name: "Libro de Excel (.xlsx)", extensions: ["xlsx"] },
        { name: "CSV (.csv)", extensions: ["csv"] },
      ],
    });
    if (!target) return null;
    const finalPath = /\.(xlsx|csv)$/i.test(target) ? target : `${target}.xlsx`;
    if (finalPath === protectedPath) {
      showStatus({
        text: "Elige otro nombre: así no se pierden las gráficas del original.",
        error: true,
      });
      return null;
    }
    return (await run(() => saveTo(finalPath))) ? finalPath : null;
  }

  // ───────────── autoguardado y recuperación ─────────────

  useEffect(() => {
    if (props.recovered)
      showStatus({
        text:
          props.notice ??
          "Documento recuperado: guárdalo para conservar los cambios",
      });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const changesRef = useRef(changes);
  changesRef.current = changes;
  /** Hasta qué cambio está guardado en el archivo, y hasta cuál en la copia de recuperación. */
  const savedAt = useRef(0);
  const recoveredAt = useRef(-1);

  // Autoguardado: con el interruptor encendido, se guarda solo un par de segundos después de cada cambio.
  useEffect(() => {
    if (!autosave || !dirty || !canOverwrite(path) || editing) return;
    const timer = setTimeout(() => {
      run(() => saveTo(path, true)).then((ok) => ok || setAutosave(false));
    }, 1500);
    return () => clearTimeout(timer);
  }, [autosave, dirty, changes, path, editing]); // eslint-disable-line react-hooks/exhaustive-deps

  // Copia de recuperación cada 20 segundos mientras haya cambios sin guardar.
  const recoveryState = useRef({ dirty, fileName, path });
  recoveryState.current = { dirty, fileName, path };
  useEffect(() => {
    const timer = setInterval(() => {
      const { dirty, fileName, path } = recoveryState.current;
      if (!dirty || recoveredAt.current === changesRef.current) return;
      recoveredAt.current = changesRef.current;
      recoveryApi.save(fileName, path);
    }, 20000);
    return () => clearInterval(timer);
  }, []);

  async function toggleAutosave() {
    const next = !autosave;
    if (next && !canOverwrite(path)) {
      // Como en Excel: para autoguardar, primero el archivo necesita un lugar.
      showStatus({
        text: "Elige dónde guardar el archivo para activar el autoguardado",
      });
      if (!(await saveDocument(true))) return;
    }
    setAutosave(next);
    try {
      localStorage.setItem(AUTOSAVE_KEY, next ? "1" : "0");
    } catch {
      // Sin almacenamiento la preferencia no se recuerda.
    }
    showStatus({
      text: next
        ? "Autoguardado activado: cada cambio se guarda solo"
        : "Autoguardado desactivado",
    });
  }

  // ───────────── zoom ─────────────

  /**
   * Punto que debe quedarse quieto al cambiar el zoom (el del puntero o el centro):
   * su posición en la hoja sin zoom (`x`, `y`) y en la pantalla (`px`, `py`).
   */
  const zoomAnchor = useRef<{
    x: number;
    y: number;
    px: number;
    py: number;
    zoom: number;
  } | null>(null);

  function setZoom(next: number, anchor?: { x: number; y: number }) {
    const value = clampZoom(next);
    if (value === zoom) return;
    const el = scrollRef.current;
    if (el) {
      const box = el.getBoundingClientRect();
      const px = Math.max(
        0,
        (anchor?.x ?? box.left + box.width / 2) - box.left - HEADER_WIDTH,
      );
      const py = Math.max(
        0,
        (anchor?.y ?? box.top + box.height / 2) - box.top - HEADER_HEIGHT,
      );
      zoomAnchor.current = {
        x: (el.scrollLeft + px) / zoom,
        y: (el.scrollTop + py) / zoom,
        px,
        py,
        zoom: value,
      };
    }
    setZoomState(value);
    saveZoom(path, value);
  }

  // Después de redibujar con el zoom nuevo, se desplaza para que el punto quede donde estaba.
  useLayoutEffect(() => {
    const anchor = zoomAnchor.current;
    const el = scrollRef.current;
    if (!anchor || !el || anchor.zoom !== zoom) return;
    zoomAnchor.current = null;
    colVirtualizer.measure();
    rowVirtualizer.measure();
    el.scrollLeft = Math.max(0, anchor.x * zoom - anchor.px);
    el.scrollTop = Math.max(0, anchor.y * zoom - anchor.py);
  }, [zoom]); // eslint-disable-line react-hooks/exhaustive-deps

  // Al arrastrar sobre las celdas no se selecciona su texto (solo las celdas).
  // El CSS ya lo pide, pero WebKit a veces lo ignora al arrastrar desde fuera de una celda.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onSelectStart = (e: Event) => {
      const target = e.target as HTMLElement | null;
      if (!target?.closest?.("input, textarea")) e.preventDefault();
    };
    el.addEventListener("selectstart", onSelectStart);
    return () => el.removeEventListener("selectstart", onSelectStart);
  }, []);

  // Pellizcar en el trackpad, o ⌃ + rueda del mouse.
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const setZoomRef = useRef(setZoom);
  setZoomRef.current = setZoom;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Chrome y Windows mandan el pellizco como rueda con ctrlKey.
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setZoomRef.current(zoomRef.current * Math.exp(-e.deltaY * 0.01), {
        x: e.clientX,
        y: e.clientY,
      });
    };
    // Safari y WebKit (la app en Mac) lo mandan como gesto.
    let start = 1;
    type Gesture = Event & { scale: number; clientX: number; clientY: number };
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      start = zoomRef.current;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const g = e as Gesture;
      setZoomRef.current(start * g.scale, { x: g.clientX, y: g.clientY });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("gesturestart", onGestureStart);
    el.addEventListener("gesturechange", onGestureChange);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("gesturestart", onGestureStart);
      el.removeEventListener("gesturechange", onGestureChange);
    };
  }, []);

  // ───────────── imprimir ─────────────

  /** Lo que se imprime con cada opción (para la vista previa y para imprimir). */
  function printRangeFor(
    area: PrintOptions["area"],
    printArea: string,
  ): Range | null {
    if (area === "selection") return clampToData(rows, selection);
    if (area === "saved" && printArea.trim()) return parseRange(printArea);
    return usedRange(view, baseCols, baseRows);
  }

  /** Las imágenes de la hoja, ya cargadas, para que estén en el papel. */
  async function loadPrintImages(): Promise<Record<number, string>> {
    const images: Record<number, string> = {};
    await Promise.all(
      view.drawings
        .filter((d) => d.type === "image")
        .map((d) =>
          sheetApi
            .imageData(d.id)
            .then((url) => (images[d.id] = url))
            .catch(() => {}),
        ),
    );
    return images;
  }

  async function startPrint(
    options: PrintOptions,
    form: PageForm,
    toPdf = false,
  ) {
    setDialog(null);
    // Como en Excel: después de imprimir quedan marcados los cortes de página.
    setShowBreaks(true);
    setPrintJob(null);
    setPrintInitial(null);
    pdfTarget.current = null;
    if (toPdf) {
      const target = await askPdfPath(path, fileName);
      if (!target) return focusGrid();
      pdfTarget.current = target;
    }
    await commit();
    // La configuración de página se guarda en el archivo (si cambió).
    let page = view.page;
    const before = pageForm(page);
    if (JSON.stringify(before) !== JSON.stringify(form)) {
      try {
        const next = await sheetApi.pageSetup(
          sheet,
          form.header,
          form.footer,
          form.repeatRows,
          form.printArea,
        );
        setView(next);
        markDirty();
        page = next.page;
      } catch (e) {
        showStatus({ text: String(e), error: true });
        return;
      }
    }
    const range = printRangeFor(options.area, form.printArea);
    if (!range) {
      showStatus({
        text: "No hay nada que imprimir con esas opciones.",
        error: true,
      });
      return;
    }
    const images = await loadPrintImages();
    const sheetName = view.sheet_names[sheet] ?? "";
    setPrintJob({
      ...options,
      range,
      images,
      header: fillPageFields(page.header, fileName, sheetName),
      footer: fillPageFields(page.footer, fileName, sheetName),
      repeat: page.repeat_rows
        ? [page.repeat_rows[0] - 1, page.repeat_rows[1] - 1]
        : null,
      breaks: { rows: page.row_breaks ?? [], cols: page.col_breaks ?? [] },
    });
  }

  /** "Seleccionar en la hoja…": se esconde el diálogo y se elige el área con el mouse. */
  const [printInitial, setPrintInitial] = useState<{
    options: PrintOptions;
    form: PageForm;
  } | null>(null);
  const [pickingArea, setPickingArea] = useState<{
    options: PrintOptions;
    form: PageForm;
  } | null>(null);
  function finishPicking(ok: boolean) {
    if (!pickingArea) return;
    const area = clampToData(rows, selection);
    const label = `${cellName({ r: area.r1, c: area.c1 })}:${cellName({ r: area.r2, c: area.c2 })}`;
    setPrintInitial(
      ok
        ? {
            options: { ...pickingArea.options, area: "saved" },
            form: { ...pickingArea.form, printArea: label },
          }
        : pickingArea,
    );
    setPickingArea(null);
    setDialog("print");
  }

  /** Área de impresión desde el menú de la celda (se guarda con el archivo). */
  function setPrintArea(clear: boolean) {
    const form = pageForm(view.page);
    const area = clampToData(rows, selection);
    const text = clear
      ? ""
      : `${cellName({ r: area.r1, c: area.c1 })}:${cellName({ r: area.r2, c: area.c2 })}`;
    mutate(() =>
      sheetApi.pageSetup(
        sheet,
        form.header,
        form.footer,
        form.repeatRows,
        text,
      ),
    );
    showStatus({
      text: clear
        ? "Se quitó el área de impresión"
        : `Área de impresión: ${text}`,
    });
  }

  // Cuando la hoja para imprimir ya está dibujada, se abre el diálogo del sistema
  // o, con "Exportar PDF", se guarda directo.
  useEffect(() => {
    if (!printJob) return;
    const target = pdfTarget.current;
    if (target) {
      let cancelled = false;
      (async () => {
        await printReady();
        if (cancelled) return;
        try {
          // Cada página ya trae su margen: la hoja del PDF es del tamaño del papel, sin margen.
          const size = pageSize(printJob);
          const name = await writePdf(target, {
            width: (size.width * 72) / 96,
            height: (size.height * 72) / 96,
            margin: 0,
          });
          showStatus({ text: `PDF guardado: ${name}` });
        } catch (e) {
          showStatus({ text: `No se pudo exportar el PDF: ${e}`, error: true });
        } finally {
          pdfTarget.current = null;
          setPrintJob(null);
        }
      })();
      return () => {
        cancelled = true;
      };
    }
    const frame = requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        invoke("print_window").catch(() => window.print());
      }),
    );
    return () => cancelAnimationFrame(frame);
  }, [printJob]); // eslint-disable-line react-hooks/exhaustive-deps

  // Terminada la impresión, la versión para imprimir ya no hace falta.
  useEffect(() => {
    const done = () => setPrintJob(null);
    window.addEventListener("afterprint", done);
    return () => window.removeEventListener("afterprint", done);
  }, []);

  // Órdenes que llegan del menú de la app o de los atajos (⌘S, ⌘⇧S, ⌘F, ⌘P).
  const commands = useRef({
    saveDocument,
    setFindOpen,
    setDialog,
    setPdfDialog,
    setZoom,
    zoom,
  });
  commands.current = {
    saveDocument,
    setFindOpen,
    setDialog,
    setPdfDialog,
    setZoom,
    zoom,
  };
  useEffect(() => {
    const stop = onCommand((command) => {
      const c = commands.current;
      if (command === "save") c.saveDocument(false);
      else if (command === "save-as") c.saveDocument(true);
      else if (command === "find") c.setFindOpen(true);
      else if (command === "print")
        (c.setPdfDialog(false), c.setDialog("print"));
      else if (command === "export-pdf")
        (c.setPdfDialog(true), c.setDialog("print"));
      else if (command === "zoom-in") c.setZoom(stepZoom(c.zoom, 1));
      else if (command === "zoom-out") c.setZoom(stepZoom(c.zoom, -1));
      else if (command === "zoom-reset") c.setZoom(1);
    });
    function onKey(e: globalThis.KeyboardEvent) {
      if (!hasModifier(e)) return;
      const key = e.key.toLowerCase();
      const command =
        key === "s"
          ? e.shiftKey
            ? "save-as"
            : "save"
          : key === "f"
            ? "find"
            : key === "p"
              ? "print"
              : key === "=" || key === "+"
                ? "zoom-in"
                : key === "-"
                  ? "zoom-out"
                  : key === "0"
                    ? "zoom-reset"
                    : null;
      if (command) {
        e.preventDefault();
        runCommand(command);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => {
      stop();
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  // ───────────── teclado ─────────────

  function onGridKeyDown(e: KeyboardEvent) {
    if (editing) return;
    const extend = e.shiftKey;

    // Con una gráfica o imagen seleccionada: borrar, soltar o moverla con las flechas.
    if (selectedDrawing !== null && !e.metaKey && !e.ctrlKey) {
      const d = view.drawings.find((x) => x.id === selectedDrawing);
      const nudge: Record<string, [number, number]> = {
        ArrowUp: [0, -1],
        ArrowDown: [0, 1],
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
      };
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        return deleteDrawing(selectedDrawing);
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setChartPanel(null);
        return setSelectedDrawing(null);
      }
      if (d && nudge[e.key]) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const [dx, dy] = nudge[e.key];
        // Solo se manda el eje que cambia, para que dos flechas seguidas no se pisen.
        return updateDrawing(
          d.id,
          dx
            ? { x: Math.max(0, d.x + dx * step) }
            : { y: Math.max(0, d.y + dy * step) },
        );
      }
    }

    if (e.metaKey || e.ctrlKey) {
      const key = e.key.toLowerCase();
      const shortcuts: Record<string, () => void> = {
        z: () => (e.shiftKey ? redo() : undo()),
        y: redo,
        c: () => copySelection(false),
        x: () => copySelection(true),
        // ⌘⇧V: pegar solo los valores, como en Google Sheets.
        v: () => (e.shiftKey ? pasteSpecial("values") : pasteFromSystem()),
        k: () => setLinkDialog(anchorOf(active)),
        b: () => applyStyle("font.b", String(!activeStyle.b)),
        i: () => applyStyle("font.i", String(!activeStyle.i)),
        u: () => applyStyle("font.u", String(!activeStyle.u)),
        // ⌘D: copia la primera fila de la selección hacia abajo, como en Excel.
        d: () =>
          selection.r2 > selection.r1 &&
          autofill(selection, { ...selection, r2: selection.r1 }),
        a: () => {
          const region = currentRegion(rows, active);
          setActive({ r: region.r1, c: region.c1 });
          setEnd({ r: region.r2, c: region.c2 });
        },
      };
      if (shortcuts[key]) {
        e.preventDefault();
        shortcuts[key]();
      }
      return;
    }

    // Alt + ↓ abre la lista desplegable de la celda, como en Excel.
    if (
      e.altKey &&
      e.key === "ArrowDown" &&
      activeValidation &&
      activeValidation.items.length
    ) {
      e.preventDefault();
      return setListOpen(true);
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
        // ⇧F2: nota de la celda, como en Excel.
        if (e.shiftKey) return editNote();
        return startEditing(input, false);
      case "Escape":
        if (painter) {
          setPainter(null);
          return showStatus({ text: "Copiar formato cancelado" });
        }
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
    // Sugerencias viejas (de antes de la última tecla) no cuentan: Enter guarda la fórmula como está.
    const suggestions =
      assist && assist.value === editingRef.current?.value
        ? assist.suggestions
        : [];

    // Lista de funciones sugeridas abierta: las flechas eligen, Tab o Enter insertan.
    if (suggestions.length && !assistDismissed) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setAssist({
          ...assist!,
          selected:
            (assist!.selected + step + suggestions.length) % suggestions.length,
        });
        return;
      }
      if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        return acceptSuggestion(suggestions[assist!.selected]);
      }
      if (e.key === "Escape") {
        e.preventDefault();
        return setAssistDismissed(true);
      }
    }

    // F4: alterna referencias relativas y absolutas ($A$1).
    if (e.key === "F4" && editing) {
      e.preventDefault();
      const next = cycleReference(editing.value, caret);
      if (next) setEditValue(next.value, next.caret);
      return;
    }

    // Con las flechas también se señalan celdas, como en Excel, si la fórmula espera una referencia.
    const arrows: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    };
    if (arrows[e.key] && quick && wantsReference()) {
      e.preventDefault();
      const [dr, dc] = arrows[e.key];
      const from = pointing
        ? e.shiftKey
          ? pointing.focus
          : pointing.anchor
        : editing!.cell;
      const next = clamp({ r: from.r + dr, c: from.c + dc });
      if (e.shiftKey && pointing) pointTo(pointing.anchor, next);
      else pointTo(next, next);
      return;
    }

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

  // ───────────── menús de clic derecho ─────────────

  function openMenu(e: ReactMouseEvent, kind: Menu["kind"], cell: Cell) {
    e.preventDefault();
    // En un encabezado solo cuenta como "dentro" si ya hay columnas (o filas) completas seleccionadas.
    const inside =
      kind === "col"
        ? wholeCols && cell.c >= selection.c1 && cell.c <= selection.c2
        : kind === "row"
          ? wholeRows && cell.r >= selection.r1 && cell.r <= selection.r2
          : cell.r >= selection.r1 &&
            cell.r <= selection.r2 &&
            cell.c >= selection.c1 &&
            cell.c <= selection.c2;
    // Clic derecho fuera de la selección: primero se selecciona lo que está bajo el mouse.
    if (!inside) {
      if (kind === "col") selectColumns(cell.c, cell.c);
      else if (kind === "row") selectRows(cell.r, cell.r);
      else select(cell);
    }
    setMenu({ x: e.clientX, y: e.clientY, kind });
  }

  function plural(n: number, one: string, many: string) {
    return n === 1 ? one : `${n} ${many}`;
  }

  function menuItems(kind: Menu["kind"]): MenuItem[] {
    const clipboard: MenuItem[] = [
      {
        label: "Cortar",
        shortcut: keys("⌘X"),
        action: () => copySelection(true),
      },
      {
        label: "Copiar",
        shortcut: keys("⌘C"),
        action: () => copySelection(false),
      },
      { label: "Pegar", shortcut: keys("⌘V"), action: pasteFromSystem },
      {
        label: "Pegar solo valores",
        shortcut: keys("⌘⇧V"),
        action: () => pasteSpecial("values"),
      },
      {
        label: "Pegar solo formato",
        disabled: !copied,
        action: () => pasteSpecial("formats"),
      },
      {
        label: "Pegar transpuesto",
        disabled: !copied,
        action: () => pasteSpecial("transpose"),
      },
    ];
    const anchor = anchorOf(active);
    const activeNote = notes.get(`${anchor.r},${anchor.c}`);
    const activeLink = links.get(`${anchor.r},${anchor.c}`);
    const noteItems: MenuItem[] = activeNote
      ? [
          { label: "Editar nota", shortcut: "⇧F2", action: () => editNote() },
          { label: "Eliminar nota", action: () => deleteNote() },
        ]
      : [{ label: "Insertar nota", shortcut: "⇧F2", action: () => editNote() }];
    const linkItems: MenuItem[] = activeLink
      ? [
          { label: "Abrir vínculo", action: () => openLink(activeLink) },
          {
            label: "Editar vínculo…",
            shortcut: keys("⌘K"),
            disabled: activeLink.dynamic,
            action: () => setLinkDialog(anchor),
          },
          {
            label: "Quitar vínculo",
            disabled: activeLink.dynamic,
            action: () => removeLink(),
          },
        ]
      : [
          {
            label: "Insertar vínculo…",
            shortcut: keys("⌘K"),
            action: () => setLinkDialog(anchor),
          },
        ];
    const rowsCount = wholeRows ? rowSpan : 1;
    const colsCount = wholeCols ? colSpan : 1;
    const rowItems: MenuItem[] = [
      {
        label: `Insertar ${plural(rowsCount, "fila", "filas")} arriba`,
        action: () => insertRows(false),
      },
      {
        label: `Insertar ${plural(rowsCount, "fila", "filas")} abajo`,
        action: () => insertRows(true),
      },
      {
        label: `Eliminar ${plural(rowSpan, "fila", "filas")}`,
        action: deleteRows,
      },
    ];
    const colItems: MenuItem[] = [
      {
        label: `Insertar ${plural(colsCount, "columna", "columnas")} a la izquierda`,
        action: () => insertColumns(false),
      },
      {
        label: `Insertar ${plural(colsCount, "columna", "columnas")} a la derecha`,
        action: () => insertColumns(true),
      },
      {
        label: `Eliminar ${plural(colSpan, "columna", "columnas")}`,
        action: deleteColumns,
      },
    ];
    const freezeItem: MenuItem =
      frozenRows || frozenCols
        ? { label: "Quitar inmovilización", action: unfreeze }
        : kind === "row"
          ? {
              label: `Inmovilizar hasta la fila ${selection.r2 + 1}`,
              action: () =>
                mutate(() => sheetApi.freeze(sheet, selection.r2 + 1, 0)),
            }
          : kind === "col"
            ? {
                label: `Inmovilizar hasta la columna ${columnName(selection.c2)}`,
                action: () =>
                  mutate(() => sheetApi.freeze(sheet, 0, selection.c2 + 1)),
              }
            : {
                label: "Inmovilizar filas y columnas anteriores",
                disabled: active.r === 0 && active.c === 0,
                action: () => freezeAtSelection(),
              };
    const sortItems: MenuItem[] = [
      { label: "Ordenar de A a Z", action: () => sortBy(active.c, true) },
      { label: "Ordenar de Z a A", action: () => sortBy(active.c, false) },
      { label: "Ordenar por varias columnas…", action: openSortDialog },
      {
        label: "Filtrar…",
        action: () => openFilter(active.c, menu?.x ?? 200, menu?.y ?? 200),
      },
      ...(filter
        ? [{ label: "Quitar todos los filtros", action: clearAllFilters }]
        : []),
      { label: "Quitar duplicados…", action: openDuplicates },
      {
        label: activeTable
          ? "Opciones de la tabla…"
          : "Dar formato como tabla…",
        action: openTableDialog,
      },
    ];

    if (kind === "row") {
      return [
        ...clipboard,
        "separator",
        ...rowItems,
        "separator",
        {
          label: `Ocultar ${plural(rowSpan, "fila", "filas")}`,
          action: () => setRowsHidden(true),
        },
        { label: "Mostrar filas ocultas", action: () => setRowsHidden(false) },
        "separator",
        freezeItem,
      ];
    }
    if (kind === "col") {
      return [
        ...clipboard,
        "separator",
        ...colItems,
        "separator",
        ...sortItems,
        "separator",
        {
          label: `Ocultar ${plural(colSpan, "columna", "columnas")}`,
          action: () => setColumnsHidden(true),
        },
        {
          label: "Mostrar columnas ocultas",
          action: () => setColumnsHidden(false),
        },
        "separator",
        freezeItem,
      ];
    }
    return [
      ...clipboard,
      "separator",
      rowItems[0],
      colItems[0],
      rowItems[2],
      colItems[2],
      "separator",
      {
        label: activeMerged ? "Separar celdas" : "Combinar celdas",
        disabled: !activeMerged && !isMultiSelection,
        action: toggleMerge,
      },
      ...sortItems,
      "separator",
      ...noteItems,
      ...linkItems,
      "separator",
      freezeItem,
      {
        label: "Establecer área de impresión",
        disabled: !isMultiSelection,
        action: () => setPrintArea(false),
      },
      ...(view.page?.print_area
        ? [
            {
              label: "Quitar área de impresión",
              action: () => setPrintArea(true),
            },
          ]
        : []),
      {
        label: "Insertar salto de página",
        disabled: !(
          (!wholeCols && selection.r1 > 0) ||
          (!wholeRows && selection.c1 > 0)
        ),
        action: insertPageBreak,
      },
      ...((!wholeCols &&
        (view.page?.row_breaks ?? []).includes(selection.r1)) ||
      (!wholeRows && (view.page?.col_breaks ?? []).includes(selection.c1))
        ? [{ label: "Quitar salto de página", action: removePageBreak }]
        : []),
      ...((view.page?.row_breaks ?? []).length ||
      (view.page?.col_breaks ?? []).length
        ? [
            {
              label: "Restablecer todos los saltos de página",
              action: () =>
                setPageBreaks(
                  [],
                  [],
                  "Se quitaron los saltos de página puestos a mano",
                ),
            },
          ]
        : []),
      { label: "Borrar contenido", shortcut: "⌫", action: clearSelection },
    ];
  }

  // ───────────── dibujo ─────────────

  const isMultiSelection =
    selection.r1 !== selection.r2 || selection.c1 !== selection.c2;
  const printData = useMemo(
    () => ({ view, cols: baseCols, rows: baseRows, merged, decorations }),
    [view, baseCols, baseRows, merged, decorations],
  );

  // ───────────── cortes de página ─────────────
  // Como en Excel: después de imprimir (o con el botón de abajo), unas líneas
  // punteadas marcan dónde termina cada página con las últimas opciones de impresión.
  const [showBreaks, setShowBreaksState] = useState(loadBreaks);
  function setShowBreaks(on: boolean) {
    setShowBreaksState(on);
    try {
      localStorage.setItem(BREAKS_KEY, on ? "1" : "0");
    } catch {
      // Sin almacenamiento la preferencia no se recuerda.
    }
  }
  // Una hoja con saltos de página puestos a mano los muestra al abrirla (si no, no se notan).
  useEffect(() => {
    if (view.page?.row_breaks?.length || view.page?.col_breaks?.length)
      setShowBreaksState(true);
  }, [sheet]); // eslint-disable-line react-hooks/exhaustive-deps
  // Vista previa de salto de página (como en Excel): las páginas con líneas azules,
  // «Página 1», «Página 2»… al fondo, y lo que no se imprime en gris.
  const [breakView, setBreakViewState] = useState(() => {
    try {
      return localStorage.getItem(BREAK_VIEW_KEY) === "1";
    } catch {
      return false;
    }
  });
  function setBreakView(on: boolean) {
    setBreakViewState(on);
    try {
      localStorage.setItem(BREAK_VIEW_KEY, on ? "1" : "0");
    } catch {
      // Sin almacenamiento la vista no se recuerda.
    }
    if (on)
      showStatus({
        text: "Vista previa de salto de página: arrastra las líneas azules para cambiar dónde empieza cada página o qué se imprime",
      });
  }
  const pageBreaks = useMemo(() => {
    if ((!showBreaks && !breakView) || dialog === "print" || pickingArea)
      return null;
    const page = view.page ?? {
      header: "",
      footer: "",
      repeat_rows: null,
      print_area: null,
    };
    const options = loadOptions(Boolean(page.print_area));
    const range = printRangeFor(options.area, pageForm(page).printArea);
    if (!range) return null;
    const repeat: [number, number] | null = page.repeat_rows
      ? [page.repeat_rows[0] - 1, page.repeat_rows[1] - 1]
      : null;
    const manual = { rows: page.row_breaks ?? [], cols: page.col_breaks ?? [] };
    const layout = layoutPages(
      range,
      baseCols,
      baseRows,
      {
        ...options,
        header: Boolean(page.header),
        footer: Boolean(page.footer),
      },
      repeat,
      manual,
    );
    // Dónde empieza cada grupo de filas y de columnas (ahí va el corte), si lo puso la persona,
    // y dónde termina lo que se imprime.
    const first = layout.pages[0];
    const rowGroups = layout.pages
      .filter((p) => p.cols[0] === first?.cols[0])
      .map((p) => p.rows)
      .filter((g) => g.length);
    const colGroups = layout.pages
      .filter((p) => p.rows[0] === first?.rows[0])
      .map((p) => p.cols)
      .filter((g) => g.length);
    const cuts = (groups: number[][], list: number[]) =>
      groups.slice(1).map((g, i) => {
        const prevLast = groups[i][groups[i].length - 1];
        return {
          at: g[0],
          manual: list.some((b) => b > prevLast && b <= g[0]),
        };
      });
    const rowCuts = cuts(rowGroups, manual.rows);
    const colCuts = cuts(colGroups, manual.cols);
    const lastRow = rowGroups.at(-1)?.at(-1);
    const lastCol = colGroups.at(-1)?.at(-1);
    const rowEdge = lastRow === undefined ? null : lastRow + 1;
    const colEdge = lastCol === undefined ? null : lastCol + 1;
    // Cada página como rectángulo (fila y columna de inicio, y dónde termina), en el orden
    // en que se imprimen: hacia abajo y luego a la derecha, como Excel.
    const band = (groups: number[][], start: number, edge: number | null) =>
      groups.map(
        (g, i) =>
          [
            i === 0 ? start : g[0],
            i + 1 < groups.length
              ? groups[i + 1][0]
              : (edge ?? g[g.length - 1] + 1),
          ] as [number, number],
      );
    const rowBands = band(rowGroups, range.r1, rowEdge);
    const colBands = band(colGroups, range.c1, colEdge);
    const rects = layout.pages
      .map((p) => {
        const ri = rowGroups.findIndex((g) => g[0] === p.rows[0]);
        const ci = colGroups.findIndex((g) => g[0] === p.cols[0]);
        return ri < 0 || ci < 0
          ? null
          : {
              r1: rowBands[ri][0],
              r2: rowBands[ri][1],
              c1: colBands[ci][0],
              c2: colBands[ci][1],
            };
      })
      .filter(
        (x): x is { r1: number; r2: number; c1: number; c2: number } =>
          x !== null,
      );
    return {
      range,
      rowCuts,
      colCuts,
      rowEdge,
      colEdge,
      pages: layout.pages.length,
      rects,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    showBreaks,
    breakView,
    dialog,
    pickingArea,
    view,
    baseCols,
    baseRows,
    printJob,
  ]);
  // ───────────── saltos de página a mano (como en Excel) ─────────────
  const manualRows = view.page?.row_breaks ?? [];
  const manualCols = view.page?.col_breaks ?? [];

  function setPageBreaks(rows: number[], cols: number[], text: string) {
    mutate(() => sheetApi.pageBreaks(sheet, rows, cols));
    setShowBreaks(true);
    showStatus({ text });
  }

  /** Como Excel: con filas elegidas, el salto va arriba de ellas; con columnas, a su izquierda; con una celda, las dos cosas. */
  function insertPageBreak() {
    const r = selection.r1;
    const c = selection.c1;
    const rows =
      !wholeCols && r > 0 && !manualRows.includes(r)
        ? [...manualRows, r]
        : manualRows;
    const cols =
      !wholeRows && c > 0 && !manualCols.includes(c)
        ? [...manualCols, c]
        : manualCols;
    if (rows === manualRows && cols === manualCols)
      return showStatus({
        text: "Aquí no se puede poner un salto de página (está en la primera fila o columna, o ya hay uno)",
      });
    setPageBreaks(
      rows,
      cols,
      "Salto de página insertado: lo que sigue se imprime en otra página",
    );
  }

  function removePageBreak() {
    const rows = wholeCols
      ? manualRows
      : manualRows.filter((x) => x !== selection.r1);
    const cols = wholeRows
      ? manualCols
      : manualCols.filter((x) => x !== selection.c1);
    setPageBreaks(rows, cols, "Se quitó el salto de página");
  }

  /** Arrastrar un corte: uno puesto a mano se mueve; uno automático se vuelve salto a mano en el lugar nuevo. */
  const [breakDrag, setBreakDrag] = useState<{
    axis: "row" | "col";
    from: number;
    manual: boolean;
    to: number;
    side?: "start" | "end";
  } | null>(null);
  const breakDragRef = useRef(breakDrag);
  breakDragRef.current = breakDrag;
  function boundaryAt(axis: Axis, pos: number, limit: number): number {
    let lo = 0;
    let hi = limit;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (axis.start(mid) < pos) lo = mid + 1;
      else hi = mid;
    }
    return lo > 0 &&
      Math.abs(axis.start(lo - 1) - pos) < Math.abs(axis.start(lo) - pos)
      ? lo - 1
      : lo;
  }
  /** `side`: se arrastra el borde de afuera (arriba/izquierda = "start", abajo/derecha = "end"), que cambia el área de impresión. */
  function startBreakDrag(
    e: React.PointerEvent,
    axis: "row" | "col",
    at: number,
    manual: boolean,
    side?: "start" | "end",
  ) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    setBreakDrag({ axis, from: at, manual, to: at, side });
    const el = scrollRef.current;
    if (!el) return;
    const move = (ev: PointerEvent) => {
      const box = el.getBoundingClientRect();
      const to =
        axis === "row"
          ? boundaryAt(
              rowAxis,
              ev.clientY - box.top + el.scrollTop - HEADER_HEIGHT,
              rowCount + 1,
            )
          : boundaryAt(
              colAxis,
              ev.clientX - box.left + el.scrollLeft - HEADER_WIDTH,
              colCount + 1,
            );
      setBreakDrag((d) => (d && d.to !== to ? { ...d, to } : d));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const d = breakDragRef.current;
      setBreakDrag(null);
      if (!d || !pageBreaks || d.to === d.from) return;
      const range = pageBreaks.range;
      if (d.side) {
        // El borde de afuera: lo que queda adentro es la nueva área de impresión.
        const area = {
          ...range,
          r2: pageBreaks.rowEdge !== null ? pageBreaks.rowEdge - 1 : range.r2,
          c2: pageBreaks.colEdge !== null ? pageBreaks.colEdge - 1 : range.c2,
        };
        if (d.axis === "row") {
          if (d.side === "start") area.r1 = Math.min(d.to, area.r2);
          else area.r2 = Math.max(d.to - 1, area.r1);
        } else if (d.side === "start") area.c1 = Math.min(d.to, area.c2);
        else area.c2 = Math.max(d.to - 1, area.c1);
        const text = `${cellName({ r: area.r1, c: area.c1 })}:${cellName({ r: area.r2, c: area.c2 })}`;
        const form = pageForm(
          view.page ?? {
            header: "",
            footer: "",
            repeat_rows: null,
            print_area: null,
          },
        );
        mutate(() =>
          sheetApi.pageSetup(
            sheet,
            form.header,
            form.footer,
            form.repeatRows,
            text,
          ),
        );
        showStatus({ text: `Área de impresión: ${text}` });
        return;
      }
      const [lo, hi] =
        d.axis === "row" ? [range.r1, range.r2] : [range.c1, range.c2];
      const list = d.axis === "row" ? manualRows : manualCols;
      const next = (
        d.manual ? list.filter((x) => x !== d.from) : [...list]
      ).filter((x) => x !== d.to);
      const inside = d.to > lo && d.to <= hi;
      if (inside) next.push(d.to);
      setPageBreaks(
        d.axis === "row" ? next : manualRows,
        d.axis === "col" ? next : manualCols,
        inside ? "Salto de página movido" : "Se quitó el salto de página",
      );
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  const selectionLabel = isMultiSelection
    ? wholeCols
      ? selection.c1 === selection.c2
        ? `Columna ${columnName(selection.c1)}`
        : `${columnName(selection.c1)}:${columnName(selection.c2)}`
      : wholeRows
        ? selection.r1 === selection.r2
          ? `Fila ${selection.r1 + 1}`
          : `${selection.r1 + 1}:${selection.r2 + 1}`
        : `${cellName({ r: selection.r1, c: selection.c1 })}:${cellName({ r: selection.r2, c: selection.c2 })}`
    : cellName(active);

  function cellClasses(r: number, c: number, numeric: boolean, extra = "") {
    const isActive = r === active.r && c === active.c;
    const inRange =
      isMultiSelection &&
      r >= selection.r1 &&
      r <= selection.r2 &&
      c >= selection.c1 &&
      c <= selection.c2;
    return `cell${numeric ? " number" : ""}${isActive ? " active" : ""}${inRange ? " in-range" : ""}${extra}`;
  }

  /** ¿La celda está vacía y sin relleno, de modo que el texto de su vecina puede pasar por encima? */
  function canSpillInto(r: number, c: number) {
    const cell = rows[r]?.[c];
    if (cell && cell[0] !== "") return false;
    if (cell && view.styles[cell[2]]?.fill) return false;
    return !merged.at(r, c) && !decorations.has(`${r},${c}`);
  }

  /** Dibuja una celda (o un bloque combinado) en la posición indicada. */
  function renderCell(
    r: number,
    c: number,
    cellBox: { top: number; left: number; width: number; height: number },
    key: string,
    extra = "",
  ) {
    // Filas o columnas ocultas: no se dibujan (con el relleno interno de la celda
    // se veía una franja de unos píxeles al seleccionar).
    if (cellBox.width <= 0 || cellBox.height <= 0) return null;
    const [text, numeric, styleId] = rows[r]?.[c] ?? ["", false, 0];
    const table = tableAt(tables, r, c);
    const tableHeader = table && r + 1 === table.row1;
    const note = notes.get(`${r},${c}`);
    const link = links.get(`${r},${c}`);
    // Dentro de una tabla, sus colores (encabezados, bandas, totales) completan el formato de la celda.
    const cellStyle = withTableStyle(
      view.styles[styleId] ?? view.styles[0],
      table,
      r,
    );
    const deco = decorations.get(`${r},${c}`);
    let box = cellBox;
    // Texto largo: se desborda sobre las celdas vacías de la derecha, como en Excel.
    if (
      text &&
      !numeric &&
      !cellStyle.wrap &&
      (!cellStyle.h || cellStyle.h === "left") &&
      !extra.includes("merged") &&
      !deco
    ) {
      const needed = textWidth(text, cellStyle) * zoom + 12;
      if (needed > box.width) {
        let width = box.width;
        for (
          let k = c + 1;
          width < needed && k < c + 30 && canSpillInto(r, k);
          k++
        )
          width += colAxis.size(k);
        if (width > box.width) {
          box = { ...box, width };
          extra += " spill";
        }
      }
    }
    return (
      <div
        key={key}
        className={cellClasses(r, c, numeric, extra)}
        style={{
          ...cellCss(cellStyle, numeric, zoom),
          ...box,
          ...(tableHeader ? { paddingRight: 22 } : null),
        }}
        onMouseDown={(e) => {
          if (e.button !== 0) return;
          if (selectedDrawing !== null) setSelectedDrawing(null);
          // ⌘ + clic (Ctrl en Windows) abre el vínculo de la celda.
          if (link && hasModifier(e) && !editing) {
            e.preventDefault();
            openLink(link);
            return;
          }
          // Escribiendo una fórmula: el clic inserta la referencia de la celda.
          if (wantsReference()) {
            e.preventDefault();
            mouseSelecting.current = "ref";
            const anchor = e.shiftKey && pointing ? pointing.anchor : { r, c };
            pointTo(anchor, { r, c });
            return;
          }
          mouseSelecting.current = "cells";
          select({ r, c }, e.shiftKey);
        }}
        onMouseEnter={() => {
          if (fillTo) setFillTo({ r, c });
          else if (mouseSelecting.current === "ref" && pointing)
            pointTo(pointing.anchor, { r, c });
          else if (mouseSelecting.current === "cells") setEnd({ r, c });
          showNoteSoon(note ? { r, c } : null);
        }}
        onMouseLeave={() => note && showNoteSoon(null)}
        onDoubleClick={() => startEditing(input, false)}
        onContextMenu={(e) => openMenu(e, "cell", { r, c })}
        title={
          note
            ? undefined
            : link
              ? `${link.target}\n${keys("⌘")}+clic para abrir`
              : text
        }
      >
        {note && <span className="note-mark" aria-label="Tiene nota" />}
        {tableHeader && (
          <button
            type="button"
            className={`table-filter${filter?.cols[c] && filter.region.r1 === table.row1 - 1 ? " active" : ""}`}
            aria-label={`Filtrar u ordenar ${text || columnName(c)}`}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              const box = (
                e.currentTarget as HTMLElement
              ).getBoundingClientRect();
              openFilter(c, box.left, box.bottom + 4, tableRegion(table));
            }}
          >
            ▾
          </button>
        )}
        {deco?.bar && (
          <span
            className="data-bar"
            style={{
              width: `${Math.max(0, Math.min(1, deco.bar.value)) * 100}%`,
              background: deco.bar.gradient
                ? `linear-gradient(90deg, ${deco.bar.color}, ${deco.bar.color}22)`
                : deco.bar.color,
              borderColor: deco.bar.color,
            }}
          />
        )}
        {deco?.icon && (
          <span className="cf-icon" style={{ color: deco.icon.color }}>
            {ICON_GLYPHS[deco.icon.icon] ?? "●"}
          </span>
        )}
        {deco?.rating && (
          <span className="cf-rating" style={{ color: deco.rating.color }}>
            {Array.from({ length: deco.rating.max }, (_, i) => (
              <span
                key={i}
                style={{ opacity: i < deco.rating!.count ? 1 : 0.25 }}
              >
                {ICON_GLYPHS[deco.rating!.icon] ?? "★"}
              </span>
            ))}
          </span>
        )}
        {(!deco || deco.show_value) && (
          <span className="cell-text">{text}</span>
        )}
      </div>
    );
  }

  function renderColHeader(
    index: number,
    left: number,
    width: number,
    frozen: boolean,
  ) {
    const filtered =
      Boolean(filter?.cols[index]) &&
      index >= filter!.region.c1 &&
      index <= filter!.region.c2;
    return (
      <div
        key={`ch-${index}`}
        className={`col-header${index >= selection.c1 && index <= selection.c2 ? " active" : ""}${frozen ? " frozen" : ""}`}
        style={{ left, width }}
        onMouseDown={(e) => {
          if (e.button !== 0) return;
          mouseSelecting.current = "cols";
          if (e.shiftKey) setEnd({ r: MAX_ROW, c: index });
          else selectColumns(index, index);
        }}
        onMouseEnter={() =>
          mouseSelecting.current === "cols" && setEnd({ r: MAX_ROW, c: index })
        }
        onContextMenu={(e) => openMenu(e, "col", { r: 0, c: index })}
      >
        {columnName(index)}
        {filtered && (
          <button
            type="button"
            className="filter-indicator"
            title="Filtro activo: clic para cambiarlo"
            aria-label={`Filtro de la columna ${columnName(index)}`}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => openFilter(index, e.clientX, e.clientY + 12)}
          >
            ⏷
          </button>
        )}
        <span
          className="col-resize"
          title="Arrastra para cambiar el ancho; doble clic para ajustarlo al texto"
          onMouseDown={(e) => startResize(e, "col", index)}
          onDoubleClick={(e) => {
            e.stopPropagation();
            autofitColumn(index);
          }}
        />
      </div>
    );
  }

  function renderRowHeader(
    index: number,
    top: number,
    height: number,
    frozen: boolean,
  ) {
    return (
      <div
        key={`rh-${index}`}
        className={`row-header${index >= selection.r1 && index <= selection.r2 ? " active" : ""}${frozen ? " frozen" : ""}`}
        style={{ top, left: scrollX, height, width: HEADER_WIDTH }}
        onMouseDown={(e) => {
          if (e.button !== 0) return;
          mouseSelecting.current = "rows";
          if (e.shiftKey) setEnd({ r: index, c: MAX_COL });
          else selectRows(index, index);
        }}
        onMouseEnter={() =>
          mouseSelecting.current === "rows" && setEnd({ r: index, c: MAX_COL })
        }
        onContextMenu={(e) => openMenu(e, "row", { r: index, c: 0 })}
      >
        {index + 1}
        <span
          className="row-resize"
          title="Arrastra para cambiar el alto"
          onMouseDown={(e) => startResize(e, "row", index)}
        />
      </div>
    );
  }

  const virtualRows = rowVirtualizer.getVirtualItems();
  const virtualCols = colVirtualizer.getVirtualItems();
  const selectionBox = rangeBox(selection);
  const showFillHandle =
    !editing &&
    !wholeCols &&
    !wholeRows &&
    selection.r2 < rowCount &&
    selection.c2 < colCount;
  const editingFrozen = editing && {
    r: editing.cell.r < frozenRows,
    c: editing.cell.c < frozenCols,
  };

  const toolbarActions = (
    <div className="toolbar-group">
      <button
        className="btn btn-icon"
        onClick={undo}
        title={keys("Deshacer (⌘Z)")}
        aria-label="Deshacer"
      >
        ↶
      </button>
      <button
        className="btn btn-icon"
        onClick={redo}
        title={keys("Rehacer (⌘⇧Z)")}
        aria-label="Rehacer"
      >
        ↷
      </button>
      <button
        className="btn btn-icon"
        onClick={() => setFindOpen((v) => !v)}
        title={keys("Buscar y reemplazar (⌘F)")}
        aria-label="Buscar"
      >
        ⌕
      </button>
      <button
        className="btn btn-icon"
        onClick={() => (setPdfDialog(false), setDialog("print"))}
        title={keys("Imprimir o exportar a PDF (⌘P)")}
        aria-label="Imprimir"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          aria-hidden
        >
          <path d="M7 8V3h10v5M7 17H4v-7a2 2 0 012-2h12a2 2 0 012 2v7h-3" />
          <rect x="7" y="14" width="10" height="7" rx="1" />
        </svg>
      </button>
      <label
        className={`autosave-toggle${autosave ? " on" : ""}`}
        title={
          autosave
            ? "Cada cambio se guarda solo en el archivo"
            : "Guardar solo cada cambio en el archivo (también hay una copia de recuperación por si la app se cierra)"
        }
      >
        <input
          type="checkbox"
          role="switch"
          checked={autosave}
          onChange={toggleAutosave}
        />
        <span className="autosave-track" aria-hidden />
        Autoguardado
      </label>
      <button
        className="btn"
        onClick={() => saveDocument()}
        title={keys("Guardar (⌘S)")}
      >
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

      <FormatBar
        style={activeStyle}
        onStyle={applyStyle}
        onBorder={applyBorder}
        onDone={focusGrid}
      >
        <Separator />
        <ToolButton
          label="Copiar formato (doble clic para aplicarlo varias veces)"
          pressed={Boolean(painter)}
          onClick={() => startPainter(false)}
          onDoubleClick={() => startPainter(true)}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinejoin="round"
            aria-hidden
          >
            <rect x="4" y="3" width="14" height="6" rx="1.5" />
            <path d="M18 6h2v5h-8v3" />
            <rect x="10.5" y="14" width="3" height="7" rx="1" />
          </svg>
        </ToolButton>
        <ToolButton
          label={activeMerged ? "Separar celdas" : "Combinar celdas"}
          pressed={Boolean(activeMerged)}
          onClick={toggleMerge}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            aria-hidden
          >
            <rect x="3" y="5" width="18" height="14" rx="1.5" />
            <path d="M7 12h10M14 9l3 3-3 3M10 9l-3 3 3 3" />
          </svg>
        </ToolButton>
        <ToolButton
          label="Ordenar de A a Z"
          onClick={() => sortBy(active.c, true)}
        >
          <span className="fb-text-icon">A↓Z</span>
        </ToolButton>
        <ToolButton
          label="Ordenar de Z a A"
          onClick={() => sortBy(active.c, false)}
        >
          <span className="fb-text-icon">Z↓A</span>
        </ToolButton>
        <ToolButton
          label={
            activeTable ? "Opciones de la tabla" : "Dar formato como tabla"
          }
          pressed={Boolean(activeTable)}
          onClick={openTableDialog}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            aria-hidden
          >
            <rect x="3" y="4" width="18" height="16" rx="1.5" />
            <path d="M3 9h18M3 14h18M9 9v11" />
            <rect
              x="3"
              y="4"
              width="18"
              height="5"
              fill="currentColor"
              stroke="none"
              opacity="0.35"
            />
          </svg>
        </ToolButton>
        <ToolButton label="Quitar duplicados" onClick={openDuplicates}>
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            aria-hidden
          >
            <rect x="3" y="4" width="11" height="6" rx="1" />
            <rect
              x="3"
              y="14"
              width="11"
              height="6"
              rx="1"
              strokeDasharray="2 2"
            />
            <path d="M17 14l4 4M21 14l-4 4" />
          </svg>
        </ToolButton>
        <ToolButton
          label="Ordenar por varias columnas"
          onClick={openSortDialog}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            aria-hidden
          >
            <path d="M4 6h10M4 12h7M4 18h4M18 5v14M15 16l3 3 3-3" />
          </svg>
        </ToolButton>
        <ToolButton
          label="Filtrar esta columna"
          pressed={Boolean(filter && filter.cols[active.c])}
          onClick={() => {
            const box = scrollRef.current?.getBoundingClientRect();
            openFilter(
              active.c,
              (box?.left ?? 0) +
                HEADER_WIDTH +
                colAxis.start(active.c) -
                scrollX,
              (box?.top ?? 0) + HEADER_HEIGHT,
            );
          }}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            aria-hidden
          >
            <path d="M4 5h16l-6 7.5V19l-4-2v-4.5z" />
          </svg>
        </ToolButton>
        <Separator />
        <ToolButton
          label="Insertar gráfica con los datos seleccionados"
          onClick={() => {
            const box = document
              .querySelector(
                "[aria-label='Insertar gráfica con los datos seleccionados']",
              )
              ?.getBoundingClientRect();
            setChartMenu({ x: box?.left ?? 200, y: (box?.bottom ?? 100) + 4 });
          }}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden
          >
            <path d="M5 20V11M10 20V6M15 20V13M20 20V8" />
          </svg>
        </ToolButton>
        <ToolButton label="Insertar imagen" onClick={insertImage}>
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            aria-hidden
          >
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <circle cx="9" cy="10" r="2" />
            <path d="M21 17l-5-5-9 8" />
          </svg>
        </ToolButton>
        <ToolButton
          label="Formato condicional"
          onClick={() => setDialog("conditional")}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            aria-hidden
          >
            <rect x="3" y="4" width="18" height="16" rx="1.5" />
            <path d="M3 10h18M3 15h18" />
            <rect
              x="5"
              y="11.5"
              width="9"
              height="2"
              fill="currentColor"
              stroke="none"
            />
            <rect
              x="5"
              y="16.5"
              width="13"
              height="2"
              fill="currentColor"
              stroke="none"
            />
          </svg>
        </ToolButton>
        <ToolButton
          label="Lista desplegable (validación de datos)"
          pressed={Boolean(activeValidation)}
          onClick={() => setDialog("validation")}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            aria-hidden
          >
            <rect x="3" y="5" width="18" height="6" rx="1.5" />
            <path d="M15 7.5l1.5 1.5L18 7.5" />
            <path d="M5 15h10M5 19h7" />
          </svg>
        </ToolButton>
        <ToolButton
          label={
            frozenRows || frozenCols
              ? "Quitar inmovilización"
              : "Inmovilizar filas y columnas anteriores a la celda"
          }
          pressed={Boolean(frozenRows || frozenCols)}
          onClick={() =>
            frozenRows || frozenCols ? unfreeze() : freezeAtSelection()
          }
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            aria-hidden
          >
            <rect x="3" y="3" width="18" height="18" rx="1.5" />
            <path d="M3 9h18M9 3v18" strokeWidth="2.6" />
          </svg>
        </ToolButton>
      </FormatBar>

      {findOpen && (
        <FindBar
          sheet={sheet}
          version={view}
          onGo={goToMatch}
          onReplaceAll={replaceAll}
          onClose={() => {
            setFindOpen(false);
            focusGrid();
          }}
        />
      )}

      {showDrawingsNotice && (
        <div className="sheet-notice" role="status">
          <span>
            Este archivo tiene elementos que WEPO todavía no conserva (formas,
            comentarios, tablas dinámicas u otros tipos de gráfica), así que al
            guardar se crea una copia y el original queda intacto.
          </span>
          <button
            className="btn btn-icon"
            aria-label="Cerrar aviso"
            onClick={() => setShowDrawingsNotice(false)}
          >
            ×
          </button>
        </div>
      )}

      <div className="formula-bar">
        <span className="cell-ref">{selectionLabel}</span>
        <button
          type="button"
          className="fx"
          title="Insertar función"
          aria-label="Insertar función"
          onClick={() => setFnDialog(true)}
        >
          fx
        </button>
        <FormulaInput
          className="fi-bar"
          label="Contenido de la celda"
          inputRef={barInputRef}
          value={editing ? editing.value : input}
          onFocus={() => {
            if (!editingRef.current) startEditing(input, false, "bar");
          }}
          onChange={(value, nextCaret) => {
            setEditing((prev) =>
              prev
                ? { ...prev, value }
                : {
                    value,
                    source: "bar",
                    quick: false,
                    cell: active,
                    original: input,
                  },
            );
            setCaret(nextCaret);
            setPointing(null);
            setAssistDismissed(false);
          }}
          onCaret={setCaret}
          onKeyDown={onEditorKeyDown}
          onBlur={() => editing?.source === "bar" && commit()}
        />
        <button
          type="button"
          className="formula-language"
          title={
            language === "es"
              ? "Funciones en español (SUMA, SI…). Clic para cambiar a inglés."
              : "Funciones en inglés (SUM, IF…). Clic para cambiar a español."
          }
          aria-label="Idioma de las funciones"
          onMouseDown={(e) => e.preventDefault()}
          onClick={toggleLanguage}
        >
          {language.toUpperCase()}
        </button>
      </div>

      <div
        className={`grid-scroll${fillTo ? " filling" : ""}${painter ? " painting" : ""}${breakView && pageBreaks ? " break-preview" : ""}`}
        ref={scrollRef}
        tabIndex={0}
        onKeyDown={onGridKeyDown}
        aria-label="Cuadrícula de la hoja"
      >
        <div
          className="grid-canvas"
          style={{
            width: colVirtualizer.getTotalSize(),
            height: rowVirtualizer.getTotalSize(),
          }}
        >
          {/* Encabezados de columna (A, B, C…) fijos arriba */}
          <div
            className="col-headers"
            style={{ width: colVirtualizer.getTotalSize() }}
          >
            {virtualCols.map((col) =>
              col.index < frozenCols
                ? null
                : renderColHeader(col.index, col.start, col.size, false),
            )}
            {Array.from({ length: frozenCols }, (_, c) =>
              renderColHeader(
                c,
                HEADER_WIDTH + colAxis.start(c) + scrollX,
                colAxis.size(c),
                true,
              ),
            )}
            <div
              className="corner"
              style={{ left: scrollX, width: HEADER_WIDTH }}
            />
          </div>

          {/* Celdas normales (las inmovilizadas y combinadas se dibujan aparte) */}
          {virtualRows.map((row) =>
            virtualCols.map((col) =>
              merged.at(row.index, col.index)
                ? null
                : renderCell(
                    row.index,
                    col.index,
                    {
                      top: row.start,
                      left: col.start,
                      width: col.size,
                      height: row.size,
                    },
                    `${row.key}-${col.key}`,
                  ),
            ),
          )}

          {/* Celdas combinadas: un bloque por cada rango */}
          {merged.ranges.map((m) =>
            renderCell(m.r1, m.c1, rangeBox(m), `m-${m.r1}-${m.c1}`, " merged"),
          )}

          {/* Paneles inmovilizados: se desplazan con la hoja para quedarse fijos */}
          {frozenRows > 0 &&
            Array.from({ length: frozenRows }, (_, r) =>
              virtualCols.map((col) =>
                col.index < frozenCols
                  ? null
                  : renderCell(
                      r,
                      col.index,
                      {
                        top: HEADER_HEIGHT + rowAxis.start(r) + scrollY,
                        left: col.start,
                        width: col.size,
                        height: rowAxis.size(r),
                      },
                      `fr-${r}-${col.key}`,
                      " frozen",
                    ),
              ),
            )}
          {frozenCols > 0 &&
            virtualRows.map((row) =>
              Array.from({ length: frozenCols }, (_, c) =>
                row.index < frozenRows
                  ? null
                  : renderCell(
                      row.index,
                      c,
                      {
                        top: row.start,
                        left: HEADER_WIDTH + colAxis.start(c) + scrollX,
                        width: colAxis.size(c),
                        height: row.size,
                      },
                      `fc-${row.key}-${c}`,
                      " frozen",
                    ),
              ),
            )}
          {frozenRows > 0 &&
            frozenCols > 0 &&
            Array.from({ length: frozenRows }, (_, r) =>
              Array.from({ length: frozenCols }, (_, c) =>
                renderCell(
                  r,
                  c,
                  {
                    top: HEADER_HEIGHT + rowAxis.start(r) + scrollY,
                    left: HEADER_WIDTH + colAxis.start(c) + scrollX,
                    width: colAxis.size(c),
                    height: rowAxis.size(r),
                  },
                  `fx-${r}-${c}`,
                  " frozen corner-frozen",
                ),
              ),
            )}
          {frozenRows > 0 && (
            <div
              className="frozen-line h"
              style={{ top: HEADER_HEIGHT + frozenHeight + scrollY - 1 }}
            />
          )}
          {frozenCols > 0 && (
            <div
              className="frozen-line v"
              style={{ left: HEADER_WIDTH + frozenWidth + scrollX - 1 }}
            />
          )}

          {/* Cortes de página: una línea punteada donde termina cada página impresa */}
          {pageBreaks &&
            (() => {
              const top = HEADER_HEIGHT + rowAxis.start(pageBreaks.range.r1);
              const bottom =
                HEADER_HEIGHT + rowAxis.start(pageBreaks.range.r2 + 1);
              const left = HEADER_WIDTH + colAxis.start(pageBreaks.range.c1);
              const right =
                HEADER_WIDTH + colAxis.start(pageBreaks.range.c2 + 1);
              const edgeTitle =
                "Borde de lo que se imprime: arrástralo para cambiar el área de impresión";
              const cutTitle = (cls: string, manual: boolean) =>
                cls.startsWith("drag")
                  ? manual
                    ? "Salto de página (puesto a mano): arrástralo para moverlo, o sácalo de lo que se imprime para quitarlo"
                    : "Corte automático: arrástralo para poner el salto en otro lugar"
                  : undefined;
              const col = (
                at: number,
                cls: string,
                manual = false,
                side?: "start" | "end",
              ) => (
                <div
                  key={`pbc-${cls}-${at}`}
                  className={`page-break v ${cls}`}
                  style={{
                    left: HEADER_WIDTH + colAxis.start(at) - 1,
                    top,
                    height: bottom - top,
                  }}
                  data-col={at}
                  data-side={side}
                  title={side ? edgeTitle : cutTitle(cls, manual)}
                  onPointerDown={
                    cls.startsWith("drag")
                      ? (e) => startBreakDrag(e, "col", at, manual, side)
                      : undefined
                  }
                />
              );
              const row = (
                at: number,
                cls: string,
                manual = false,
                side?: "start" | "end",
              ) => (
                <div
                  key={`pbr-${cls}-${at}`}
                  className={`page-break h ${cls}`}
                  style={{
                    top: HEADER_HEIGHT + rowAxis.start(at) - 1,
                    left,
                    width: right - left,
                  }}
                  data-row={at}
                  data-side={side}
                  title={side ? edgeTitle : cutTitle(cls, manual)}
                  onPointerDown={
                    cls.startsWith("drag")
                      ? (e) => startBreakDrag(e, "row", at, manual, side)
                      : undefined
                  }
                />
              );
              const hidden = (
                axis: "row" | "col",
                at: number,
                side?: "start" | "end",
              ) =>
                breakDrag?.axis === axis &&
                breakDrag.from === at &&
                breakDrag.side === side;
              const rowEnd = pageBreaks.rowEdge ?? pageBreaks.range.r2 + 1;
              const colEnd = pageBreaks.colEdge ?? pageBreaks.range.c2 + 1;
              return (
                <>
                  {breakView && (
                    <>
                      {/* Lo que no se imprime queda en gris */}
                      <div
                        className="break-preview-area"
                        style={{
                          top,
                          left,
                          width: HEADER_WIDTH + colAxis.start(colEnd) - left,
                          height: HEADER_HEIGHT + rowAxis.start(rowEnd) - top,
                        }}
                      />
                      {pageBreaks.rects.map((p, i) => {
                        const w = colAxis.start(p.c2) - colAxis.start(p.c1);
                        const h = rowAxis.start(p.r2) - rowAxis.start(p.r1);
                        return (
                          <div
                            key={`pg-${i}`}
                            className="break-preview-label"
                            style={{
                              left: HEADER_WIDTH + colAxis.start(p.c1),
                              top: HEADER_HEIGHT + rowAxis.start(p.r1),
                              width: w,
                              height: h,
                              fontSize: Math.max(
                                12,
                                Math.min(72, w / 5, h / 2),
                              ),
                            }}
                            aria-hidden="true"
                          >
                            Página {i + 1}
                          </div>
                        );
                      })}
                    </>
                  )}
                  {pageBreaks.colCuts.map((c) =>
                    hidden("col", c.at)
                      ? null
                      : col(c.at, c.manual ? "drag manual" : "drag", c.manual),
                  )}
                  {pageBreaks.rowCuts.map((r) =>
                    hidden("row", r.at)
                      ? null
                      : row(r.at, r.manual ? "drag manual" : "drag", r.manual),
                  )}
                  {breakView ? (
                    <>
                      {!hidden("col", pageBreaks.range.c1, "start") &&
                        col(pageBreaks.range.c1, "drag outer", false, "start")}
                      {!hidden("col", colEnd, "end") &&
                        col(colEnd, "drag outer", false, "end")}
                      {!hidden("row", pageBreaks.range.r1, "start") &&
                        row(pageBreaks.range.r1, "drag outer", false, "start")}
                      {!hidden("row", rowEnd, "end") &&
                        row(rowEnd, "drag outer", false, "end")}
                    </>
                  ) : (
                    <>
                      {pageBreaks.colEdge !== null &&
                        col(pageBreaks.colEdge, "edge")}
                      {pageBreaks.rowEdge !== null &&
                        row(pageBreaks.rowEdge, "edge")}
                    </>
                  )}
                  {breakDrag &&
                    (breakDrag.axis === "row"
                      ? row(breakDrag.to, "ghost")
                      : col(breakDrag.to, "ghost"))}
                </>
              );
            })()}

          {/* Gráficas e imágenes */}
          <DrawingLayer
            drawings={view.drawings}
            selected={selectedDrawing}
            onSelect={(id) => {
              setSelectedDrawing(id);
              if (id !== chartPanel) setChartPanel(null);
              focusGrid();
            }}
            onChange={updateDrawing}
            onEdit={(id) => setChartPanel(id)}
            zoom={zoom}
          />

          {/* Nota: al pasar el mouse, o abierta para escribir */}
          {(() => {
            const target =
              noteEdit ?? (hoverNote && !editing ? hoverNote : null);
            if (!target) return null;
            const area = merged.at(target.r, target.c) ?? {
              r1: target.r,
              c1: target.c,
              r2: target.r,
              c2: target.c,
            };
            const box = rangeBox(area);
            const style = { left: box.left + box.width + 8, top: box.top };
            if (noteEdit) {
              return (
                <NoteEditor
                  key={`ne-${noteEdit.r}-${noteEdit.c}`}
                  style={style}
                  initial={noteEdit.text}
                  onSave={saveNote}
                  onCancel={() => {
                    setNoteEdit(null);
                    focusGrid();
                  }}
                />
              );
            }
            const note = notes.get(`${target.r},${target.c}`);
            if (!note) return null;
            return (
              <div
                className="note-bubble"
                style={style}
                role="note"
                onMouseEnter={() => showNoteSoon(target)}
                onMouseLeave={() => showNoteSoon(null)}
              >
                {note.author && <b>{note.author}:</b>} {note.text}
              </div>
            );
          })()}

          {/* Vínculo de la celda activa: a dónde lleva, y botones para abrirlo o cambiarlo */}
          {(() => {
            if (
              editing ||
              noteEdit ||
              isMultiSelection ||
              mouseSelecting.current
            )
              return null;
            const at = anchorOf(active);
            const link = links.get(`${at.r},${at.c}`);
            if (!link) return null;
            const area = merged.at(at.r, at.c) ?? {
              r1: at.r,
              c1: at.c,
              r2: at.r,
              c2: at.c,
            };
            const box = rangeBox(area);
            return (
              <div
                className="link-card"
                style={{ left: box.left, top: box.top + box.height + 4 }}
                onMouseDown={(e) => e.stopPropagation()}
              >
                <span className="link-card-target" title={link.target}>
                  {link.target.replace(/^mailto:/, "")}
                </span>
                <button
                  type="button"
                  className="link-card-button"
                  onClick={() => openLink(link)}
                >
                  Abrir
                </button>
                {!link.dynamic && (
                  <>
                    <button
                      type="button"
                      className="link-card-button"
                      onClick={() => setLinkDialog(at)}
                    >
                      Editar
                    </button>
                    <button
                      type="button"
                      className="link-card-button"
                      onClick={() => removeLink(at)}
                    >
                      Quitar
                    </button>
                  </>
                )}
              </div>
            );
          })()}

          {/* Números de fila fijos a la izquierda (los de filas inmovilizadas, aparte) */}
          {virtualRows.map((row) =>
            row.index < frozenRows
              ? null
              : renderRowHeader(row.index, row.start, row.size, false),
          )}
          {Array.from({ length: frozenRows }, (_, r) =>
            renderRowHeader(
              r,
              HEADER_HEIGHT + rowAxis.start(r) + scrollY,
              rowAxis.size(r),
              true,
            ),
          )}

          {/* Contorno de la selección con la esquina para el autollenado */}
          {!wholeCols && !wholeRows && (
            <div className="selection-outline" style={selectionBox}>
              {showFillHandle && (
                <span
                  className="fill-handle"
                  title="Arrastra para continuar la serie; doble clic para llenar hacia abajo"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setFillTo({ r: selection.r2, c: selection.c2 });
                  }}
                  onDoubleClick={autofillDown}
                />
              )}
            </div>
          )}
          {fillTo && (
            <div className="fill-preview" style={rangeBox(fillRange(fillTo))} />
          )}

          {/* Flecha y opciones de la lista desplegable de la celda activa */}
          {activeValidation &&
            activeValidation.kind !== "number" &&
            activeValidation.kind !== "date" &&
            !editing &&
            (() => {
              const box = rangeBox({
                r1: active.r,
                c1: active.c,
                r2: active.r,
                c2: active.c,
              });
              return (
                <>
                  <button
                    type="button"
                    className="list-arrow"
                    style={{
                      left: box.left + box.width + 2,
                      top: box.top + Math.max(0, (box.height - 20) / 2),
                    }}
                    title="Elegir de la lista (⌥↓)"
                    aria-label="Abrir lista de opciones"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => setListOpen((v) => !v)}
                  >
                    ▾
                  </button>
                  {listOpen && (
                    <div
                      className="list-picker"
                      role="listbox"
                      style={{
                        left: box.left,
                        top: box.top + box.height + 2,
                        minWidth: box.width,
                      }}
                    >
                      {activeValidation.items.length === 0 && (
                        <div className="list-empty">La lista está vacía</div>
                      )}
                      {activeValidation.items.map((item) => (
                        <button
                          key={item}
                          type="button"
                          role="option"
                          aria-selected={
                            item === rows[active.r]?.[active.c]?.[0]
                          }
                          className={`list-option${item === rows[active.r]?.[active.c]?.[0] ? " selected" : ""}`}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => pickFromList(item)}
                        >
                          {item}
                        </button>
                      ))}
                    </div>
                  )}
                </>
              );
            })()}

          {/* Referencias de la fórmula en edición, pintadas sobre la cuadrícula */}
          {editing &&
            findRefs(editing.value)
              .filter(
                (ref) => !ref.sheet || ref.sheet === view.sheet_names[sheet],
              )
              .map((ref, i) => (
                <div
                  key={`ref-${i}`}
                  className="ref-box"
                  style={{
                    ...rangeBox(ref.range),
                    borderColor: ref.color,
                    background: `${ref.color}14`,
                  }}
                />
              ))}

          {editing?.source === "cell" && (
            <FormulaInput
              inputRef={cellEditorRef}
              className="cell-editor"
              label="Editar celda"
              value={editing.value}
              style={{
                ...cellCss(activeStyle, false, zoom),
                top:
                  HEADER_HEIGHT +
                  rowAxis.start(editing.cell.r) +
                  (editingFrozen?.r ? scrollY : 0),
                left:
                  HEADER_WIDTH +
                  colAxis.start(editing.cell.c) +
                  (editingFrozen?.c ? scrollX : 0),
                height: Math.max(
                  rowAxis.size(editing.cell.r),
                  DEFAULT_ROW_HEIGHT * zoom,
                ),
                width: Math.max(
                  colAxis.size(editing.cell.c),
                  (editing.value.length * 8 + 20) * zoom,
                ),
                background: activeStyle.fill ?? undefined,
                // El borde de la caja de edición es el del editor, no el de la celda.
                borderTop: undefined,
                borderRight: undefined,
                borderBottom: undefined,
                borderLeft: undefined,
              }}
              onChange={(value, nextCaret) => {
                setEditing({ ...editing, value });
                setCaret(nextCaret);
                setPointing(null);
                setAssistDismissed(false);
              }}
              onCaret={setCaret}
              onKeyDown={onEditorKeyDown}
              onBlur={() => commit()}
            />
          )}

          {/* Contorno punteado de lo que se copió o cortó */}
          {copied && (
            <div className="copy-outline" style={rangeBox(copied.range)} />
          )}

          {/* Guía mientras se arrastra el borde de una columna o fila */}
          {resize && (
            <div
              className={`resize-guide ${resize.axis}`}
              style={
                resize.axis === "col"
                  ? {
                      left:
                        HEADER_WIDTH +
                        colAxis.start(resize.index) +
                        resize.size,
                    }
                  : {
                      top:
                        HEADER_HEIGHT +
                        rowAxis.start(resize.index) +
                        resize.size,
                    }
              }
            />
          )}
        </div>
      </div>

      <SheetTabs
        names={view.sheet_names}
        active={sheet}
        onSelect={switchSheet}
        onAdd={addSheet}
        onRename={(i, name) => mutate(() => sheetApi.renameSheet(i, name))}
        onDuplicate={(i) => {
          resetSelection();
          mutate(() => sheetApi.duplicateSheet(i));
        }}
        onDelete={(i) => {
          resetSelection();
          mutate(() => sheetApi.deleteSheet(i));
        }}
        onMove={(i, to) => mutate(() => sheetApi.moveSheet(i, to))}
      >
        {status && (
          <span
            className={`sheet-status ${status.error ? "error" : ""}`}
            role="status"
          >
            {status.text}
          </span>
        )}
        {stats && stats.count > 0 && (
          <span
            className="sheet-stats"
            title={
              stats.numbers
                ? `Mínimo: ${statsFormat.format(stats.min ?? 0)} · Máximo: ${statsFormat.format(stats.max ?? 0)}`
                : undefined
            }
          >
            {stats.numbers > 0 && (
              <span>
                Promedio: {statsFormat.format(stats.sum / stats.numbers)}
              </span>
            )}
            <span>Recuento: {statsFormat.format(stats.count)}</span>
            {stats.numbers > 0 && (
              <span>Suma: {statsFormat.format(stats.sum)}</span>
            )}
          </span>
        )}
        <div className="sheet-views" role="group" aria-label="Vista de la hoja">
          <button
            type="button"
            className={breakView ? "" : "on"}
            aria-pressed={!breakView}
            title="Normal"
            onClick={() => breakView && setBreakView(false)}
          >
            Normal
          </button>
          <button
            type="button"
            className={breakView ? "on" : ""}
            aria-pressed={breakView}
            aria-label="Vista previa de salto de página"
            title="Vista previa de salto de página: ver y acomodar las páginas que se imprimen"
            onClick={() => !breakView && setBreakView(true)}
          >
            Saltos de página
          </button>
        </div>
        {!breakView && (
          <button
            type="button"
            className={`page-break-toggle${showBreaks ? " on" : ""}`}
            aria-pressed={showBreaks}
            onClick={() => setShowBreaks(!showBreaks)}
            title={
              showBreaks && pageBreaks
                ? `Cortes de página: ${pageBreaks.pages} ${pageBreaks.pages === 1 ? "página" : "páginas"} con las últimas opciones de impresión`
                : "Mostrar dónde corta cada página al imprimir"
            }
          >
            Cortes de página
          </button>
        )}
        <ZoomControl zoom={zoom} onChange={(z) => setZoom(z)} />
      </SheetTabs>

      {editing &&
        assist &&
        !assistDismissed &&
        assist.value === editing.value &&
        (assist.suggestions.length > 0 || assist.signature) && (
          <FormulaAssist
            anchor={(() => {
              const box = activeInput()?.getBoundingClientRect();
              return { left: box?.left ?? 0, top: box?.bottom ?? 0 };
            })()}
            language={language}
            suggestions={assist.suggestions}
            selected={assist.selected}
            onPick={acceptSuggestion}
            signature={assist.signature}
          />
        )}

      {chartPanel !== null &&
        (() => {
          const chart = view.drawings.find((d) => d.id === chartPanel);
          return chart && chart.type === "chart" ? (
            <ChartPanel
              chart={chart}
              onChange={(patch) => updateDrawing(chart.id, patch)}
              onDelete={() => deleteDrawing(chart.id)}
              onClose={() => setChartPanel(null)}
            />
          ) : null;
        })()}

      {chartMenu && (
        <ContextMenu
          x={chartMenu.x}
          y={chartMenu.y}
          onClose={() => setChartMenu(null)}
          items={CHART_TYPES.map((t) => ({
            label:
              t.kind === "combo"
                ? "Gráfica combinada (columnas y línea)"
                : `Gráfica de ${t.label.toLowerCase()}`,
            action: () => insertChart(t.kind),
          }))}
        />
      )}

      {dialog === "conditional" && (
        <ConditionalFormatDialog
          sheet={sheet}
          range={usedSelection()}
          onAdd={addConditionalRule}
          onDelete={(index) =>
            mutate(() => sheetApi.deleteConditionalRule(sheet, index))
          }
          onClose={() => {
            setDialog(null);
            focusGrid();
          }}
        />
      )}
      {tableDialog && (
        <TableDialog
          rangeLabel={`${cellName({ r: tableDialog.range.r1, c: tableDialog.range.c1 })}:${cellName({ r: tableDialog.range.r2, c: tableDialog.range.c2 })}`}
          table={tableDialog.table}
          onSave={saveTable}
          onRemove={removeTable}
          onClose={() => {
            setTableDialog(null);
            focusGrid();
          }}
        />
      )}
      {fnDialog && (
        <FunctionDialog
          language={language}
          onInsert={insertFunction}
          onClose={() => setFnDialog(false)}
        />
      )}
      {dupDialog && (
        <DuplicatesDialog
          region={dupDialog}
          headers={Array.from(
            { length: dupDialog.c2 - dupDialog.c1 + 1 },
            (_, i) => rows[dupDialog.r1]?.[dupDialog.c1 + i]?.[0] ?? "",
          )}
          initialHeader={looksLikeHeader(rows, dupDialog)}
          onApply={(cols, header) => removeDuplicates(dupDialog, cols, header)}
          onClose={() => {
            setDupDialog(null);
            focusGrid();
          }}
        />
      )}
      {sortDialog && (
        <SortDialog
          region={sortDialog}
          headers={Array.from(
            { length: sortDialog.c2 - sortDialog.c1 + 1 },
            (_, i) => rows[sortDialog.r1]?.[sortDialog.c1 + i]?.[0] ?? "",
          )}
          initialHeader={looksLikeHeader(rows, sortDialog)}
          onSort={(levels, header) => sortByLevels(sortDialog, levels, header)}
          onClose={() => {
            setSortDialog(null);
            focusGrid();
          }}
        />
      )}
      {linkDialog && (
        <LinkDialog
          text={rows[linkDialog.r]?.[linkDialog.c]?.[0] ?? ""}
          target={links.get(`${linkDialog.r},${linkDialog.c}`)?.target ?? null}
          onSave={saveLink}
          onRemove={() => removeLink(linkDialog)}
          onClose={() => {
            setLinkDialog(null);
            focusGrid();
          }}
        />
      )}
      {dialog === "print" && (
        <PrintDialog
          selectionLabel={
            selection.r1 === selection.r2 && selection.c1 === selection.c2
              ? cellName({ r: selection.r1, c: selection.c1 })
              : `${cellName({ r: selection.r1, c: selection.c1 })}:${cellName({ r: selection.r2, c: selection.c2 })}`
          }
          page={
            view.page ?? {
              header: "",
              footer: "",
              repeat_rows: null,
              print_area: null,
            }
          }
          initial={printInitial}
          rangeFor={printRangeFor}
          data={printData}
          fileName={fileName}
          sheetName={view.sheet_names[sheet] ?? ""}
          loadImages={loadPrintImages}
          onPrint={startPrint}
          onPickArea={(options, form) => {
            setDialog(null);
            setPickingArea({ options, form });
            focusGrid();
          }}
          pdf={pdfDialog}
          onClose={() => {
            setDialog(null);
            setPrintInitial(null);
            focusGrid();
          }}
        />
      )}
      {pickingArea && (
        <div className="print-pick-bar" role="status">
          <span>
            Selecciona el área de impresión en la hoja: <b>{selectionLabel}</b>
          </span>
          <button
            type="button"
            className="btn"
            onClick={() => finishPicking(false)}
          >
            Cancelar
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => finishPicking(true)}
          >
            Listo
          </button>
        </div>
      )}
      {printJob && (
        <PrintSheet
          job={printJob}
          view={view}
          cols={baseCols}
          rows={baseRows}
          merged={merged}
          decorations={decorations}
        />
      )}
      {dialog === "validation" && (
        <ValidationDialog
          range={
            activeValidation && !isMultiSelection
              ? {
                  r1: activeValidation.row1 - 1,
                  c1: activeValidation.col1 - 1,
                  r2: activeValidation.row2 - 1,
                  c2: activeValidation.col2 - 1,
                }
              : usedSelection()
          }
          current={activeValidation}
          onSave={saveValidation}
          onClose={() => {
            setDialog(null);
            focusGrid();
          }}
        />
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu.kind)}
          onClose={() => setMenu(null)}
        />
      )}

      {filterMenu && (
        <FilterMenu
          x={filterMenu.x}
          y={filterMenu.y}
          column={columnName(filterMenu.col)}
          values={filterValues(filterMenu.region, filterMenu.col)}
          current={filter?.cols[filterMenu.col] ?? null}
          onApply={(spec) =>
            applyFilter(filterMenu.region, filterMenu.col, spec)
          }
          onSort={(ascending) =>
            sortByLevels(
              filterMenu.region,
              [{ col: filterMenu.col, ascending }],
              true,
            )
          }
          onClose={() => setFilterMenu(null)}
        />
      )}
    </div>
  );
}

/** Cuadro amarillo para escribir una nota. ⌘↩ (o salir del cuadro) guarda; Esc cancela. */
function NoteEditor(props: {
  style: { left: number; top: number };
  initial: string;
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(props.initial);
  const done = useRef(false);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    if (save) props.onSave(text);
    else props.onCancel();
  };
  return (
    <div
      className="note-bubble editing"
      style={props.style}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <textarea
        className="note-input"
        aria-label="Nota de la celda"
        placeholder="Escribe una nota…"
        value={text}
        autoFocus
        onChange={(e) => setText(e.target.value)}
        onBlur={() => finish(true)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") finish(false);
          else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) finish(true);
        }}
      />
      <small className="note-hint">
        {keys("⌘")}↩ para guardar · Esc para cancelar
      </small>
    </div>
  );
}
