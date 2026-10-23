// Texto de las diapositivas ↔ editor TipTap. Cada párrafo del cuadro es un
// párrafo del editor con sus atributos (viñeta, nivel, espacios); el formato de
// las letras son marcas (negrita, color, tamaño…).

import { Extension } from "@tiptap/core";
import type { JSONContent } from "@tiptap/react";
import type { Para, Run, TextBody } from "./model";

type Mark = { type: string; attrs?: Record<string, unknown> };

/** Atributos de párrafo de las diapositivas (viñetas, nivel, espacios), con el mismo marcado que la vista normal. */
export const SlideParagraph = Extension.create({
  name: "slideParagraph",
  addGlobalAttributes() {
    const data = (name: string, parse: (v: string) => unknown = (v) => v) => ({
      default: null,
      parseHTML: (el: HTMLElement) => {
        const v = el.getAttribute(`data-${name}`);
        return v === null ? null : parse(v);
      },
      renderHTML: (attrs: Record<string, unknown>) => {
        const v = attrs[name];
        return v === null || v === undefined || v === 0 ? {} : { [`data-${name}`]: String(v) };
      },
    });
    const style = (attr: string, css: (v: number) => string, read: (el: HTMLElement) => number | null) => ({
      default: null,
      parseHTML: read,
      renderHTML: (attrs: Record<string, unknown>) => (attrs[attr] === null || attrs[attr] === undefined ? {} : { style: css(attrs[attr] as number) }),
    });
    const pt = (v: string) => (v ? parseFloat(v) : null);
    return [
      {
        types: ["paragraph"],
        attributes: {
          bullet: data("bullet"),
          level: data("level", Number),
          spaceBefore: style("spaceBefore", (v) => `margin-top: ${v}pt`, (el) => pt(el.style.marginTop)),
          spaceAfter: style("spaceAfter", (v) => `margin-bottom: ${v}pt`, (el) => pt(el.style.marginBottom)),
          lineSpacing: style("lineSpacing", (v) => `line-height: ${Math.round(v * 1.2 * 1000) / 1000}`, (el) => (el.style.lineHeight ? parseFloat(el.style.lineHeight) / 1.2 : null)),
          endSize: style("endSize", (v) => `--end-size: ${v}pt`, (el) => pt(el.style.getPropertyValue("--end-size"))),
        },
      },
    ];
  },
  addKeyboardShortcuts() {
    // Tab y ⇧Tab cambian el nivel de la viñeta, como en PowerPoint.
    const shift = (delta: number) => () => {
      const { state, view } = this.editor;
      const tr = state.tr;
      state.doc.nodesBetween(state.selection.from, state.selection.to, (node, pos) => {
        if (node.type.name !== "paragraph") return true;
        const level = Math.max(0, Math.min(8, (node.attrs.level ?? 0) + delta));
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, level: level || null });
        return false;
      });
      view.dispatch(tr);
      return true;
    };
    return { Tab: shift(1), "Shift-Tab": shift(-1) };
  },
});

function runMarks(r: Run): Mark[] {
  const marks: Mark[] = [];
  if (r.bold) marks.push({ type: "bold" });
  if (r.italic) marks.push({ type: "italic" });
  if (r.underline) marks.push({ type: "underline" });
  if (r.strike) marks.push({ type: "strike" });
  const style: Record<string, string> = {};
  if (r.color) style.color = r.color;
  if (r.size) style.fontSize = `${r.size}pt`;
  if (r.font) style.fontFamily = r.font;
  if (Object.keys(style).length) marks.push({ type: "textStyle", attrs: style });
  if (r.link) marks.push({ type: "link", attrs: { href: r.link } });
  return marks;
}

