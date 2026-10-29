// Leer presentaciones de PowerPoint (.pptx) para WEPO Present.
//
// En un .pptx casi nada viene completo en la diapositiva: la posición de un
// título, su tamaño de letra o si el contenido lleva viñetas se heredan del
// diseño (slideLayout), del patrón (slideMaster) y del tema. Aquí se resuelve
// esa herencia y cada cuadro queda con sus valores propios, listos para dibujar.

import JSZip from "jszip";
import type { ChartElement, Deck, ImageElement, Media, LayoutId, Line, Para, Role, Run, ShapeElement, Slide, SlideElement, TableElement, TextBody, Theme } from "./model";
import { DEFAULT_THEME, EMU_PER_PX, uid } from "./model";
import { readChartXml } from "./charts";
import { readTransition } from "./transitions";
import { readMediaTiming, readTiming } from "./animations";
import { audioIcon, mediaMime } from "./media";

const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

// ───────────── XML ─────────────

function parse(xml: string): Element {
  return new DOMParser().parseFromString(xml, "application/xml").documentElement;
}
function kids(el: Element | null | undefined, name?: string): Element[] {
  if (!el) return [];
  return Array.from(el.children).filter((c) => !name || c.localName === name);
}
function child(el: Element | null | undefined, name: string): Element | undefined {
  return kids(el, name)[0];
}
/** Camino de hijos: path(el, "spPr", "xfrm", "off"). */
function path(el: Element | null | undefined, ...names: string[]): Element | undefined {
  let cur: Element | undefined = el ?? undefined;
  for (const n of names) cur = child(cur, n);
  return cur;
}
function num(el: Element | null | undefined, name: string): number | null {
  const v = el?.getAttribute(name);
  return v === null || v === undefined || v === "" ? null : Number(v);
}
const px = (emu: number | null) => (emu === null ? 0 : Math.round((emu / EMU_PER_PX) * 100) / 100);

// ───────────── colores ─────────────

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function rgbToHex([r, g, b]: number[]): string {
  return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}
function rgbToHsl([r, g, b]: number[]): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}
function hslToRgb([h, s, l]: number[]): [number, number, number] {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}

/** Aplica los modificadores de DrawingML (lumMod, lumOff, tint, shade) a un color. */
function modify(hex: string, el: Element): string {
  let rgb = hexToRgb(hex);
  for (const m of kids(el)) {
    const v = (num(m, "val") ?? 0) / 100000;
    if (m.localName === "lumMod" || m.localName === "lumOff") {
      const hsl = rgbToHsl(rgb);
      hsl[2] = m.localName === "lumMod" ? hsl[2] * v : hsl[2] + v;
      hsl[2] = Math.max(0, Math.min(1, hsl[2]));
      rgb = hslToRgb(hsl);
    } else if (m.localName === "tint") rgb = rgb.map((c) => c + (255 - c) * (1 - v)) as typeof rgb;
    else if (m.localName === "shade") rgb = rgb.map((c) => c * v) as typeof rgb;
  }
  return rgbToHex(rgb);
}

const PRESET_COLORS: Record<string, string> = { black: "#000000", white: "#FFFFFF", red: "#FF0000", green: "#008000", blue: "#0000FF", yellow: "#FFFF00", gray: "#808080", orange: "#FFA500" };

// ───────────── lector ─────────────

type Rel = { target: string; type: string; external: boolean };
type Placeholder = { type: string | null; idx: string | null; sp: Element };
type Part = { root: Element; rels: Map<string, Rel>; path: string; placeholders: Placeholder[] };

/** Estilo de texto de una fuente de la cadena de herencia (lstStyle o txStyles). */
type StyleSource = Element | undefined;

const LAYOUT_TYPES: Record<string, LayoutId> = {
  title: "title",
  obj: "titleContent",
  tx: "titleContent",
  twoObj: "twoContent",
  twoTxTwoObj: "twoContent",
  secHead: "section",
  titleOnly: "titleOnly",
  blank: "blank",
};

function phOf(sp: Element): { type: string | null; idx: string | null } | null {
  const ph = path(sp, "nvSpPr", "nvPr", "ph") ?? path(sp, "nvPicPr", "nvPr", "ph") ?? path(sp, "nvGraphicFramePr", "nvPr", "ph");
  if (!ph) return null;
  return { type: ph.getAttribute("type"), idx: ph.getAttribute("idx") };
}

function roleOf(type: string | null): Role {
  return type === "title" || type === "ctrTitle" ? "title" : type === "subTitle" ? "subtitle" : "body";
}

