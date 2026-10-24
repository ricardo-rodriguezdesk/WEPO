// Modelo de una presentación de WEPO Present.
//
// Las medidas van en píxeles de la diapositiva (96 por pulgada, como CSS), así
// que una diapositiva 16:9 de PowerPoint (13.333 × 7.5 pulgadas) mide 1280 × 720.
// En el .pptx todo va en EMU: 9525 EMU = 1 píxel. Los tamaños de letra van en puntos.

export const EMU_PER_PX = 9525;

export type Run = {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  /** Puntos. */
  size?: number;
  /** "#RRGGBB". */
  color?: string;
  font?: string;
  link?: string;
};

export type Para = {
  runs: Run[];
  align?: "left" | "center" | "right" | "justify";
  /** Nivel de sangría de la lista (0 a 8). */
  level?: number;
  bullet?: "bullet" | "number" | null;
  /** Puntos. */
  spaceBefore?: number;
  spaceAfter?: number;
  /** Múltiplo del interlineado (1 = sencillo). */
  lineSpacing?: number;
  /** Tamaño del párrafo vacío (para que conserve su alto). */
  endSize?: number;
};

export type TextBody = {
  paras: Para[];
  anchor?: "top" | "middle" | "bottom";
  /** Márgenes internos en px: izquierda, arriba, derecha, abajo. */
  insets?: [number, number, number, number];
  /** Tamaño de letra por omisión del cuadro (puntos), heredado del diseño. */
  defaultSize?: number;
  /** Escala de la letra cuando PowerPoint la achicó para que quepa. */
  fontScale?: number;
};

export type Line = { color: string; width: number; dash?: "solid" | "dash" | "dot" };

type Box = { id: string; x: number; y: number; w: number; h: number; rot?: number; flipH?: boolean; flipV?: boolean; name?: string };

/** Para qué sirve el cuadro en el diseño de la diapositiva (título, subtítulo, contenido). */
export type Role = "title" | "subtitle" | "body";

export type ShapeElement = Box & {
  kind: "shape";
  /** Forma predefinida de PowerPoint ("rect", "ellipse", "roundRect"…). */
  geom: string;
  fill: string | null;
  line: Line | null;
  text?: TextBody;
  role?: Role;
  /** Marcador de posición del diseño (para guardarlo igual en el .pptx). */
  placeholder?: { type: string | null; idx: string | null };
};

export type ImageElement = Box & { kind: "image"; src: string };

/** `merged`: la celda está tapada por otra combinada a su izquierda ("h") o arriba ("v"). */
export type TableCell = { text: TextBody; fill: string | null; span?: number; rowSpan?: number; merged?: "h" | "v" };
export type TableElement = Box & { kind: "table"; cols: number[]; rows: { h: number; cells: TableCell[] }[]; border: string | null; header: boolean };

/** Gráfica de la diapositiva: los datos van en ella misma (en el .pptx, con su libro de Excel). */
export type ChartKind = "column" | "bar" | "line" | "area" | "pie" | "doughnut";
export type ChartSeries = { name: string; values: (number | null)[]; color: string };
export type ChartElement = Box & {
  kind: "chart";
  chartType: ChartKind;
  title: string;
  legend: boolean;
  stacked: boolean;
  /** Valores escritos sobre las barras, los puntos o las rebanadas. */
  labels: boolean;
  categories: string[];
  series: ChartSeries[];
};

export type SlideElement = ShapeElement | ImageElement | TableElement | ChartElement;

export type LayoutId = "title" | "titleContent" | "twoContent" | "titleOnly" | "section" | "blank";

/** Cómo entra la diapositiva al presentar. */
/** "none": sin efecto (sirve para que pase sola después de un tiempo). */
export type TransitionKind = "none" | "fade" | "push" | "wipe" | "cover" | "zoom" | "split";
export type Direction = "left" | "right" | "up" | "down";
export type Transition = {
  kind: TransitionKind;
  /** Milisegundos que dura. */
  duration: number;
  /** Hacia dónde se mueve (empujar, barrido, cubrir). */
  direction?: Direction;
  /** Pasar sola a la siguiente después de estos milisegundos (además del clic). */
  advanceAfter?: number | null;
};

export type Slide = {
  id: string;
  layout: LayoutId;
  /** Color de fondo propio; null = el del tema. */
  background: string | null;
  /** Imagen de fondo (data URL). */
  backgroundImage?: string | null;
  elements: SlideElement[];
  notes: string;
  hidden?: boolean;
  transition?: Transition | null;
};

