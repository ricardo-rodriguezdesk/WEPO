// Guardar en .odp (OpenDocument, el formato de LibreOffice Impress).
//
// Un .odp es un ZIP con content.xml (las diapositivas), styles.xml (el patrón:
// tamaño, fondo y letra del tema), meta.xml y las imágenes, videos y gráficas.
// Se escribe lo mismo que WEPO Present tiene: cuadros de texto con su formato y
// listas, formas, imágenes, videos y audios, tablas, gráficas (como objetos de
// gráfica de LibreOffice, con sus datos), notas, diapositivas ocultas, fondos,
// transiciones y animaciones (con los mismos efectos que trae LibreOffice).
// Lo que LibreOffice no tiene igual (unas transiciones vistosas, el pulso y el
// balanceo) se guarda con el más parecido y con una marca de WEPO para que al
// volver a abrirlo en WEPO quede igual.

import JSZip from "jszip";
import type { Animation, ChartElement, Deck, ImageElement, Para, Run, ShapeElement, Slide, SlideElement, TableElement, TextBody, Transition } from "./model";
import { isEmptyText } from "./model";
import { isLine } from "./geometry";
import { animationSteps, clsOf } from "./animations";
import { mediaBytes } from "./media";
import { SLICE_COLORS } from "../sheets/ChartSvg";

export const WEPO_NS = "urn:wepo:present:1.0";