/** Número de forma (cNvPr id) de un elemento de la diapositiva. */
function shapeId(el: Element): string | null {
  const nv = kids(el).find((c) => c.localName.startsWith("nv") && c.localName.endsWith("Pr"));
  return child(nv, "cNvPr")?.getAttribute("id") ?? null;
}

class PptxReader {
  unsupported = new Set<string>();
  /** Mientras se lee una diapositiva: número de forma → id del elemento (para las animaciones). */
  private shapeIds: Map<string, string> | null = null;
  theme: Theme = structuredClone(DEFAULT_THEME);
  private schemeColors = new Map<string, string>();
  private parts = new Map<string, Part>();
  private defaultTextStyle: Element | undefined;

  constructor(private zip: JSZip) {}

  async text(p: string): Promise<string | null> {
    return (await this.zip.file(p)?.async("string")) ?? null;
  }

  async rels(partPath: string): Promise<Map<string, Rel>> {
    const dir = partPath.slice(0, partPath.lastIndexOf("/"));
    const relPath = `${dir}/_rels/${partPath.slice(partPath.lastIndexOf("/") + 1)}.rels`;
    const xml = await this.text(relPath);
    const out = new Map<string, Rel>();
    if (!xml) return out;
    for (const r of kids(parse(xml), "Relationship")) {
      const external = r.getAttribute("TargetMode") === "External";
      const target = r.getAttribute("Target") ?? "";
      out.set(r.getAttribute("Id") ?? "", { target: external ? target : resolvePath(dir, target), type: r.getAttribute("Type") ?? "", external });
    }
    return out;
  }

  async part(p: string): Promise<Part | null> {
    const cached = this.parts.get(p);
    if (cached) return cached;
    const xml = await this.text(p);
    if (!xml) return null;
    const root = parse(xml);
    const placeholders: Placeholder[] = [];
    const tree = path(root, "cSld", "spTree");
    for (const sp of kids(tree)) {
      const ph = phOf(sp);
      if (ph) placeholders.push({ ...ph, sp });
    }
    const part = { root, rels: await this.rels(p), path: p, placeholders };
    this.parts.set(p, part);
    return part;
  }

  relOfType(part: Part, type: string): Rel | undefined {
    return [...part.rels.values()].find((r) => r.type.endsWith(`/${type}`));
  }

  // ───── tema y colores ─────

  async loadTheme(themePath: string) {
    const xml = await this.text(themePath);
    if (!xml) return;
    const root = parse(xml);
    const scheme = path(root, "themeElements", "clrScheme");
    for (const c of kids(scheme)) {
      const v = child(c, "srgbClr")?.getAttribute("val") ?? child(c, "sysClr")?.getAttribute("lastClr");
      if (v) this.schemeColors.set(c.localName, `#${v.toUpperCase()}`);
    }
    const fonts = path(root, "themeElements", "fontScheme");
    const major = path(fonts, "majorFont", "latin")?.getAttribute("typeface");
    const minor = path(fonts, "minorFont", "latin")?.getAttribute("typeface");
    const c = (k: string, fallback: string) => this.schemeColors.get(k) ?? fallback;
    this.theme = {
      id: "archivo",
      name: root.getAttribute("name") || "Del archivo",
      colors: {
        dk1: c("dk1", "#000000"),
        lt1: c("lt1", "#FFFFFF"),
        dk2: c("dk2", "#44546A"),
        lt2: c("lt2", "#E7E6E6"),
        accent1: c("accent1", "#4472C4"),
        accent2: c("accent2", "#ED7D31"),
        accent3: c("accent3", "#A5A5A5"),
        accent4: c("accent4", "#FFC000"),
        accent5: c("accent5", "#5B9BD5"),
        accent6: c("accent6", "#70AD47"),
        hlink: c("hlink", "#0563C1"),
        folHlink: c("folHlink", "#954F72"),
      },
      fonts: { major: major || "Calibri Light", minor: minor || "Calibri" },
      background: c("lt1", "#FFFFFF"),
      text: c("dk1", "#000000"),
      title: c("dk1", "#000000"),
    };
  }

  /** Mapa bg1→lt1, tx1→dk1… del patrón. */
  private clrMap = new Map<string, string>([
    ["bg1", "lt1"],
    ["tx1", "dk1"],
    ["bg2", "lt2"],
    ["tx2", "dk2"],
  ]);

  setClrMap(master: Part) {
    const map = child(master.root, "clrMap");
    if (!map) return;
    for (const a of Array.from(map.attributes)) this.clrMap.set(a.name, a.value);
    // El fondo y el texto "normales" del tema, según el patrón.
    const bg = this.schemeColors.get(this.clrMap.get("bg1") ?? "lt1");
    const tx = this.schemeColors.get(this.clrMap.get("tx1") ?? "dk1");
    if (bg) this.theme.background = bg;
    if (tx) this.theme.text = this.theme.title = tx;
  }

