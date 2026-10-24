// Gráficas de WEPO Present.
//
// En el .pptx una gráfica es un graphicFrame que apunta a ppt/charts/chartN.xml
// (DrawingML Chart). Los números van ahí mismo (en la caché) y también en un
// libro de Excel incrustado, para que en PowerPoint se pueda «Editar datos».

import JSZip from "jszip";
import type { ChartElement, ChartKind, ChartSeries, Theme } from "./model";
import { uid } from "./model";
import type { ChartView } from "../../lib/spreadsheet";

export const CHART_KINDS: { id: ChartKind; name: string }[] = [
  { id: "column", name: "Columnas" },
  { id: "bar", name: "Barras" },
  { id: "line", name: "Líneas" },
  { id: "area", name: "Áreas" },
  { id: "pie", name: "Pastel" },
  { id: "doughnut", name: "Dona" },
];

export function seriesColor(theme: Theme, i: number): string {
  const c = theme.colors;
  return [c.accent1, c.accent2, c.accent3, c.accent4, c.accent5, c.accent6][i % 6];
}

/** Gráfica nueva con datos de ejemplo, centrada en la diapositiva. */
export function newChart(theme: Theme, width: number, height: number): ChartElement {
  const w = Math.round(width * 0.6);
  const h = Math.round(height * 0.6);
  return {
    id: uid(),
    kind: "chart",
    x: Math.round((width - w) / 2),
    y: Math.round((height - h) / 2 + height * 0.06),
    w,
    h,
    chartType: "column",
    title: "",
    legend: true,
    stacked: false,
    labels: false,
    categories: ["Categoría 1", "Categoría 2", "Categoría 3", "Categoría 4"],
    series: [
      { name: "Serie 1", values: [4.3, 2.5, 3.5, 4.5], color: seriesColor(theme, 0) },
      { name: "Serie 2", values: [2.4, 4.4, 1.8, 2.8], color: seriesColor(theme, 1) },
      { name: "Serie 3", values: [2, 2, 3, 5], color: seriesColor(theme, 2) },
    ],
  };
}

/** Lo que necesita el dibujo de gráficas de Sheets (ChartSvg). */
export function chartView(el: ChartElement): ChartView {
  return {
    type: "chart",
    id: 0,
    x: 0,
    y: 0,
    w: el.w,
    h: el.h,
    kind: el.chartType,
    title: el.title,
    legend: el.legend,
    stacked: el.stacked,
    labels: el.labels,
    x_title: "",
    y_title: "",
    series: el.series.map((s) => ({
      name: s.name,
      color: s.color,
      values: s.values,
      categories: el.categories,
      x: [],
      refs: { name: null, name_is_ref: false, categories: null, values: "", color: null },
    })),
  };
}

// ───────────── leer ─────────────

const C = "http://schemas.openxmlformats.org/drawingml/2006/chart";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";

function kid(el: Element | null | undefined, name: string): Element | undefined {
  return el ? Array.from(el.children).find((c) => c.localName === name) : undefined;
}
function kidsOf(el: Element | null | undefined, name: string): Element[] {
  return el ? Array.from(el.children).filter((c) => c.localName === name) : [];
}
const val = (el: Element | undefined) => el?.getAttribute("val") ?? null;

/** Puntos de una caché (strCache, numCache o valores escritos a mano), por su índice. */
function points(cache: Element | undefined): string[] {
  if (!cache) return [];
  const count = Number(val(kid(cache, "ptCount")) ?? 0);
  const out: string[] = Array(count).fill("");
  for (const pt of kidsOf(cache, "pt")) out[Number(pt.getAttribute("idx") ?? 0)] = kid(pt, "v")?.textContent ?? "";
  return out;
}

/** Los puntos de c:tx, c:cat o c:val (de la referencia con su caché, o escritos a mano). */
function refPoints(holder: Element | undefined): string[] {
  if (!holder) return [];
  const ref = kid(holder, "strRef") ?? kid(holder, "numRef");
  if (ref) return points(kid(ref, "strCache") ?? kid(ref, "numCache"));
  const multi = kid(holder, "multiLvlStrRef");
  if (multi) return points(kid(kid(multi, "multiLvlStrCache"), "lvl"));
  return points(kid(holder, "strLit") ?? kid(holder, "numLit"));
}

