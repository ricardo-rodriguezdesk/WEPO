import { useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useVirtualizer } from "@tanstack/react-virtual";
import "./App.css";

type Sheet = { name: string; rows: string[][] };
type Workbook = { sheets: Sheet[] };

const ROW_HEIGHT = 24;
const COL_WIDTH = 110;
const HEADER_WIDTH = 50;
const MIN_ROWS = 100;
const MIN_COLS = 26;

// 0 -> A, 25 -> Z, 26 -> AA ...
function columnName(index: number): string {
  let name = "";
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

export default function App() {
  const [workbook, setWorkbook] = useState<Workbook | null>(null);
  const [fileName, setFileName] = useState("Sin título");
  const [activeSheet, setActiveSheet] = useState(0);
  const [selected, setSelected] = useState<{ r: number; c: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const sheet = workbook?.sheets[activeSheet];
  const rows = sheet?.rows ?? [];
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

  async function openFile() {
    const path = await open({
      multiple: false,
      filters: [
        { name: "Hojas de cálculo", extensions: ["xlsx", "xlsm", "xlsb", "xls", "ods", "csv"] },
      ],
    });
    if (!path) return;
    try {
      const wb = await invoke<Workbook>("open_file", { path });
      setWorkbook(wb);
      setActiveSheet(0);
      setSelected(null);
      setError(null);
      setFileName(path.split("/").pop() ?? path);
      scrollRef.current?.scrollTo(0, 0);
    } catch (e) {
      setError(String(e));
    }
  }

  // Desplazamiento horizontal actual: mantiene fijos los números de fila.
  const scrollX = colVirtualizer.scrollOffset ?? 0;

  const selectedValue = selected ? rows[selected.r]?.[selected.c] ?? "" : "";

  return (
    <div className="app">
      <header className="toolbar">
        <button onClick={openFile}>Abrir…</button>
        <span className="file-name">{fileName}</span>
      </header>

      <div className="formula-bar">
        <span className="cell-ref">
          {selected ? `${columnName(selected.c)}${selected.r + 1}` : ""}
        </span>
        <input readOnly value={selectedValue} />
      </div>

      {error && <div className="error">No se pudo abrir el archivo: {error}</div>}

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

      {workbook && (
        <footer className="sheet-tabs">
          {workbook.sheets.map((s, i) => (
            <button
              key={s.name}
              className={i === activeSheet ? "active" : ""}
              onClick={() => {
                setActiveSheet(i);
                setSelected(null);
              }}
            >
              {s.name}
            </button>
          ))}
        </footer>
      )}
    </div>
  );
}