  /** Color de un elemento que contiene srgbClr, schemeClr, sysClr o prstClr. `phClr` es el color que llega de un estilo. */
  color(el: Element | undefined, phClr?: string): string | null {
    if (!el) return null;
    for (const c of kids(el)) {
      let base: string | null = null;
      if (c.localName === "srgbClr") base = `#${(c.getAttribute("val") ?? "000000").toUpperCase()}`;
      else if (c.localName === "sysClr") base = `#${(c.getAttribute("lastClr") ?? "000000").toUpperCase()}`;
      else if (c.localName === "prstClr") base = PRESET_COLORS[c.getAttribute("val") ?? ""] ?? "#000000";
      else if (c.localName === "schemeClr") {
        const v = c.getAttribute("val") ?? "";
        if (v === "phClr") base = phClr ?? null;
        else base = this.schemeColors.get(this.clrMap.get(v) ?? v) ?? null;
      } else if (c.localName === "scrgbClr") {
        base = rgbToHex(["r", "g", "b"].map((k) => ((num(c, k) ?? 0) / 100000) * 255));
      }
      if (base) return modify(base, c);
    }
    return null;
  }

  /** Relleno: color sólido, el primer color de un degradado, o null si no tiene. `undefined` = no lo dice. */
  fill(spPr: Element | undefined): string | null | undefined {
    if (!spPr) return undefined;
    if (child(spPr, "noFill")) return null;
    const solid = child(spPr, "solidFill");
    if (solid) return this.color(solid);
    const grad = child(spPr, "gradFill");
    if (grad) return this.color(path(grad, "gsLst", "gs"));
    if (child(spPr, "blipFill")) this.unsupported.add("formas con imagen de relleno");
    if (child(spPr, "pattFill")) return this.color(path(spPr, "pattFill", "fgClr"));
    return undefined;
  }

  line(ln: Element | undefined): Line | null | undefined {
    if (!ln) return undefined;
    if (child(ln, "noFill")) return null;
    const color = this.color(child(ln, "solidFill")) ?? this.color(path(child(ln, "gradFill"), "gsLst", "gs"));
    if (!color) return undefined;
    const width = Math.max(0.75, px(num(ln, "w") ?? 12700));
    const dash = path(ln, "prstDash")?.getAttribute("val") ?? "solid";
    return { color, width, dash: dash === "solid" ? "solid" : dash.toLowerCase().includes("dot") ? "dot" : "dash" };
  }

  // ───── estilos de texto ─────

  /** Fuentes de estilo de un cuadro, de la más cercana a la más general. */
  styleChain(sp: Element, layout: Part | null, master: Part | null): StyleSource[] {
    const ph = phOf(sp);
    const chain: StyleSource[] = [path(sp, "txBody", "lstStyle")];
    if (ph) {
      const fromLayout = layout ? findPlaceholder(layout, ph) : undefined;
      const fromMaster = master ? findPlaceholder(master, ph, true) : undefined;
      chain.push(path(fromLayout, "txBody", "lstStyle"), path(fromMaster, "txBody", "lstStyle"));
      const styles = path(master?.root, "txStyles");
      chain.push(child(styles, ph.type === "title" || ph.type === "ctrTitle" ? "titleStyle" : "bodyStyle"));
    } else {
      chain.push(path(master?.root, "txStyles", "otherStyle"));
    }
    chain.push(this.defaultTextStyle);
    return chain;
  }

  /** Primera fuente que define algo para el nivel: pPr del nivel y su defRPr. */
  levelProps(chain: StyleSource[], level: number): Element[] {
    const out: Element[] = [];
    for (const s of chain) {
      const lvl = child(s, `lvl${level + 1}pPr`);
      if (lvl) out.push(lvl);
    }
    return out;
  }