export type ChartRead = Omit<ChartElement, "id" | "kind" | "x" | "y" | "w" | "h"> & { unsupported: string[] };

/**
 * Lee chartN.xml. `color` resuelve los colores de DrawingML (srgbClr,
 * schemeClr…) con el tema de la presentación.
 */
export function readChartXml(xml: string, theme: Theme, color: (el: Element | undefined) => string | null): ChartRead | null {
  const root = new DOMParser().parseFromString(xml, "application/xml").documentElement;
  const chart = kid(root, "chart");
  const plot = kid(chart, "plotArea");
  if (!plot) return null;
  const unsupported: string[] = [];
  const groups = Array.from(plot.children).filter((c) => c.localName.endsWith("Chart"));
  if (!groups.length) return null;
  if (groups.length > 1) unsupported.push("gráficas combinadas");
  const g = groups[0];
  const name = g.localName;
  let chartType: ChartKind;
  if (name === "barChart" || name === "bar3DChart") chartType = val(kid(g, "barDir")) === "bar" ? "bar" : "column";
  else if (name === "lineChart" || name === "line3DChart" || name === "stockChart" || name === "radarChart") chartType = "line";
  else if (name === "areaChart" || name === "area3DChart") chartType = "area";
  else if (name === "pieChart" || name === "pie3DChart" || name === "ofPieChart") chartType = "pie";
  else if (name === "doughnutChart") chartType = "doughnut";
  else {
    unsupported.push("gráficas de dispersión o de burbujas");
    chartType = "line";
  }
  if (name.includes("3D")) unsupported.push("gráficas en 3D");
  const grouping = val(kid(g, "grouping"));
  const stacked = grouping === "stacked" || grouping === "percentStacked";

  let categories: string[] = [];
  const series: ChartSeries[] = kidsOf(g, "ser").map((ser, i) => {
    const cats = refPoints(kid(ser, "cat"));
    if (cats.length > categories.length) categories = cats;
    const values = refPoints(kid(ser, "val")).map((v) => (v === "" || Number.isNaN(Number(v)) ? null : Number(v)));
    const spPr = kid(ser, "spPr");
    const fillColor = color(kid(spPr, "solidFill"));
    const lineColor = color(kid(kid(spPr, "ln"), "solidFill"));
    const nameText = refPoints(kid(ser, "tx"))[0] ?? kid(kid(ser, "tx"), "v")?.textContent ?? "";
    return {
      name: nameText || `Serie ${i + 1}`,
      values,
      color: (chartType === "line" ? (lineColor ?? fillColor) : (fillColor ?? lineColor)) ?? seriesColor(theme, i),
    };
  });
  const length = Math.max(categories.length, ...series.map((s) => s.values.length), 0);
  if (categories.length < length) categories = Array.from({ length }, (_, i) => categories[i] || `${i + 1}`);
  for (const s of series) while (s.values.length < length) s.values.push(null);

  const titleEl = kid(chart, "title");
  let title = titleEl ? Array.from(titleEl.getElementsByTagNameNS(A, "t")).map((t) => t.textContent ?? "").join("") : "";
  if (titleEl && !title) title = refPoints(kid(titleEl, "tx"))[0] ?? "";
  // Sin título escrito, PowerPoint pone el nombre de la serie cuando hay una sola.
  if (!titleEl && val(kid(chart, "autoTitleDeleted")) !== "1" && series.length === 1) title = series[0].name;
  const showVal = (el: Element | undefined) => val(kid(kid(el, "dLbls"), "showVal")) === "1";
  const labels = showVal(g) || kidsOf(g, "ser").some((s) => showVal(s));
  return { chartType, title, legend: Boolean(kid(chart, "legend")), stacked, labels, categories, series, unsupported };
}

// ───────────── escribir ─────────────

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
const hex = (c: string) => c.replace("#", "").slice(0, 6).toUpperCase();

