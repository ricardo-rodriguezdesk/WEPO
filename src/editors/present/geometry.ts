// Formas predefinidas de PowerPoint dibujadas como trayectos SVG.
// Las que WEPO no dibuja se ven como rectángulo, pero al guardar conservan su nombre.

export const SHAPES: { geom: string; name: string }[] = [
  { geom: "rect", name: "Rectángulo" },
  { geom: "roundRect", name: "Rectángulo redondeado" },
  { geom: "ellipse", name: "Elipse" },
  { geom: "triangle", name: "Triángulo" },
  { geom: "rtTriangle", name: "Triángulo rectángulo" },
  { geom: "diamond", name: "Rombo" },
  { geom: "parallelogram", name: "Paralelogramo" },
  { geom: "trapezoid", name: "Trapecio" },
  { geom: "pentagon", name: "Pentágono" },
  { geom: "hexagon", name: "Hexágono" },
  { geom: "octagon", name: "Octágono" },
  { geom: "rightArrow", name: "Flecha a la derecha" },
  { geom: "leftArrow", name: "Flecha a la izquierda" },
  { geom: "upArrow", name: "Flecha arriba" },
  { geom: "downArrow", name: "Flecha abajo" },
  { geom: "chevron", name: "Cheurón" },
  { geom: "star5", name: "Estrella" },
  { geom: "heart", name: "Corazón" },
  { geom: "wedgeRoundRectCallout", name: "Globo de diálogo" },
  { geom: "line", name: "Línea" },
];

const poly = (pts: [number, number][]) => `M${pts.map(([x, y]) => `${round(x)},${round(y)}`).join("L")}Z`;
const round = (n: number) => Math.round(n * 100) / 100;

function regular(sides: number, w: number, h: number, start = -Math.PI / 2): string {
  const pts: [number, number][] = [];
  for (let i = 0; i < sides; i++) {
    const a = start + (i * 2 * Math.PI) / sides;
    pts.push([w / 2 + (w / 2) * Math.cos(a), h / 2 + (h / 2) * Math.sin(a)]);
  }
  return poly(pts);
}

