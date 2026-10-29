// Escribir presentaciones de PowerPoint (.pptx) desde WEPO Present.
//
// Se arma un .pptx completo: tema, patrón, seis diseños, las diapositivas con
// todo su formato escrito explícitamente (para que se vea igual en PowerPoint,
// Keynote o LibreOffice), imágenes y notas del orador.

import JSZip from "jszip";
import type { ChartElement, Deck, ImageElement, LayoutId, Para, Run, ShapeElement, Slide, SlideElement, TableElement, TextBody, Theme } from "./model";
import { EMU_PER_PX, layoutElements } from "./model";
import { isLine } from "./geometry";
import { chartWorkbook, chartXml } from "./charts";
import { transitionXml } from "./transitions";
import { timingXml } from "./animations";
import type { MediaTiming } from "./animations";
import { mediaBytes, mediaContentType } from "./media";

const NS = `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"`;
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`;
const CT = "application/vnd.openxmlformats-officedocument.presentationml";

const emu = (px: number) => Math.round(px * EMU_PER_PX);
const hex = (color: string) => color.replace("#", "").slice(0, 6).toUpperCase();

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function dataUrlBytes(src: string): { bytes: Uint8Array; ext: string } | null {
  const m = /^data:image\/(png|jpeg|jpg|gif|svg\+xml);base64,(.*)$/.exec(src);
  if (!m) return null;
  const binary = atob(m[2]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { bytes, ext: m[1] === "jpg" ? "jpeg" : m[1] === "svg+xml" ? "svg" : m[1] };
}

const LAYOUT_ORDER: LayoutId[] = ["title", "titleContent", "twoContent", "section", "titleOnly", "blank"];
const LAYOUT_TYPE: Record<LayoutId, string> = { title: "title", titleContent: "obj", twoContent: "twoObj", section: "secHead", titleOnly: "titleOnly", blank: "blank" };
const LAYOUT_NAME: Record<LayoutId, string> = {
  title: "Diapositiva de título",
  titleContent: "Título y contenido",
  twoContent: "Dos objetos",
  section: "Encabezado de sección",
  titleOnly: "Solo el título",
  blank: "En blanco",
};

// ───────────── texto ─────────────

function runXml(run: Run, links: (url: string) => string, fallbackSize?: number): string {
  const attrs = [`lang="es-MX"`];
  const size = run.size ?? fallbackSize;
  if (size) attrs.push(`sz="${Math.round(size * 100)}"`);
  if (run.bold) attrs.push(`b="1"`);
  if (run.italic) attrs.push(`i="1"`);
  if (run.underline) attrs.push(`u="sng"`);
  if (run.strike) attrs.push(`strike="sngStrike"`);
  attrs.push(`dirty="0"`);
  let props = "";
  if (run.color) props += `<a:solidFill><a:srgbClr val="${hex(run.color)}"/></a:solidFill>`;
  if (run.font) props += `<a:latin typeface="${esc(run.font)}"/><a:cs typeface="${esc(run.font)}"/>`;
  if (run.link) props += `<a:hlinkClick r:id="${links(run.link)}"/>`;
  const rPr = `<a:rPr ${attrs.join(" ")}>${props}</a:rPr>`;
  // Los saltos de línea dentro del párrafo son <a:br/>.
  return run.text
    .split("\n")
    .map((part, i) => (i ? `<a:br>${rPr}</a:br>` : "") + (part ? `<a:r>${rPr}<a:t>${esc(part)}</a:t></a:r>` : ""))
    .join("");
}

function paraXml(p: Para, links: (url: string) => string, defaultSize?: number): string {
  const level = p.level ?? 0;
  const attrs: string[] = [];
  if (p.bullet) {
    const mar = 285750 * (level + 1);
    attrs.push(`marL="${mar}"`, `indent="-285750"`);
  } else if (level) attrs.push(`marL="${285750 * level}"`, `indent="0"`);
  if (level) attrs.push(`lvl="${level}"`);
  if (p.align && p.align !== "left") attrs.push(`algn="${p.align === "center" ? "ctr" : p.align === "right" ? "r" : "just"}"`);
  let inner = "";
  if (p.lineSpacing) inner += `<a:lnSpc><a:spcPct val="${Math.round(p.lineSpacing * 100000)}"/></a:lnSpc>`;
  if (p.spaceBefore !== undefined) inner += `<a:spcBef><a:spcPts val="${Math.round(p.spaceBefore * 100)}"/></a:spcBef>`;
  if (p.spaceAfter !== undefined) inner += `<a:spcAft><a:spcPts val="${Math.round(p.spaceAfter * 100)}"/></a:spcAft>`;
  if (p.bullet === "bullet") inner += `<a:buFont typeface="Arial"/><a:buChar char="•"/>`;
  else if (p.bullet === "number") inner += `<a:buFont typeface="+mj-lt"/><a:buAutoNum type="arabicPeriod"/>`;
  else inner += `<a:buNone/>`;
  const size = p.runs.find((r) => r.size)?.size ?? p.endSize ?? defaultSize;
  const end = `<a:endParaRPr lang="es-MX"${size ? ` sz="${Math.round(size * 100)}"` : ""} dirty="0"/>`;
  return `<a:p><a:pPr ${attrs.join(" ")}>${inner}</a:pPr>${p.runs.map((r) => runXml(r, links, defaultSize)).join("")}${end}</a:p>`;
}

function bodyXml(text: TextBody | undefined, links: (url: string) => string, wrapTag = "p:txBody"): string {
  const t = text ?? { paras: [{ runs: [] }] };
  const [l, tp, r, b] = t.insets ?? [9.6, 4.8, 9.6, 4.8];
  const anchor = t.anchor === "middle" ? "ctr" : t.anchor === "bottom" ? "b" : "t";
  const paras = t.paras.length ? t.paras : [{ runs: [] }];
  return `<${wrapTag}><a:bodyPr wrap="square" lIns="${emu(l)}" tIns="${emu(tp)}" rIns="${emu(r)}" bIns="${emu(b)}" anchor="${anchor}" rtlCol="0"><a:noAutofit/></a:bodyPr><a:lstStyle/>${paras.map((p) => paraXml(p, links, t.defaultSize)).join("")}</${wrapTag}>`;
}

// ───────────── elementos ─────────────

function xfrm(el: SlideElement, tag = "a:xfrm"): string {
  const attrs = [el.rot ? `rot="${Math.round(el.rot * 60000)}"` : "", el.flipH ? `flipH="1"` : "", el.flipV ? `flipV="1"` : ""].filter(Boolean).join(" ");
  return `<${tag}${attrs ? ` ${attrs}` : ""}><a:off x="${emu(el.x)}" y="${emu(el.y)}"/><a:ext cx="${emu(Math.max(el.w, 0))}" cy="${emu(Math.max(el.h, 0))}"/></${tag}>`;
}

function lineXml(line: ShapeElement["line"]): string {
  if (!line) return `<a:ln><a:noFill/></a:ln>`;
  const dash = line.dash && line.dash !== "solid" ? `<a:prstDash val="${line.dash === "dot" ? "sysDot" : "dash"}"/>` : "";
  return `<a:ln w="${emu(line.width)}"><a:solidFill><a:srgbClr val="${hex(line.color)}"/></a:solidFill>${dash}</a:ln>`;
}

class SlideWriter {
  rels: string[] = [];
  /** Número de forma (cNvPr id) de cada elemento, para las animaciones. */
  spids = new Map<string, number>();
  private nextRel = 2; // rId1 es el diseño
  private nextId = 2;
  constructor(
    private media: (bytes: Uint8Array, ext: string, prefix?: string) => string,
    /** Guarda la gráfica (chartN.xml, su libro y sus relaciones) y devuelve el nombre de su parte. */
    private chartPart: (el: ChartElement) => string = () => "",
  ) {}

  rel(type: string, target: string, external = false): string {
    const id = `rId${this.nextRel++}`;
    this.rels.push(`<Relationship Id="${id}" Type="${REL}/${type}" Target="${esc(target)}"${external ? ' TargetMode="External"' : ""}/>`);
    return id;
  }

  links = (url: string) => this.rel("hyperlink", url, true);

  /** Relación con un tipo que no es de la norma (como la de los medios de Office 2010). */
  rawRel(type: string, target: string): string {
    const id = `rId${this.nextRel++}`;
    this.rels.push(`<Relationship Id="${id}" Type="${type}" Target="${esc(target)}"/>`);
    return id;
  }

  /** Videos y audios de la diapositiva (para su parte de <p:timing>). */
  mediaIds = new Map<string, MediaTiming>();

  shape(el: ShapeElement): string {
    const id = this.nextId++;
    this.spids.set(el.id, id);
    const ph = el.placeholder ? `<p:ph${el.placeholder.type ? ` type="${el.placeholder.type}"` : ""}${el.placeholder.idx ? ` idx="${el.placeholder.idx}"` : ""}/>` : "";
    const name = esc(el.name ?? (el.role ? `${el.role === "title" ? "Título" : el.role === "subtitle" ? "Subtítulo" : "Contenido"} ${id}` : `Forma ${id}`));
    const isText = !el.placeholder && el.geom === "rect" && !el.fill && !el.line && el.text;
    const fill = el.fill ? `<a:solidFill><a:srgbClr val="${hex(el.fill)}"/></a:solidFill>` : `<a:noFill/>`;
    const spPr = `<p:spPr>${xfrm(el)}<a:prstGeom prst="${esc(el.geom)}"><a:avLst/></a:prstGeom>${isLine(el.geom) ? "" : fill}${lineXml(el.line)}</p:spPr>`;
    const text = el.text || ph ? bodyXml(el.text, this.links) : "";
    return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr${isText ? ' txBox="1"' : ""}>${ph ? '<a:spLocks noGrp="1"/>' : ""}</p:cNvSpPr><p:nvPr>${ph}</p:nvPr></p:nvSpPr>${spPr}${text}</p:sp>`;
  }

  image(el: ImageElement): string {
    const data = dataUrlBytes(el.src);
    if (!data) return "";
    const id = this.nextId++;
    this.spids.set(el.id, id);
    const rid = this.rel("image", `../media/${this.media(data.bytes, data.ext)}`);
    // Video o audio: el archivo va en ppt/media con sus dos relaciones (la de siempre y la de Office 2010).
    const file = el.media ? mediaBytes(el.media.src) : null;
    let nvPr = "<p:nvPr/>";
    let click = "";
    if (el.media && file) {
      const target = `../media/${this.media(file.bytes, file.ext, "media")}`;
      const link = this.rel(el.media.type, target);
      const embed = this.rawRel("http://schemas.microsoft.com/office/2007/relationships/media", target);
      this.mediaIds.set(el.id, { spid: id, type: el.media.type, autoplay: Boolean(el.media.autoplay), loop: Boolean(el.media.loop) });
      click = '<a:hlinkClick r:id="" action="ppaction://media"/>';
      nvPr = `<p:nvPr><a:${el.media.type}File r:link="${link}"/><p:extLst><p:ext uri="{DAA4B4D4-6D71-4841-9C94-3DA1C8E7AF24}"><p14:media xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" r:embed="${embed}"/></p:ext></p:extLst></p:nvPr>`;
    }
    return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="${esc(el.name ?? `Imagen ${id}`)}">${click}</p:cNvPr><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr>${nvPr}</p:nvPicPr><p:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${xfrm(el)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
  }

  table(el: TableElement): string {
    const id = this.nextId++;
    this.spids.set(el.id, id);
    const border = el.border ? `<a:solidFill><a:srgbClr val="${hex(el.border)}"/></a:solidFill>` : "<a:noFill/>";
    const edge = (tag: string) => `<a:${tag} w="12700">${border}</a:${tag}>`;
    const rows = el.rows
      .map((row, ri) => {
        const cells = row.cells
          .map((c) => {
            // El encabezado se ve con letra blanca y negrita en WEPO; se escribe así para PowerPoint.
            const text = el.header && ri === 0 ? mapHeader(c.text) : c.text;
            const attrs = [c.span && c.span > 1 ? `gridSpan="${c.span}"` : "", c.rowSpan && c.rowSpan > 1 ? `rowSpan="${c.rowSpan}"` : "", c.merged === "h" ? `hMerge="1"` : c.merged === "v" ? `vMerge="1"` : ""].filter(Boolean).join(" ");
            const fill = c.fill ? `<a:solidFill><a:srgbClr val="${hex(c.fill)}"/></a:solidFill>` : "<a:noFill/>";
            return `<a:tc${attrs ? ` ${attrs}` : ""}>${bodyXml(text, this.links, "a:txBody")}<a:tcPr>${edge("lnL")}${edge("lnR")}${edge("lnT")}${edge("lnB")}${fill}</a:tcPr></a:tc>`;
          })
          .join("");
        return `<a:tr h="${emu(row.h)}">${cells}</a:tr>`;
      })
      .join("");
    const grid = el.cols.map((w) => `<a:gridCol w="${emu(w)}"/>`).join("");
    return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="${esc(el.name ?? `Tabla ${id}`)}"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>${xfrm(el, "p:xfrm")}<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr${el.header ? ' firstRow="1"' : ""} bandRow="1"/><a:tblGrid>${grid}</a:tblGrid>${rows}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
  }

  chart(el: ChartElement): string {
    const id = this.nextId++;
    this.spids.set(el.id, id);
    const rid = this.rel("chart", `../charts/${this.chartPart(el)}`);
    return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="${esc(el.name ?? `Gráfica ${id}`)}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>${xfrm(el, "p:xfrm")}<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="${rid}"/></a:graphicData></a:graphic></p:graphicFrame>`;
  }

  element(el: SlideElement): string {
    return el.kind === "shape" ? this.shape(el) : el.kind === "image" ? this.image(el) : el.kind === "chart" ? this.chart(el) : this.table(el);
  }
}

