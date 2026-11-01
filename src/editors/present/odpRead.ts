// Abrir presentaciones de LibreOffice Impress (.odp) en WEPO Present.
//
// Se leen las diapositivas de content.xml con su texto (y el formato que viene
// de sus estilos), formas, líneas, imágenes, videos y audios, tablas, gráficas
// (los objetos de gráfica con sus datos), notas, fondos, diapositivas ocultas,
// transiciones y animaciones. Lo que WEPO no tiene se anota en `unsupported`
// (para avisar y guardar en una copia).

import JSZip from "jszip";
import type { AnimClass, AnimEffect, AnimTrigger, Animation, ChartElement, ChartKind, Deck, Direction, ImageElement, LayoutId, Para, Role, Run, ShapeElement, Slide, SlideElement, TableCell, TableElement, TextBody, Theme, Transition, TransitionKind } from "./model";
import { DEFAULT_THEME, THEMES, isEmptyText, uid } from "./model";
import { audioIcon, mediaKindOf } from "./media";
import { seriesColor } from "./charts";
import { WEPO_NS } from "./odpWrite";

const NS = {
  office: "urn:oasis:names:tc:opendocument:xmlns:office:1.0",
  style: "urn:oasis:names:tc:opendocument:xmlns:style:1.0",
  text: "urn:oasis:names:tc:opendocument:xmlns:text:1.0",
  table: "urn:oasis:names:tc:opendocument:xmlns:table:1.0",
  draw: "urn:oasis:names:tc:opendocument:xmlns:drawing:1.0",
  fo: "urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0",
  xlink: "http://www.w3.org/1999/xlink",
  meta: "urn:oasis:names:tc:opendocument:xmlns:meta:1.0",
  presentation: "urn:oasis:names:tc:opendocument:xmlns:presentation:1.0",
  svg: "urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0",
  chart: "urn:oasis:names:tc:opendocument:xmlns:chart:1.0",
  smil: "urn:oasis:names:tc:opendocument:xmlns:smil-compatible:1.0",
  anim: "urn:oasis:names:tc:opendocument:xmlns:animation:1.0",
  loext: "urn:org:documentfoundation:names:experimental:office:xmlns:loext:1.0",
  xml: "http://www.w3.org/XML/1998/namespace",
  dr3d: "urn:oasis:names:tc:opendocument:xmlns:dr3d:1.0",
  wepo: WEPO_NS,
};
type Ns = keyof typeof NS;

const get = (el: Element | null | undefined, ns: Ns, name: string): string | null => el?.getAttributeNS(NS[ns], name) ?? null;
const kids = (el: Element | null | undefined, ns?: Ns, name?: string): Element[] =>
  el ? Array.from(el.children).filter((c) => (!ns || c.namespaceURI === NS[ns]) && (!name || c.localName === name)) : [];
const first = (el: Element | null | undefined, ns: Ns, name: string) => kids(el, ns, name)[0];

function parse(xml: string): Element {
  return new DOMParser().parseFromString(xml, "application/xml").documentElement;
}

/** "2cm", "0.5in", "12pt" → píxeles de la diapositiva (96 por pulgada). */
export function toPx(value: string | null | undefined): number | null {
  const m = /^(-?[\d.]+(?:e-?\d+)?)\s*(cm|mm|in|pt|pc|px)?$/i.exec(value?.trim() ?? "");
  if (!m) return null;
  const factor = { cm: 96 / 2.54, mm: 96 / 25.4, in: 96, pt: 96 / 72, pc: 16, px: 1 }[(m[2] ?? "cm").toLowerCase() as "cm"];
  return Number(m[1]) * factor;
}

const toPt = (value: string | null | undefined) => {
  const px = toPx(value);
  return px === null ? null : Math.round(((px * 72) / 96) * 10) / 10;
};

/** "0.5s", "500ms", "PT00H00M05S", "PT5.5S" → milisegundos. */
function toMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const v = value.trim();
  let m = /^(-?[\d.]+)\s*(ms|s|min|h)?$/.exec(v);
  if (m) return Number(m[1]) * { ms: 1, s: 1000, min: 60000, h: 3600000 }[(m[2] ?? "s") as "s"];
  m = /^P(?:T(?:([\d.]+)H)?(?:([\d.]+)M)?(?:([\d.]+)S)?)$/.exec(v);
  if (m) return (Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)) * 1000;
  return null;
}

