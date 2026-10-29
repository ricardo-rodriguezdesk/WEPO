// Animaciones de WEPO Present: de entrada, de énfasis y de salida.
//
// Al presentar, cada clic hace entrar el siguiente grupo de elementos (los que
// van «con la anterior» o «después de la anterior» entran en el mismo clic).
// En el .pptx van en <p:timing>, con los mismos efectos de PowerPoint
// (Aparecer, Desvanecer, Entrar volando, Zoom y Barrido; sus salidas; y de
// énfasis Pulso, Girar, Crecer, Balancear y Transparencia).

import type { AnimClass, AnimEffect, AnimTrigger, Animation, Deck, Direction, ShapeElement, Slide, SlideElement } from "./model";
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

export const EXIT_EFFECTS: { id: AnimEffect | null; name: string; directions: boolean }[] = [
  { id: null, name: "Ninguna", directions: false },
  { id: "appear", name: "Desaparecer", directions: false },
  { id: "fade", name: "Desvanecer", directions: false },
  { id: "fly", name: "Salir volando", directions: true },
  { id: "zoom", name: "Zoom", directions: false },
  { id: "wipe", name: "Barrido", directions: true },
];

export const EMPHASIS_EFFECTS: { id: AnimEffect | null; name: string; directions: boolean }[] = [
  { id: null, name: "Ninguna", directions: false },
  { id: "pulse", name: "Pulso", directions: false },
  { id: "spin", name: "Girar", directions: false },
  { id: "grow", name: "Crecer", directions: false },
  { id: "teeter", name: "Balancear", directions: false },
  { id: "transparency", name: "Transparencia", directions: false },
];

/** Hacia dónde se va (salir volando, barrido de salida). */
export const EXIT_DIRECTIONS: { id: Direction; name: string }[] = [
  { id: "down", name: "Hacia abajo" },
  { id: "left", name: "Hacia la izquierda" },
  { id: "right", name: "Hacia la derecha" },
  { id: "up", name: "Hacia arriba" },
];

export const CLASSES: { id: AnimClass; name: string }[] = [
  { id: "entr", name: "Entrada" },
  { id: "emph", name: "Énfasis" },
  { id: "exit", name: "Salida" },
];

export const clsOf = (a: Pick<Animation, "cls">): AnimClass => a.cls ?? "entr";

export function effectsFor(cls: AnimClass) {
  return cls === "exit" ? EXIT_EFFECTS : cls === "emph" ? EMPHASIS_EFFECTS : EFFECTS;
}

export function effectName(effect: AnimEffect | null | undefined, cls: AnimClass = "entr"): string {
  return effectsFor(cls).find((e) => e.id === (effect ?? null))?.name ?? "Ninguna";
}

export function newAnimation(target: string, effect: AnimEffect, cls: AnimClass = "entr"): Animation {
  const directed = effect === "fly" || effect === "wipe";
  return {
    id: uid("a"),
    target,
    effect,
    direction: directed ? (cls === "exit" ? "down" : "up") : undefined,
    trigger: "click",
    duration: effect === "appear" ? 0 : cls === "emph" ? 1000 : 500,
    delay: 0,
    ...(cls === "entr" ? {} : { cls }),
  };
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

/**
 * CSS que esconde lo que no se ve después de `from` clics: lo que todavía no entra
 * y lo que ya salió. Lo que sale en el clic `playing` (el que se está animando)
 * todavía no se esconde: su animación lo desaparece.
 */
export function hiddenCss(steps: AnimStep[], from: number, scope: string, playing = -1): string {
  const visible = new Map<string, boolean>();
  // Al principio: lo que tiene entrada está escondido; lo demás, a la vista.
  for (const st of steps)
    for (const i of st.items) {
      const sel = unitSelector(i);
      if (!visible.has(sel)) visible.set(sel, clsOf(i.anim) !== "entr");
    }
  steps.slice(0, from).forEach((st, k) => {
    for (const i of st.items) {
      const cls = clsOf(i.anim);
      if (cls === "entr") visible.set(unitSelector(i), true);
      else if (cls === "exit" && k !== playing) visible.set(unitSelector(i), false);
    }
  });
  const hidden = [...visible.entries()].filter(([, v]) => !v).map(([sel]) => `${scope} ${sel}`);
  return hidden.length ? `${hidden.join(",")}{visibility:hidden !important}` : "";
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
    default:
      return [{ opacity: 0 }, { opacity: 1 }];
  }
}