function mapHeader(text: TextBody): TextBody {
  return { ...text, paras: text.paras.map((p) => ({ ...p, runs: p.runs.map((r) => ({ ...r, color: r.color ?? "#FFFFFF", bold: r.bold ?? true })) })) };
}

const GROUP = `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>`;

function backgroundXml(color: string | null, imageRel: string | null): string {
  if (imageRel) return `<p:bg><p:bgPr><a:blipFill dpi="0" rotWithShape="1"><a:blip r:embed="${imageRel}"/><a:srcRect/><a:stretch><a:fillRect/></a:stretch></a:blipFill><a:effectLst/></p:bgPr></p:bg>`;
  if (!color) return "";
  return `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="${hex(color)}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>`;
}

// ───────────── tema, patrón y diseños ─────────────

function themeXml(theme: Theme): string {
  const c = theme.colors;
  const clr = (name: string, v: string) => `<a:${name}><a:srgbClr val="${hex(v)}"/></a:${name}>`;
  const font = (face: string) => `<a:latin typeface="${esc(face)}"/><a:ea typeface=""/><a:cs typeface=""/>`;
  const fills = `<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>`.repeat(3);
  const lines = [6350, 12700, 19050].map((w) => `<a:ln w="${w}" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>`).join("");
  const effects = `<a:effectStyle><a:effectLst/></a:effectStyle>`.repeat(3);
  return `${XML}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="${esc(theme.name)}"><a:themeElements><a:clrScheme name="${esc(theme.name)}">${clr("dk1", c.dk1)}${clr("lt1", c.lt1)}${clr("dk2", c.dk2)}${clr("lt2", c.lt2)}${clr("accent1", c.accent1)}${clr("accent2", c.accent2)}${clr("accent3", c.accent3)}${clr("accent4", c.accent4)}${clr("accent5", c.accent5)}${clr("accent6", c.accent6)}${clr("hlink", c.hlink)}${clr("folHlink", c.folHlink)}</a:clrScheme><a:fontScheme name="${esc(theme.name)}"><a:majorFont>${font(theme.fonts.major)}</a:majorFont><a:minorFont>${font(theme.fonts.minor)}</a:minorFont></a:fontScheme><a:fmtScheme name="${esc(theme.name)}"><a:fillStyleLst>${fills}</a:fillStyleLst><a:lnStyleLst>${lines}</a:lnStyleLst><a:effectStyleLst>${effects}</a:effectStyleLst><a:bgFillStyleLst>${fills}</a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`;
}