  run(r: Element, inherited: Element[], linkRels: Map<string, Rel>, fontScale: number, styleColor: string | null = null, ownLevels = 0): Run {
    const rPr = child(r, "rPr");
    // Cada propiedad: la del texto, o la primera de la herencia que la tenga.
    const fromChain = (attrName: string) => {
      const own = rPr?.getAttribute(attrName);
      if (own !== null && own !== undefined) return own;
      for (const lvl of inherited) {
        const v = child(lvl, "defRPr")?.getAttribute(attrName);
        if (v !== null && v !== undefined) return v;
      }
      return null;
    };
    const colorEl = (() => {
      const own = child(rPr, "solidFill");
      if (own) return own;
      // El color del estilo de la forma (fontRef) gana a los estilos generales del patrón,
      // pero no a lo que diga el propio párrafo o el cuadro.
      if (styleColor) {
        const close = inherited.slice(0, ownLevels).map((lvl) => path(lvl, "defRPr", "solidFill")).find(Boolean);
        return close ?? null;
      }
      for (const lvl of inherited) {
        const f = path(lvl, "defRPr", "solidFill");
        if (f) return f;
      }
      return undefined;
    })();
    const latin = (() => {
      const own = path(rPr, "latin")?.getAttribute("typeface");
      if (own) return own;
      for (const lvl of inherited) {
        const v = path(lvl, "defRPr", "latin")?.getAttribute("typeface");
        if (v) return v;
      }
      return null;
    })();
    const out: Run = { text: r.localName === "br" ? "\n" : (child(r, "t")?.textContent ?? "") };
    const sz = fromChain("sz");
    if (sz) out.size = Math.round((Number(sz) / 100) * fontScale * 10) / 10;
    if (["1", "true"].includes(fromChain("b") ?? "")) out.bold = true;
    if (["1", "true"].includes(fromChain("i") ?? "")) out.italic = true;
    const u = fromChain("u");
    if (u && u !== "none") out.underline = true;
    const strike = fromChain("strike");
    if (strike && strike !== "noStrike") out.strike = true;
    // Sin color propio ni heredado, el que indica el estilo de la forma (fontRef).
    const color = (colorEl ? this.color(colorEl) : null) ?? styleColor;
    if (color) out.color = color;
    if (latin) out.font = latin === "+mj-lt" ? this.theme.fonts.major : latin === "+mn-lt" ? this.theme.fonts.minor : latin;
    const link = path(rPr, "hlinkClick")?.getAttributeNS(R, "id");
    const rel = link ? linkRels.get(link) : undefined;
    if (rel?.external) out.link = rel.target;
    return out;
  }

  textBody(sp: Element, layout: Part | null, master: Part | null, rels: Map<string, Rel>): TextBody | undefined {
    const body = child(sp, "txBody");
    if (!body) return undefined;
    const ph = phOf(sp);
    const fromLayout = ph && layout ? findPlaceholder(layout, ph) : undefined;
    const fromMaster = ph && master ? findPlaceholder(master, ph, true) : undefined;
    const bodyPr = [child(body, "bodyPr"), path(fromLayout, "txBody", "bodyPr"), path(fromMaster, "txBody", "bodyPr")];
    const bodyAttr = (name: string) => bodyPr.map((b) => b?.getAttribute(name)).find((v) => v !== null && v !== undefined) ?? null;
    const anchor = bodyAttr("anchor");
    const fontScale = (num(path(child(body, "bodyPr"), "normAutofit"), "fontScale") ?? 100000) / 100000;
    const inset = (name: string, fallback: number) => {
      const v = bodyAttr(name);
      return v === null ? fallback : px(Number(v));
    };
    const chain = this.styleChain(sp, layout, master);
    const styleColor = this.color(path(sp, "style", "fontRef"));
    const paras: Para[] = [];
    for (const p of kids(body, "p")) {
      const pPr = child(p, "pPr");
      const level = num(pPr, "lvl") ?? 0;
      const inherited = [...(pPr ? [pPr] : []), ...this.levelProps(chain, level)];
      // Cuántas de esas fuentes son del propio cuadro (el párrafo y el lstStyle de la forma).
      const ownLevels = (pPr ? 1 : 0) + (child(chain[0], `lvl${level + 1}pPr`) ? 1 : 0);
      const pick = (attrName: string) => inherited.map((e) => e.getAttribute(attrName)).find((v) => v !== null && v !== undefined) ?? null;
      const pickChild = (name: string) => inherited.map((e) => child(e, name)).find(Boolean);
      const algn = pick("algn");
      const para: Para = { runs: [], level };
      if (algn === "ctr") para.align = "center";
      else if (algn === "r") para.align = "right";
      else if (algn === "just" || algn === "dist") para.align = "justify";
      // Viñetas: la primera definición (buNone, buChar o buAutoNum) que aparezca en la herencia.
      for (const e of inherited) {
        if (child(e, "buNone")) {
          para.bullet = null;
          break;
        }
        if (child(e, "buChar") || child(e, "buBlip")) {
          para.bullet = "bullet";
          break;
        }
        if (child(e, "buAutoNum")) {
          para.bullet = "number";
          break;
        }
      }
      const spacing = (name: string) => {
        const pts = num(path(pickChild(name), "spcPts"), "val");
        return pts === null ? undefined : pts / 100;
      };
      const before = spacing("spcBef");
      const after = spacing("spcAft");
      if (before !== undefined) para.spaceBefore = before;
      if (after !== undefined) para.spaceAfter = after;
      const lnPct = num(path(pickChild("lnSpc"), "spcPct"), "val");
      if (lnPct !== null) para.lineSpacing = lnPct / 100000;
      for (const r of kids(p)) {
        if (r.localName === "r" || r.localName === "br" || r.localName === "fld") para.runs.push(this.run(r, inherited, rels, fontScale, styleColor, ownLevels));
      }
      const end = child(p, "endParaRPr")?.getAttribute("sz") ?? pick("sz") ?? child(inherited.find((e) => child(e, "defRPr")?.getAttribute("sz")), "defRPr")?.getAttribute("sz");
      if (end) para.endSize = Math.round((Number(end) / 100) * fontScale * 10) / 10;
      paras.push(para);
    }
    // Tamaño de letra por omisión del cuadro (para los párrafos nuevos).
    const lvl1 = this.levelProps(chain, 0).map((e) => child(e, "defRPr")?.getAttribute("sz")).find(Boolean);
    return {
      paras: paras.length ? paras : [{ runs: [] }],
      anchor: anchor === "ctr" ? "middle" : anchor === "b" ? "bottom" : "top",
      insets: [inset("lIns", 9.6), inset("tIns", 4.8), inset("rIns", 9.6), inset("bIns", 4.8)],
      defaultSize: lvl1 ? (Number(lvl1) / 100) * fontScale : 18,
      fontScale: fontScale !== 1 ? fontScale : undefined,
    };
  }