const ROOT_NS = [
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"',
  'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"',
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"',
  'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"',
  'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"',
  'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"',
  'xmlns:xlink="http://www.w3.org/1999/xlink"',
  'xmlns:dc="http://purl.org/dc/elements/1.1/"',
  'xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0"',
  'xmlns:number="urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0"',
  'xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0"',
  'xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"',
  'xmlns:chart="urn:oasis:names:tc:opendocument:xmlns:chart:1.0"',
  'xmlns:smil="urn:oasis:names:tc:opendocument:xmlns:smil-compatible:1.0"',
  'xmlns:anim="urn:oasis:names:tc:opendocument:xmlns:animation:1.0"',
  'xmlns:loext="urn:org:documentfoundation:names:experimental:office:xmlns:loext:1.0"',
  `xmlns:wepo="${WEPO_NS}"`,
].join(" ");

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Píxeles de la diapositiva (96 por pulgada) → centímetros. */
const cm = (px: number) => `${(Math.round((px / 96) * 2.54 * 1000) / 1000).toString()}cm`;
const sec = (ms: number) => `${Math.round(ms) / 1000}s`;
const hex = (c: string) => (/^#[0-9a-f]{6}$/i.test(c) ? c.toLowerCase() : /^#[0-9a-f]{3}$/i.test(c) ? `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}`.toLowerCase() : "#000000");

function imageBytes(src: string): { bytes: Uint8Array; ext: string; mime: string } | null {
  const m = /^data:image\/(png|jpeg|jpg|gif|svg\+xml|webp|bmp);base64,(.*)$/.exec(src);
  if (!m) return null;
  const binary = atob(m[2]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const ext = m[1] === "jpg" || m[1] === "jpeg" ? "jpg" : m[1] === "svg+xml" ? "svg" : m[1];
  return { bytes, ext, mime: `image/${m[1] === "jpg" ? "jpeg" : m[1]}` };
}

/** Formas de PowerPoint → las de LibreOffice con el mismo dibujo. */
export const GEOM_TO_ODF: Record<string, string> = {
  rect: "rectangle",
  roundRect: "round-rectangle",
  ellipse: "ellipse",
  triangle: "isosceles-triangle",
  rtTriangle: "right-triangle",
  diamond: "diamond",
  parallelogram: "parallelogram",
  trapezoid: "trapezoid",
  pentagon: "pentagon",
  hexagon: "hexagon",
  octagon: "octagon",
  rightArrow: "right-arrow",
  leftArrow: "left-arrow",
  upArrow: "up-arrow",
  downArrow: "down-arrow",
  chevron: "chevron",
  star5: "star5",
  heart: "heart",
  wedgeRoundRectCallout: "round-rectangular-callout",
  wedgeRectCallout: "rectangular-callout",
  can: "can",
  cube: "cube",
  flowChartDecision: "flowchart-decision",
  flowChartConnector: "flowchart-connector",
  flowChartAlternateProcess: "flowchart-alternate-process",
  flowChartInputOutput: "flowchart-data",
  flowChartExtract: "flowchart-extract",
  homePlate: "pentagon-right",
};

// ───────────── transiciones ─────────────

type OdfTransition = { type: string; subtype: string; reverse?: boolean; fadeColor?: string };

/** De dónde llega la diapositiva nueva («left» = se mueve hacia la izquierda, llega por la derecha). */
const FROM: Record<string, string> = { left: "fromRight", right: "fromLeft", up: "fromBottom", down: "fromTop" };

export function odfTransition(t: Transition): OdfTransition | null {
  const dir = t.direction ?? "left";
  switch (t.kind) {
    case "none":
      return null;
    case "fade":
      return { type: "fade", subtype: "crossfade" };
    case "push":
      return { type: "pushWipe", subtype: FROM[dir] };
    case "cover":
      return { type: "slideWipe", subtype: FROM[dir] };
    case "wipe":
      return dir === "left" || dir === "right" ? { type: "barWipe", subtype: "leftToRight", reverse: dir === "left" } : { type: "barWipe", subtype: "topToBottom", reverse: dir === "up" };
    case "zoom":
      return { type: "irisWipe", subtype: "rectangle" };
    case "split":
    case "doors":
    case "curtains":
      return { type: "barnDoorWipe", subtype: "vertical" };
    case "wheel":
      return { type: "pinWheelWipe", subtype: "oneBlade" };
    case "blinds":
      return { type: "blindsWipe", subtype: "vertical" };
    case "newsflash":
      return { type: "zoom", subtype: "rotateIn" };
    case "cube":
      return { type: "miscShapeWipe", subtype: "cornersOut" };
    case "flip":
      return { type: "miscShapeWipe", subtype: "circle" };
    case "vortex":
      return { type: "miscShapeWipe", subtype: "vertical" };
    case "ripple":
      return { type: "miscShapeWipe", subtype: "horizontal" };
    case "gallery":
    case "ferris":
      return { type: "pushWipe", subtype: dir === "right" ? "fromLeft" : "fromRight" };
    case "flash":
      return { type: "fade", subtype: "fadeOverColor", fadeColor: "#ffffff" };
    default:
      return { type: "fade", subtype: "crossfade" };
  }
}

function speed(ms: number) {
  return ms <= 500 ? "fast" : ms <= 1000 ? "medium" : "slow";
}

function duration(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `PT${String(Math.floor(s / 3600)).padStart(2, "0")}H${String(Math.floor(s / 60) % 60).padStart(2, "0")}M${String(s % 60).padStart(2, "0")}S`;
}

// ───────────── animaciones ─────────────

const ENTR_FROM: Record<string, string> = { up: "from-bottom", down: "from-top", left: "from-right", right: "from-left" };
const EXIT_TO: Record<string, string> = { down: "from-bottom", up: "from-top", left: "from-left", right: "from-right" };

/** Lo de adentro de un efecto (los nodos que LibreOffice reproduce) y su nombre en LibreOffice. */
function effectNodes(a: Animation, target: string, sub: string): { preset: string; subType?: string; nodes: string } {
  const d = sec(Math.max(a.duration, 1));
  const tg = `smil:targetElement="${target}"${sub}`;
  const show = `<anim:set smil:begin="0s" smil:dur="0.001s" smil:fill="hold" ${tg} smil:attributeName="visibility" smil:to="visible"/>`;
  const hideAt = (ms: number) => `<anim:set smil:begin="${sec(Math.max(ms - 1, 0))}" smil:dur="0.001s" smil:fill="hold" ${tg} smil:attributeName="visibility" smil:to="hidden"/>`;
  const cls = clsOf(a);
  const dir = a.direction ?? (cls === "exit" ? "down" : "up");
  if (cls === "emph") {
    switch (a.effect) {
      case "spin":
        return { preset: "ooo-emphasis-spin", nodes: `<anim:animateTransform smil:begin="0s" smil:dur="${d}" smil:fill="hold" ${tg} smil:by="360" smil:attributeName="transform" svg:type="rotate"/>` };
      case "grow":
        return { preset: "ooo-emphasis-grow-and-shrink", nodes: `<anim:animateTransform smil:begin="0s" smil:dur="${d}" smil:fill="hold" ${tg} smil:to="1.5,1.5" smil:attributeName="transform" svg:type="scale"/>` };
      case "pulse":
        return { preset: "ooo-emphasis-grow-and-shrink", nodes: `<anim:animateTransform smil:begin="0s" smil:dur="${sec(a.duration / 4)}" smil:fill="hold" ${tg} smil:to="1.1,1.1" smil:autoReverse="true" smil:repeatCount="2" smil:attributeName="transform" svg:type="scale"/>` };
      case "teeter":
        return { preset: "ooo-emphasis-spin", nodes: `<anim:animateTransform smil:begin="0s" smil:dur="${d}" smil:fill="hold" ${tg} smil:values="0;6;-6;6;-6;0" smil:keyTimes="0;0.2;0.4;0.6;0.8;1" smil:attributeName="transform" svg:type="rotate"/>` };
      default:
        return { preset: "ooo-emphasis-transparency", nodes: `<anim:set smil:begin="0s" smil:dur="${d}" smil:fill="hold" ${tg} smil:attributeName="opacity" smil:to="0.4"/>` };
    }
  }
  if (cls === "exit") {
    const end = hideAt(a.duration);
    switch (a.effect) {
      case "appear":
        return { preset: "ooo-exit-disappear", nodes: hideAt(1) };
      case "fly": {
        const y = dir === "down" ? "1+height/2" : dir === "up" ? "0-height/2" : "y";
        const x = dir === "left" ? "0-width/2" : dir === "right" ? "1+width/2" : "x";
        return {
          preset: "ooo-exit-fly-out",
          subType: EXIT_TO[dir],
          nodes: `<anim:animate smil:dur="${d}" smil:fill="hold" ${tg} smil:attributeName="x" smil:values="x;${x}" smil:keyTimes="0;1"/><anim:animate smil:dur="${d}" smil:fill="hold" ${tg} smil:attributeName="y" smil:values="y;${y}" smil:keyTimes="0;1"/>${end}`,
        };
      }
      case "zoom":
        return { preset: "ooo-exit-zoom", subType: "out", nodes: `<anim:animate smil:dur="${d}" smil:fill="hold" ${tg} smil:attributeName="width" smil:values="width;0" smil:keyTimes="0;1"/><anim:animate smil:dur="${d}" smil:fill="hold" ${tg} smil:attributeName="height" smil:values="height;0" smil:keyTimes="0;1"/>${end}` };
      case "wipe": {
        const vertical = dir === "up" || dir === "down";
        return {
          preset: "ooo-exit-wipe",
          subType: EXIT_TO[dir],
          nodes: `<anim:transitionFilter smil:dur="${d}" ${tg} smil:type="barWipe" smil:subtype="${vertical ? "topToBottom" : "leftToRight"}"${dir === "up" || dir === "left" ? ' smil:direction="reverse"' : ""} smil:mode="out"/>${end}`,
        };
      }
      default:
        return { preset: "ooo-exit-fade-out", nodes: `<anim:transitionFilter smil:dur="${d}" ${tg} smil:type="fade" smil:subtype="crossfade" smil:mode="out"/>${end}` };
    }
  }
  switch (a.effect) {
    case "appear":
      return { preset: "ooo-entrance-appear", nodes: show };
    case "fly": {
      const y = dir === "up" ? "1+height/2" : dir === "down" ? "0-height/2" : "y";
      const x = dir === "left" ? "1+width/2" : dir === "right" ? "0-width/2" : "x";
      return {
        preset: "ooo-entrance-fly-in",
        subType: ENTR_FROM[dir],
        nodes: `${show}<anim:animate smil:dur="${d}" smil:fill="hold" ${tg} smil:attributeName="x" smil:values="${x};x" smil:keyTimes="0;1"/><anim:animate smil:dur="${d}" smil:fill="hold" ${tg} smil:attributeName="y" smil:values="${y};y" smil:keyTimes="0;1"/>`,
      };
    }
    case "zoom":
      return { preset: "ooo-entrance-zoom", subType: "in", nodes: `${show}<anim:animate smil:dur="${d}" smil:fill="hold" ${tg} smil:attributeName="width" smil:values="0;width" smil:keyTimes="0;1"/><anim:animate smil:dur="${d}" smil:fill="hold" ${tg} smil:attributeName="height" smil:values="0;height" smil:keyTimes="0;1"/>` };
    case "wipe": {
      const vertical = dir === "up" || dir === "down";
      return {
        preset: "ooo-entrance-wipe",
        subType: ENTR_FROM[dir],
        nodes: `${show}<anim:transitionFilter smil:dur="${d}" ${tg} smil:type="barWipe" smil:subtype="${vertical ? "topToBottom" : "leftToRight"}"${dir === "up" || dir === "left" ? ' smil:direction="reverse"' : ""}/>`,
      };
    }
    default:
      return { preset: "ooo-entrance-fade-in", nodes: `${show}<anim:transitionFilter smil:dur="${d}" ${tg} smil:type="fade" smil:subtype="crossfade"/>` };
  }
}

const PRESET_CLASS = { entr: "entrance", exit: "exit", emph: "emphasis" } as const;

// ───────────── el escritor ─────────────

type Media = { path: string; bytes: Uint8Array; mime: string };

class OdpWriter {
  private auto = new Map<string, string>();
  private autoXml: string[] = [];
  private counts: Record<string, number> = {};
  files: Media[] = [];
  private byContent = new Map<string, string>();
  /** Gráficas: carpeta del objeto → su content.xml. */
  objects: { dir: string; content: string }[] = [];
  /** Imágenes de fondo (draw:fill-image, van en styles.xml). */
  fillImages: { name: string; href: string }[] = [];
  private nextId = 1;
  paraIds = 0;

  constructor(private deck: Deck) {}

  /** Estilo automático (los iguales se comparten). */
  style(family: string, prefix: string, inner: string, extra = ""): string {
    const key = `${family}|${extra}|${inner}`;
    const known = this.auto.get(key);
    if (known) return known;
    this.counts[prefix] = (this.counts[prefix] ?? 0) + 1;
    const name = `${prefix}${this.counts[prefix]}`;
    this.auto.set(key, name);
    this.autoXml.push(`<style:style style:name="${name}" style:family="${family}"${extra}>${inner}</style:style>`);
    return name;
  }

  autoStyles() {
    return this.autoXml.join("");
  }

  id() {
    return `id${this.nextId++}`;
  }

  /** Guarda un archivo en el paquete (una sola vez aunque se repita). */
  media(dir: string, bytes: Uint8Array, ext: string, mime: string): string {
    const key = `${ext}:${bytes.length}:${bytes.subarray(0, 64).join(",")}:${bytes.subarray(-64).join(",")}`;
    const known = this.byContent.get(key);
    if (known) return known;
    this.counts[dir] = (this.counts[dir] ?? 0) + 1;
    const path = `${dir}/${dir === "Pictures" ? "imagen" : "medio"}${this.counts[dir]}.${ext}`;
    this.files.push({ path, bytes, mime });
    this.byContent.set(key, path);
    return path;
  }

  // ─── texto ───

  textStyle(run: Run): string | null {
    const p: string[] = [];
    if (run.bold) p.push('fo:font-weight="bold" style:font-weight-asian="bold" style:font-weight-complex="bold"');
    if (run.italic) p.push('fo:font-style="italic" style:font-style-asian="italic" style:font-style-complex="italic"');
    if (run.underline) p.push('style:text-underline-style="solid" style:text-underline-width="auto" style:text-underline-color="font-color"');
    if (run.strike) p.push('style:text-line-through-style="solid" style:text-line-through-type="single"');
    if (run.size) p.push(`fo:font-size="${run.size}pt" style:font-size-asian="${run.size}pt" style:font-size-complex="${run.size}pt"`);
    if (run.color) p.push(`fo:color="${hex(run.color)}"`);
    if (run.font) p.push(`fo:font-family="${esc(`'${run.font}'`)}" style:font-family-asian="${esc(`'${run.font}'`)}" style:font-family-complex="${esc(`'${run.font}'`)}"`);
    return p.length ? this.style("text", "T", `<style:text-properties ${p.join(" ")}/>`) : null;
  }

  paraStyle(p: Para): string | null {
    const props: string[] = [];
    if (p.align && p.align !== "left") props.push(`fo:text-align="${p.align === "center" ? "center" : p.align === "right" ? "end" : "justify"}"`);
    if (p.spaceBefore !== undefined) props.push(`fo:margin-top="${p.spaceBefore}pt"`);
    if (p.spaceAfter !== undefined) props.push(`fo:margin-bottom="${p.spaceAfter}pt"`);
    if (p.lineSpacing) props.push(`fo:line-height="${Math.round(p.lineSpacing * 100)}%"`);
    // Sangría de los párrafos sin viñeta con nivel (como en PowerPoint: 0.79 cm por nivel).
    if (!p.bullet && p.level) props.push(`fo:margin-left="${(0.794 * p.level).toFixed(3)}cm"`);
    const size = !p.runs.some((r) => r.text) && p.endSize ? `<style:text-properties fo:font-size="${p.endSize}pt" style:font-size-asian="${p.endSize}pt" style:font-size-complex="${p.endSize}pt"/>` : "";
    if (!props.length && !size) return null;
    return this.style("paragraph", "P", `${props.length ? `<style:paragraph-properties ${props.join(" ")}/>` : ""}${size}`);
  }

  runs(runs: Run[]): string {
    return runs
      .map((run) => {
        const name = this.textStyle(run);
        const content = textContent(run.text);
        if (!content) return "";
        const span = name ? `<text:span text:style-name="${name}">${content}</text:span>` : `<text:span>${content}</text:span>`;
        return run.link ? `<text:a xlink:type="simple" xlink:href="${esc(run.link)}">${span}</text:a>` : span;
      })
      .join("");
  }

  para(p: Para, id: string | null): string {
    const name = this.paraStyle(p);
    const attrs = `${name ? ` text:style-name="${name}"` : ""}${id ? ` xml:id="${id}" text:id="${id}"` : ""}`;
    return `<text:p${attrs}>${this.runs(p.runs)}</text:p>`;
  }

  /** Párrafos con sus listas (anidadas por nivel). `ids`: párrafos con nombre, para las animaciones por párrafo. */
  paragraphs(text: TextBody | undefined, ids?: Map<number, string>): string {
    const paras = text?.paras.length ? text.paras : [{ runs: [] }];
    let out = "";
    const stack: { open: boolean }[] = [];
    let kind: Para["bullet"] = null;
    const closeAll = () => {
      while (stack.length) {
        if (stack[stack.length - 1].open) out += "</text:list-item>";
        out += "</text:list>";
        stack.pop();
      }
    };
    paras.forEach((p, i) => {
      const xmlId = ids?.get(i) ?? null;
      if (!p.bullet) {
        closeAll();
        kind = null;
        out += this.para(p, xmlId);
        return;
      }
      if (stack.length && kind !== p.bullet) closeAll();
      kind = p.bullet;
      const depth = Math.min(Math.max(p.level ?? 0, 0), 8) + 1;
      if (!stack.length) {
        out += `<text:list text:style-name="${p.bullet === "number" ? "L2" : "L1"}">`;
        stack.push({ open: false });
      }
      while (stack.length > depth) {
        if (stack[stack.length - 1].open) out += "</text:list-item>";
        out += "</text:list>";
        stack.pop();
      }
      while (stack.length < depth) {
        const top = stack[stack.length - 1];
        if (!top.open) {
          out += "<text:list-item>";
          top.open = true;
        }
        out += "<text:list>";
        stack.push({ open: false });
      }
      const top = stack[stack.length - 1];
      if (top.open) out += "</text:list-item>";
      out += `<text:list-item>${this.para(p, xmlId)}`;
      top.open = true;
    });
    closeAll();
    return out;
  }

  // ─── elementos ───

  /** Posición y tamaño (con el giro, como lo escribe LibreOffice: girado sobre la esquina y movido). */
  geometry(el: SlideElement): string {
    const size = `svg:width="${cm(Math.max(el.w, 0))}" svg:height="${cm(Math.max(el.h, 0))}"`;
    if (!el.rot) return `${size} svg:x="${cm(el.x)}" svg:y="${cm(el.y)}"`;
    const d = (el.rot * Math.PI) / 180;
    const cx = el.x + el.w / 2;
    const cy = el.y + el.h / 2;
    const tx = cx + (-el.w / 2) * Math.cos(d) - (-el.h / 2) * Math.sin(d);
    const ty = cy + (-el.w / 2) * Math.sin(d) + (-el.h / 2) * Math.cos(d);
    return `${size} draw:transform="rotate (${(-d).toFixed(6)}) translate (${cm(tx)} ${cm(ty)})"`;
  }

  stroke(line: ShapeElement["line"]): string {
    if (!line) return 'draw:stroke="none"';
    const dash = line.dash === "dash" ? ' draw:stroke-dash="WEPO_20_guion"' : line.dash === "dot" ? ' draw:stroke-dash="WEPO_20_punto"' : "";
    return `draw:stroke="${dash ? "dash" : "solid"}"${dash} svg:stroke-color="${hex(line.color)}" svg:stroke-width="${cm(line.width)}"`;
  }

  textArea(text: TextBody | undefined): string {
    const [l, t, r, b] = text?.insets ?? [9.6, 4.8, 9.6, 4.8];
    const anchor = text?.anchor === "middle" ? "middle" : text?.anchor === "bottom" ? "bottom" : "top";
    return `draw:textarea-vertical-align="${anchor}" draw:auto-grow-height="false" draw:auto-grow-width="false" draw:fit-to-size="false" style:shrink-to-fit="false" fo:min-height="0cm" fo:padding-left="${cm(l)}" fo:padding-top="${cm(t)}" fo:padding-right="${cm(r)}" fo:padding-bottom="${cm(b)}" fo:wrap-option="wrap"`;
  }

  defaultSize(text: TextBody | undefined): string {
    const s = text?.defaultSize ? Math.round(text.defaultSize * (text.fontScale ?? 1) * 10) / 10 : null;
    return s ? `<style:text-properties fo:font-size="${s}pt" style:font-size-asian="${s}pt" style:font-size-complex="${s}pt"/>` : "";
  }

  shape(el: ShapeElement, ids: Map<string, string>, paraIds: Map<string, Map<number, string>>): string {
    const id = this.id();
    ids.set(el.id, id);
    const name = el.name ? ` draw:name="${esc(el.name)}"` : "";
    const idAttrs = `xml:id="${id}" draw:id="${id}"`;
    if (isLine(el.geom)) {
      const style = this.style("graphic", "gr", `<style:graphic-properties ${this.stroke(el.line ?? { color: "#000000", width: 1 })} draw:fill="none"/>`);
      let [x1, y1, x2, y2] = [el.x, el.y, el.x + el.w, el.y + el.h];
      if (el.flipH) [x1, x2] = [x2, x1];
      if (el.flipV) [y1, y2] = [y2, y1];
      if (el.rot) {
        const d = (el.rot * Math.PI) / 180;
        const cx = el.x + el.w / 2;
        const cy = el.y + el.h / 2;
        const turn = (x: number, y: number) => [cx + (x - cx) * Math.cos(d) - (y - cy) * Math.sin(d), cy + (x - cx) * Math.sin(d) + (y - cy) * Math.cos(d)];
        [x1, y1] = turn(x1, y1);
        [x2, y2] = turn(x2, y2);
      }
      return `<draw:line${name} draw:style-name="${style}" draw:layer="layout" ${idAttrs} svg:x1="${cm(x1)}" svg:y1="${cm(y1)}" svg:x2="${cm(x2)}" svg:y2="${cm(y2)}"><text:p/></draw:line>`;
    }
    const fill = el.fill ? `draw:fill="solid" draw:fill-color="${hex(el.fill)}"` : 'draw:fill="none"';
    const props = `<style:graphic-properties ${fill} ${this.stroke(el.line)} ${this.textArea(el.text)}/>${this.defaultSize(el.text)}`;
    const body = this.paragraphs(el.text, paraIds.get(el.id));
    const textBox = !el.placeholder && el.geom === "rect" && !el.fill && !el.line;
    if (el.role || textBox) {
      const cls = el.role === "title" ? "title" : el.role === "subtitle" ? "subtitle" : el.role === "body" ? "outline" : null;
      const style = cls ? this.style("presentation", "pr", props, ` style:parent-style-name="WEPO-${cls === "outline" ? "outline1" : cls}"`) : this.style("graphic", "gr", props, ' style:parent-style-name="standard"');
      const empty = isEmptyText(el.text);
      const pres = cls ? ` presentation:class="${cls}"${empty ? ' presentation:placeholder="true"' : ""} presentation:user-transformed="true"` : "";
      const family = cls ? "presentation:style-name" : "draw:style-name";
      return `<draw:frame${name} ${family}="${style}" draw:layer="layout" ${idAttrs} ${this.geometry(el)}${pres}><draw:text-box>${cls && empty ? "" : body}</draw:text-box></draw:frame>`;
    }
    const style = this.style("graphic", "gr", props, ' style:parent-style-name="standard"');
    const type = GEOM_TO_ODF[el.geom] ?? `ooxml-${el.geom}`;
    const path = GEOM_TO_ODF[el.geom] ? "" : ' draw:enhanced-path="M 0 0 L 21600 0 21600 21600 0 21600 Z N"';
    const mirror = `${el.flipH ? ' draw:mirror-horizontal="true"' : ""}${el.flipV ? ' draw:mirror-vertical="true"' : ""}`;
    return `<draw:custom-shape${name} draw:style-name="${style}" draw:layer="layout" ${idAttrs} ${this.geometry(el)}>${el.text ? body : ""}<draw:enhanced-geometry svg:viewBox="0 0 21600 21600" draw:type="${type}"${path}${mirror}/></draw:custom-shape>`;
  }

  image(el: ImageElement, ids: Map<string, string>): string {
    const img = imageBytes(el.src);
    if (!img) return "";
    const id = this.id();
    ids.set(el.id, id);
    const mirror = el.flipH && el.flipV ? ' style:mirror="horizontal vertical"' : el.flipH ? ' style:mirror="horizontal"' : el.flipV ? ' style:mirror="vertical"' : "";
    const style = this.style("graphic", "gr", `<style:graphic-properties draw:stroke="none" draw:fill="none"${mirror}/>`, ' style:parent-style-name="standard"');
    const picture = this.media("Pictures", img.bytes, img.ext, img.mime);
    const image = `<draw:image xlink:href="${picture}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"><text:p/></draw:image>`;
    const name = esc(el.name ?? (el.media ? `${el.media.type === "video" ? "Video" : "Audio"} ${id}` : `Imagen ${id}`));
    const file = el.media ? mediaBytes(el.media.src) : null;
    let inner = image;
    if (el.media && file) {
      const mime = /^data:([\w/+.-]+);/.exec(el.media.src)?.[1] ?? "application/vnd.sun.star.media";
      const path = this.media("Media", file.bytes, file.ext, mime);
      const autoplay = el.media.autoplay ? `<draw:param draw:name="WEPO-autoplay" draw:value="true"/>` : "";
      inner = `<draw:plugin xlink:href="${path}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad" draw:mime-type="${esc(mime)}"><draw:param draw:name="Loop" draw:value="${el.media.loop ? "true" : "false"}"/><draw:param draw:name="Mute" draw:value="false"/><draw:param draw:name="VolumeDB" draw:value="0"/>${autoplay}</draw:plugin>${image}`;
    }
    return `<draw:frame draw:name="${name}" draw:style-name="${style}" draw:layer="layout" xml:id="${id}" draw:id="${id}" ${this.geometry(el)}>${inner}</draw:frame>`;
  }

  table(el: TableElement, ids: Map<string, string>): string {
    const id = this.id();
    ids.set(el.id, id);
    const frame = this.style("graphic", "gr", '<style:graphic-properties draw:stroke="none" draw:fill="none"/>', ' style:parent-style-name="standard"');
    const cols = el.cols.map((w) => `<table:table-column table:style-name="${this.style("table-column", "co", `<style:table-column-properties style:column-width="${cm(w)}" style:use-optimal-column-width="false"/>`)}"/>`).join("");
    const border = el.border ? `0.75pt solid ${hex(el.border)}` : "none";
    const rows = el.rows
      .map((row, ri) => {
        const rowStyle = this.style("table-row", "ro", `<style:table-row-properties style:row-height="${cm(row.h)}" style:use-optimal-row-height="false"/>`);
        const cells = row.cells
          .map((c) => {
            if (c.merged) return "<table:covered-table-cell/>";
            const fill = c.fill ? `draw:fill="solid" draw:fill-color="${hex(c.fill)}"` : 'draw:fill="none"';
            const [l, t, r, b] = c.text.insets ?? [9.6, 4.8, 9.6, 4.8];
            const anchor = c.text.anchor === "middle" ? "middle" : c.text.anchor === "bottom" ? "bottom" : "top";
            const props = `<loext:graphic-properties ${fill} draw:textarea-vertical-align="${anchor}" fo:padding-left="${cm(l)}" fo:padding-top="${cm(t)}" fo:padding-right="${cm(r)}" fo:padding-bottom="${cm(b)}"/><style:table-cell-properties fo:border="${border}"${c.fill ? ` fo:background-color="${hex(c.fill)}"` : ""} style:vertical-align="${anchor}"/><style:paragraph-properties fo:border="${border}"/>${this.defaultSize(c.text)}`;
            const style = this.style("table-cell", "ce", props);
            const text = el.header && ri === 0 ? headerText(c.text) : c.text;
            const span = `${c.span && c.span > 1 ? ` table:number-columns-spanned="${c.span}"` : ""}${c.rowSpan && c.rowSpan > 1 ? ` table:number-rows-spanned="${c.rowSpan}"` : ""}`;
            return `<table:table-cell table:style-name="${style}"${span}>${this.paragraphs(text)}</table:table-cell>`;
          })
          .join("");
        return `<table:table-row table:style-name="${rowStyle}">${cells}</table:table-row>`;
      })
      .join("");
    const name = esc(el.name ?? `Tabla ${id}`);
    return `<draw:frame draw:name="${name}" draw:style-name="${frame}" draw:layer="layout" xml:id="${id}" draw:id="${id}" ${this.geometry(el)}><table:table${el.header ? ' table:use-first-row-styles="true" wepo:header="true"' : ""}>${cols}${rows}</table:table></draw:frame>`;
  }

  chart(el: ChartElement, ids: Map<string, string>): string {
    const id = this.id();
    ids.set(el.id, id);
    const dir = `Object ${this.objects.length + 1}`;
    this.objects.push({ dir, content: chartContent(el, this.deck.theme.text, this.deck.theme.fonts.minor) });
    const style = this.style("graphic", "gr", '<style:graphic-properties draw:stroke="none" draw:fill="none"/>', ' style:parent-style-name="standard"');
    const name = esc(el.name ?? `Gráfica ${id}`);
    return `<draw:frame draw:name="${name}" draw:style-name="${style}" draw:layer="layout" xml:id="${id}" draw:id="${id}" ${this.geometry(el)}><draw:object xlink:href="./${dir}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/></draw:frame>`;
  }

  element(el: SlideElement, ids: Map<string, string>, paraIds: Map<string, Map<number, string>>): string {
    return el.kind === "shape" ? this.shape(el, ids, paraIds) : el.kind === "image" ? this.image(el, ids) : el.kind === "table" ? this.table(el, ids) : this.chart(el, ids);
  }

  // ─── diapositivas ───

  timing(slide: Slide, pageId: string, ids: Map<string, string>, paraIds: Map<string, Map<number, string>>): string {
    let inner = "";
    const t = slide.transition;
    const odf = t ? odfTransition(t) : null;
    if (t && odf) {
      inner += `<anim:par smil:begin="${pageId}.begin"><anim:transitionFilter smil:dur="${sec(t.duration)}" smil:type="${odf.type}" smil:subtype="${odf.subtype}"${odf.reverse ? ' smil:direction="reverse"' : ""}${odf.fadeColor ? ` smil:fadeColor="${odf.fadeColor}"` : ""}/></anim:par>`;
    }
    const groups: string[] = [];
    for (const step of animationSteps(slide)) {
      const items = step.items
        .map((item, i) => {
          const a = item.anim;
          const elId = ids.get(a.target);
          if (!elId) return "";
          let target = elId;
          let sub = "";
          if (item.para !== null) {
            const pid = paraIds.get(a.target)?.get(item.para);
            if (pid) target = pid;
            else sub = ' anim:sub-item="text"';
          }
          const trigger = i === 0 ? (step.auto ? (item.trigger === "with" ? "with-previous" : "after-previous") : "on-click") : item.trigger === "after" ? "after-previous" : item.trigger === "with" ? "with-previous" : "on-click";
          const { preset, subType, nodes } = effectNodes(a, target, sub);
          const cls = clsOf(a);
          const attrs = `smil:begin="${sec(a.delay)}" smil:fill="hold" presentation:node-type="${trigger}" presentation:preset-class="${PRESET_CLASS[cls]}" presentation:preset-id="${preset}"${subType ? ` presentation:preset-sub-type="${subType}"` : ""} wepo:effect="${a.effect}"${a.direction ? ` wepo:direction="${a.direction}"` : ""}${a.byParagraph ? ' wepo:by-paragraph="true"' : ""}`;
          return `<anim:par smil:begin="${sec(item.start - a.delay)}" smil:fill="hold"><anim:par ${attrs}>${nodes}</anim:par></anim:par>`;
        })
        .join("");
      if (items) groups.push(`<anim:par smil:begin="${step.auto ? "0s" : "next"}" smil:fill="hold">${items}</anim:par>`);
    }
    // Videos y audios que empiezan solos al llegar a la diapositiva.
    for (const el of slide.elements) {
      if (el.kind !== "image" || !el.media?.autoplay || !ids.get(el.id)) continue;
      groups.unshift(`<anim:par smil:begin="0s" smil:fill="hold"><anim:par smil:begin="0s" smil:fill="hold"><anim:par smil:begin="0s" smil:fill="hold" presentation:node-type="after-previous" presentation:preset-class="media-call" presentation:preset-id=""><anim:command smil:dur="0.001s" smil:fill="hold" smil:targetElement="${ids.get(el.id)}" anim:command="play"/></anim:par></anim:par></anim:par>`);
    }
    if (groups.length) inner += `<anim:seq smil:dur="indefinite" presentation:node-type="main-sequence">${groups.join("")}</anim:seq>`;
    return inner ? `<anim:par smil:dur="indefinite" smil:restart="never" presentation:node-type="timing-root">${inner}</anim:par>` : "";
  }

  pageStyle(slide: Slide): string {
    const props: string[] = ['presentation:background-visible="true"', 'presentation:background-objects-visible="true"'];
    if (slide.backgroundImage) {
      const img = imageBytes(slide.backgroundImage);
      if (img) {
        const href = this.media("Pictures", img.bytes, img.ext, img.mime);
        let name = this.fillImages.find((f) => f.href === href)?.name;
        if (!name) {
          name = `WEPO_20_fondo_20_${this.fillImages.length + 1}`;
          this.fillImages.push({ name, href });
        }
        props.push(`draw:fill="bitmap" draw:fill-image-name="${name}" style:repeat="stretch" draw:background-size="full"`);
      }
    } else if (slide.background) props.push(`draw:fill="solid" draw:fill-color="${hex(slide.background)}"`);
    if (slide.hidden) props.push('presentation:visibility="hidden"');
    const t = slide.transition;
    if (t?.advanceAfter) props.push(`presentation:transition-type="automatic" presentation:duration="${duration(t.advanceAfter)}"`);
    const odf = t ? odfTransition(t) : null;
    if (t && odf) {
      props.push(`presentation:transition-speed="${speed(t.duration)}" smil:type="${odf.type}" smil:subtype="${odf.subtype}"${odf.reverse ? ' smil:direction="reverse"' : ""}${odf.fadeColor ? ` smil:fadeColor="${odf.fadeColor}"` : ""}`);
    }
    if (t) props.push(`wepo:transition="${t.kind}"${t.direction ? ` wepo:direction="${t.direction}"` : ""} wepo:duration="${Math.round(t.duration)}"`);
    return this.style("drawing-page", "dp", `<style:drawing-page-properties ${props.join(" ")}/>`);
  }

  notes(text: string, n: number): string {
    const style = this.style("presentation", "pr", '<style:graphic-properties draw:fill="none"/>', ' style:parent-style-name="WEPO-notes"');
    const w = this.deck.width;
    const paras = text ? text.split("\n").map((line) => `<text:p>${textContent(line)}</text:p>`).join("") : "";
    return `<presentation:notes draw:style-name="${this.style("drawing-page", "dp", '<style:drawing-page-properties presentation:display-header="false" presentation:display-footer="false" presentation:display-page-number="false" presentation:display-date-time="false"/>')}"><draw:page-thumbnail draw:layer="layout" svg:width="14cm" svg:height="${(14 * (this.deck.height / w)).toFixed(3)}cm" svg:x="3.5cm" svg:y="2cm" draw:page-number="${n}" presentation:class="page"/><draw:frame presentation:style-name="${style}" draw:layer="layout" svg:width="17cm" svg:height="11cm" svg:x="2cm" svg:y="12.5cm" presentation:class="notes"${text ? "" : ' presentation:placeholder="true"'}><draw:text-box>${paras}</draw:text-box></draw:frame></presentation:notes>`;
  }

  slide(slide: Slide, n: number): string {
    const ids = new Map<string, string>();
    // Párrafos que entran uno por uno: cada uno lleva su propio id.
    const paraIds = new Map<string, Map<number, string>>();
    for (const a of slide.animations ?? []) {
      if (!a.byParagraph) continue;
      const el = slide.elements.find((e) => e.id === a.target);
      if (el?.kind !== "shape" || !el.text) continue;
      const map = paraIds.get(el.id) ?? new Map<number, string>();
      el.text.paras.forEach((_, i) => map.set(i, `p${++this.paraIds}`));
      paraIds.set(el.id, map);
    }
    const pageId = `pagina${n}`;
    const shapes = slide.elements.map((el) => this.element(el, ids, paraIds)).join("");
    const style = this.pageStyle(slide);
    return `<draw:page draw:name="page${n}" draw:style-name="${style}" draw:master-page-name="WEPO" xml:id="${pageId}" draw:id="${pageId}" wepo:layout="${slide.layout}">${shapes}${this.timing(slide, pageId, ids, paraIds)}${this.notes(slide.notes, n)}</draw:page>`;
  }
}

function headerText(text: TextBody): TextBody {
  return { ...text, paras: text.paras.map((p) => ({ ...p, runs: p.runs.map((r) => ({ ...r, color: r.color ?? "#FFFFFF", bold: r.bold ?? true })) })) };
}

/** Texto con los espacios repetidos, tabuladores y saltos de línea de OpenDocument. */
export function textContent(text: string): string {
  return text
    .split("\n")
    .map((line) =>
      line
        .split("\t")
        .map((part) => esc(part).replace(/ {2,}/g, (m) => ` <text:s text:c="${m.length - 1}"/>`).replace(/^ /, '<text:s/>'))
        .join("<text:tab/>"),
    )
    .join("<text:line-break/>");
}

// ───────────── gráficas ─────────────

const CHART_CLASS: Record<ChartElement["chartType"], string> = { column: "chart:bar", bar: "chart:bar", line: "chart:line", area: "chart:area", pie: "chart:circle", doughnut: "chart:ring" };

function colLetter(i: number) {
  let s = "";
  let n = i + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function chartContent(el: ChartElement, textColor: string, font: string): string {
  const rows = el.categories.length;
  const pie = el.chartType === "pie" || el.chartType === "doughnut";
  const line = el.chartType === "line";
  const fontAttr = `fo:font-family="${esc(`'${font}'`)}"`;
  const styles: string[] = [
    `<style:style style:name="ch1" style:family="chart"><style:graphic-properties draw:stroke="none" draw:fill="none"/></style:style>`,
    `<style:style style:name="ch2" style:family="chart"><style:text-properties fo:color="${hex(textColor)}" ${fontAttr} fo:font-size="18pt"/></style:style>`,
    `<style:style style:name="ch3" style:family="chart"><style:text-properties fo:color="${hex(textColor)}" ${fontAttr} fo:font-size="12pt"/></style:style>`,
    `<style:style style:name="ch4" style:family="chart"><style:chart-properties${el.chartType === "bar" ? ' chart:vertical="true"' : ""}${el.stacked && !pie ? ' chart:stacked="true"' : ""}${el.chartType === "doughnut" ? ' chart:hole-size="50%"' : ""} chart:treat-empty-cells="leave-gap"/></style:style>`,
    `<style:style style:name="ch5" style:family="chart"><style:chart-properties chart:display-label="true"${el.chartType === "bar" ? ' chart:reverse-direction="true"' : ""}/><style:graphic-properties svg:stroke-color="#bfbfbf"/><style:text-properties fo:color="${hex(textColor)}" ${fontAttr} fo:font-size="12pt"/></style:style>`,
    `<style:style style:name="ch6" style:family="chart"><style:chart-properties chart:display-label="true"${el.chartType === "bar" ? ' chart:axis-position="end"' : ""}/><style:graphic-properties draw:stroke="none"/><style:text-properties fo:color="${hex(textColor)}" ${fontAttr} fo:font-size="12pt"/></style:style>`,
    `<style:style style:name="ch7" style:family="chart"><style:graphic-properties svg:stroke-color="#d9d9d9"/></style:style>`,
    `<style:style style:name="ch8" style:family="chart"><style:graphic-properties draw:stroke="none" draw:fill="none"/></style:style>`,
  ];
  const labels = el.labels ? ' chart:data-label-number="value"' : "";
  const series = el.series
    .map((s, i) => {
      const name = `chs${i + 1}`;
      const g = line ? `draw:stroke="solid" svg:stroke-color="${hex(s.color)}" svg:stroke-width="0.07cm" draw:fill-color="${hex(s.color)}"` : `draw:fill="solid" draw:fill-color="${hex(s.color)}" draw:stroke="none"`;
      styles.push(`<style:style style:name="${name}" style:family="chart"><style:chart-properties${labels}${line ? ' chart:symbol-type="none"' : ""}/><style:graphic-properties ${g}/><style:text-properties fo:color="${hex(textColor)}" fo:font-size="11pt"/></style:style>`);
      const col = colLetter(i + 1);
      // En el pastel cada rebanada lleva su color (el de las series, como en WEPO).
      let points = `<chart:data-point chart:repeated="${rows}"/>`;
      if (pie) {
        points = el.categories
          .map((_, ci) => {
            const pname = `chp${i + 1}_${ci + 1}`;
            styles.push(`<style:style style:name="${pname}" style:family="chart"><style:graphic-properties draw:fill="solid" draw:fill-color="${hex(SLICE_COLORS[ci % SLICE_COLORS.length])}" draw:stroke="solid" svg:stroke-color="#ffffff"/></style:style>`);
            return `<chart:data-point chart:style-name="${pname}"/>`;
          })
          .join("");
      }
      return `<chart:series chart:style-name="${name}" chart:values-cell-range-address="local-table.$${col}$2:.$${col}$${rows + 1}" chart:label-cell-address="local-table.$${col}$1" chart:class="${CHART_CLASS[el.chartType]}">${points}</chart:series>`;
    })
    .join("");
  const header = `<table:table-row><table:table-cell><text:p/></table:table-cell>${el.series.map((s) => `<table:table-cell office:value-type="string"><text:p>${esc(s.name)}</text:p></table:table-cell>`).join("")}</table:table-row>`;
  const body = el.categories
    .map((c, ri) => `<table:table-row><table:table-cell office:value-type="string"><text:p>${esc(c)}</text:p></table:table-cell>${el.series.map((s) => (s.values[ri] === null || s.values[ri] === undefined ? `<table:table-cell><text:p/></table:table-cell>` : `<table:table-cell office:value-type="float" office:value="${s.values[ri]}"><text:p>${s.values[ri]}</text:p></table:table-cell>`)).join("")}</table:table-row>`)
    .join("");
  const last = colLetter(el.series.length);
  const title = el.title ? `<chart:title chart:style-name="ch2"><text:p>${esc(el.title)}</text:p></chart:title>` : "";
  const legend = el.legend ? `<chart:legend chart:legend-position="${pie ? "end" : "bottom"}" style:legend-expansion="${pie ? "high" : "wide"}" chart:style-name="ch3"/>` : "";
  const axes = pie
    ? ""
    : `<chart:axis chart:dimension="x" chart:name="primary-x" chart:style-name="ch5"><chart:categories table:cell-range-address="local-table.$A$2:.$A$${rows + 1}"/></chart:axis><chart:axis chart:dimension="y" chart:name="primary-y" chart:style-name="ch6"><chart:grid chart:style-name="ch7" chart:class="major"/></chart:axis>`;
  const pieCats = pie ? `<chart:axis chart:dimension="x" chart:name="primary-x"><chart:categories table:cell-range-address="local-table.$A$2:.$A$${rows + 1}"/></chart:axis>` : "";
  return `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${ROOT_NS} office:version="1.3"><office:automatic-styles>${styles.join("")}</office:automatic-styles><office:body><office:chart><chart:chart svg:width="${cm(el.w)}" svg:height="${cm(el.h)}" chart:class="${CHART_CLASS[el.chartType]}" chart:style-name="ch1">${title}${legend}<chart:plot-area chart:style-name="ch4" table:cell-range-address="local-table.$A$1:.$${last}$${rows + 1}" chart:data-source-has-labels="both">${axes}${pieCats}${series}<chart:wall chart:style-name="ch8"/></chart:plot-area><table:table table:name="local-table"><table:table-header-columns><table:table-column/></table:table-header-columns><table:table-columns><table:table-column table:number-columns-repeated="${Math.max(el.series.length, 1)}"/></table:table-columns><table:table-header-rows>${header}</table:table-header-rows><table:table-rows>${body}</table:table-rows></table:table></chart:chart></office:chart></office:body></office:document-content>`;
}

// ───────────── el paquete ─────────────

function listStyles(): string {
  const levels = (kind: "bullet" | "number") =>
    Array.from({ length: 9 }, (_, i) => {
      const indent = `<style:list-level-properties text:space-before="${(0.794 * i).toFixed(3)}cm" text:min-label-width="0.794cm"/>`;
      return kind === "bullet"
        ? `<text:list-level-style-bullet text:level="${i + 1}" text:bullet-char="${i % 2 ? "–" : "●"}">${indent}<style:text-properties fo:font-family="OpenSymbol" style:font-size-rel="${i % 2 ? 75 : 45}%"/></text:list-level-style-bullet>`
        : `<text:list-level-style-number text:level="${i + 1}" style:num-format="1" style:num-suffix=".">${indent}</text:list-level-style-number>`;
    }).join("");
  return `<text:list-style style:name="L1">${levels("bullet")}</text:list-style><text:list-style style:name="L2">${levels("number")}</text:list-style>`;
}

function stylesXml(deck: Deck, fillImages: OdpWriter["fillImages"]): string {
  const th = deck.theme;
  const minor = esc(`'${th.fonts.minor}'`);
  const major = esc(`'${th.fonts.major}'`);
  const text = (font: string, size: number, color: string, bold = false) =>
    `<style:text-properties fo:font-family="${font}" style:font-family-asian="${font}" style:font-family-complex="${font}" fo:font-size="${size}pt" style:font-size-asian="${size}pt" style:font-size-complex="${size}pt" fo:color="${hex(color)}"${bold ? ' fo:font-weight="bold"' : ""}/>`;
  const presentation = (name: string, size: number, color: string, font: string, extra = "") =>
    `<style:style style:name="WEPO-${name}" style:family="presentation"><style:graphic-properties draw:stroke="none" draw:fill="none"${extra}/><style:paragraph-properties fo:margin-top="0cm" fo:margin-bottom="0cm"/>${text(font, size, color)}</style:style>`;
  const outline = Array.from({ length: 9 }, (_, i) =>
    i === 0
      ? presentation("outline1", 24, th.text, minor)
      : `<style:style style:name="WEPO-outline${i + 1}" style:family="presentation" style:parent-style-name="WEPO-outline${i}"><style:text-properties fo:font-size="${Math.max(24 - 2 * i, 14)}pt"/></style:style>`,
  ).join("");
  const fills = fillImages.map((f) => `<draw:fill-image draw:name="${f.name}" xlink:href="${f.href}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/>`).join("");
  const w = cm(deck.width);
  const h = cm(deck.height);
  return `<?xml version="1.0" encoding="UTF-8"?><office:document-styles ${ROOT_NS} office:version="1.3"><office:styles>${fills}<draw:stroke-dash draw:name="WEPO_20_guion" draw:display-name="WEPO guion" draw:style="rect" draw:dots1="1" draw:dots1-length="0.2cm" draw:distance="0.1cm"/><draw:stroke-dash draw:name="WEPO_20_punto" draw:display-name="WEPO punto" draw:style="round" draw:dots1="1" draw:dots1-length="0.02cm" draw:distance="0.08cm"/><style:default-style style:family="graphic"><style:graphic-properties svg:stroke-color="#3465a4" draw:fill-color="#729fcf"/>${text(minor, 18, th.text)}</style:default-style><style:style style:name="standard" style:family="graphic"><style:graphic-properties draw:stroke="none" draw:fill="none" fo:wrap-option="wrap"/><style:paragraph-properties fo:margin-top="0cm" fo:margin-bottom="0cm"/>${text(minor, 18, th.text)}</style:style>${presentation("title", 40, th.title, major)}${presentation("subtitle", 24, th.text, minor)}${outline}${presentation("notes", 12, "#000000", minor)}<style:style style:name="WEPO-background" style:family="presentation"><style:graphic-properties draw:stroke="none" draw:fill="none"/></style:style><style:style style:name="WEPO-backgroundobjects" style:family="presentation"/></office:styles><office:automatic-styles><style:page-layout style:name="PM1"><style:page-layout-properties fo:margin-top="0cm" fo:margin-bottom="0cm" fo:margin-left="0cm" fo:margin-right="0cm" fo:page-width="${w}" fo:page-height="${h}" style:print-orientation="${deck.width >= deck.height ? "landscape" : "portrait"}"/></style:page-layout><style:page-layout style:name="PM2"><style:page-layout-properties fo:margin-top="0cm" fo:margin-bottom="0cm" fo:margin-left="0cm" fo:margin-right="0cm" fo:page-width="21.59cm" fo:page-height="27.94cm" style:print-orientation="portrait"/></style:page-layout><style:style style:name="Mdp1" style:family="drawing-page"><style:drawing-page-properties draw:background-size="border" draw:fill="solid" draw:fill-color="${hex(th.background)}"/></style:style>${listStyles()}</office:automatic-styles><office:master-styles><style:master-page style:name="WEPO" style:page-layout-name="PM1" draw:style-name="Mdp1"><draw:frame presentation:style-name="WEPO-title" draw:layer="backgroundobjects" svg:width="${cm(deck.width * 0.875)}" svg:height="${cm(deck.height * 0.2)}" svg:x="${cm(deck.width * 0.0625)}" svg:y="${cm(deck.height * 0.05)}" presentation:class="title" presentation:placeholder="true"><draw:text-box/></draw:frame><draw:frame presentation:style-name="WEPO-outline1" draw:layer="backgroundobjects" svg:width="${cm(deck.width * 0.875)}" svg:height="${cm(deck.height * 0.64)}" svg:x="${cm(deck.width * 0.0625)}" svg:y="${cm(deck.height * 0.28)}" presentation:class="outline" presentation:placeholder="true"><draw:text-box/></draw:frame><presentation:notes style:page-layout-name="PM2"><draw:page-thumbnail presentation:style-name="WEPO-background" draw:layer="backgroundobjects" svg:width="14cm" svg:height="7.875cm" svg:x="3.5cm" svg:y="2cm" presentation:class="page"/><draw:frame presentation:style-name="WEPO-notes" draw:layer="backgroundobjects" svg:width="17cm" svg:height="11cm" svg:x="2cm" svg:y="12.5cm" presentation:class="notes" presentation:placeholder="true"><draw:text-box/></draw:frame></presentation:notes></style:master-page></office:master-styles></office:document-styles>`;
}

function metaXml(deck: Deck, title: string): string {
  const now = new Date().toISOString().replace(/\.\d+Z$/, "");
  return `<?xml version="1.0" encoding="UTF-8"?><office:document-meta ${ROOT_NS} office:version="1.3"><office:meta><meta:generator>WEPO Present</meta:generator>${title ? `<dc:title>${esc(title)}</dc:title>` : ""}<meta:creation-date>${now}</meta:creation-date><dc:date>${now}</dc:date><meta:user-defined meta:name="WEPO-tema">${esc(deck.theme.id)}</meta:user-defined></office:meta></office:document-meta>`;
}

export async function writeOdp(deck: Deck, title = ""): Promise<Uint8Array> {
  const w = new OdpWriter(deck);
  const pages = deck.slides.map((s, i) => w.slide(s, i + 1)).join("");
  const content = `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${ROOT_NS} office:version="1.3"><office:automatic-styles>${w.autoStyles()}${listStyles()}</office:automatic-styles><office:body><office:presentation>${pages}<presentation:settings presentation:mouse-visible="false"/></office:presentation></office:body></office:document-content>`;
  const zip = new JSZip();
  // El tipo va primero y sin comprimir: así se reconoce el archivo.
  zip.file("mimetype", "application/vnd.oasis.opendocument.presentation", { compression: "STORE" });
  zip.file("content.xml", content);
  zip.file("styles.xml", stylesXml(deck, w.fillImages));
  zip.file("meta.xml", metaXml(deck, title));
  const entries = [
    '<manifest:file-entry manifest:full-path="/" manifest:version="1.3" manifest:media-type="application/vnd.oasis.opendocument.presentation"/>',
    '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>',
    '<manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>',
    '<manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/>',
  ];
  for (const f of w.files) {
    zip.file(f.path, f.bytes);
    entries.push(`<manifest:file-entry manifest:full-path="${esc(f.path)}" manifest:media-type="${esc(f.mime)}"/>`);
  }
  for (const o of w.objects) {
    zip.file(`${o.dir}/content.xml`, o.content);
    zip.file(`${o.dir}/styles.xml`, `<?xml version="1.0" encoding="UTF-8"?><office:document-styles ${ROOT_NS} office:version="1.3"><office:styles/></office:document-styles>`);
    entries.push(`<manifest:file-entry manifest:full-path="${o.dir}/" manifest:version="1.3" manifest:media-type="application/vnd.oasis.opendocument.chart"/>`);
    entries.push(`<manifest:file-entry manifest:full-path="${o.dir}/content.xml" manifest:media-type="text/xml"/>`);
    entries.push(`<manifest:file-entry manifest:full-path="${o.dir}/styles.xml" manifest:media-type="text/xml"/>`);
  }
  zip.file("META-INF/manifest.xml", `<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3">${entries.join("")}</manifest:manifest>`);
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE", mimeType: "application/vnd.oasis.opendocument.presentation" });
}
