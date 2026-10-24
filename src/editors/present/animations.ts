// Animaciones de entrada de WEPO Present.
//
// Al presentar, cada clic hace entrar el siguiente grupo de elementos (los que
// van «con la anterior» o «después de la anterior» entran en el mismo clic).
// En el .pptx van en <p:timing>, con los mismos efectos de PowerPoint
// (Aparecer, Desvanecer, Entrar volando, Zoom y Barrido).

import type { AnimEffect, AnimTrigger, Animation, Deck, Direction, ShapeElement, Slide, SlideElement } from "./model";
import { isEmptyText, uid } from "./model";

export const EFFECTS: { id: AnimEffect | null; name: string; directions: boolean }[] = [
  { id: null, name: "Ninguna", directions: false },
  { id: "appear", name: "Aparecer", directions: false },
  { id: "fade", name: "Desvanecer", directions: false },
  { id: "fly", name: "Entrar volando", directions: true },
  { id: "zoom", name: "Zoom", directions: false },
  { id: "wipe", name: "Barrido", directions: true },
];

/** De dónde entra («desde abajo» = sube). */
export const ANIM_DIRECTIONS: { id: Direction; name: string }[] = [
  { id: "up", name: "Desde abajo" },
  { id: "right", name: "Desde la izquierda" },
  { id: "left", name: "Desde la derecha" },
  { id: "down", name: "Desde arriba" },
];

export const TRIGGERS: { id: AnimTrigger; name: string }[] = [
  { id: "click", name: "Al hacer clic" },
  { id: "with", name: "Con la anterior" },
  { id: "after", name: "Después de la anterior" },
];

export function effectName(effect: AnimEffect | null | undefined): string {
  return EFFECTS.find((e) => e.id === (effect ?? null))?.name ?? "Ninguna";
}

export function newAnimation(target: string, effect: AnimEffect): Animation {
  return { id: uid("a"), target, effect, direction: effect === "fly" || effect === "wipe" ? "up" : undefined, trigger: "click", duration: effect === "appear" ? 0 : 500, delay: 0 };
}

/** Párrafos con texto de un cuadro (los que pueden entrar uno por uno). */
export function textParagraphs(el: SlideElement | undefined): number[] {
  if (!el || el.kind !== "shape" || !el.text || isEmptyText(el.text)) return [];
  return el.text.paras.map((p, i) => (p.runs.some((r) => r.text.trim()) ? i : -1)).filter((i) => i >= 0);
}

/** Lo que entra de una vez: un elemento entero o uno de sus párrafos. */
export type AnimUnit = { anim: Animation; para: number | null; trigger: AnimTrigger };
export type AnimItem = AnimUnit & { start: number; end: number };
/** Un clic: lo que entra con él, con su momento de inicio. `auto`: empieza solo al llegar a la diapositiva. */
export type AnimStep = { auto: boolean; items: AnimItem[] };

/** Los pasos (clics) de la diapositiva, en orden. */
export function animationSteps(slide: Slide): AnimStep[] {
  const units: AnimUnit[] = [];
  for (const anim of slide.animations ?? []) {
    const el = slide.elements.find((e) => e.id === anim.target);
    if (!el) continue;
    const paras = anim.byParagraph ? textParagraphs(el) : [];
    if (paras.length > 1) paras.forEach((p, i) => units.push({ anim, para: p, trigger: i === 0 ? anim.trigger : "click" }));
    else units.push({ anim, para: null, trigger: anim.trigger });
  }
  const steps: AnimStep[] = [];
  let lastStart = 0;
  let lastEnd = 0;
  for (const u of units) {
    let step = steps[steps.length - 1];
    if (!step || u.trigger === "click") {
      step = { auto: !steps.length && u.trigger !== "click", items: [] };
      steps.push(step);
      lastStart = 0;
      lastEnd = 0;
    }
    const base = !step.items.length ? 0 : u.trigger === "after" ? lastEnd : u.trigger === "with" ? lastStart : 0;
    const start = base + u.anim.delay;
    const end = start + u.anim.duration;
    step.items.push({ ...u, start, end });
    lastStart = start;
    lastEnd = Math.max(lastEnd, end);
  }
  return steps;
}

/** Selector CSS de lo que entra (el elemento o su párrafo). */
export function unitSelector(u: AnimUnit): string {
  const el = `[data-anim="${u.anim.target}"]`;
  return u.para === null ? el : `${el} [data-para="${u.para}"]`;
}