  // ───── elementos ─────

  /** Posición y tamaño (del propio cuadro o heredados de su marcador de posición). */
  box(xfrmOwner: Element | undefined, fallbacks: (Element | undefined)[]) {
    const xfrm = [xfrmOwner, ...fallbacks].map((e) => child(e, "xfrm")).find((x) => x && child(x, "off"));
    const off = child(xfrm, "off");
    const ext = child(xfrm, "ext");
    return {
      x: px(num(off, "x")),
      y: px(num(off, "y")),
      w: px(num(ext, "cx")),
      h: px(num(ext, "cy")),
      rot: num(xfrm, "rot") ? (num(xfrm, "rot") ?? 0) / 60000 : undefined,
      flipH: xfrm?.getAttribute("flipH") === "1" || undefined,
      flipV: xfrm?.getAttribute("flipV") === "1" || undefined,
    };
  }

  async image(rel: Rel | undefined): Promise<string | null> {
    if (!rel || rel.external) return null;
    const file = this.zip.file(rel.target);
    if (!file) return null;
    const ext = rel.target.split(".").pop()?.toLowerCase() ?? "";
    const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : ext === "svg" ? "image/svg+xml" : null;
    if (!mime) {
      this.unsupported.add("imágenes en formatos que no son PNG, JPEG o GIF");
      return null;
    }
    return `data:${mime};base64,${await file.async("base64")}`;
  }

  /** Video o audio de un <p:pic> (si lo tiene y viene dentro del archivo). */
  async media(pic: Element, part: Part): Promise<Media | null> {
    const nvPr = path(pic, "nvPicPr", "nvPr");
    const file = child(nvPr, "videoFile") ?? child(nvPr, "audioFile") ?? child(nvPr, "quickTimeFile") ?? child(nvPr, "wavAudioFile");
    if (!file) return null;
    const type: Media["type"] = file.localName === "audioFile" || file.localName === "wavAudioFile" ? "audio" : "video";
    // El de Office 2010 (p14:media) es el que va dentro del archivo; el otro puede ser un vínculo.
    const p14 = Array.from(nvPr!.getElementsByTagNameNS("*", "media"))[0];
    const ids = [p14?.getAttributeNS(R, "embed"), file.getAttributeNS(R, "link"), file.getAttributeNS(R, "embed")].filter((v): v is string => Boolean(v));
    for (const id of ids) {
      const rel = part.rels.get(id);
      if (!rel || rel.external) continue;
      const zipped = this.zip.file(rel.target);
      const mime = mediaMime(rel.target.split(".").pop() ?? "");
      if (!zipped || !mime) continue;
      return { type, src: `data:${mime};base64,${await zipped.async("base64")}` };
    }
    this.unsupported.add(type === "video" ? "videos vinculados o en formatos que WEPO no reproduce" : "audios vinculados o en formatos que WEPO no reproduce");
    return null;
  }

