import { useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import EditorToolbar from "../../components/EditorToolbar";
import type { Workbook } from "../../lib/spreadsheet";
import { columnName } from "../../lib/spreadsheet";
import "./SheetEditor.css";

const ROW_HEIGHT = 24;
const COL_WIDTH = 110;
const HEADER_WIDTH = 50;
const MIN_ROWS = 100;
const MIN_COLS = 26;

type Props = {
  workbook: Workbook;
  fileName: string;
  onHome: () => void;
  onOpen: () => void;
};

/** WEPO Sheets: cuadrícula virtualizada con pestañas de hojas. */
export default function SheetEditor({ workbook, fileName, onHome, onOpen }: Props) {
  const [activeSheet, setActiveSheet] = useState(0);
  const [selected, setSelected] = useState<{ r: number; c: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const rows = workbook.sheets[activeSheet]?.rows ?? [];
  const rowCount = Math.max(MIN_ROWS, rows.length + 20);
  const colCount = Math.max(MIN_COLS, ...rows.map((r) => r.length + 5));

  // Solo se dibujan las filas y columnas visibles: así un archivo
  // de cientos de miles de celdas sigue siendo fluido.
  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });
  const colVirtualizer = useVirtualizer({
    horizontal: true,
    count: colCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => COL_WIDTH,
    overscan: 4,
  });

  // Desplazamiento horizontal actual: mantiene fijos los números de fila.
  const scrollX = colVirtualizer.scrollOffset ?? 0;
  const selectedValue = selected ? rows[selected.r]?.[selected.c] ?? "" : "";

  function switchSheet(index: number) {
    setActiveSheet(index);
    setSelected(null);
    scrollRef.current?.scrollTo(0, 0);
  }

  return (
    <div className="editor kind-sheets">
      <EditorToolbar kind="sheets" fileName={fileName} onHome={onHome} onOpen={onOpen} />

      <div className="formula-bar">
        <span className="cell-ref">
          {selected ? `${columnName(selected.c)}${selected.r + 1}` : ""}
        </span>
        <input readOnly value={selectedValue} aria-label="Contenido de la celda" />
      </div>

      <div className="grid-scroll" ref={scrollRef}>
        <div
          className="grid-canvas"
          style={{
            width: colVirtualizer.getTotalSize() + HEADER_WIDTH,
            height: rowVirtualizer.getTotalSize() + ROW_HEIGHT,
          }}
        >
          {/* Encabezados de columna (A, B, C…) fijos arriba */}
          <div className="col-headers" style={{ width: colVirtualizer.getTotalSize() + HEADER_WIDTH }}>
            <div className="corner" style={{ left: scrollX, width: HEADER_WIDTH }} />
            {colVirtualizer.getVirtualItems().map((col) => (
              <div
                key={col.key}
                className={`col-header ${selected?.c === col.index ? "active" : ""}`}
                style={{ left: col.start + HEADER_WIDTH, width: col.size }}
              >
                {columnName(col.index)}
              </div>
            ))}
          </div>

          {rowVirtualizer.getVirtualItems().map((row) => (
            <div key={row.key}>
              {/* Número de fila fijo a la izquierda */}
              <div
                className={`row-header ${selected?.r === row.index ? "active" : ""}`}
                style={{ top: row.start + ROW_HEIGHT, left: scrollX, height: row.size, width: HEADER_WIDTH }}
              >
                {row.index + 1}
              </div>
              {colVirtualizer.getVirtualItems().map((col) => {
                const value = rows[row.index]?.[col.index] ?? "";
                const isSelected = selected?.r === row.index && selected?.c === col.index;
                const isNumber = value !== "" && !isNaN(Number(value));
                return (
                  <div
                    key={col.key}
                    className={`cell ${isSelected ? "selected" : ""} ${isNumber ? "number" : ""}`}
                    style={{
                      top: row.start + ROW_HEIGHT,
                      left: col.start + HEADER_WIDTH,
                      width: col.size,
                      height: row.size,
                    }}
                    onClick={() => setSelected({ r: row.index, c: col.index })}
                    title={value}
                  >
                    {value}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      <footer className="sheet-tabs">
        {workbook.sheets.map((s, i) => (
          <button
            key={`${i}-${s.name}`}
            className={`btn ${i === activeSheet ? "active" : ""}`}
            onClick={() => switchSheet(i)}
          >
            {s.name}
          </button>
        ))}
      </footer>
    </div>
  );
}