/** CSS que esconde todo lo que todavía no entra (desde el paso `from`). */
export function hiddenCss(steps: AnimStep[], from: number, scope: string): string {
  const selectors = steps.slice(from).flatMap((s) => s.items.map((i) => `${scope} ${unitSelector(i)}`));
  return selectors.length ? `${selectors.join(",")}{visibility:hidden !important}` : "";
}

/** Cuadros clave de la entrada (con translate/scale sueltos: no pisan el giro del elemento). */
export function enterFrames(anim: Animation, el: SlideElement | undefined, deck: Pick<Deck, "width" | "height">): Keyframe[] {
  switch (anim.effect) {
    case "appear":
      return [{ opacity: 1 }, { opacity: 1 }];
    case "fade":
      return [{ opacity: 0 }, { opacity: 1 }];
    case "zoom":
      return [{ opacity: 0, scale: "0.2" }, { opacity: 1, scale: "1" }];
    case "fly": {
      const x = el?.x ?? 0;
      const y = el?.y ?? 0;
      const w = el?.w ?? 0;
      const h = el?.h ?? 0;
      const from =
        anim.direction === "right"
          ? `${-(x + w)}px 0`
          : anim.direction === "left"
            ? `${deck.width - x}px 0`
            : anim.direction === "down"
              ? `0 ${-(y + h)}px`
              : `0 ${deck.height - y}px`;
      return [{ translate: from }, { translate: "0 0" }];
    }
    case "wipe": {
      const start =
        anim.direction === "right"
          ? "inset(0 100% 0 0)"
          : anim.direction === "left"
            ? "inset(0 0 0 100%)"
            : anim.direction === "down"
              ? "inset(0 0 100% 0)"
              : "inset(100% 0 0 0)";
      return [{ clipPath: start }, { clipPath: "inset(0 0 0 0)" }];
    }
  }
}

/** Hace entrar lo de un paso dentro de `root` (la diapositiva que se ve). */
export function playStep(step: AnimStep, root: HTMLElement, slide: Slide, deck: Pick<Deck, "width" | "height">, offset = 0): globalThis.Animation[] {
  const out: globalThis.Animation[] = [];
  for (const item of step.items) {
    const target = root.querySelector<HTMLElement>(unitSelector(item));
    if (!target) continue;
    const el = slide.elements.find((e) => e.id === item.anim.target);
    out.push(
      target.animate(enterFrames(item.anim, el, deck), {
        duration: Math.max(1, item.anim.duration),
        delay: offset + item.start,
        easing: item.anim.effect === "fly" ? "cubic-bezier(.2,.75,.25,1)" : "ease-out",
        fill: "backwards",
      }),
    );
  }
  return out;
}

// ───────────── .pptx ─────────────

type Ids = { next: () => number };

const FLY_SUBTYPE: Record<Direction, number> = { up: 4, right: 8, left: 2, down: 1 };
const SUBTYPE_DIR: Record<number, Direction> = { 4: "up", 8: "right", 2: "left", 1: "down" };
const WIPE_FILTER: Record<Direction, string> = { up: "wipe(up)", right: "wipe(right)", left: "wipe(left)", down: "wipe(down)" };

function target(spid: number, para: number | null): string {
  return para === null ? `<p:spTgt spid="${spid}"/>` : `<p:spTgt spid="${spid}"><p:txEl><p:pRg st="${para}" end="${para}"/></p:txEl></p:spTgt>`;
}