  async elements(tree: Element | undefined, part: Part, layout: Part | null, master: Part | null, inheritedOnly = false): Promise<SlideElement[]> {
    const out: SlideElement[] = [];
    const mark = (source: Element, element: SlideElement) => {
      const id = shapeId(source);
      if (id && this.shapeIds && !inheritedOnly) this.shapeIds.set(id, element.id);
    };
    for (const el of kids(tree)) {
      const name = el.localName;
      if (name === "sp" || name === "cxnSp") {
        const ph = phOf(el);
        // En el diseño y el patrón, los marcadores de posición no se dibujan (los llena la diapositiva).
        if (inheritedOnly && ph) continue;
        const fromLayout = ph && layout ? findPlaceholder(layout, ph) : undefined;
        const fromMaster = ph && master ? findPlaceholder(master, ph, true) : undefined;
        const spPr = child(el, "spPr");
        const style = child(el, "style");
        const geom = path(spPr, "prstGeom")?.getAttribute("prst") ?? (child(spPr, "custGeom") ? "rect" : name === "cxnSp" ? "line" : "rect");
        if (child(spPr, "custGeom")) this.unsupported.add("formas libres");
        const styleFill = num(path(style, "fillRef"), "idx") ? this.color(path(style, "fillRef")) : null;
        const fill = this.fill(spPr);
        const styleLine = num(path(style, "lnRef"), "idx") ? this.color(path(style, "lnRef")) : null;
        const line = this.line(child(spPr, "ln"));
        const text = this.textBody(el, layout, master, part.rels);
        const shape: ShapeElement = {
          id: uid(),
          kind: "shape",
          name: path(el, "nvSpPr", "cNvPr")?.getAttribute("name") ?? undefined,
          ...this.box(spPr, [child(fromLayout, "spPr"), child(fromMaster, "spPr")]),
          geom,
          fill: fill === undefined ? (ph ? (this.fill(child(fromLayout, "spPr")) ?? null) : styleFill) : fill,
          line: line === undefined ? (styleLine && !ph ? { color: styleLine, width: 1 } : null) : line,
          text,
          role: ph ? roleOf(ph.type) : undefined,
          placeholder: ph ?? undefined,
        };
        if (shape.w <= 0 && shape.h <= 0) continue;
        mark(el, shape);
        out.push(shape);
      } else if (name === "pic") {
        const ph = phOf(el);
        if (inheritedOnly && ph) continue;
        const media = await this.media(el, part);
        const embed = path(el, "blipFill", "blip")?.getAttributeNS(R, "embed");
        const src = (await this.image(embed ? part.rels.get(embed) : undefined)) ?? (media ? audioIcon() : null);
        if (path(el, "blipFill", "srcRect")) this.unsupported.add("imágenes recortadas");
        const fromLayout = ph && layout ? findPlaceholder(layout, ph) : undefined;
        if (src) {
          const image = { id: uid(), kind: "image", src, ...this.box(child(el, "spPr"), [child(fromLayout, "spPr")]) } as ImageElement;
          if (media) {
            image.media = media;
            image.name = path(el, "nvPicPr", "cNvPr")?.getAttribute("name") ?? undefined;
          }
          mark(el, image);
          out.push(image);
        }
      } else if (name === "grpSp") {
        // Los grupos se desarman: cada pieza queda en su lugar en la diapositiva.
        const xfrm = path(el, "grpSpPr", "xfrm");
        const off = child(xfrm, "off");
        const ext = child(xfrm, "ext");
        const chOff = child(xfrm, "chOff");
        const chExt = child(xfrm, "chExt");
        const sx = (num(ext, "cx") ?? 1) / (num(chExt, "cx") || num(ext, "cx") || 1);
        const sy = (num(ext, "cy") ?? 1) / (num(chExt, "cy") || num(ext, "cy") || 1);
        const inner = await this.elements(el, part, layout, master, inheritedOnly);
        for (const e of inner) {
          e.x = px(num(off, "x")) + (e.x - px(num(chOff, "x"))) * sx;
          e.y = px(num(off, "y")) + (e.y - px(num(chOff, "y"))) * sy;
          e.w *= sx;
          e.h *= sy;
          out.push(e);
        }
      } else if (name === "graphicFrame") {
        const uri = path(el, "graphic", "graphicData")?.getAttribute("uri") ?? "";
        if (uri.endsWith("/table")) {
          const table = this.table(el, part);
          if (table) (mark(el, table), out.push(table));
        } else if (uri.endsWith("/chart")) {
          const chart = await this.chart(el, part);
          if (chart) (mark(el, chart), out.push(chart));
          else this.unsupported.add("gráficas");
        } else if (uri.includes("chart")) this.unsupported.add("gráficas");
        else if (uri.includes("diagram")) this.unsupported.add("SmartArt");
        else this.unsupported.add("objetos incrustados");
      } else if (name === "AlternateContent") {
        // Contenido nuevo con versión de respaldo: se lee el respaldo.
        const fallback = child(el, "Fallback");
        if (fallback) out.push(...(await this.elements(fallback, part, layout, master, inheritedOnly)));
      } else if (name === "contentPart") {
        this.unsupported.add("dibujos a mano (tinta)");
      }
    }
    return out;
  }