export function toEditor(text: TextBody): JSONContent {
  return {
    type: "doc",
    content: text.paras.map((p) => {
      const content: JSONContent[] = [];
      for (const r of p.runs) {
        const marks = runMarks(r);
        r.text.split("\n").forEach((part, i) => {
          if (i) content.push({ type: "hardBreak" });
          if (part) content.push({ type: "text", text: part, ...(marks.length ? { marks } : {}) });
        });
      }
      return {
        type: "paragraph",
        attrs: {
          textAlign: p.align ?? null,
          bullet: p.bullet ?? null,
          level: p.level || null,
          spaceBefore: p.spaceBefore ?? null,
          spaceAfter: p.spaceAfter ?? null,
          lineSpacing: p.lineSpacing ?? null,
          endSize: p.endSize ?? null,
        },
        ...(content.length ? { content } : {}),
      };
    }),
  };
}

function sizeOf(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const m = /([\d.]+)\s*(pt|px)?/.exec(value);
  if (!m) return undefined;
  return Math.round((m[2] === "px" ? Number(m[1]) * 0.75 : Number(m[1])) * 10) / 10;
}

export function fromEditor(doc: JSONContent, base: TextBody): TextBody {
  const paras: Para[] = (doc.content ?? []).map((node) => {
    const a = node.attrs ?? {};
    const runs: Run[] = [];
    for (const n of node.content ?? []) {
      if (n.type === "hardBreak") {
        const last = runs[runs.length - 1];
        if (last) last.text += "\n";
        else runs.push({ text: "\n" });
        continue;
      }
      if (n.type !== "text" || !n.text) continue;
      const marks = (n.marks ?? []) as Mark[];
      const has = (t: string) => marks.some((m) => m.type === t);
      const style = (marks.find((m) => m.type === "textStyle")?.attrs ?? {}) as Record<string, unknown>;
      const run: Run = { text: n.text };
      if (has("bold")) run.bold = true;
      if (has("italic")) run.italic = true;
      if (has("underline")) run.underline = true;
      if (has("strike")) run.strike = true;
      if (style.color) run.color = String(style.color);
      const size = sizeOf(style.fontSize);
      if (size) run.size = size;
      if (style.fontFamily) run.font = String(style.fontFamily).split(",")[0].replace(/["']/g, "").trim();
      const link = marks.find((m) => m.type === "link")?.attrs?.href;
      if (link) run.link = String(link);
      // Pedazos seguidos con el mismo formato se juntan.
      const prev = runs[runs.length - 1];
      if (prev && JSON.stringify({ ...prev, text: "" }) === JSON.stringify({ ...run, text: "" })) prev.text += run.text;
      else runs.push(run);
    }
    const p: Para = { runs };
    if (a.textAlign && a.textAlign !== "left") p.align = a.textAlign as Para["align"];
    if (a.bullet) p.bullet = a.bullet as Para["bullet"];
    else p.bullet = null;
    if (a.level) p.level = Number(a.level);
    if (a.spaceBefore !== null && a.spaceBefore !== undefined) p.spaceBefore = Number(a.spaceBefore);
    if (a.spaceAfter !== null && a.spaceAfter !== undefined) p.spaceAfter = Number(a.spaceAfter);
    if (a.lineSpacing) p.lineSpacing = Number(a.lineSpacing);
    if (a.endSize) p.endSize = Number(a.endSize);
    return p;
  });
  return { ...base, paras: paras.length ? paras : [{ runs: [] }] };
}

// ───────────── formato de todo el cuadro (cuando está seleccionado sin editar) ─────────────

export function mapRuns(text: TextBody, fn: (r: Run) => Run): TextBody {
  return { ...text, paras: text.paras.map((p) => ({ ...p, runs: p.runs.map(fn) })) };
}

export function mapParas(text: TextBody, fn: (p: Para) => Para): TextBody {
  return { ...text, paras: text.paras.map(fn) };
}

/** ¿Todo el texto del cuadro tiene esta propiedad? (para que el botón se vea presionado). */
export function allRuns(text: TextBody | undefined, test: (r: Run) => boolean): boolean {
  const runs = text?.paras.flatMap((p) => p.runs).filter((r) => r.text) ?? [];
  return runs.length > 0 && runs.every(test);
}