function behaviors(anim: Animation, tgt: string, ids: Ids): string {
  const set = `<p:set><p:cBhvr><p:cTn id="${ids.next()}" dur="1" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst></p:cTn><p:tgtEl>${tgt}</p:tgtEl><p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr><p:to><p:strVal val="visible"/></p:to></p:set>`;
  const dur = Math.max(1, Math.round(anim.duration));
  const prop = (attr: string, from: string, to: string) =>
    `<p:anim calcmode="lin" valueType="num"><p:cBhvr additive="base"><p:cTn id="${ids.next()}" dur="${dur}" fill="hold"/><p:tgtEl>${tgt}</p:tgtEl><p:attrNameLst><p:attrName>${attr}</p:attrName></p:attrNameLst></p:cBhvr><p:tavLst><p:tav tm="0"><p:val><p:strVal val="${from}"/></p:val></p:tav><p:tav tm="100000"><p:val><p:strVal val="${to}"/></p:val></p:tav></p:tavLst></p:anim>`;
  const effect = (filter: string) => `<p:animEffect transition="in" filter="${filter}"><p:cBhvr><p:cTn id="${ids.next()}" dur="${dur}"/><p:tgtEl>${tgt}</p:tgtEl></p:cBhvr></p:animEffect>`;
  switch (anim.effect) {
    case "appear":
      return set;
    case "fade":
      return set + effect("fade");
    case "zoom":
      return set + prop("ppt_w", "0", "#ppt_w") + prop("ppt_h", "0", "#ppt_h") + effect("fade");
    case "wipe":
      return set + effect(WIPE_FILTER[anim.direction ?? "up"]);
    case "fly": {
      const d = anim.direction ?? "up";
      if (d === "up") return set + prop("ppt_x", "#ppt_x", "#ppt_x") + prop("ppt_y", "1+#ppt_h/2", "#ppt_y");
      if (d === "down") return set + prop("ppt_x", "#ppt_x", "#ppt_x") + prop("ppt_y", "0-#ppt_h/2", "#ppt_y");
      if (d === "right") return set + prop("ppt_x", "0-#ppt_w/2", "#ppt_x") + prop("ppt_y", "#ppt_y", "#ppt_y");
      return set + prop("ppt_x", "1+#ppt_w/2", "#ppt_x") + prop("ppt_y", "#ppt_y", "#ppt_y");
    }
  }
}

const PRESET: Record<AnimEffect, number> = { appear: 1, fade: 10, fly: 2, zoom: 53, wipe: 22 };

/**
 * <p:timing> de la diapositiva. `spid` da el número de forma (cNvPr id) de cada
 * elemento en el .pptx. Va al final de <p:sld>, después de la transición.
 */
export function timingXml(slide: Slide, spid: (elementId: string) => number | undefined): string {
  const steps = animationSteps(slide);
  if (!steps.length) return "";
  let n = 2;
  const ids: Ids = { next: () => ++n };
  const builds = new Map<number, string>();
  const clicks = steps
    .map((step) => {
      const clickId = ids.next();
      // Dentro del clic: lo que va «con la anterior» entra en el mismo grupo; «después de la anterior» abre otro que empieza al terminar lo de antes.
      const parts: { start: number; items: AnimItem[] }[] = [];
      let partEnd = 0;
      for (const item of step.items) {
        if (!parts.length || item.trigger === "after") parts.push({ start: parts.length ? partEnd : 0, items: [] });
        parts[parts.length - 1].items.push(item);
        partEnd = Math.max(partEnd, item.end);
      }
      const groups = parts
        .map(({ start, items }, g) => {
          const groupId = ids.next();
          const effects = items
            .map((item, k) => {
              const sp = spid(item.anim.target);
              if (sp === undefined) return "";
              const element = slide.elements.find((e) => e.id === item.anim.target);
              builds.set(sp, element?.kind === "shape" && element.text ? `<p:bldP spid="${sp}" grpId="0"${item.anim.byParagraph ? ' build="p"' : ""}${(element as ShapeElement).fill ? ' animBg="1"' : ""}/>` : "");
              const nodeType = k > 0 ? "withEffect" : g > 0 || item.trigger === "after" ? "afterEffect" : item.trigger === "with" ? "withEffect" : "clickEffect";
              const sub = item.anim.effect === "fly" || item.anim.effect === "wipe" ? FLY_SUBTYPE[item.anim.direction ?? "up"] : item.anim.effect === "zoom" ? 16 : 0;
              const tgt = target(sp, item.para);
              const effectId = ids.next();
              return `<p:par><p:cTn id="${effectId}" presetID="${PRESET[item.anim.effect]}" presetClass="entr" presetSubtype="${sub}" fill="hold" grpId="0" nodeType="${nodeType}"><p:stCondLst><p:cond delay="${Math.round(item.anim.delay)}"/></p:stCondLst><p:childTnLst>${behaviors(item.anim, tgt, ids)}</p:childTnLst></p:cTn></p:par>`;
            })
            .join("");
          return `<p:par><p:cTn id="${groupId}" fill="hold"><p:stCondLst><p:cond delay="${Math.round(start)}"/></p:stCondLst><p:childTnLst>${effects}</p:childTnLst></p:cTn></p:par>`;
        })
        .join("");
      const cond = step.auto ? '<p:cond delay="indefinite"/><p:cond evt="onBegin" delay="0"><p:tn val="2"/></p:cond>' : '<p:cond delay="indefinite"/>';
      return `<p:par><p:cTn id="${clickId}" fill="hold"><p:stCondLst>${cond}</p:stCondLst><p:childTnLst>${groups}</p:childTnLst></p:cTn></p:par>`;
    })
    .join("");
  const bld = [...builds.values()].filter(Boolean).join("");
  return `<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst><p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst>${clicks}</p:childTnLst></p:cTn><p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst><p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst></p:seq></p:childTnLst></p:cTn></p:par></p:tnLst>${bld ? `<p:bldLst>${bld}</p:bldLst>` : ""}</p:timing>`;
}