  /** Gráfica: el graphicFrame apunta a chartN.xml, que trae los datos en su caché. */
  async chart(frame: Element, part: Part): Promise<ChartElement | null> {
    const ref = path(frame, "graphic", "graphicData", "chart");
    const rel = ref ? part.rels.get(ref.getAttributeNS(R, "id") ?? "") : undefined;
    if (!rel || rel.external) return null;
    const xml = await this.text(rel.target);
    if (!xml) return null;
    const data = readChartXml(xml, this.theme, (el) => this.color(el));
    if (!data) return null;
    for (const u of data.unsupported) this.unsupported.add(u);
    const { unsupported: _u, ...rest } = data;
    const xfrm = child(frame, "xfrm");
    return {
      id: uid(),
      kind: "chart",
      name: path(frame, "nvGraphicFramePr", "cNvPr")?.getAttribute("name") ?? undefined,
      x: px(num(child(xfrm, "off"), "x")),
      y: px(num(child(xfrm, "off"), "y")),
      w: px(num(child(xfrm, "ext"), "cx")),
      h: px(num(child(xfrm, "ext"), "cy")),
      ...rest,
    };
  }

  table(frame: Element, part: Part): TableElement | null {
    const tbl = path(frame, "graphic", "graphicData", "tbl");
    if (!tbl) return null;
    const xfrm = child(frame, "xfrm");
    const cols = kids(child(tbl, "tblGrid"), "gridCol").map((c) => px(num(c, "w")));
    const header = path(tbl, "tblPr")?.getAttribute("firstRow") === "1";
    const rows: TableElement["rows"] = [];
    kids(tbl, "tr").forEach((tr, ri) => {
      const cells = kids(tr, "tc").map((tc) => {
        const tcPr = child(tc, "tcPr");
        const body = this.textBody(tc, null, null, part.rels) ?? { paras: [{ runs: [] }] };
        // Las tablas de PowerPoint toman colores de su estilo; aquí se usan los del tema.
        const fill = this.fill(tcPr) ?? (header && ri === 0 ? this.theme.colors.accent1 : null);
        // Encabezado de la tabla: texto blanco y en negrita, salvo que el archivo diga otro color.
        if (header && ri === 0) {
          for (const p of body.paras) for (const r of p.runs) if (!r.color || r.color === this.theme.text) (r.color = "#FFFFFF"), (r.bold = true);
        }
        return {
          text: body,
          fill: fill ?? null,
          span: num(tc, "gridSpan") ?? undefined,
          rowSpan: num(tc, "rowSpan") ?? undefined,
          merged: tc.getAttribute("hMerge") === "1" ? ("h" as const) : tc.getAttribute("vMerge") === "1" ? ("v" as const) : undefined,
        };
      });
      rows.push({ h: px(num(tr, "h")), cells });
    });
    return {
      id: uid(),
      kind: "table",
      x: px(num(child(xfrm, "off"), "x")),
      y: px(num(child(xfrm, "off"), "y")),
      w: cols.reduce((a, b) => a + b, 0),
      h: rows.reduce((a, r) => a + r.h, 0),
      cols,
      rows,
      border: "#BFBFBF",
      header,
    };
  }

  async background(parts: (Part | null)[]): Promise<{ color: string | null; image: string | null }> {
    for (const part of parts) {
      const bg = path(part?.root, "cSld", "bg");
      if (!bg || !part) continue;
      const bgPr = child(bg, "bgPr");
      if (bgPr) {
        const blip = path(bgPr, "blipFill", "blip")?.getAttributeNS(R, "embed");
        if (blip) return { color: null, image: await this.image(part.rels.get(blip)) };
        const fill = this.fill(bgPr);
        if (fill) return { color: fill, image: null };
      }
      const ref = child(bg, "bgRef");
      if (ref) {
        const c = this.color(ref);
        if (c) return { color: c, image: null };
      }
    }
    return { color: null, image: null };
  }

  async notes(slide: Part): Promise<string> {
    const rel = this.relOfType(slide, "notesSlide");
    if (!rel) return "";
    const notes = await this.part(rel.target);
    if (!notes) return "";
    const body = notes.placeholders.find((p) => p.type === "body");
    if (!body) return "";
    return kids(child(body.sp, "txBody"), "p")
      .map((p) => Array.from(p.getElementsByTagNameNS(A, "t")).map((t) => t.textContent ?? "").join(""))
      .join("\n")
      .trim();
  }