export type Theme = {
  id: string;
  name: string;
  colors: {
    dk1: string;
    lt1: string;
    dk2: string;
    lt2: string;
    accent1: string;
    accent2: string;
    accent3: string;
    accent4: string;
    accent5: string;
    accent6: string;
    hlink: string;
    folHlink: string;
  };
  fonts: { major: string; minor: string };
  /** Fondo de las diapositivas y color del texto y los títulos. */
  background: string;
  text: string;
  title: string;
};

export type Deck = {
  width: number;
  height: number;
  slides: Slide[];
  theme: Theme;
  /** Cosas del archivo que WEPO todavía no conserva. */
  unsupported: string[];
};

// ───────────── ids ─────────────

let counter = 0;
export function uid(prefix = "e"): string {
  counter++;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}`;
}

// ───────────── temas ─────────────

const OFFICE_COLORS: Theme["colors"] = {
  dk1: "#000000",
  lt1: "#FFFFFF",
  dk2: "#0E2841",
  lt2: "#E8E8E8",
  accent1: "#156082",
  accent2: "#E97132",
  accent3: "#196B24",
  accent4: "#0F9ED5",
  accent5: "#A02B93",
  accent6: "#4EA72E",
  hlink: "#467886",
  folHlink: "#96607D",
};

export const THEMES: Theme[] = [
  {
    id: "wepo",
    name: "WEPO",
    colors: { ...OFFICE_COLORS, accent1: "#5B5BD6", accent2: "#D9572B", accent3: "#1F8A55", accent4: "#3B6FD8", accent5: "#C42B45", accent6: "#E0A100" },
    fonts: { major: "Helvetica Neue", minor: "Helvetica Neue" },
    background: "#FFFFFF",
    text: "#1D1D1F",
    title: "#1D1D1F",
  },
  {
    id: "office",
    name: "Office",
    colors: OFFICE_COLORS,
    fonts: { major: "Aptos Display", minor: "Aptos" },
    background: "#FFFFFF",
    text: "#000000",
    title: "#000000",
  },
  {
    id: "noche",
    name: "Noche",
    colors: { ...OFFICE_COLORS, dk1: "#FFFFFF", lt1: "#14141C", accent1: "#8B8BF0", accent2: "#F08A62", accent3: "#3CCF85", accent4: "#6F9BF0", accent5: "#F0707F", accent6: "#F5C451" },
    fonts: { major: "Avenir Next", minor: "Avenir Next" },
    background: "#14141C",
    text: "#E9E9F0",
    title: "#FFFFFF",
  },
  {
    id: "oceano",
    name: "Océano",
    colors: { ...OFFICE_COLORS, accent1: "#0B6E99", accent2: "#14A3A1", accent3: "#F2A541", accent4: "#2B4C7E", accent5: "#E4572E", accent6: "#76B041" },
    fonts: { major: "Georgia", minor: "Verdana" },
    background: "#F3F8FB",
    text: "#1C3144",
    title: "#0B4F6C",
  },
  {
    id: "terracota",
    name: "Terracota",
    colors: { ...OFFICE_COLORS, accent1: "#B5543A", accent2: "#D9A441", accent3: "#6B8F71", accent4: "#3E5641", accent5: "#8C4A2F", accent6: "#C98B6B" },
    fonts: { major: "Palatino", minor: "Gill Sans" },
    background: "#FBF5EF",
    text: "#3B2A22",
    title: "#7A2E1C",
  },
  {
    id: "menta",
    name: "Menta",
    colors: { ...OFFICE_COLORS, accent1: "#1F8A55", accent2: "#3CB4A0", accent3: "#F2C14E", accent4: "#2D6A4F", accent5: "#F07167", accent6: "#457B9D" },
    fonts: { major: "Trebuchet MS", minor: "Trebuchet MS" },
    background: "#F2FAF5",
    text: "#1B3A2B",
    title: "#14532D",
  },
];

export const DEFAULT_THEME = THEMES[0];

// ───────────── diseños ─────────────

export const LAYOUTS: { id: LayoutId; name: string }[] = [
  { id: "title", name: "Diapositiva de título" },
  { id: "titleContent", name: "Título y contenido" },
  { id: "twoContent", name: "Dos columnas" },
  { id: "section", name: "Encabezado de sección" },
  { id: "titleOnly", name: "Solo título" },
  { id: "blank", name: "En blanco" },
];

const para = (text: string, extra: Partial<Para> = {}): Para => ({ runs: text ? [{ text }] : [], ...extra });

/** Cuadros de texto de un diseño, con el texto de ejemplo que se ve mientras están vacíos. */
export function layoutElements(layout: LayoutId, width: number, height: number): ShapeElement[] {
  const m = width * 0.0625; // margen lateral
  const box = (role: Role, x: number, y: number, w: number, h: number, size: number, anchor: TextBody["anchor"], align: Para["align"], ph: ShapeElement["placeholder"]): ShapeElement => ({
    id: uid(),
    kind: "shape",
    geom: "rect",
    fill: null,
    line: null,
    x: Math.round(x),
    y: Math.round(y),
    w: Math.round(w),
    h: Math.round(h),
    role,
    placeholder: ph,
    text: { paras: [para("", { align, bullet: role === "body" ? "bullet" : null })], anchor, defaultSize: size },
  });
  switch (layout) {
    case "title":
      return [
        box("title", m * 1.5, height * 0.22, width - m * 3, height * 0.32, 54, "bottom", "center", { type: "ctrTitle", idx: null }),
        box("subtitle", m * 1.5, height * 0.57, width - m * 3, height * 0.2, 24, "top", "center", { type: "subTitle", idx: "1" }),
      ];
    case "titleContent":
      return [
        box("title", m, height * 0.05, width - m * 2, height * 0.2, 40, "middle", "left", { type: "title", idx: null }),
        box("body", m, height * 0.28, width - m * 2, height * 0.64, 24, "top", "left", { type: null, idx: "1" }),
      ];
    case "twoContent":
      return [
        box("title", m, height * 0.05, width - m * 2, height * 0.2, 40, "middle", "left", { type: "title", idx: null }),
        box("body", m, height * 0.28, (width - m * 2) / 2 - 12, height * 0.64, 22, "top", "left", { type: null, idx: "1" }),
        box("body", width / 2 + 12, height * 0.28, (width - m * 2) / 2 - 12, height * 0.64, 22, "top", "left", { type: null, idx: "2" }),
      ];
    case "section":
      return [
        box("title", m, height * 0.32, width - m * 2, height * 0.3, 54, "bottom", "left", { type: "title", idx: null }),
        box("subtitle", m, height * 0.64, width - m * 2, height * 0.14, 22, "top", "left", { type: "body", idx: "1" }),
      ];
    case "titleOnly":
      return [box("title", m, height * 0.05, width - m * 2, height * 0.2, 40, "middle", "left", { type: "title", idx: null })];
    default:
      return [];
  }
}

/** Texto gris que se ve en un cuadro vacío del diseño. */
export function placeholderHint(role: Role | undefined): string {
  return role === "title" ? "Haz clic para agregar un título" : role === "subtitle" ? "Haz clic para agregar un subtítulo" : "Haz clic para agregar texto";
}

export function newSlide(layout: LayoutId, deck: Pick<Deck, "width" | "height">): Slide {
  return { id: uid("s"), layout, background: null, elements: layoutElements(layout, deck.width, deck.height), notes: "" };
}

export function newDeck(): Deck {
  const deck: Deck = { width: 1280, height: 720, slides: [], theme: DEFAULT_THEME, unsupported: [] };
  deck.slides.push(newSlide("title", deck));
  return deck;
}

/** ¿El cuadro no tiene nada de texto? */
export function isEmptyText(text: TextBody | undefined): boolean {
  return !text || text.paras.every((p) => p.runs.every((r) => !r.text));
}

/** Texto plano de una diapositiva (para las notas, buscar o el nombre de la miniatura). */
export function slideTitle(slide: Slide): string {
  const title = slide.elements.find((e) => e.kind === "shape" && e.role === "title") as ShapeElement | undefined;
  return title?.text?.paras.map((p) => p.runs.map((r) => r.text).join("")).join(" ").trim() ?? "";
}

export function cloneElement<T extends SlideElement>(el: T, dx = 0, dy = 0): T {
  return { ...structuredClone(el), id: uid(), x: el.x + dx, y: el.y + dy };
}

export function cloneSlide(slide: Slide): Slide {
  return { ...structuredClone(slide), id: uid("s"), elements: slide.elements.map((e) => cloneElement(e)) };
}