const kids = (el: Element | null | undefined, name?: string) => (el ? Array.from(el.children).filter((c) => !name || c.localName === name) : []);
const kid = (el: Element | null | undefined, name: string) => kids(el, name)[0];

/**
 * Lee las animaciones de <p:timing>. `element` da el id de WEPO de cada número
 * de forma. Las de salida, énfasis o trayectoria se cuentan en `skipped`; las
 * de entrada que WEPO no tiene se leen como Desvanecer (`approximated`).
 */
export function readTiming(slideRoot: Element, element: (spid: string) => string | undefined): { animations: Animation[]; skipped: boolean; approximated: boolean } {
  const out: Animation[] = [];
  let skipped = false;
  let approximated = false;
  const timing = kid(slideRoot, "timing");
  if (!timing) return { animations: out, skipped, approximated };
  const main = Array.from(timing.getElementsByTagNameNS("*", "cTn")).find((c) => c.getAttribute("nodeType") === "mainSeq");
  if (!main) {
    // Solo animaciones con disparador (clic en un objeto): WEPO no las tiene.
    if (timing.getElementsByTagNameNS("*", "cTn").length > 1) skipped = true;
    return { animations: out, skipped, approximated };
  }
  for (const effect of Array.from(main.getElementsByTagNameNS("*", "cTn")).filter((c) => c.getAttribute("presetClass"))) {
    const cls = effect.getAttribute("presetClass");
    if (cls !== "entr") {
      skipped = true;
      continue;
    }
    const spTgt = effect.getElementsByTagNameNS("*", "spTgt")[0];
    const id = spTgt ? element(spTgt.getAttribute("spid") ?? "") : undefined;
    if (!id) continue;
    const preset = Number(effect.getAttribute("presetID") ?? 0);
    const sub = Number(effect.getAttribute("presetSubtype") ?? 0);
    let anim: AnimEffect;
    if (preset === 1) anim = "appear";
    else if (preset === 10) anim = "fade";
    else if (preset === 2) anim = "fly";
    else if (preset === 53 || preset === 23) anim = "zoom";
    else if (preset === 22) anim = "wipe";
    else {
      anim = "fade";
      approximated = true;
    }
    const nodeType = effect.getAttribute("nodeType");
    const trigger: AnimTrigger = nodeType === "withEffect" ? "with" : nodeType === "afterEffect" ? "after" : "click";
    const delay = Number(kid(kid(effect, "stCondLst"), "cond")?.getAttribute("delay") ?? 0) || 0;
    const durations = Array.from(effect.getElementsByTagNameNS("*", "cTn"))
      .map((c) => Number(c.getAttribute("dur")))
      .filter((d) => Number.isFinite(d));
    const duration = anim === "appear" ? 0 : Math.max(0, ...durations.filter((d) => d > 1)) || 500;
    const para = spTgt.getElementsByTagNameNS("*", "pRg")[0];
    const last = out[out.length - 1];
    // Párrafo por párrafo: los efectos seguidos sobre el mismo cuadro se juntan en una animación.
    if (para && last && last.target === id && last.byParagraph && last.effect === anim && trigger === "click") continue;
    out.push({
      id: uid("a"),
      target: id,
      effect: anim,
      direction: anim === "fly" || anim === "wipe" ? (SUBTYPE_DIR[sub] ?? "up") : undefined,
      trigger,
      duration,
      delay: Math.max(0, delay),
      byParagraph: para ? true : undefined,
    });
  }
  return { animations: out, skipped, approximated };
}