function levels(size: (lvl: number) => number, color: string, font: string, bullets: boolean, extra = ""): string {
  return Array.from({ length: 9 }, (_, i) => {
    const mar = bullets ? ` marL="${285750 * (i + 1)}" indent="-285750"` : "";
    const bu = bullets ? `<a:buFont typeface="Arial"/><a:buChar char="•"/>` : `<a:buNone/>`;
    return `<a:lvl${i + 1}pPr${mar} algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:lnSpc><a:spcPct val="90000"/></a:lnSpc><a:spcBef><a:spcPts val="${bullets ? 1000 : 0}"/></a:spcBef>${bu}<a:defRPr sz="${size(i) * 100}" kern="1200"${extra}><a:solidFill><a:srgbClr val="${hex(color)}"/></a:solidFill><a:latin typeface="${esc(font)}"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl${i + 1}pPr>`;
  }).join("");
}

function masterXml(theme: Theme, deck: Deck, layoutCount: number): string {
  const title = layoutElements("titleContent", deck.width, deck.height)[0];
  const body = layoutElements("titleContent", deck.width, deck.height)[1];
  const ph = (el: ShapeElement, id: number, name: string, phXml: string) =>
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr>${phXml}</p:nvPr></p:nvSpPr><p:spPr>${xfrm(el)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0" anchor="${el.role === "title" ? "ctr" : "t"}"><a:normAutofit/></a:bodyPr><a:lstStyle/><a:p><a:r><a:rPr lang="es-MX"/><a:t>${el.role === "title" ? "Título" : "Texto"}</a:t></a:r></a:p></p:txBody></p:sp>`;
  const ids = Array.from({ length: layoutCount }, (_, i) => `<p:sldLayoutId id="${2147483649 + i}" r:id="rId${i + 1}"/>`).join("");
  const bodySizes = [28, 24, 20, 18, 18, 18, 18, 18, 18];
  return `${XML}<p:sldMaster ${NS}><p:cSld>${backgroundXml(theme.background, null)}<p:spTree>${GROUP}${ph(title, 2, "Título 1", '<p:ph type="title"/>')}${ph(body, 3, "Texto 2", '<p:ph type="body" idx="1"/>')}</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst>${ids}</p:sldLayoutIdLst><p:txStyles><p:titleStyle>${levels(() => 40, theme.title, theme.fonts.major, false)}</p:titleStyle><p:bodyStyle>${levels((i) => bodySizes[i], theme.text, theme.fonts.minor, true)}</p:bodyStyle><p:otherStyle>${levels(() => 18, theme.text, theme.fonts.minor, false)}</p:otherStyle></p:txStyles></p:sldMaster>`;
}

function layoutXml(id: LayoutId, deck: Deck): string {
  const shapes = layoutElements(id, deck.width, deck.height)
    .map((el, i) => {
      const p = el.placeholder!;
      const phXml = `<p:ph${p.type ? ` type="${p.type}"` : ""}${p.idx ? ` idx="${p.idx}"` : ""}/>`;
      const size = el.text?.defaultSize ?? 24;
      const algn = el.text?.paras[0]?.align === "center" ? ' algn="ctr"' : "";
      const bullets = el.role === "body" ? "" : "<a:buNone/>";
      const anchor = el.text?.anchor === "middle" ? "ctr" : el.text?.anchor === "bottom" ? "b" : "t";
      return `<p:sp><p:nvSpPr><p:cNvPr id="${i + 2}" name="${esc(el.role ?? "texto")} ${i + 1}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr>${phXml}</p:nvPr></p:nvSpPr><p:spPr>${xfrm(el)}</p:spPr><p:txBody><a:bodyPr anchor="${anchor}"/><a:lstStyle><a:lvl1pPr${algn}>${bullets}<a:defRPr sz="${size * 100}"/></a:lvl1pPr></a:lstStyle><a:p><a:r><a:rPr lang="es-MX"/><a:t>${el.role === "title" ? "Título" : el.role === "subtitle" ? "Subtítulo" : "Texto"}</a:t></a:r></a:p></p:txBody></p:sp>`;
    })
    .join("");
  return `${XML}<p:sldLayout ${NS} type="${LAYOUT_TYPE[id]}" preserve="1"><p:cSld name="${esc(LAYOUT_NAME[id])}"><p:spTree>${GROUP}${shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
}

function notesMasterXml(deckTheme: Theme): string {
  return `${XML}<p:notesMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${GROUP}<p:sp><p:nvSpPr><p:cNvPr id="2" name="Imagen de diapositiva 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg" idx="2"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="685800" y="1143000"/><a:ext cx="5486400" cy="3086100"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Notas 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" sz="quarter" idx="3"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="685800" y="4400550"/><a:ext cx="5486400" cy="3600450"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="es-MX"/></a:p></p:txBody></p:sp></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:notesStyle><a:lvl1pPr marL="0" algn="l" rtl="0"><a:defRPr sz="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="${esc(deckTheme.fonts.minor)}"/></a:defRPr></a:lvl1pPr></p:notesStyle></p:notesMaster>`;
}

function notesXml(text: string): string {
  const paras = text
    .split("\n")
    .map((line) => (line ? `<a:p><a:r><a:rPr lang="es-MX" dirty="0"/><a:t>${esc(line)}</a:t></a:r></a:p>` : `<a:p><a:endParaRPr lang="es-MX"/></a:p>`))
    .join("");
  return `${XML}<p:notes ${NS}><p:cSld><p:spTree>${GROUP}<p:sp><p:nvSpPr><p:cNvPr id="2" name="Imagen de diapositiva 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Notas 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${paras}</p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`;
}

// ───────────── presentación completa ─────────────

export async function writePptx(deck: Deck, title = ""): Promise<Uint8Array> {
  const zip = new JSZip();
  const put = (name: string, data: string | Uint8Array) => zip.file(name, data, { createFolders: false });
  const mediaTypes = new Set<string>();
  // La misma imagen en varias diapositivas se guarda una sola vez.
  const mediaByContent = new Map<string, string>();
  const counts: Record<string, number> = {};
  const media = (bytes: Uint8Array, ext: string, prefix = "image") => {
    const key = `${ext}:${bytes.length}:${bytes.subarray(0, 64).join(",")}:${bytes.subarray(-64).join(",")}`;
    const known = mediaByContent.get(key);
    if (known) return known;
    counts[prefix] = (counts[prefix] ?? 0) + 1;
    const name = `${prefix}${counts[prefix]}.${ext}`;
    put(`ppt/media/${name}`, bytes);
    mediaTypes.add(ext);
    mediaByContent.set(key, name);
    return name;
  };

  // Gráficas: cada una con su chartN.xml y su libro de Excel incrustado (para «Editar datos»).
  const workbooks = new Map<string, Uint8Array>();
  await Promise.all(deck.slides.flatMap((s) => s.elements).filter((e): e is ChartElement => e.kind === "chart").map(async (e) => workbooks.set(e.id, await chartWorkbook(e))));
  let chartCount = 0;
  const chartPart = (el: ChartElement) => {
    const n = ++chartCount;
    put(`ppt/charts/chart${n}.xml`, chartXml(el, deck.theme.text));
    put(`ppt/embeddings/Microsoft_Excel_Worksheet${n}.xlsx`, workbooks.get(el.id)!);
    put(
      `ppt/charts/_rels/chart${n}.xml.rels`,
      `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/package" Target="../embeddings/Microsoft_Excel_Worksheet${n}.xlsx"/></Relationships>`,
    );
    slideOverrides.push(`<Override PartName="/ppt/charts/chart${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`);
    return `chart${n}.xml`;
  };

  const slideOverrides: string[] = [];
  const presRels: string[] = [`<Relationship Id="rId1" Type="${REL}/slideMaster" Target="slideMasters/slideMaster1.xml"/>`];
  const sldIds: string[] = [];
  deck.slides.forEach((slide: Slide, i) => {
    const n = i + 1;
    const w = new SlideWriter(media, chartPart);
    const layoutIndex = LAYOUT_ORDER.indexOf(slide.layout) + 1 || 2;
    let bgRel: string | null = null;
    if (slide.backgroundImage) {
      const data = dataUrlBytes(slide.backgroundImage);
      if (data) bgRel = w.rel("image", `../media/${media(data.bytes, data.ext)}`);
    }
    const body = slide.elements.map((el) => w.element(el)).join("");
    const bg = backgroundXml(slide.background ?? (slide.backgroundImage ? null : null), bgRel);
    put(
      `ppt/slides/slide${n}.xml`,
      `${XML}<p:sld ${NS}${slide.hidden ? ' show="0"' : ""}><p:cSld>${bg}<p:spTree>${GROUP}${body}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>${transitionXml(slide.transition)}${timingXml(slide, (id) => w.spids.get(id), [...w.mediaIds.values()])}</p:sld>`,
    );
    const rels = [`<Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout${layoutIndex}.xml"/>`, ...w.rels];
    if (slide.notes.trim()) {
      put(`ppt/notesSlides/notesSlide${n}.xml`, notesXml(slide.notes));
      put(
        `ppt/notesSlides/_rels/notesSlide${n}.xml.rels`,
        `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/notesMaster" Target="../notesMasters/notesMaster1.xml"/><Relationship Id="rId2" Type="${REL}/slide" Target="../slides/slide${n}.xml"/></Relationships>`,
      );
      rels.push(`<Relationship Id="rIdN" Type="${REL}/notesSlide" Target="../notesSlides/notesSlide${n}.xml"/>`);
      slideOverrides.push(`<Override PartName="/ppt/notesSlides/notesSlide${n}.xml" ContentType="${CT}.notesSlide+xml"/>`);
    }
    put(`ppt/slides/_rels/slide${n}.xml.rels`, `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join("")}</Relationships>`);
    slideOverrides.push(`<Override PartName="/ppt/slides/slide${n}.xml" ContentType="${CT}.slide+xml"/>`);
    presRels.push(`<Relationship Id="rId${n + 1}" Type="${REL}/slide" Target="slides/slide${n}.xml"/>`);
    sldIds.push(`<p:sldId id="${255 + n}" r:id="rId${n + 1}"/>`);
  });
  const k = deck.slides.length + 2;
  presRels.push(
    `<Relationship Id="rId${k}" Type="${REL}/notesMaster" Target="notesMasters/notesMaster1.xml"/>`,
    `<Relationship Id="rId${k + 1}" Type="${REL}/presProps" Target="presProps.xml"/>`,
    `<Relationship Id="rId${k + 2}" Type="${REL}/viewProps" Target="viewProps.xml"/>`,
    `<Relationship Id="rId${k + 3}" Type="${REL}/theme" Target="theme/theme1.xml"/>`,
    `<Relationship Id="rId${k + 4}" Type="${REL}/tableStyles" Target="tableStyles.xml"/>`,
  );

  const theme = deck.theme;
  put(
    "ppt/presentation.xml",
    `${XML}<p:presentation ${NS} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:notesMasterIdLst><p:notesMasterId r:id="rId${k}"/></p:notesMasterIdLst><p:sldIdLst>${sldIds.join("")}</p:sldIdLst><p:sldSz cx="${emu(deck.width)}" cy="${emu(deck.height)}"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle>${levels(() => 18, theme.text, theme.fonts.minor, false)}</p:defaultTextStyle></p:presentation>`,
  );
  put("ppt/_rels/presentation.xml.rels", `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${presRels.join("")}</Relationships>`);
  put("ppt/theme/theme1.xml", themeXml(theme));
  put("ppt/theme/theme2.xml", themeXml(theme));
  put("ppt/slideMasters/slideMaster1.xml", masterXml(theme, deck, LAYOUT_ORDER.length));
  put(
    "ppt/slideMasters/_rels/slideMaster1.xml.rels",
    `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${LAYOUT_ORDER.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout${i + 1}.xml"/>`).join("")}<Relationship Id="rId${LAYOUT_ORDER.length + 1}" Type="${REL}/theme" Target="../theme/theme1.xml"/></Relationships>`,
  );
  LAYOUT_ORDER.forEach((id, i) => {
    put(`ppt/slideLayouts/slideLayout${i + 1}.xml`, layoutXml(id, deck));
    put(
      `ppt/slideLayouts/_rels/slideLayout${i + 1}.xml.rels`,
      `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`,
    );
  });
  put("ppt/notesMasters/notesMaster1.xml", notesMasterXml(theme));
  put(
    "ppt/notesMasters/_rels/notesMaster1.xml.rels",
    `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/theme" Target="../theme/theme2.xml"/></Relationships>`,
  );
  put("ppt/presProps.xml", `${XML}<p:presentationPr ${NS}/>`);
  put("ppt/viewProps.xml", `${XML}<p:viewPr ${NS}><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>`);
  put("ppt/tableStyles.xml", `${XML}<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`);

  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  put(
    "docProps/core.xml",
    `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(title)}</dc:title><dc:creator>WEPO Present</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`,
  );
  put("docProps/app.xml", `${XML}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>WEPO Present</Application><Slides>${deck.slides.length}</Slides></Properties>`);
  put(
    "_rels/.rels",
    `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="${REL}/extended-properties" Target="docProps/app.xml"/></Relationships>`,
  );
  const mime: Record<string, string> = { png: "image/png", jpeg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml" };
  for (const e of mediaTypes) mime[e] ??= mediaContentType(e);
  put(
    "[Content_Types].xml",
    `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${chartCount ? '<Default Extension="xlsx" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"/>' : ""}${[...mediaTypes].map((e) => `<Default Extension="${e}" ContentType="${mime[e]}"/>`).join("")}<Override PartName="/ppt/presentation.xml" ContentType="${CT}.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="${CT}.slideMaster+xml"/>${LAYOUT_ORDER.map((_, i) => `<Override PartName="/ppt/slideLayouts/slideLayout${i + 1}.xml" ContentType="${CT}.slideLayout+xml"/>`).join("")}${slideOverrides.join("")}<Override PartName="/ppt/notesMasters/notesMaster1.xml" ContentType="${CT}.notesMaster+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/ppt/theme/theme2.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/ppt/presProps.xml" ContentType="${CT}.presProps+xml"/><Override PartName="/ppt/viewProps.xml" ContentType="${CT}.viewProps+xml"/><Override PartName="/ppt/tableStyles.xml" ContentType="${CT}.tableStyles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`,
  );
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}