/** Cuadros clave de la salida: la entrada al revés (hacia donde se va). */
export function exitFrames(anim: Animation, el: SlideElement | undefined, deck: Pick<Deck, "width" | "height">): Keyframe[] {
  if (anim.effect === "appear") return [{ opacity: 1 }, { opacity: 0 }];
  // Salir hacia abajo es lo contrario de entrar desde abajo.
  const toward: Record<Direction, Direction> = { down: "up", up: "down", left: "right", right: "left" };
  const flip = anim.effect === "fly" ? { ...anim, direction: toward[anim.direction ?? "down"] } : anim.effect === "wipe" ? { ...anim, direction: toward[anim.direction ?? "down"] } : anim;
  return [...enterFrames(flip, el, deck)].reverse().map((f) => ({ ...f, offset: undefined }));
}

/** Cuadros clave del énfasis (el elemento ya está en la diapositiva). */
export function emphasisFrames(anim: Animation): Keyframe[] {
  switch (anim.effect) {
    case "pulse":
      return [{ scale: "1" }, { scale: "1.1" }, { scale: "1" }, { scale: "1.1" }, { scale: "1" }];
    case "spin":
      return [{ rotate: "0deg" }, { rotate: "360deg" }];
    case "grow":
      return [{ scale: "1" }, { scale: "1.5" }];
    case "teeter":
      return [{ rotate: "0deg" }, { rotate: "6deg" }, { rotate: "-6deg" }, { rotate: "6deg" }, { rotate: "-6deg" }, { rotate: "0deg" }];
    case "transparency":
      return [{ opacity: 1 }, { opacity: 0.4 }];
    default:
      return [{ opacity: 1 }, { opacity: 1 }];
  }
}