  async read(): Promise<Deck> {
    const pres = await this.part("ppt/presentation.xml");
    if (!pres) throw new Error("El archivo no parece una presentación de PowerPoint (no tiene ppt/presentation.xml)");
    const size = child(pres.root, "sldSz");
    const width = px(num(size, "cx") ?? 12192000);
    const height = px(num(size, "cy") ?? 6858000);
    this.defaultTextStyle = child(pres.root, "defaultTextStyle");
    const themeRel = this.relOfType(pres, "theme");
    if (themeRel) await this.loadTheme(themeRel.target);

    const slides: Slide[] = [];
    let clrMapSet = false;
    for (const sldId of kids(child(pres.root, "sldIdLst"), "sldId")) {
      const rel = pres.rels.get(sldId.getAttributeNS(R, "id") ?? "");
      if (!rel) continue;
      const slide = await this.part(rel.target);
      if (!slide) continue;
      const layoutRel = this.relOfType(slide, "slideLayout");
      const layout = layoutRel ? await this.part(layoutRel.target) : null;
      const masterRel = layout ? this.relOfType(layout, "slideMaster") : undefined;
      const master = masterRel ? await this.part(masterRel.target) : null;
      if (master && !clrMapSet) {
        this.setClrMap(master);
        clrMapSet = true;
      }
      const { transition, other } = readTransition(slide.root);
      if (other) this.unsupported.add("algunas transiciones (se cambian por Desvanecer)");

      // Lo que el patrón y el diseño dibujan en todas las diapositivas (logos, franjas…) va al fondo.
      const inherited: SlideElement[] = [];
      const showMaster = (part: Part | null) => part?.root.getAttribute("showMasterSp") !== "0";
      if (master && showMaster(layout) && showMaster(slide)) inherited.push(...(await this.elements(path(master.root, "cSld", "spTree"), master, null, master, true)));
      if (layout && showMaster(slide)) inherited.push(...(await this.elements(path(layout.root, "cSld", "spTree"), layout, null, master, true)));
      this.shapeIds = new Map();
      const own = await this.elements(path(slide.root, "cSld", "spTree"), slide, layout, master);
      const ids = this.shapeIds;
      this.shapeIds = null;
      const timing = readTiming(slide.root, (spid) => ids.get(spid));
      for (const [spid, opts] of readMediaTiming(slide.root)) {
        const target = own.find((e) => e.id === ids.get(spid));
        if (target?.kind === "image" && target.media) target.media = { ...target.media, ...opts };
      }
      if (timing.skipped) this.unsupported.add("animaciones con trayectoria u otras que WEPO no tiene");
      if (timing.approximated) this.unsupported.add("algunas animaciones de entrada (se cambian por Desvanecer)");
      const bg = await this.background([slide, layout, master]);
      slides.push({
        id: uid("s"),
        layout: LAYOUT_TYPES[layout?.root.getAttribute("type") ?? ""] ?? "titleContent",
        background: bg.color,
        backgroundImage: bg.image,
        elements: [...inherited, ...own],
        notes: await this.notes(slide),
        hidden: slide.root.getAttribute("show") === "0" || undefined,
        transition,
        animations: timing.animations.length ? timing.animations : undefined,
      });
    }
    return { width, height, slides, theme: this.theme, unsupported: [...this.unsupported] };
  }
}

/** Busca en el diseño (o el patrón) el marcador de posición que corresponde a uno de la diapositiva. */
function findPlaceholder(part: Part, ph: { type: string | null; idx: string | null }, isMaster = false): Element | undefined {
  const type = ph.type ?? "body";
  if (!isMaster && ph.idx !== null) {
    const byIdx = part.placeholders.find((p) => p.idx === ph.idx);
    if (byIdx) return byIdx.sp;
  }
  const same = part.placeholders.find((p) => (p.type ?? "body") === type);
  if (same) return same.sp;
  // En el patrón solo hay un título y un cuerpo.
  const family = type === "title" || type === "ctrTitle" ? ["title", "ctrTitle"] : ["body", "subTitle", "obj"];
  return part.placeholders.find((p) => family.includes(p.type ?? "body"))?.sp;
}

function resolvePath(dir: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = dir.split("/").filter(Boolean);
  for (const seg of target.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

export async function readPptx(data: Uint8Array): Promise<Deck> {
  const zip = await JSZip.loadAsync(data);
  const deck = await new PptxReader(zip).read();
  if (!deck.slides.length) throw new Error("La presentación no tiene diapositivas");
  return deck;
}

export { A, P, R };