const color = (v: string | null | undefined) => (v && /^#[0-9a-f]{6}$/i.test(v) ? v.toUpperCase() : null);
const unquote = (font: string) => font.split(",")[0].trim().replace(/^['"]|['"]$/g, "");

// ───────────── estilos ─────────────

/** Estilos por familia y nombre, con su herencia (style:parent-style-name y el estilo por omisión). */
class Styles {
  private named = new Map<string, Element>();
  private defaults = new Map<string, Element>();
  lists = new Map<string, Element>();
  fillImages = new Map<string, string>();

  add(root: Element | null | undefined) {
    if (!root) return;
    for (const el of kids(root)) {
      if (el.namespaceURI === NS.style && el.localName === "style") this.named.set(`${get(el, "style", "family")}|${get(el, "style", "name")}`, el);
      else if (el.namespaceURI === NS.style && el.localName === "default-style") this.defaults.set(get(el, "style", "family") ?? "", el);
      else if (el.namespaceURI === NS.text && el.localName === "list-style") this.lists.set(get(el, "style", "name") ?? "", el);
      else if (el.namespaceURI === NS.draw && el.localName === "fill-image") this.fillImages.set(get(el, "draw", "name") ?? "", get(el, "xlink", "href") ?? "");
    }
  }

  find(family: string, name: string | null): Element | undefined {
    return name ? this.named.get(`${family}|${name}`) : undefined;
  }

  /** Cadena del estilo: él, sus padres y el de la familia por omisión. */
  chain(family: string, name: string | null): Element[] {
    const out: Element[] = [];
    let el = this.find(family, name);
    const seen = new Set<Element>();
    while (el && !seen.has(el)) {
      seen.add(el);
      out.push(el);
      el = this.find(family, get(el, "style", "parent-style-name"));
    }
    const d = this.defaults.get(family);
    if (d) out.push(d);
    return out;
  }

  /** Valor de una propiedad (la más cercana en la cadena). */
  prop(chain: Element[], propsName: string, ns: Ns, attr: string, propsNs: Ns = "style"): string | null {
    for (const el of chain) {
      for (const props of kids(el).filter((k) => k.localName === propsName && (k.namespaceURI === NS[propsNs] || k.namespaceURI === NS.loext))) {
        const v = get(props, ns, attr);
        if (v !== null) return v;
      }
    }
    return null;
  }

  /** Lista de un estilo de lista que trae el propio estilo gráfico (como hace LibreOffice en los marcadores). */
  inlineList(chain: Element[]): Element | undefined {
    for (const el of chain) {
      const name = get(el, "style", "list-style-name");
      if (name && this.lists.get(name)) return this.lists.get(name);
      for (const g of kids(el, "style", "graphic-properties")) {
        const l = first(g, "text", "list-style");
        if (l) return l;
      }
    }
    return undefined;
  }
}

type TextProps = Omit<Run, "text" | "link">;

function textProps(styles: Styles, chain: Element[]): TextProps {
  const p = (attr: string, ns: Ns = "fo") => styles.prop(chain, "text-properties", ns, attr);
  const out: TextProps = {};
  const weight = p("font-weight");
  if (weight) out.bold = weight === "bold" || Number(weight) >= 600;
  const italic = p("font-style");
  if (italic) out.italic = italic === "italic" || italic === "oblique";
  const under = p("text-underline-style", "style");
  if (under) out.underline = under !== "none";
  const strike = p("text-line-through-style", "style");
  if (strike) out.strike = strike !== "none";
  const size = p("font-size");
  if (size && !size.endsWith("%")) out.size = toPt(size) ?? undefined;
  const c = color(p("color"));
  if (c) out.color = c;
  const family = p("font-family") ?? fontFace(styles, p("font-name", "style"));
  if (family) out.font = unquote(family);
  return out;
}

let faces = new Map<string, string>();
function fontFace(_styles: Styles, name: string | null): string | null {
  return name ? (faces.get(name) ?? name) : null;
}

function readFaces(...roots: (Element | null | undefined)[]) {
  for (const root of roots) {
    for (const decls of kids(root, "office", "font-face-decls")) {
      for (const f of kids(decls, "style", "font-face")) faces.set(get(f, "style", "name") ?? "", unquote(get(f, "svg", "font-family") ?? get(f, "style", "name") ?? ""));
    }
  }
}

/** Quita las propiedades que son iguales a las del cuadro (para no repetirlas en cada pedazo de texto). */
function diff(props: TextProps, base: TextProps): TextProps {
  const out: TextProps = {};
  for (const k of Object.keys(props) as (keyof TextProps)[]) if (props[k] !== base[k]) (out as Record<string, unknown>)[k] = props[k];
  return out;
}

// ───────────── transiciones y animaciones ─────────────

const FROM_DIR: Record<string, Direction> = { fromRight: "left", fromLeft: "right", fromBottom: "up", fromTop: "down" };

function transitionOf(type: string, subtype: string, reverse: boolean, fadeColor: string | null): { kind: TransitionKind; direction?: Direction; other: boolean } {
  switch (type) {
    case "fade":
      return { kind: subtype === "fadeOverColor" && fadeColor?.toLowerCase() === "#ffffff" ? "flash" : "fade", other: false };
    case "pushWipe":
      return { kind: "push", direction: FROM_DIR[subtype] ?? "left", other: false };
    case "slideWipe":
      return { kind: "cover", direction: FROM_DIR[subtype] ?? "left", other: false };
    case "barWipe":
      return { kind: "wipe", direction: subtype === "topToBottom" ? (reverse ? "up" : "down") : reverse ? "left" : "right", other: false };
    case "irisWipe":
    case "zoom":
      return { kind: subtype === "rotateIn" ? "newsflash" : "zoom", other: false };
    case "barnDoorWipe":
      return { kind: "split", other: false };
    case "pinWheelWipe":
    case "clockWipe":
      return { kind: "wheel", other: false };
    case "blindsWipe":
      return { kind: "blinds", other: false };
    case "miscShapeWipe":
      if (subtype === "cornersOut" || subtype === "cornersIn") return { kind: "cube", direction: "left", other: false };
      if (subtype === "circle") return { kind: "flip", direction: "left", other: false };
      if (subtype === "vertical") return { kind: "vortex", direction: "left", other: false };
      if (subtype === "horizontal") return { kind: "ripple", other: false };
      return { kind: "fade", other: true };
    default:
      return { kind: "fade", other: true };
  }
}

const SPEED: Record<string, number> = { fast: 500, medium: 1000, slow: 2000 };
const TO_DIR_ENTR: Record<string, Direction> = { "from-bottom": "up", "from-top": "down", "from-right": "left", "from-left": "right" };
const TO_DIR_EXIT: Record<string, Direction> = { "from-bottom": "down", "from-top": "up", "from-left": "left", "from-right": "right" };

/** Efecto de WEPO para cada uno de LibreOffice. `approx`: no es igual, es el más parecido. */
function effectOf(preset: string, cls: AnimClass): { effect: AnimEffect; approx: boolean } {
  const id = preset.replace(/^ooo-(entrance|exit|emphasis)-/, "");
  if (cls === "emph") {
    if (id === "spin") return { effect: "spin", approx: false };
    if (id === "grow-and-shrink") return { effect: "grow", approx: false };
    if (id === "transparency") return { effect: "transparency", approx: false };
    if (id === "teeter") return { effect: "teeter", approx: false };
    return { effect: "pulse", approx: true };
  }
  if (id === "appear" || id === "disappear") return { effect: "appear", approx: false };
  if (id === "fade-in" || id === "fade-out" || id === "fade-in-and-out") return { effect: "fade", approx: false };
  if (id === "fly-in" || id === "fly-out" || id === "fly-in-slow" || id === "fly-out-slow") return { effect: "fly", approx: false };
  if (id === "zoom") return { effect: "zoom", approx: false };
  if (id === "wipe") return { effect: "wipe", approx: false };
  return { effect: "fade", approx: true };
}

// ───────────── el lector ─────────────

type Ctx = { ids: Map<string, string>; paraIds: Map<string, { el: string; para: number }> };

class OdpReader {
  styles = new Styles();
  master = new Styles();
  unsupported = new Set<string>();
  theme: Theme = DEFAULT_THEME;
  /** Archivo hecho por WEPO: la letra y el color del tema no se copian a cada texto. */
  ours = false;

  constructor(private zip: JSZip) {}

  async dataUrl(href: string | null): Promise<string | null> {
    if (!href || /^[a-z]+:/i.test(href)) return null;
    const path = href.replace(/^\.\//, "");
    const file = this.zip.file(path);
    if (!file) return null;
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    const mime = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml", webp: "image/webp", bmp: "image/bmp" }[ext];
    if (!mime) return null;
    return `data:${mime};base64,${await file.async("base64")}`;
  }

  /** Propiedades gráficas de un elemento (relleno, línea, texto). */
  graphicChain(el: Element): Element[] {
    const pres = get(el, "presentation", "style-name");
    const draw = get(el, "draw", "style-name");
    return pres ? this.styles.chain("presentation", pres) : this.styles.chain("graphic", draw);
  }

  fill(chain: Element[], fallback: "solid" | "none"): string | null {
    const kind = this.styles.prop(chain, "graphic-properties", "draw", "fill") ?? fallback;
    if (kind === "solid") return color(this.styles.prop(chain, "graphic-properties", "draw", "fill-color")) ?? "#729FCF";
    if (kind === "gradient") {
      this.unsupported.add("rellenos degradados");
      return color(this.styles.prop(chain, "graphic-properties", "draw", "fill-color")) ?? null;
    }
    if (kind === "bitmap" || kind === "hatch") this.unsupported.add("rellenos con imagen o trama");
    return null;
  }

  stroke(chain: Element[], fallback: "solid" | "none"): ShapeElement["line"] {
    const kind = this.styles.prop(chain, "graphic-properties", "draw", "stroke") ?? fallback;
    if (kind === "none") return null;
    const c = color(this.styles.prop(chain, "graphic-properties", "svg", "stroke-color")) ?? "#3465A4";
    const width = Math.max(toPx(this.styles.prop(chain, "graphic-properties", "svg", "stroke-width")) ?? 1, 1);
    const dashName = this.styles.prop(chain, "graphic-properties", "draw", "stroke-dash");
    const dash = kind === "dash" ? (/punto|dot/i.test(dashName ?? "") ? "dot" : "dash") : "solid";
    return { color: c, width: Math.round(width * 100) / 100, dash };
  }

  /** Posición, tamaño y giro (svg:x… o draw:transform). */
  box(el: Element): { x: number; y: number; w: number; h: number; rot?: number } {
    const w = toPx(get(el, "svg", "width")) ?? 0;
    const h = toPx(get(el, "svg", "height")) ?? 0;
    const transform = get(el, "draw", "transform");
    if (transform) {
      const rot = /rotate\s*\(\s*(-?[\d.e-]+)\s*\)/.exec(transform);
      const tr = /translate\s*\(\s*(-?[\d.e-]+[a-z]*)\s+(-?[\d.e-]+[a-z]*)\s*\)/.exec(transform);
      const a = rot ? Number(rot[1]) : 0;
      const tx = tr ? (toPx(tr[1]) ?? 0) : 0;
      const ty = tr ? (toPx(tr[2]) ?? 0) : 0;
      const d = -a;
      // La esquina girada está en (tx, ty): el centro es esa esquina más la mitad girada.
      const cx = tx + (w / 2) * Math.cos(d) - (h / 2) * Math.sin(d);
      const cy = ty + (w / 2) * Math.sin(d) + (h / 2) * Math.cos(d);
      let deg = Math.round(((d * 180) / Math.PI) * 100) / 100;
      deg = ((deg % 360) + 360) % 360;
      return { x: cx - w / 2, y: cy - h / 2, w, h, ...(deg ? { rot: deg } : {}) };
    }
    return { x: toPx(get(el, "svg", "x")) ?? 0, y: toPx(get(el, "svg", "y")) ?? 0, w, h };
  }

  /** Texto de un cuadro: sus párrafos (y listas). */
  text(holder: Element, chain: Element[], cls: string | null, ctx: Ctx | null, elId: string): TextBody {
    const base = textProps(this.styles, chain);
    const defaultSize = base.size;
    const p = (attr: string) => this.styles.prop(chain, "graphic-properties", "fo", attr);
    const pad = (attr: string, d: number) => toPx(p(attr)) ?? d;
    const insets: [number, number, number, number] = [pad("padding-left", 9.6), pad("padding-top", 4.8), pad("padding-right", 9.6), pad("padding-bottom", 4.8)].map((n) => Math.round(n * 100) / 100) as [number, number, number, number];
    const va = this.styles.prop(chain, "graphic-properties", "draw", "textarea-vertical-align");
    const anchor = va === "middle" ? "middle" : va === "bottom" ? "bottom" : "top";
    // En un archivo de WEPO la letra y el color del tema vienen del tema mismo.
    const inherited: TextProps = this.ours ? {} : { ...base };
    delete inherited.size;
    const paras: Para[] = [];
    const listDefault = this.styles.inlineList(chain);
    const walk = (node: Element, level: number, list: Element | undefined) => {
      for (const child of kids(node)) {
        if (child.namespaceURI === NS.text && (child.localName === "p" || child.localName === "h")) {
          paras.push(this.para(child, level, list, cls, inherited));
          const xmlId = get(child, "xml", "id") ?? get(child, "text", "id");
          if (xmlId && ctx) ctx.paraIds.set(xmlId, { el: elId, para: paras.length - 1 });
        } else if (child.namespaceURI === NS.text && child.localName === "list") {
          const name = get(child, "text", "style-name");
          const style = (name ? (this.styles.lists.get(name) ?? this.master.lists.get(name)) : undefined) ?? list ?? listDefault;
          for (const item of kids(child)) {
            if (item.localName === "list-item") walk(item, level + 1, style);
            else if (item.localName === "list-header") walk(item, level + 1, undefined);
          }
        }
      }
    };
    walk(holder, -1, undefined);
    return { paras: paras.length ? paras : [{ runs: [] }], anchor, insets, ...(defaultSize ? { defaultSize } : {}) };
  }

  para(p: Element, level: number, list: Element | undefined, cls: string | null, inherited: TextProps): Para {
    const chain = this.styles.chain("paragraph", get(p, "text", "style-name"));
    const out: Para = { runs: [] };
    const align = this.styles.prop(chain, "paragraph-properties", "fo", "text-align");
    if (align === "center") out.align = "center";
    else if (align === "end" || align === "right") out.align = "right";
    else if (align === "justify") out.align = "justify";
    const top = toPt(this.styles.prop(chain, "paragraph-properties", "fo", "margin-top"));
    const bottom = toPt(this.styles.prop(chain, "paragraph-properties", "fo", "margin-bottom"));
    if (top) out.spaceBefore = top;
    if (bottom) out.spaceAfter = bottom;
    const lh = this.styles.prop(chain, "paragraph-properties", "fo", "line-height");
    if (lh?.endsWith("%") && Number(lh.slice(0, -1)) !== 100) out.lineSpacing = Number(lh.slice(0, -1)) / 100;
    if (level >= 0) {
      out.level = Math.min(level, 8);
      const lvl = list ? kids(list).find((l) => Number(get(l, "text", "level") ?? 1) === level + 1) : undefined;
      if (!lvl) out.bullet = list || cls === "outline" ? "bullet" : null;
      else if (lvl.localName === "list-level-style-number") out.bullet = get(lvl, "style", "num-format") ? "number" : null;
      else if (lvl.localName === "list-level-style-bullet") out.bullet = get(lvl, "text", "bullet-char") ? "bullet" : null;
      else out.bullet = "bullet";
      if (!out.level) delete out.level;
    } else {
      const ml = toPx(this.styles.prop(chain, "paragraph-properties", "fo", "margin-left"));
      if (ml && ml > 20) out.level = Math.min(Math.round(ml / 30), 8);
    }
    const paraProps = { ...inherited, ...textProps(this.styles, chain) };
    const runs: Run[] = [];
    const push = (text: string, props: TextProps, link?: string) => {
      if (!text) return;
      const last = runs[runs.length - 1];
      const clean = diff(props, {});
      const same = last && JSON.stringify({ ...last, text: "" }) === JSON.stringify({ ...clean, ...(link ? { link } : {}), text: "" });
      if (same) last.text += text;
      else runs.push({ text, ...clean, ...(link ? { link } : {}) });
    };
    const walk = (node: Node, props: TextProps, link?: string) => {
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === Node.TEXT_NODE) push((child.textContent ?? "").replace(/[\r\n]+/g, " "), props, link);
        else if (child.nodeType === Node.ELEMENT_NODE) {
          const el = child as Element;
          if (el.namespaceURI !== NS.text) continue;
          if (el.localName === "span") walk(el, { ...props, ...textProps(this.styles, this.styles.chain("text", get(el, "text", "style-name"))) }, link);
          else if (el.localName === "a") walk(el, props, get(el, "xlink", "href") ?? undefined);
          else if (el.localName === "s") push(" ".repeat(Number(get(el, "text", "c") ?? 1)), props, link);
          else if (el.localName === "tab") push("\t", props, link);
          else if (el.localName === "line-break") push("\n", props, link);
          else if (["page-number", "date", "time", "title", "author-name"].includes(el.localName)) push(el.textContent ?? "", props, link);
        }
      }
    };
    walk(p, paraProps);
    out.runs = runs;
    if (!runs.length && paraProps.size) out.endSize = paraProps.size;
    return out;
  }

  role(cls: string | null): Role | undefined {
    return cls === "title" ? "title" : cls === "subtitle" ? "subtitle" : cls === "outline" || cls === "text" ? "body" : undefined;
  }

  async element(el: Element, ctx: Ctx, out: SlideElement[]) {
    if (el.namespaceURI === NS.draw && el.localName === "g") {
      for (const child of kids(el)) await this.element(child, ctx, out);
      return;
    }
    if (el.namespaceURI === NS.dr3d) return void this.unsupported.add("objetos 3D");
    if (el.namespaceURI !== NS.draw) return;
    const drawId = get(el, "xml", "id") ?? get(el, "draw", "id");
    const name = get(el, "draw", "name") ?? undefined;
    const id = uid();
    const add = (e: SlideElement) => {
      if (drawId) ctx.ids.set(drawId, e.id);
      out.push(e);
    };
    const chain = this.graphicChain(el);
    switch (el.localName) {
      case "frame": {
        const cls = get(el, "presentation", "class");
        const box = this.box(el);
        const textBox = first(el, "draw", "text-box");
        const image = first(el, "draw", "image");
        const plugin = first(el, "draw", "plugin");
        const tableEl = first(el, "table", "table");
        const object = first(el, "draw", "object");
        if (tableEl) return add(this.table(tableEl, id, box, name));
        if (object) {
          const chart = await this.chart(get(object, "xlink", "href"), id, box, name);
          if (chart) return add(chart);
          this.unsupported.add("objetos incrustados");
          if (image) {
            const src = await this.dataUrl(get(image, "xlink", "href"));
            if (src) return add({ id, kind: "image", src, ...box, name });
          }
          return;
        }
        if (plugin) {
          const href = get(plugin, "xlink", "href") ?? "";
          const file = this.zip.file(href.replace(/^\.\//, ""));
          const ext = href.split(".").pop()?.toLowerCase() ?? "";
          const type = mediaKindOf(ext) ?? (/^audio\//.test(get(plugin, "draw", "mime-type") ?? "") ? "audio" : /^video\//.test(get(plugin, "draw", "mime-type") ?? "") ? "video" : null);
          if (!file || !type) {
            this.unsupported.add("videos o audios enlazados (fuera del archivo)");
            return;
          }
          const params = new Map(kids(plugin, "draw", "param").map((p) => [get(p, "draw", "name") ?? "", get(p, "draw", "value") ?? ""]));
          const mime = (get(plugin, "draw", "mime-type") ?? "").includes("/") ? get(plugin, "draw", "mime-type")! : type === "video" ? `video/${ext === "mov" ? "quicktime" : ext}` : `audio/${ext === "mp3" ? "mpeg" : ext}`;
          const src = `data:${mime};base64,${await file.async("base64")}`;
          const poster = (await this.dataUrl(image ? get(image, "xlink", "href") : null)) ?? audioIcon();
          const media: ImageElement = { id, kind: "image", src: poster, ...box, name, media: { type, src, ...(params.get("Loop") === "true" ? { loop: true } : {}), ...(params.get("WEPO-autoplay") === "true" ? { autoplay: true } : {}) } };
          return add(media);
        }
        if (image) {
          const src = await this.dataUrl(get(image, "xlink", "href"));
          if (!src) return void this.unsupported.add("imágenes en formatos que WEPO no abre");
          const mirror = this.styles.prop(chain, "graphic-properties", "style", "mirror") ?? "";
          return add({ id, kind: "image", src, ...box, name, ...(mirror.includes("horizontal") ? { flipH: true } : {}), ...(mirror.includes("vertical") ? { flipV: true } : {}) });
        }
        if (textBox) {
          if (cls === "header" || cls === "footer" || cls === "date-time" || cls === "page-number") return;
          const role = this.role(cls);
          const text = this.text(textBox, chain, cls, ctx, id);
          const shape: ShapeElement = { id, kind: "shape", geom: "rect", fill: this.fill(chain, "none"), line: this.stroke(chain, "none"), ...box, name, text };
          if (role) {
            shape.role = role;
            shape.placeholder = { type: role === "title" ? (cls === "title" && this.layoutHint === "title" ? "ctrTitle" : "title") : role === "subtitle" ? "subTitle" : null, idx: role === "title" ? null : "1" };
          }
          // Un marcador vacío de LibreOffice («Haga clic para…») se queda vacío.
          if (get(el, "presentation", "placeholder") === "true") shape.text = { ...text, paras: [{ runs: [], bullet: role === "body" ? "bullet" : null }] };
          return add(shape);
        }
        return;
      }
      case "custom-shape":
      case "rect":
      case "ellipse":
      case "circle": {
        const geometry = first(el, "draw", "enhanced-geometry");
        const type = el.localName === "custom-shape" ? (get(geometry, "draw", "type") ?? "rectangle") : el.localName === "rect" ? "rectangle" : "ellipse";
        const geom = ODF_TO_GEOM[type] ?? (type.startsWith("ooxml-") ? type.slice(6) : null);
        if (!geom) this.unsupported.add("formas que WEPO no dibuja (se ven como rectángulo)");
        const box = this.box(el);
        const hasText = kids(el, "text").length > 0;
        const shape: ShapeElement = {
          id,
          kind: "shape",
          geom: geom ?? "rect",
          fill: this.fill(chain, "solid"),
          line: this.stroke(chain, "solid"),
          ...box,
          name,
          ...(get(geometry, "draw", "mirror-horizontal") === "true" ? { flipH: true } : {}),
          ...(get(geometry, "draw", "mirror-vertical") === "true" ? { flipV: true } : {}),
        };
        if (el.localName === "rect" && get(el, "draw", "corner-radius")) shape.geom = "roundRect";
        if (hasText) shape.text = this.text(el, chain, null, ctx, id);
        return add(shape);
      }
      case "line":
      case "connector": {
        let x1 = toPx(get(el, "svg", "x1")) ?? 0;
        let y1 = toPx(get(el, "svg", "y1")) ?? 0;
        let x2 = toPx(get(el, "svg", "x2")) ?? 0;
        let y2 = toPx(get(el, "svg", "y2")) ?? 0;
        if (el.localName === "connector" && get(el, "draw", "type") && get(el, "draw", "type") !== "line") this.unsupported.add("conectores con quiebres o curvos (se ven rectos)");
        const flipH = x2 < x1;
        const flipV = y2 < y1;
        if (flipH) [x1, x2] = [x2, x1];
        if (flipV) [y1, y2] = [y2, y1];
        return add({ id, kind: "shape", geom: "line", fill: null, line: this.stroke(chain, "solid") ?? { color: "#000000", width: 1 }, x: x1, y: y1, w: x2 - x1, h: y2 - y1, name, ...(flipH ? { flipH } : {}), ...(flipV ? { flipV } : {}) });
      }
      case "polygon":
      case "polyline":
      case "path":
      case "regular-polygon":
        this.unsupported.add("formas libres (se ven como rectángulo)");
        return add({ id, kind: "shape", geom: "rect", fill: this.fill(chain, "solid"), line: this.stroke(chain, "solid"), ...this.box(el), name });
      case "page-thumbnail":
        return;
      default:
        this.unsupported.add(`elementos de tipo ${el.localName}`);
    }
  }

  layoutHint: LayoutId | null = null;

  table(tbl: Element, id: string, box: { x: number; y: number; w: number; h: number; rot?: number }, name?: string): TableElement {
    const columns: number[] = [];
    const collectCols = (node: Element) => {
      for (const c of kids(node, "table")) {
        if (c.localName === "table-column") {
          const repeat = Number(get(c, "table", "number-columns-repeated") ?? 1);
          const w = toPx(this.styles.prop(this.styles.chain("table-column", get(c, "table", "style-name")), "table-column-properties", "style", "column-width"));
          for (let i = 0; i < repeat; i++) columns.push(w ?? 0);
        } else if (c.localName === "table-columns" || c.localName === "table-header-columns") collectCols(c);
      }
    };
    collectCols(tbl);
    const rowEls: Element[] = [];
    const collectRows = (node: Element) => {
      for (const c of kids(node, "table")) {
        if (c.localName === "table-row") rowEls.push(c);
        else if (c.localName === "table-rows" || c.localName === "table-header-rows") collectRows(c);
      }
    };
    collectRows(tbl);
    const header = get(tbl, "wepo", "header") === "true" || get(tbl, "table", "use-first-row-styles") === "true";
    const rows: TableElement["rows"] = [];
    const covered: Set<string> = new Set();
    rowEls.forEach((r, ri) => {
      const rowChain = this.styles.chain("table-row", get(r, "table", "style-name"));
      const h = toPx(this.styles.prop(rowChain, "table-row-properties", "style", "row-height")) ?? toPx(this.styles.prop(rowChain, "table-row-properties", "style", "min-row-height")) ?? box.h / Math.max(rowEls.length, 1);
      const defaultCell = get(r, "table", "default-cell-style-name");
      const cells: TableCell[] = [];
      let ci = 0;
      for (const c of kids(r, "table")) {
        if (c.localName !== "table-cell" && c.localName !== "covered-table-cell") continue;
        const repeat = Number(get(c, "table", "number-columns-repeated") ?? 1);
        for (let k = 0; k < repeat; k++, ci++) {
          if (c.localName === "covered-table-cell") {
            cells.push({ text: { paras: [{ runs: [] }] }, fill: null, merged: covered.has(`${ri},${ci}`) ? "v" : "h" });
            continue;
          }
          const chain = this.styles.chain("table-cell", get(c, "table", "style-name") ?? defaultCell);
          const span = Number(get(c, "table", "number-columns-spanned") ?? 1);
          const rowSpan = Number(get(c, "table", "number-rows-spanned") ?? 1);
          for (let dr = 1; dr < rowSpan; dr++) for (let dc = 0; dc < span; dc++) covered.add(`${ri + dr},${ci + dc}`);
          const fillKind = this.styles.prop(chain, "graphic-properties", "draw", "fill");
          const fill = fillKind === "solid" ? color(this.styles.prop(chain, "graphic-properties", "draw", "fill-color")) : fillKind === "none" ? null : color(this.styles.prop(chain, "table-cell-properties", "fo", "background-color"));
          const text = this.text(c, chain, null, null, id);
          if (header && ri === 0) for (const p of text.paras) for (const run of p.runs) {
            if (run.color === "#FFFFFF") delete run.color;
            if (run.bold) delete run.bold;
          }
          cells.push({ text, fill, ...(span > 1 ? { span } : {}), ...(rowSpan > 1 ? { rowSpan } : {}) });
        }
      }
      rows.push({ h, cells });
    });
    const border = color((this.styles.prop(this.styles.chain("table-cell", get(rowEls[0] ? kids(rowEls[0], "table", "table-cell")[0] : null, "table", "style-name") ?? get(rowEls[0], "table", "default-cell-style-name")), "table-cell-properties", "fo", "border") ?? this.styles.prop(this.styles.chain("table-cell", get(rowEls[0] ? kids(rowEls[0], "table", "table-cell")[0] : null, "table", "style-name") ?? get(rowEls[0], "table", "default-cell-style-name")), "paragraph-properties", "fo", "border") ?? "").split(" ").find((t) => t.startsWith("#")));
    const cols = columns.length ? columns : Array.from({ length: Math.max(...rows.map((r) => r.cells.length), 1) }, () => box.w / Math.max(...rows.map((r) => r.cells.length), 1));
    for (const r of rows) while (r.cells.length < cols.length) r.cells.push({ text: { paras: [{ runs: [] }] }, fill: null });
    return { id, kind: "table", ...box, name, cols, rows, border, header };
  }

  async chart(href: string | null, id: string, box: { x: number; y: number; w: number; h: number; rot?: number }, name?: string): Promise<ChartElement | null> {
    if (!href) return null;
    const dir = href.replace(/^\.\//, "").replace(/\/$/, "");
    const file = this.zip.file(`${dir}/content.xml`);
    if (!file) return null;
    const root = parse(await file.async("string"));
    const styles = new Styles();
    styles.add(first(root, "office", "automatic-styles"));
    const chartEl = first(first(first(root, "office", "body"), "office", "chart"), "chart", "chart");
    if (!chartEl) return null;
    const cls = (get(chartEl, "chart", "class") ?? "").replace(/^chart:/, "");
    const plot = first(chartEl, "chart", "plot-area");
    const plotChain = styles.chain("chart", get(plot, "chart", "style-name"));
    const vertical = styles.prop(plotChain, "chart-properties", "chart", "vertical") === "true";
    const stacked = styles.prop(plotChain, "chart-properties", "chart", "stacked") === "true" || styles.prop(plotChain, "chart-properties", "chart", "percentage") === "true";
    const kindMap: Record<string, ChartKind> = { bar: vertical ? "bar" : "column", line: "line", area: "area", circle: "pie", ring: "doughnut" };
    const chartType = kindMap[cls];
    if (!chartType) {
      this.unsupported.add(`gráficas de tipo ${cls || "desconocido"} (se cambian por columnas)`);
    }
    // Los datos: la tabla local (primera fila = nombres de las series, primera columna = categorías).
    const tbl = first(chartEl, "table", "table");
    const rows: Element[] = [];
    const collect = (node: Element | undefined) => {
      for (const c of kids(node, "table")) {
        if (c.localName === "table-row") rows.push(c);
        else if (c.localName === "table-rows" || c.localName === "table-header-rows") collect(c);
      }
    };
    collect(tbl);
    const cellsOf = (r: Element) => {
      const out: Element[] = [];
      for (const c of kids(r, "table")) {
        const n = Number(get(c, "table", "number-columns-repeated") ?? 1);
        for (let i = 0; i < Math.min(n, 64); i++) out.push(c);
      }
      return out;
    };
    const head = rows[0] ? cellsOf(rows[0]) : [];
    const seriesEls = kids(plot, "chart", "series");
    const categories = rows.slice(1).map((r) => cellsOf(r)[0]?.textContent ?? "");
    const series = seriesEls.map((s, i) => {
      const chain = styles.chain("chart", get(s, "chart", "style-name"));
      const range = get(s, "chart", "values-cell-range-address") ?? "";
      const m = /\$?([A-Z]+)\$?\d+/.exec(range.split(":")[0].split(".").pop() ?? "");
      let col = i + 1;
      if (m) col = m[1].split("").reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
      const values = rows.slice(1).map((r) => {
        const c = cellsOf(r)[col];
        const v = get(c, "office", "value");
        return v !== null && v !== "" ? Number(v) : null;
      });
      const c = color(styles.prop(chain, "graphic-properties", "draw", "fill-color")) ?? (chartType === "line" ? color(styles.prop(chain, "graphic-properties", "svg", "stroke-color")) : null) ?? seriesColor(this.theme, i);
      return { name: head[col]?.textContent ?? `Serie ${i + 1}`, values, color: c };
    });
    const labels = seriesEls.some((s) => {
      const v = styles.prop(styles.chain("chart", get(s, "chart", "style-name")), "chart-properties", "chart", "data-label-number");
      return v === "value" || v === "percentage";
    });
    return {
      id,
      kind: "chart",
      ...box,
      name,
      chartType: chartType ?? "column",
      title: first(first(chartEl, "chart", "title"), "text", "p")?.textContent ?? "",
      legend: Boolean(first(chartEl, "chart", "legend")),
      stacked,
      labels,
      categories,
      series,
    };
  }

  notes(page: Element): string {
    const notes = first(page, "presentation", "notes");
    const frame = kids(notes, "draw", "frame").find((f) => get(f, "presentation", "class") === "notes");
    const box = first(frame, "draw", "text-box");
    if (!box || get(frame, "presentation", "placeholder") === "true") return "";
    const lines: string[] = [];
    const walk = (node: Element) => {
      for (const c of kids(node, "text")) {
        if (c.localName === "p" || c.localName === "h") lines.push(textOf(c));
        else if (c.localName === "list" || c.localName === "list-item") walk(c);
      }
    };
    walk(box);
    return lines.join("\n").replace(/\n+$/, "");
  }

  /** Transición: el tipo va en el estilo de la página; la duración, en su animación (o la velocidad). */
  transition(page: Element, style: Element[]): { t: Transition | null } {
    const p = (ns: Ns, attr: string) => this.styles.prop(style, "drawing-page-properties", ns, attr);
    const type = p("smil", "type");
    const advance = p("presentation", "transition-type") === "automatic" ? toMs(p("presentation", "duration")) : null;
    const root = kids(page, "anim", "par").find((x) => get(x, "presentation", "node-type") === "timing-root");
    const filter = kids(root, "anim", "par")
      .filter((x) => (get(x, "smil", "begin") ?? "").endsWith(".begin"))
      .map((x) => first(x, "anim", "transitionFilter"))
      .find(Boolean);
    const ours = p("wepo", "transition") as TransitionKind | null;
    let t: Transition | null = null;
    const dur = toMs(get(filter, "smil", "dur")) ?? (p("wepo", "duration") ? Number(p("wepo", "duration")) : null) ?? SPEED[p("presentation", "transition-speed") ?? "medium"] ?? 700;
    if (ours) {
      t = { kind: ours, duration: dur, ...(p("wepo", "direction") ? { direction: p("wepo", "direction") as Direction } : {}) };
    } else if (type) {
      const r = transitionOf(type, p("smil", "subtype") ?? "", p("smil", "direction") === "reverse", p("smil", "fadeColor"));
      if (r.other) this.unsupported.add("transiciones que WEPO no tiene (se cambian por Desvanecer)");
      t = { kind: r.kind, duration: dur, ...(r.direction ? { direction: r.direction } : {}) };
    } else if (advance) t = { kind: "none", duration: 0 };
    if (t && advance) t.advanceAfter = advance;
    return { t };
  }

  /** Animaciones (la secuencia principal), y los videos que empiezan solos. */
  timing(page: Element, ctx: Ctx, elements: SlideElement[]): Animation[] {
    const root = kids(page, "anim", "par").find((x) => get(x, "presentation", "node-type") === "timing-root");
    const seq = kids(root, "anim", "seq").find((x) => get(x, "presentation", "node-type") === "main-sequence");
    if (!seq) {
      if (kids(root, "anim", "seq").length) this.unsupported.add("animaciones que empiezan al hacer clic en un objeto");
      return [];
    }
    if (kids(root, "anim", "seq").length > 1) this.unsupported.add("animaciones que empiezan al hacer clic en un objeto");
    type Unit = { anim: Animation; para: number | null };
    const units: Unit[] = [];
    for (const group of kids(seq, "anim")) {
      const effects: Element[] = [];
      const find = (n: Element) => {
        for (const c of kids(n, "anim")) {
          if (get(c, "presentation", "preset-class") || (get(c, "presentation", "node-type") && get(c, "presentation", "node-type") !== "timing-root")) effects.push(c);
          else if (c.localName === "par" || c.localName === "seq") find(c);
        }
      };
      find(group);
      for (const fx of effects) {
        const presetClass = get(fx, "presentation", "preset-class") ?? "";
        const nodeType = get(fx, "presentation", "node-type") ?? "on-click";
        const children = kids(fx, "anim");
        const targetName = children.map((c) => get(c, "smil", "targetElement")).find(Boolean) ?? null;
        if (presetClass === "media-call") {
          const elId = targetName ? ctx.ids.get(targetName) : undefined;
          const el = elements.find((e) => e.id === elId);
          if (el?.kind === "image" && el.media && children.some((c) => get(c, "anim", "command") === "play")) el.media.autoplay = true;
          continue;
        }
        if (!targetName) continue;
        const para = ctx.paraIds.get(targetName);
        const target = para?.el ?? ctx.ids.get(targetName);
        if (!target) continue;
        const cls: AnimClass = presetClass === "exit" ? "exit" : presetClass === "emphasis" ? "emph" : presetClass === "entrance" ? "entr" : "entr";
        if (!["entrance", "exit", "emphasis"].includes(presetClass)) {
          this.unsupported.add("animaciones de trayectoria y otras (se cambian por Desvanecer)");
        }
        const ours = get(fx, "wepo", "effect") as AnimEffect | null;
        const { effect, approx } = ours ? { effect: ours, approx: false } : effectOf(get(fx, "presentation", "preset-id") ?? "", cls);
        if (approx) this.unsupported.add("animaciones que WEPO no tiene (se cambian por la más parecida)");
        const sub = get(fx, "presentation", "preset-sub-type") ?? "";
        const direction = (get(fx, "wepo", "direction") as Direction | null) ?? (effect === "fly" || effect === "wipe" ? ((cls === "exit" ? TO_DIR_EXIT : TO_DIR_ENTR)[sub] ?? (cls === "exit" ? "down" : "up")) : undefined);
        const durations = children.map((c) => toMs(get(c, "smil", "dur")) ?? 0).filter((d) => d > 2);
        let duration = durations.length ? Math.max(...durations) : 0;
        if (ours === "pulse") duration *= 4;
        const trigger: AnimTrigger = nodeType === "with-previous" ? "with" : nodeType === "after-previous" ? "after" : "click";
        const anim: Animation = {
          id: uid("a"),
          target,
          effect,
          trigger,
          duration: effect === "appear" ? 0 : Math.round(duration),
          delay: Math.round(toMs(get(fx, "smil", "begin")) ?? 0),
          ...(direction ? { direction } : {}),
          ...(cls === "entr" ? {} : { cls }),
        };
        units.push({ anim, para: para ? para.para : children.some((c) => get(c, "anim", "sub-item") === "text") ? -1 : null });
      }
    }
    // Los párrafos que entran uno por uno (cada uno con su clic) vuelven a ser una sola animación.
    const out: Animation[] = [];
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      if (u.para === null || u.para < 0) {
        out.push(u.anim);
        continue;
      }
      let j = i + 1;
      while (j < units.length && units[j].para !== null && units[j].anim.target === u.anim.target && units[j].anim.effect === u.anim.effect && units[j].anim.trigger === "click" && (units[j].para ?? 0) > (units[j - 1].para ?? 0)) j++;
      out.push(j - i > 1 || this.paraCount(elements, u.anim.target) > 1 ? { ...u.anim, byParagraph: true } : u.anim);
      i = j - 1;
    }
    return out;
  }

  paraCount(elements: SlideElement[], id: string): number {
    const el = elements.find((e) => e.id === id);
    return el?.kind === "shape" && el.text ? el.text.paras.filter((p) => p.runs.some((r) => r.text.trim())).length : 0;
  }

  layoutOf(page: Element, elements: SlideElement[]): LayoutId {
    const ours = get(page, "wepo", "layout") as LayoutId | null;
    if (ours) return ours;
    const roles = elements.flatMap((e) => (e.kind === "shape" && e.role ? [e.role] : []));
    const bodies = roles.filter((r) => r === "body").length;
    if (roles.includes("title") && roles.includes("subtitle")) return "title";
    if (roles.includes("title") && bodies >= 2) return "twoContent";
    if (roles.includes("title") && bodies === 1) return "titleContent";
    if (roles.includes("title")) return "titleOnly";
    return "blank";
  }

  async page(page: Element): Promise<Slide> {
    const ctx: Ctx = { ids: new Map(), paraIds: new Map() };
    const elements: SlideElement[] = [];
    const pageLayout = get(page, "presentation", "presentation-page-layout-name");
    this.layoutHint = pageLayout === "AL1T0" ? "title" : null;
    for (const child of kids(page)) await this.element(child, ctx, elements);
    const style = this.styles.chain("drawing-page", get(page, "draw", "style-name"));
    const p = (ns: Ns, attr: string) => this.styles.prop(style, "drawing-page-properties", ns, attr);
    const fillKind = p("draw", "fill");
    let background: string | null = null;
    let backgroundImage: string | null = null;
    if (fillKind === "solid") background = color(p("draw", "fill-color"));
    else if (fillKind === "bitmap") {
      backgroundImage = await this.dataUrl(this.master.fillImages.get(p("draw", "fill-image-name") ?? "") ?? null);
      if (!backgroundImage) this.unsupported.add("fondos con imagen en formatos que WEPO no abre");
    } else if (fillKind === "gradient") {
      this.unsupported.add("fondos degradados");
      background = color(p("draw", "fill-color"));
    }
    if (background && background === this.theme.background.toUpperCase()) background = null;
    const { t } = this.transition(page, style);
    const animations = this.timing(page, ctx, elements);
    const slide: Slide = {
      id: uid("s"),
      layout: this.layoutOf(page, elements),
      background,
      ...(backgroundImage ? { backgroundImage } : {}),
      elements,
      notes: this.notes(page),
      ...(p("presentation", "visibility") === "hidden" ? { hidden: true } : {}),
      ...(t ? { transition: t } : {}),
      ...(animations.length ? { animations } : {}),
    };
    // Las cajas de título y contenido vacías se ven con su texto de ayuda.
    for (const e of elements) if (e.kind === "shape" && e.role && isEmptyText(e.text) && !e.text) e.text = { paras: [{ runs: [] }] };
    return slide;
  }

  /** Tema: el de WEPO si el archivo es de WEPO; si no, uno con el fondo, la letra y los colores del patrón. */
  readTheme(meta: Element | null, styles: Element | null, masterName: string | null): Theme {
    const officeMeta = first(meta, "office", "meta");
    const tag = kids(officeMeta, "meta", "user-defined").find((u) => get(u, "meta", "name") === "WEPO-tema");
    const known = tag ? THEMES.find((t) => t.id === tag.textContent?.trim()) : undefined;
    if (known) {
      this.ours = true;
      return known;
    }
    const masters = kids(first(styles, "office", "master-styles"), "style", "master-page");
    const master = masters.find((m) => get(m, "style", "name") === masterName) ?? masters[0];
    const mdp = this.master.chain("drawing-page", get(master, "draw", "style-name"));
    const bg = this.master.prop(mdp, "drawing-page-properties", "draw", "fill") === "solid" ? color(this.master.prop(mdp, "drawing-page-properties", "draw", "fill-color")) : null;
    const name = get(master, "style", "name") ?? "";
    const titleChain = this.styles.chain("presentation", `${name}-title`);
    const bodyChain = this.styles.chain("presentation", `${name}-outline1`);
    const title = textProps(this.styles, titleChain);
    const body = textProps(this.styles, bodyChain);
    return {
      ...THEMES.find((t) => t.id === "office")!,
      id: "odp",
      name: "Del archivo",
      background: bg ?? "#FFFFFF",
      text: body.color ?? "#000000",
      title: title.color ?? body.color ?? "#000000",
      fonts: { major: title.font ?? body.font ?? "Arial", minor: body.font ?? "Arial" },
    };
  }
}

function textOf(p: Element): string {
  let s = "";
  const walk = (n: Node) => {
    for (const c of Array.from(n.childNodes)) {
      if (c.nodeType === Node.TEXT_NODE) s += c.textContent;
      else if (c.nodeType === Node.ELEMENT_NODE) {
        const el = c as Element;
        if (el.localName === "s") s += " ".repeat(Number(get(el, "text", "c") ?? 1));
        else if (el.localName === "tab") s += "\t";
        else if (el.localName === "line-break") s += "\n";
        else walk(el);
      }
    }
  };
  walk(p);
  return s;
}

/** Formas de LibreOffice → las de PowerPoint que WEPO dibuja. */
const ODF_TO_GEOM: Record<string, string> = {
  rectangle: "rect",
  "round-rectangle": "roundRect",
  ellipse: "ellipse",
  circle: "ellipse",
  "isosceles-triangle": "triangle",
  "right-triangle": "rtTriangle",
  diamond: "diamond",
  parallelogram: "parallelogram",
  trapezoid: "trapezoid",
  pentagon: "pentagon",
  hexagon: "hexagon",
  octagon: "octagon",
  "right-arrow": "rightArrow",
  "left-arrow": "leftArrow",
  "up-arrow": "upArrow",
  "down-arrow": "downArrow",
  chevron: "chevron",
  "pentagon-right": "homePlate",
  star5: "star5",
  heart: "heart",
  "round-rectangular-callout": "wedgeRoundRectCallout",
  "rectangular-callout": "wedgeRectCallout",
  can: "can",
  cube: "cube",
  "flowchart-process": "rect",
  "flowchart-decision": "flowChartDecision",
  "flowchart-connector": "flowChartConnector",
  "flowchart-alternate-process": "flowChartAlternateProcess",
  "flowchart-data": "flowChartInputOutput",
  "flowchart-extract": "flowChartExtract",
  "ooxml-rect": "rect",
};

export async function readOdp(data: Uint8Array): Promise<Deck> {
  const zip = await JSZip.loadAsync(data);
  const contentFile = zip.file("content.xml");
  if (!contentFile) throw new Error("El archivo no es una presentación de OpenDocument");
  const content = parse(await contentFile.async("string"));
  const stylesRoot = zip.file("styles.xml") ? parse(await zip.file("styles.xml")!.async("string")) : null;
  const meta = zip.file("meta.xml") ? parse(await zip.file("meta.xml")!.async("string")) : null;
  faces = new Map();
  readFaces(stylesRoot, content);
  const r = new OdpReader(zip);
  // content.xml ve sus estilos automáticos y los comunes de styles.xml; el patrón, los de styles.xml.
  r.styles.add(first(stylesRoot, "office", "styles"));
  r.styles.add(first(content, "office", "automatic-styles"));
  r.master.add(first(stylesRoot, "office", "styles"));
  r.master.add(first(stylesRoot, "office", "automatic-styles"));
  for (const [k, v] of r.master.lists) if (!r.styles.lists.has(k)) r.styles.lists.set(k, v);
  for (const [k, v] of r.master.fillImages) r.styles.fillImages.set(k, v);
  const presentation = first(first(content, "office", "body"), "office", "presentation");
  if (!presentation) throw new Error("El archivo no es una presentación de OpenDocument");
  const pages = kids(presentation, "draw", "page");
  r.theme = r.readTheme(meta, stylesRoot, get(pages[0], "draw", "master-page-name"));
  // Tamaño de la diapositiva: el del patrón de la primera página.
  const masters = kids(first(stylesRoot, "office", "master-styles"), "style", "master-page");
  const master = masters.find((m) => get(m, "style", "name") === get(pages[0], "draw", "master-page-name")) ?? masters[0];
  const layout = kids(first(stylesRoot, "office", "automatic-styles"), "style", "page-layout").find((l) => get(l, "style", "name") === get(master, "style", "page-layout-name"));
  const props = first(layout, "style", "page-layout-properties");
  const width = Math.round(toPx(get(props, "fo", "page-width")) ?? 1280);
  const height = Math.round(toPx(get(props, "fo", "page-height")) ?? 720);
  if (masters.length && !r.ours && kids(master).some((k) => k.namespaceURI === NS.draw && !get(k, "presentation", "class"))) r.unsupported.add("dibujos del patrón de diapositivas");
  const slides: Slide[] = [];
  for (const page of pages) slides.push(await r.page(page));
  if (!slides.length) throw new Error("La presentación no tiene diapositivas");
  return { width, height, slides, theme: r.theme, unsupported: [...r.unsupported] };
}