/** Anima lo de un paso dentro de `root` (la diapositiva que se ve). */
export function playStep(step: AnimStep, root: HTMLElement, slide: Slide, deck: Pick<Deck, "width" | "height">, offset = 0): globalThis.Animation[] {
  const out: globalThis.Animation[] = [];
  for (const item of step.items) {
    const target = root.querySelector<HTMLElement>(unitSelector(item));
    if (!target) continue;
    const el = slide.elements.find((e) => e.id === item.anim.target);
    const cls = clsOf(item.anim);
    const frames = cls === "exit" ? exitFrames(item.anim, el, deck) : cls === "emph" ? emphasisFrames(item.anim) : enterFrames(item.anim, el, deck);
    // La entrada se queda escondida mientras espera; la salida y lo que crece o se vuelve transparente se quedan así al terminar.
    const fill: FillMode = cls === "entr" ? "backwards" : cls === "exit" || item.anim.effect === "grow" || item.anim.effect === "transparency" ? "both" : "none";
    out.push(
      target.animate(frames, {
        duration: Math.max(1, item.anim.duration),
        delay: offset + item.start,
        easing: item.anim.effect === "fly" ? (cls === "exit" ? "cubic-bezier(.75,0,.8,.25)" : "cubic-bezier(.2,.75,.25,1)") : cls === "emph" ? "ease-in-out" : cls === "exit" ? "ease-in" : "ease-out",
        fill,
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
  const cls = clsOf(anim);
  const dur = Math.max(1, Math.round(anim.duration));
  const visibility = (value: "visible" | "hidden", delay: number) =>
    `<p:set><p:cBhvr><p:cTn id="${ids.next()}" dur="1" fill="hold"><p:stCondLst><p:cond delay="${delay}"/></p:stCondLst></p:cTn><p:tgtEl>${tgt}</p:tgtEl><p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr><p:to><p:strVal val="${value}"/></p:to></p:set>`;
  const prop = (attr: string, from: string, to: string) =>
    `<p:anim calcmode="lin" valueType="num"><p:cBhvr additive="base"><p:cTn id="${ids.next()}" dur="${dur}" fill="hold"/><p:tgtEl>${tgt}</p:tgtEl><p:attrNameLst><p:attrName>${attr}</p:attrName></p:attrNameLst></p:cBhvr><p:tavLst><p:tav tm="0"><p:val><p:strVal val="${from}"/></p:val></p:tav><p:tav tm="100000"><p:val><p:strVal val="${to}"/></p:val></p:tav></p:tavLst></p:anim>`;
  const effect = (filter: string, transition: "in" | "out" = "in") =>
    `<p:animEffect transition="${transition}" filter="${filter}"><p:cBhvr><p:cTn id="${ids.next()}" dur="${dur}"/><p:tgtEl>${tgt}</p:tgtEl></p:cBhvr></p:animEffect>`;
  const rot = (by: number, length: number, delay: number) =>
    `<p:animRot by="${by}"><p:cBhvr><p:cTn id="${ids.next()}" dur="${Math.max(1, Math.round(length))}" fill="hold"><p:stCondLst><p:cond delay="${Math.round(delay)}"/></p:stCondLst></p:cTn><p:tgtEl>${tgt}</p:tgtEl><p:attrNameLst><p:attrName>r</p:attrName></p:attrNameLst></p:cBhvr></p:animRot>`;
  const scale = (by: number, length: number, autoRev = false, repeat = 1) =>
    `<p:animScale><p:cBhvr><p:cTn id="${ids.next()}" dur="${Math.max(1, Math.round(length))}"${autoRev ? ' autoRev="1"' : ""}${repeat > 1 ? ` repeatCount="${repeat * 1000}"` : ""} fill="hold"/><p:tgtEl>${tgt}</p:tgtEl></p:cBhvr><p:by x="${by}" y="${by}"/></p:animScale>`;

  if (cls === "emph") {
    switch (anim.effect) {
      case "spin":
        return rot(21600000, dur, 0);
      case "grow":
        return scale(150000, dur);
      case "pulse":
        return scale(110000, dur / 4, true, 2);
      case "teeter": {
        // ±6° de ida y vuelta, en cinco partes iguales (como el «Balancear» de PowerPoint).
        const part = dur / 5;
        return [360000, -720000, 720000, -720000, 360000].map((by, i) => rot(by, part, i * part)).join("");
      }
      case "transparency":
        return `<p:set><p:cBhvr><p:cTn id="${ids.next()}" dur="${dur}" fill="hold"/><p:tgtEl>${tgt}</p:tgtEl><p:attrNameLst><p:attrName>style.opacity</p:attrName></p:attrNameLst></p:cBhvr><p:to><p:strVal val="0.4"/></p:to></p:set><p:animEffect filter="image" prLst="opacity: 0.4"><p:cBhvr rctx="IE"><p:cTn id="${ids.next()}" dur="${dur}" fill="hold"/><p:tgtEl>${tgt}</p:tgtEl></p:cBhvr></p:animEffect>`;
      default:
        return "";
    }
  }

  if (cls === "exit") {
    const hide = visibility("hidden", Math.max(0, dur - 1));
    switch (anim.effect) {
      case "appear":
        return visibility("hidden", 0);
      case "fade":
        return effect("fade", "out") + hide;
      case "zoom":
        return prop("ppt_w", "#ppt_w", "0") + prop("ppt_h", "#ppt_h", "0") + effect("fade", "out") + hide;
      case "wipe":
        return effect(WIPE_FILTER[anim.direction ?? "down"], "out") + hide;
      case "fly": {
        const d = anim.direction ?? "down";
        if (d === "down") return prop("ppt_x", "#ppt_x", "#ppt_x") + prop("ppt_y", "#ppt_y", "1+#ppt_h/2") + hide;
        if (d === "up") return prop("ppt_x", "#ppt_x", "#ppt_x") + prop("ppt_y", "#ppt_y", "0-#ppt_h/2") + hide;
        if (d === "left") return prop("ppt_x", "#ppt_x", "0-#ppt_w/2") + prop("ppt_y", "#ppt_y", "#ppt_y") + hide;
        return prop("ppt_x", "#ppt_x", "1+#ppt_w/2") + prop("ppt_y", "#ppt_y", "#ppt_y") + hide;
      }
      default:
        return hide;
    }
  }

  const set = visibility("visible", 0);
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
    default:
      return set + effect("fade");
  }
}

/** Número de efecto de PowerPoint (presetID) de cada uno. */
const PRESET: Record<AnimEffect, number> = { appear: 1, fade: 10, fly: 2, zoom: 53, wipe: 22, pulse: 26, spin: 8, grow: 6, teeter: 32, transparency: 9 };
/** Al salir, el subtipo dice hacia dónde: 4 abajo, 8 izquierda, 2 derecha, 1 arriba. */
const EXIT_SUBTYPE: Record<Direction, number> = { down: 4, left: 8, right: 2, up: 1 };
const SUBTYPE_EXIT: Record<number, Direction> = { 4: "down", 8: "left", 2: "right", 1: "up" };

/**
 * <p:timing> de la diapositiva. `spid` da el número de forma (cNvPr id) de cada
 * elemento en el .pptx. Va al final de <p:sld>, después de la transición.
 */
/** Video o audio de una diapositiva, tal como se guarda en <p:timing>. */
export type MediaTiming = { spid: number; type: "video" | "audio"; autoplay: boolean; loop: boolean };

export function timingXml(slide: Slide, spid: (elementId: string) => number | undefined, media: MediaTiming[] = []): string {
  const steps = animationSteps(slide);
  if (!steps.length && !media.length) return "";
  let n = 2;
  const ids: Ids = { next: () => ++n };
  const builds = new Map<number, string>();
  // Los que empiezan solos: un paso al inicio de la diapositiva con «reproducir» (como PowerPoint).
  const autoplay = media.filter((m) => m.autoplay);
  const playXml = autoplay.length
    ? (() => {
        const clickId = ids.next();
        const groupId = ids.next();
        const effects = autoplay
          .map((m, k) => {
            const effectId = ids.next();
            const cmdId = ids.next();
            return `<p:par><p:cTn id="${effectId}" presetID="1" presetClass="mediacall" presetSubtype="0" fill="hold" nodeType="${k ? "withEffect" : "afterEffect"}"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst><p:cmd type="call" cmd="playFrom(0.0)"><p:cBhvr><p:cTn id="${cmdId}" dur="1" fill="hold"/><p:tgtEl><p:spTgt spid="${m.spid}"/></p:tgtEl></p:cBhvr></p:cmd></p:childTnLst></p:cTn></p:par>`;
          })
          .join("");
        return `<p:par><p:cTn id="${clickId}" fill="hold"><p:stCondLst><p:cond delay="indefinite"/><p:cond evt="onBegin" delay="0"><p:tn val="2"/></p:cond></p:stCondLst><p:childTnLst><p:par><p:cTn id="${groupId}" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>${effects}</p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par>`;
      })()
    : "";
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
              const cls = clsOf(item.anim);
              const directed = item.anim.effect === "fly" || item.anim.effect === "wipe";
              const sub =
                cls === "emph" ? 0 : directed ? (cls === "exit" ? EXIT_SUBTYPE[item.anim.direction ?? "down"] : FLY_SUBTYPE[item.anim.direction ?? "up"]) : item.anim.effect === "zoom" ? 16 : 0;
              const tgt = target(sp, item.para);
              const effectId = ids.next();
              return `<p:par><p:cTn id="${effectId}" presetID="${PRESET[item.anim.effect]}" presetClass="${cls}" presetSubtype="${sub}" fill="hold" grpId="0" nodeType="${nodeType}"><p:stCondLst><p:cond delay="${Math.round(item.anim.delay)}"/></p:stCondLst><p:childTnLst>${behaviors(item.anim, tgt, ids)}</p:childTnLst></p:cTn></p:par>`;
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
  // Cada video o audio tiene su nodo (volumen, repetir); con él PowerPoint lo reproduce con un clic.
  const nodes = media
    .map((m) => `<p:${m.type}><p:cMediaNode vol="80000"><p:cTn id="${ids.next()}"${m.loop ? ' repeatCount="indefinite"' : ""} fill="hold"><p:stCondLst><p:cond delay="indefinite"/></p:stCondLst></p:cTn><p:tgtEl><p:spTgt spid="${m.spid}"/></p:tgtEl></p:cMediaNode></p:${m.type}>`)
    .join("");
  const main = steps.length || playXml ? `<p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst>${playXml}${clicks}</p:childTnLst></p:cTn><p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst><p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst></p:seq>` : "";
  return `<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst>${main}${nodes}</p:childTnLst></p:cTn></p:par></p:tnLst>${bld ? `<p:bldLst>${bld}</p:bldLst>` : ""}</p:timing>`;
}

const kids = (el: Element | null | undefined, name?: string) => (el ? Array.from(el.children).filter((c) => !name || c.localName === name) : []);
const kid = (el: Element | null | undefined, name: string) => kids(el, name)[0];

/** Qué videos y audios empiezan solos o se repiten (por número de forma). */
export function readMediaTiming(slideRoot: Element): Map<string, { autoplay?: boolean; loop?: boolean }> {
  const out = new Map<string, { autoplay?: boolean; loop?: boolean }>();
  const timing = kid(slideRoot, "timing");
  if (!timing) return out;
  const get = (spid: string) => out.get(spid) ?? (out.set(spid, {}), out.get(spid)!);
  for (const node of Array.from(timing.getElementsByTagNameNS("*", "cMediaNode"))) {
    const spid = node.getElementsByTagNameNS("*", "spTgt")[0]?.getAttribute("spid");
    if (spid && kid(node, "cTn")?.getAttribute("repeatCount") === "indefinite") get(spid).loop = true;
  }
  // Empieza solo si su «reproducir» está en un paso que arranca al empezar la diapositiva (o después de otro que lo hace).
  for (const cmd of Array.from(timing.getElementsByTagNameNS("*", "cmd"))) {
    if (!/^playFrom/.test(cmd.getAttribute("cmd") ?? "")) continue;
    const spid = cmd.getElementsByTagNameNS("*", "spTgt")[0]?.getAttribute("spid");
    let step: Element | null = cmd;
    while (step && !(step.localName === "par" && step.parentElement?.parentElement?.getAttribute("nodeType") === "mainSeq")) step = step.parentElement;
    const cond = step ? kid(kid(kid(step, "cTn"), "stCondLst"), "cond") : null;
    const conds = step ? Array.from(kid(kid(step, "cTn"), "stCondLst")?.children ?? []) : [];
    const auto = conds.some((c) => c.getAttribute("evt") === "onBegin") || (cond?.getAttribute("delay") !== "indefinite" && cond !== null);
    if (spid && auto) get(spid).autoplay = true;
  }
  return out;
}

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
    if (Array.from(timing.getElementsByTagNameNS("*", "cTn")).filter((c) => c.parentElement?.localName !== "cMediaNode").length > 1) skipped = true;
    return { animations: out, skipped, approximated };
  }
  for (const effect of Array.from(main.getElementsByTagNameNS("*", "cTn")).filter((c) => c.getAttribute("presetClass"))) {
    const cls = effect.getAttribute("presetClass");
    // «Reproducir» un video o audio: se lee aparte (readMediaTiming).
    if (cls === "mediacall") continue;
    if (cls !== "entr" && cls !== "exit" && cls !== "emph") {
      // Trayectorias y otras: WEPO no las tiene.
      skipped = true;
      continue;
    }
    const spTgt = effect.getElementsByTagNameNS("*", "spTgt")[0];
    const id = spTgt ? element(spTgt.getAttribute("spid") ?? "") : undefined;
    if (!id) continue;
    const preset = Number(effect.getAttribute("presetID") ?? 0);
    const sub = Number(effect.getAttribute("presetSubtype") ?? 0);
    let anim: AnimEffect;
    if (cls === "emph") {
      const emph: Record<number, AnimEffect> = { 26: "pulse", 8: "spin", 6: "grow", 32: "teeter", 9: "transparency", 35: "pulse" };
      anim = emph[preset] ?? "pulse";
      if (!emph[preset]) approximated = true;
    } else if (preset === 1) anim = "appear";
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
    // Hasta dónde llega cada comportamiento (con su espera, ida y vuelta y repeticiones).
    const durations = Array.from(effect.getElementsByTagNameNS("*", "cTn"))
      .filter((c) => c !== effect)
      .map((c) => {
        const d = Number(c.getAttribute("dur"));
        if (!Number.isFinite(d) || d <= 1) return 0;
        const wait = Number(kid(kid(c, "stCondLst"), "cond")?.getAttribute("delay") ?? 0) || 0;
        const times = (c.getAttribute("autoRev") === "1" ? 2 : 1) * Math.max(1, (Number(c.getAttribute("repeatCount")) || 1000) / 1000);
        return wait + d * times;
      });
    const duration = anim === "appear" ? 0 : Math.round(Math.max(0, ...durations)) || 500;
    const para = spTgt.getElementsByTagNameNS("*", "pRg")[0];
    const last = out[out.length - 1];
    // Párrafo por párrafo: los efectos seguidos sobre el mismo cuadro se juntan en una animación.
    if (para && last && last.target === id && last.byParagraph && last.effect === anim && clsOf(last) === cls && trigger === "click") continue;
    out.push({
      id: uid("a"),
      target: id,
      effect: anim,
      direction: anim === "fly" || anim === "wipe" ? (cls === "exit" ? (SUBTYPE_EXIT[sub] ?? "down") : (SUBTYPE_DIR[sub] ?? "up")) : undefined,
      trigger,
      duration,
      delay: Math.max(0, delay),
      byParagraph: para ? true : undefined,
      ...(cls === "entr" ? {} : { cls }),
    });
  }
  return { animations: out, skipped, approximated };
}
