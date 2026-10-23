// Colores de las tablas ("Dar formato como tabla"), parecidos a los estilos
// medianos de Excel. Los usa la cuadrícula y la versión para imprimir.

import type { StyleView, TableStyle, TableView } from "../../lib/spreadsheet";

export const TABLE_COLORS: Record<TableStyle, { label: string; header: string; text: string; band: string }> = {
  azul: { label: "Azul", header: "#4472C4", text: "#FFFFFF", band: "#D9E1F2" },
  verde: { label: "Verde", header: "#70AD47", text: "#FFFFFF", band: "#E2EFDA" },
  naranja: { label: "Naranja", header: "#ED7D31", text: "#FFFFFF", band: "#FCE4D6" },
  gris: { label: "Gris", header: "#A5A5A5", text: "#FFFFFF", band: "#EDEDED" },
  dorado: { label: "Dorado", header: "#FFC000", text: "#1F1F1F", band: "#FFF2CC" },
  celeste: { label: "Celeste", header: "#5B9BD5", text: "#FFFFFF", band: "#DDEBF7" },
  oscuro: { label: "Oscuro", header: "#404040", text: "#FFFFFF", band: "#E7E6E6" },
};

/** Tabla que contiene la celda (fila y columna desde 0). */
export function tableAt(tables: TableView[], r: number, c: number): TableView | undefined {
  return tables.find((t) => r + 1 >= t.row1 && r + 1 <= t.row2 && c + 1 >= t.col1 && c + 1 <= t.col2);
}

/** Lo que filtra una tabla: sus encabezados y datos, sin la fila de totales (desde 0). */
export function tableRegion(t: TableView) {
  return { r1: t.row1 - 1, c1: t.col1 - 1, r2: t.row2 - 1 - (t.totals ? 1 : 0), c2: t.col2 - 1 };
}

/**
 * El estilo con el que se ve una celda de tabla: encabezados con color, filas
 * alternas (bandas) y totales en negrita. El formato propio de la celda manda.
 */
export function withTableStyle(style: StyleView, table: TableView | undefined, r: number): StyleView {
  if (!table) return style;
  const colors = TABLE_COLORS[table.style] ?? TABLE_COLORS.azul;
  const row = r + 1;
  if (row === table.row1) {
    return { ...style, b: true, fill: style.fill ?? colors.header, color: style.color ?? colors.text };
  }
  if (table.totals && row === table.row2) {
    const line = { style: "double", color: colors.header };
    return { ...style, b: true, borders: [style.borders[0] ?? line, style.borders[1], style.borders[2], style.borders[3]] };
  }
  const banded = table.banded && (row - table.row1 - 1) % 2 === 0;
  return banded ? { ...style, fill: style.fill ?? colors.band } : style;
}