/** Trayecto SVG de la forma en una caja de w × h. `line` se dibuja de esquina a esquina. */
export function shapePath(geom: string, w: number, h: number): { d: string; open?: boolean } {
  switch (geom) {
    case "ellipse":
    case "flowChartConnector":
      return { d: `M${w / 2},0A${w / 2},${h / 2} 0 1 1 ${w / 2 - 0.01},0Z` };
    case "roundRect":
    case "flowChartAlternateProcess": {
      const r = Math.min(w, h) * 0.1667;
      return { d: `M${r},0H${w - r}A${r},${r} 0 0 1 ${w},${r}V${h - r}A${r},${r} 0 0 1 ${w - r},${h}H${r}A${r},${r} 0 0 1 0,${h - r}V${r}A${r},${r} 0 0 1 ${r},0Z` };
    }
    case "triangle":
    case "flowChartExtract":
      return { d: poly([[w / 2, 0], [w, h], [0, h]]) };
    case "rtTriangle":
      return { d: poly([[0, 0], [w, h], [0, h]]) };
    case "diamond":
    case "flowChartDecision":
      return { d: poly([[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]]) };
    case "parallelogram":
    case "flowChartInputOutput": {
      const o = Math.min(w, h) * 0.25;
      return { d: poly([[o, 0], [w, 0], [w - o, h], [0, h]]) };
    }
    case "trapezoid": {
      const o = Math.min(w, h) * 0.25;
      return { d: poly([[o, 0], [w - o, 0], [w, h], [0, h]]) };
    }
    case "pentagon":
      return { d: regular(5, w, h) };
    case "homePlate": {
      const o = Math.min(w, h) * 0.5;
      return { d: poly([[0, 0], [w - o, 0], [w, h / 2], [w - o, h], [0, h]]) };
    }
    case "hexagon": {
      const o = Math.min(w, h) * 0.25;
      return { d: poly([[o, 0], [w - o, 0], [w, h / 2], [w - o, h], [o, h], [0, h / 2]]) };
    }
    case "octagon": {
      const o = Math.min(w, h) * 0.29;
      return { d: poly([[o, 0], [w - o, 0], [w, o], [w, h - o], [w - o, h], [o, h], [0, h - o], [0, o]]) };
    }
    case "rightArrow": {
      const head = Math.min(w * 0.5, h * 0.5);
      return { d: poly([[0, h * 0.25], [w - head, h * 0.25], [w - head, 0], [w, h / 2], [w - head, h], [w - head, h * 0.75], [0, h * 0.75]]) };
    }
    case "leftArrow": {
      const head = Math.min(w * 0.5, h * 0.5);
      return { d: poly([[w, h * 0.25], [head, h * 0.25], [head, 0], [0, h / 2], [head, h], [head, h * 0.75], [w, h * 0.75]]) };
    }
    case "upArrow": {
      const head = Math.min(w * 0.5, h * 0.5);
      return { d: poly([[w * 0.25, h], [w * 0.25, head], [0, head], [w / 2, 0], [w, head], [w * 0.75, head], [w * 0.75, h]]) };
    }
    case "downArrow": {
      const head = Math.min(w * 0.5, h * 0.5);
      return { d: poly([[w * 0.25, 0], [w * 0.75, 0], [w * 0.75, h - head], [w, h - head], [w / 2, h], [0, h - head], [w * 0.25, h - head]]) };
    }
    case "chevron": {
      const o = Math.min(w, h) * 0.5;
      return { d: poly([[0, 0], [w - o, 0], [w, h / 2], [w - o, h], [0, h], [o, h / 2]]) };
    }
    case "star5": {
      const pts: [number, number][] = [];
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const r = i % 2 ? 0.38 : 1;
        pts.push([w / 2 + (w / 2) * r * Math.cos(a), h / 2 + (h / 2) * r * Math.sin(a)]);
      }
      return { d: poly(pts) };
    }
    case "heart":
      return {
        d: `M${w / 2},${h * 0.25}C${w / 2},${h * 0.1} ${w * 0.4},0 ${w * 0.25},0C${w * 0.1},0 0,${h * 0.12} 0,${h * 0.3}C0,${h * 0.55} ${w * 0.25},${h * 0.72} ${w / 2},${h}C${w * 0.75},${h * 0.72} ${w},${h * 0.55} ${w},${h * 0.3}C${w},${h * 0.12} ${w * 0.9},0 ${w * 0.75},0C${w * 0.6},0 ${w / 2},${h * 0.1} ${w / 2},${h * 0.25}Z`,
      };
    case "wedgeRoundRectCallout":
    case "wedgeRectCallout": {
      const r = geom === "wedgeRectCallout" ? 0 : Math.min(w, h) * 0.12;
      const b = h * 0.8;
      return {
        d: `M${r},0H${w - r}${r ? `A${r},${r} 0 0 1 ${w},${r}` : ""}V${b - r}${r ? `A${r},${r} 0 0 1 ${w - r},${b}` : ""}H${w * 0.42}L${w * 0.2},${h}L${w * 0.27},${b}H${r}${r ? `A${r},${r} 0 0 1 0,${b - r}` : ""}V${r}${r ? `A${r},${r} 0 0 1 ${r},0` : ""}Z`,
      };
    }
    case "ellipseRibbon":
    case "can":
    case "cube":
    default:
      if (geom === "line" || geom === "straightConnector1" || geom.startsWith("bentConnector") || geom.startsWith("curvedConnector")) {
        return { d: `M0,0L${w},${h}`, open: true };
      }
      return { d: `M0,0H${w}V${h}H0Z` };
  }
}

export const KNOWN_GEOMS = new Set([
  "rect",
  "roundRect",
  "ellipse",
  "triangle",
  "rtTriangle",
  "diamond",
  "parallelogram",
  "trapezoid",
  "pentagon",
  "homePlate",
  "hexagon",
  "octagon",
  "rightArrow",
  "leftArrow",
  "upArrow",
  "downArrow",
  "chevron",
  "star5",
  "heart",
  "wedgeRoundRectCallout",
  "wedgeRectCallout",
  "line",
  "straightConnector1",
  "flowChartConnector",
  "flowChartAlternateProcess",
  "flowChartExtract",
  "flowChartDecision",
  "flowChartInputOutput",
]);

export function isLine(geom: string): boolean {
  return geom === "line" || geom === "straightConnector1" || geom.startsWith("bentConnector") || geom.startsWith("curvedConnector");
}
