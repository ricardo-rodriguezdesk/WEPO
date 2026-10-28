// Barras del esquema (grupos de filas y columnas), como en Excel: a la izquierda
// de los números de fila y arriba de las letras, con una línea por grupo, el
// botón − / + debajo (o a la derecha) de cada uno y los botones 1, 2, 3… en la esquina.

import type { GroupView, OutlineAction, OutlineView } from "../../lib/spreadsheet";
import type { Axis } from "./layout";
import { HEADER_HEIGHT, HEADER_WIDTH } from "./layout";

/** Ancho de cada nivel en la barra. */
export const LEVEL_STEP = 14;

export function gutterSize(levels: number) {
  return levels > 0 ? LEVEL_STEP * (levels + 1) + 4 : 0;
}

type Props = {
  outline: OutlineView;
  rowAxis: Axis;
  colAxis: Axis;
  scrollX: number;
  scrollY: number;
  onAction: (action: OutlineAction) => void;
};

/** ¿Está escondido dentro de un grupo de afuera que está contraído? */
function insideCollapsed(g: GroupView, list: GroupView[]) {
  return list.some((o) => o.collapsed && o.level < g.level && o.start <= g.start && o.end >= g.end);
}

function Bars({ list, levels, axis, scroll, columns, onAction }: { list: GroupView[]; levels: number; axis: Axis; scroll: number; columns: boolean; onAction: Props["onAction"] }) {
  const header = columns ? HEADER_WIDTH : HEADER_HEIGHT;
  const name = columns ? "columnas" : "filas";
  return (
    <>
      <div className={`outline-levels ${columns ? "cols" : "rows"}`} style={columns ? { width: header } : { height: header }}>
        {Array.from({ length: levels + 1 }, (_, i) => (
          <button
            key={i}
            type="button"
            className="outline-level"
            title={i === levels ? `Mostrar todas las ${name}` : `Mostrar el nivel ${i + 1} de ${name}`}
            aria-label={`Nivel ${i + 1} de ${name}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onAction({ kind: "level", columns, level: i + 1 })}
          >
            {i + 1}
          </button>
        ))}
      </div>
      <div className="outline-track" style={columns ? { left: header } : { top: header }}>
        {list.map((g) => {
          if (insideCollapsed(g, list)) return null;
          const at = (LEVEL_STEP * (g.level - 1)) + 4;
          const from = axis.start(g.start - 1) - scroll;
          const to = axis.start(g.end) - scroll;
          // El botón va en la fila (o columna) de resumen: la de después del grupo.
          const summary = axis.start(g.end) - scroll;
          const size = Math.max(14, axis.size(g.end));
          const button = (
            <button
              type="button"
              className="outline-toggle"
              style={columns ? { left: summary + 2, top: at } : { top: summary + 2, left: at }}
              title={g.collapsed ? `Expandir ${name} ${g.start}–${g.end}` : `Contraer ${name} ${g.start}–${g.end}`}
              aria-label={`${g.collapsed ? "Expandir" : "Contraer"} el grupo de ${name} ${columns ? `${g.start}–${g.end}` : `${g.start} a ${g.end}`}`}
              aria-expanded={!g.collapsed}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onAction({ kind: "collapse", columns, level: g.level, start: g.start, collapsed: !g.collapsed })}
            >
              {g.collapsed ? "+" : "−"}
            </button>
          );
          return (
            <div key={`${g.level}-${g.start}`}>
              {!g.collapsed && to > from && (
                <div
                  className={`outline-line ${columns ? "h" : "v"}`}
                  style={columns ? { left: from + 2, width: to - from - 2, top: at + 6 } : { top: from + 2, height: to - from - 2, left: at + 6 }}
                />
              )}
              {size > 0 && button}
            </div>
          );
        })}
      </div>
    </>
  );
}

export default function OutlineGutter({ outline, rowAxis, colAxis, scrollX, scrollY, onAction }: Props) {
  const left = gutterSize(outline.row_levels);
  const top = gutterSize(outline.col_levels);
  return (
    <>
      {left > 0 && (
        <div className="outline-gutter rows" style={{ width: left, top }} aria-label="Grupos de filas">
          <Bars list={outline.rows} levels={outline.row_levels} axis={rowAxis} scroll={scrollY} columns={false} onAction={onAction} />
        </div>
      )}
      {top > 0 && (
        <div className="outline-gutter cols" style={{ height: top, left }} aria-label="Grupos de columnas">
          <Bars list={outline.cols} levels={outline.col_levels} axis={colAxis} scroll={scrollX} columns onAction={onAction} />
        </div>
      )}
      {left > 0 && top > 0 && <div className="outline-corner" style={{ width: left, height: top }} />}
    </>
  );
}