/** "A", "B"… "AA" como en Excel (desde 0). */
function colName(i: number): string {
  let n = i + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

const SHEET = "Hoja1";

function strCache(points: string[]): string {
  return `<c:strCache><c:ptCount val="${points.length}"/>${points.map((p, i) => `<c:pt idx="${i}"><c:v>${esc(p)}</c:v></c:pt>`).join("")}</c:strCache>`;
}

function numCache(points: (number | null)[]): string {
  return `<c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${points.length}"/>${points
    .map((p, i) => (p === null ? "" : `<c:pt idx="${i}"><c:v>${p}</c:v></c:pt>`))
    .join("")}</c:numCache>`;
}

const LABELS = `<c:dLbls><c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr><c:showLegendKey val="0"/><c:showVal val="1"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="0"/><c:showBubbleSize val="0"/></c:dLbls>`;

/** chartN.xml de una gráfica. `textColor`: color del texto de ejes, leyenda y título (el del tema). */
export function chartXml(el: ChartElement, textColor: string): string {
  const n = el.categories.length;
  const pie = el.chartType === "pie" || el.chartType === "doughnut";
  const sers = (pie ? el.series.slice(0, 1) : el.series)
    .map((s, i) => {
      const col = colName(i + 1);
      const tx = `<c:tx><c:strRef><c:f>${SHEET}!$${col}$1</c:f>${strCache([s.name])}</c:strRef></c:tx>`;
      const fill = `<a:solidFill><a:srgbClr val="${hex(s.color)}"/></a:solidFill>`;
      const spPr =
        el.chartType === "line"
          ? `<c:spPr><a:ln w="28575" cap="rnd">${fill}<a:round/></a:ln></c:spPr>`
          : `<c:spPr>${fill}<a:ln><a:noFill/></a:ln></c:spPr>`;
      // En el pastel cada rebanada lleva su color.
      const points = pie
        ? el.categories
            .map((_, k) => `<c:dPt><c:idx val="${k}"/><c:bubble3D val="0"/><c:spPr><a:solidFill><a:srgbClr val="${hex(PIE_COLORS[k % PIE_COLORS.length])}"/></a:solidFill><a:ln w="12700"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:ln></c:spPr></c:dPt>`)
            .join("")
        : "";
      const cat = `<c:cat><c:strRef><c:f>${SHEET}!$A$2:$A$${n + 1}</c:f>${strCache(el.categories)}</c:strRef></c:cat>`;
      const values = `<c:val><c:numRef><c:f>${SHEET}!$${col}$2:$${col}$${n + 1}</c:f>${numCache(s.values.slice(0, n))}</c:numRef></c:val>`;
      const labels = el.labels ? LABELS : "";
      const head = `<c:idx val="${i}"/><c:order val="${i}"/>${tx}`;
      if (el.chartType === "line") return `<c:ser>${head}${spPr}<c:marker><c:symbol val="circle"/><c:size val="5"/><c:spPr>${fill}</c:spPr></c:marker>${labels}${cat}${values}<c:smooth val="0"/></c:ser>`;
      if (el.chartType === "column" || el.chartType === "bar") return `<c:ser>${head}${spPr}<c:invertIfNegative val="0"/>${labels}${cat}${values}</c:ser>`;
      if (pie) return `<c:ser>${head}${spPr}${points}${labels}${cat}${values}</c:ser>`;
      return `<c:ser>${head}${spPr}${labels}${cat}${values}</c:ser>`;
    })
    .join("");
  const axes = `<c:axId val="500000001"/><c:axId val="500000002"/>`;
  const grouping = el.stacked ? "stacked" : el.chartType === "column" || el.chartType === "bar" ? "clustered" : "standard";
  let group: string;
  if (el.chartType === "column" || el.chartType === "bar")
    group = `<c:barChart><c:barDir val="${el.chartType === "bar" ? "bar" : "col"}"/><c:grouping val="${grouping}"/><c:varyColors val="0"/>${sers}<c:gapWidth val="${el.stacked ? 80 : 150}"/>${el.stacked ? '<c:overlap val="100"/>' : ""}${axes}</c:barChart>`;
  else if (el.chartType === "line") group = `<c:lineChart><c:grouping val="${grouping}"/><c:varyColors val="0"/>${sers}<c:marker val="1"/>${axes}</c:lineChart>`;
  else if (el.chartType === "area") group = `<c:areaChart><c:grouping val="${grouping}"/><c:varyColors val="0"/>${sers}${axes}</c:areaChart>`;
  else if (el.chartType === "pie") group = `<c:pieChart><c:varyColors val="1"/>${sers}<c:firstSliceAng val="0"/></c:pieChart>`;
  else group = `<c:doughnutChart><c:varyColors val="1"/>${sers}<c:firstSliceAng val="0"/><c:holeSize val="55"/></c:doughnutChart>`;

  const txPr = (size: number) => `<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="${size}"><a:solidFill><a:srgbClr val="${hex(textColor)}"/></a:solidFill></a:defRPr></a:pPr><a:endParaRPr lang="es-MX"/></a:p></c:txPr>`;
  const horizontal = el.chartType === "bar";
  const axisLine = `<c:spPr><a:ln w="9525"><a:solidFill><a:srgbClr val="BFBFBF"/></a:solidFill></a:ln></c:spPr>`;
  const grid = `<c:majorGridlines><c:spPr><a:ln w="9525"><a:solidFill><a:srgbClr val="D9D9D9"/></a:solidFill></a:ln></c:spPr></c:majorGridlines>`;
  const axisXml = pie
    ? ""
    : `<c:catAx><c:axId val="500000001"/><c:scaling><c:orientation val="${horizontal ? "maxMin" : "minMax"}"/></c:scaling><c:delete val="0"/><c:axPos val="${horizontal ? "l" : "b"}"/><c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>${axisLine}${txPr(1200)}<c:crossAx val="500000002"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx><c:valAx><c:axId val="500000002"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${horizontal ? "t" : "l"}"/>${grid}<c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:spPr><a:ln><a:noFill/></a:ln></c:spPr>${txPr(1200)}<c:crossAx val="500000001"/><c:crosses val="${horizontal ? "max" : "autoZero"}"/><c:crossBetween val="between"/></c:valAx>`;
  const title = el.title
    ? `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1800" b="0"><a:solidFill><a:srgbClr val="${hex(textColor)}"/></a:solidFill></a:defRPr></a:pPr><a:r><a:rPr lang="es-MX" sz="1800" b="0"><a:solidFill><a:srgbClr val="${hex(textColor)}"/></a:solidFill></a:rPr><a:t>${esc(el.title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>`
    : `<c:autoTitleDeleted val="1"/>`;
  const legend = el.legend ? `<c:legend><c:legendPos val="r"/><c:overlay val="0"/>${txPr(1200)}</c:legend>` : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><c:chartSpace xmlns:c="${C}" xmlns:a="${A}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><c:date1904 val="0"/><c:lang val="es-MX"/><c:roundedCorners val="0"/><c:chart>${title}<c:plotArea><c:layout/>${group}${axisXml}<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr></c:plotArea>${legend}<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart><c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr><c:externalData r:id="rId1"><c:autoUpdate val="0"/></c:externalData></c:chartSpace>`;
}

const PIE_COLORS = ["#4472C4", "#ED7D31", "#A5A5A5", "#FFC000", "#5B9BD5", "#70AD47", "#264478", "#9E480E", "#636363", "#997300"];

/** El libro de Excel incrustado con los datos (para «Editar datos» en PowerPoint). */
export async function chartWorkbook(el: ChartElement): Promise<Uint8Array> {
  const zip = new JSZip();
  const XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`;
  const str = (ref: string, text: string) => `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(text)}</t></is></c>`;
  const rows: string[] = [];
  rows.push(`<row r="1">${str("A1", "")}${el.series.map((s, i) => str(`${colName(i + 1)}1`, s.name)).join("")}</row>`);
  el.categories.forEach((cat, r) => {
    const n = r + 2;
    const cells = el.series.map((s, i) => (s.values[r] === null || s.values[r] === undefined ? "" : `<c r="${colName(i + 1)}${n}"><v>${s.values[r]}</v></c>`)).join("");
    rows.push(`<row r="${n}">${str(`A${n}`, cat)}${cells}</row>`);
  });
  zip.file(
    "[Content_Types].xml",
    `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
  );
  zip.file(
    "_rels/.rels",
    `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  );
  zip.file(
    "xl/workbook.xml",
    `${XML}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${SHEET}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  );
  zip.file(
    "xl/_rels/workbook.xml.rels",
    `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
  );
  zip.file("xl/worksheets/sheet1.xml", `${XML}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.join("")}</sheetData></worksheet>`);
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}
