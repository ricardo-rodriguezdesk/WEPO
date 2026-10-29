// Transiciones entre diapositivas de WEPO Present: cómo se ven al presentar
// (con la API de animaciones del navegador) y cómo van en el .pptx
// (<p:transition>, con la duración exacta de PowerPoint 2010 y su respaldo).

import type { Direction, Transition, TransitionKind } from "./model";

export const TRANSITIONS: { id: TransitionKind; name: string; directions: boolean; fancy?: boolean }[] = [
  { id: "none", name: "Ninguna", directions: false },
  { id: "fade", name: "Desvanecer", directions: false },
  { id: "push", name: "Empujar", directions: true },
  { id: "wipe", name: "Barrido", directions: true },
  { id: "cover", name: "Cubrir", directions: true },
  { id: "zoom", name: "Acercar", directions: false },
  { id: "split", name: "Dividir", directions: false },
  { id: "cube", name: "Cubo", directions: true, fancy: true },
  { id: "flip", name: "Voltear", directions: true, fancy: true },
  { id: "gallery", name: "Galería", directions: true, fancy: true },
  { id: "doors", name: "Puertas", directions: false, fancy: true },
  { id: "curtains", name: "Cortinas", directions: false, fancy: true },
  { id: "fallOver", name: "Caer", directions: false, fancy: true },
  { id: "vortex", name: "Remolino", directions: false, fancy: true },
  { id: "ripple", name: "Onda", directions: false, fancy: true },
  { id: "wheel", name: "Reloj", directions: false, fancy: true },
  { id: "blinds", name: "Persianas", directions: false, fancy: true },
  { id: "newsflash", name: "Noticia", directions: false, fancy: true },
  { id: "flash", name: "Destello", directions: false, fancy: true },
  { id: "ferris", name: "Rueda", directions: true, fancy: true },
];

/** Hacia dónde se mueve la diapositiva nueva («desde la derecha» = se mueve a la izquierda). */
export const DIRECTIONS: { id: Direction; name: string }[] = [
  { id: "left", name: "Desde la derecha" },
  { id: "right", name: "Desde la izquierda" },
  { id: "up", name: "Desde abajo" },
  { id: "down", name: "Desde arriba" },
];

export const DURATIONS = [300, 500, 700, 1000, 1500, 2000];

export function transitionName(t: Transition | null | undefined): string {
  return TRANSITIONS.find((x) => x.id === (t?.kind ?? "none"))?.name ?? "Ninguna";
}

/** Desplazamiento de entrada según la dirección (de dónde viene la diapositiva nueva). */
function offset(dir: Direction | undefined, amount = "100%"): string {
  switch (dir) {
    case "right":
      return `translateX(-${amount})`;
    case "up":
      return `translateY(${amount})`;
    case "down":
      return `translateY(-${amount})`;
    default:
      return `translateX(${amount})`;
  }
}

function exitOffset(dir: Direction | undefined): string {
  switch (dir) {
    case "right":
      return "translateX(100%)";
    case "up":
      return "translateY(-100%)";
    case "down":
      return "translateY(100%)";
    default:
      return "translateX(-100%)";
  }
}

/** Recorte inicial del barrido: la diapositiva nueva se descubre desde ese lado. */
function wipeStart(dir: Direction | undefined): string {
  switch (dir) {
    case "right":
      return "inset(0 100% 0 0)";
    case "up":
      return "inset(100% 0 0 0)";
    case "down":
      return "inset(0 0 100% 0)";
    default:
      return "inset(0 0 0 100%)";
  }
}

/** Cuadros clave sencillos (sin elementos extra): la diapositiva que entra y la que sale. */
type Frames = { enter: Keyframe[]; exit: Keyframe[] | null; perspective?: boolean; exitOnTop?: boolean; easing?: string };

const horizontal = (d: Direction | undefined) => d !== "up" && d !== "down";
/** +1 si la nueva viene de la derecha (o de abajo), −1 si viene del otro lado. */
const sign = (d: Direction | undefined) => (d === "right" || d === "down" ? -1 : 1);

/** Un punto del borde de la diapositiva (en %) a cierto ángulo, contando desde las 12 en el sentido del reloj. */
function edgePoint(deg: number): string {
  const a = ((deg - 90) * Math.PI) / 180;
  const x = Math.cos(a);
  const y = Math.sin(a);
  const k = 1 / Math.max(Math.abs(x), Math.abs(y));
  return `${50 + x * k * 71}% ${50 + y * k * 71}%`;
}

/** Reloj: la nueva aparece como la manecilla que da la vuelta (mismos puntos en cada cuadro, para que se pueda animar). */
function wheelFrames(): Keyframe[] {
  const steps = 24;
  const points = 26;
  return Array.from({ length: steps + 1 }, (_, i) => {
    const sweep = (360 * i) / steps;
    const pts = ["50% 50%"];
    for (let k = 0; k < points - 1; k++) pts.push(edgePoint((sweep * k) / (points - 2)));
    return { clipPath: `polygon(${pts.join(", ")})`, offset: i / steps };
  });
}

/** Persianas: ocho tiras que se abren a la vez (un solo polígono en zigzag). */
function blindsFrames(): Keyframe[] {
  const strips = 8;
  const at = (open: number) => {
    const pts: string[] = [];
    for (let i = 0; i < strips; i++) {
      const top = (100 * i) / strips;
      const h = (100 / strips) * open;
      pts.push(`0% ${top}%`, `100% ${top}%`, `100% ${top + h}%`, `0% ${top + h}%`);
    }
    return `polygon(${pts.join(", ")})`;
  };
  return [{ clipPath: at(0) }, { clipPath: at(1) }];
}

function simpleFrames(t: Transition): Frames {
  const d = t.direction;
  const s = sign(d);
  const h = horizontal(d);
  switch (t.kind) {
    case "none":
      return { enter: [], exit: null };
    case "fade":
      return { enter: [{ opacity: 0 }, { opacity: 1 }], exit: [{ opacity: 1 }, { opacity: 0 }], easing: "linear" };
    case "push":
      return { enter: [{ transform: offset(d) }, { transform: "none" }], exit: [{ transform: "none" }, { transform: exitOffset(d) }] };
    case "cover":
      return { enter: [{ transform: offset(d) }, { transform: "none" }], exit: null };
    case "wipe":
      return { enter: [{ clipPath: wipeStart(d) }, { clipPath: "inset(0 0 0 0)" }], exit: null };
    case "zoom":
      return { enter: [{ transform: "scale(0.3)", opacity: 0 }, { transform: "none", opacity: 1 }], exit: [{ opacity: 1 }, { opacity: 0 }] };
    case "split":
      return { enter: [{ clipPath: "inset(0 50% 0 50%)" }, { clipPath: "inset(0 0 0 0)" }], exit: null };
    case "cube": {
      // Un cubo que gira: la orilla que comparten las dos caras va de un lado al otro.
      const axis = h ? "Y" : "X";
      const move = h ? "X" : "Y";
      const rot = h ? 90 * s : -90 * s;
      const enterOrigin = h ? (s > 0 ? "0% 50%" : "100% 50%") : s > 0 ? "50% 0%" : "50% 100%";
      const exitOrigin = h ? (s > 0 ? "100% 50%" : "0% 50%") : s > 0 ? "50% 100%" : "50% 0%";
      return {
        perspective: true,
        easing: "cubic-bezier(.45,.05,.35,1)",
        enter: [
          { transformOrigin: enterOrigin, transform: `translate${move}(${100 * s}%) rotate${axis}(${rot}deg)`, filter: "brightness(.55)" },
          { transformOrigin: enterOrigin, transform: "none", filter: "brightness(1)" },
        ],
        exit: [
          { transformOrigin: exitOrigin, transform: "none", filter: "brightness(1)" },
          { transformOrigin: exitOrigin, transform: `translate${move}(${-100 * s}%) rotate${axis}(${-rot}deg)`, filter: "brightness(.55)" },
        ],
      };
    }
    case "flip": {
      const axis = h ? "Y" : "X";
      const r = (h ? 1 : -1) * 90 * s;
      return {
        perspective: true,
        easing: "ease-in-out",
        enter: [
          { transform: `rotate${axis}(${r}deg) scale(.9)`, opacity: 0, offset: 0 },
          { transform: `rotate${axis}(${r}deg) scale(.9)`, opacity: 0, offset: 0.5 },
          { transform: `rotate${axis}(${r}deg) scale(.9)`, opacity: 1, offset: 0.5001 },
          { transform: "none", opacity: 1 },
        ],
        exit: [
          { transform: "none", opacity: 1 },
          { transform: `rotate${axis}(${-r}deg) scale(.9)`, opacity: 1, offset: 0.5 },
          { transform: `rotate${axis}(${-r}deg) scale(.9)`, opacity: 0, offset: 0.5001 },
          { transform: `rotate${axis}(${-r}deg) scale(.9)`, opacity: 0 },
        ],
      };
    }
    case "gallery": {
      const move = h ? "X" : "Y";
      const axis = h ? "Y" : "X";
      return {
        perspective: true,
        easing: "cubic-bezier(.5,0,.3,1)",
        enter: [
          { transform: `translate${move}(${110 * s}%) rotate${axis}(${(h ? -35 : 35) * s}deg) scale(.75)` },
          { transform: `translate${move}(${12 * s}%) rotate${axis}(${(h ? -12 : 12) * s}deg) scale(.8)`, offset: 0.6 },
          { transform: "none" },
        ],
        exit: [
          { transform: "none" },
          { transform: `translate${move}(${-60 * s}%) rotate${axis}(${(h ? 25 : -25) * s}deg) scale(.75)`, offset: 0.5 },
          { transform: `translate${move}(${-120 * s}%) rotate${axis}(${(h ? 35 : -35) * s}deg) scale(.7)` },
        ],
      };
    }
    case "fallOver":
      return {
        perspective: true,
        exitOnTop: true,
        easing: "cubic-bezier(.55,0,.9,.4)",
        enter: [{ filter: "brightness(.6)" }, { filter: "brightness(1)" }],
        exit: [
          { transformOrigin: "50% 100%", transform: "none", opacity: 1 },
          { transformOrigin: "50% 100%", transform: "rotateX(-88deg)", opacity: 0.85 },
        ],
      };
    case "vortex":
      return {
        easing: "cubic-bezier(.2,.8,.2,1)",
        enter: [
          { transform: "rotate(-300deg) scale(0)", opacity: 0, filter: "blur(14px)" },
          { transform: "rotate(-40deg) scale(.9)", opacity: 1, filter: "blur(3px)", offset: 0.7 },
          { transform: "none", opacity: 1, filter: "blur(0)" },
        ],
        exit: [
          { transform: "none", opacity: 1, filter: "blur(0)" },
          { transform: "rotate(160deg) scale(1.8)", opacity: 0, filter: "blur(18px)" },
        ],
      };
    case "ripple":
      return {
        easing: "cubic-bezier(.3,.6,.2,1)",
        enter: [{ clipPath: "circle(0% at 50% 50%)" }, { clipPath: "circle(75% at 50% 50%)" }],
        exit: [{ transform: "none", filter: "blur(0)" }, { transform: "scale(1.12)", filter: "blur(4px)" }],
      };
    case "wheel":
      return { enter: wheelFrames(), exit: null, easing: "linear" };
    case "blinds":
      return { enter: blindsFrames(), exit: null, easing: "ease-in-out" };
    case "newsflash":
      return {
        easing: "cubic-bezier(.25,.8,.3,1)",
        enter: [{ transform: "rotate(720deg) scale(0)" }, { transform: "none" }],
        exit: [{ opacity: 1 }, { opacity: 0 }],
      };
    case "ferris": {
      const o = s > 0 ? "0% 0%" : "100% 0%";
      return {
        easing: "cubic-bezier(.3,1.35,.5,1)",
        enter: [
          { transformOrigin: o, transform: `rotate(${-90 * s}deg)`, opacity: 0.6 },
          { transformOrigin: o, transform: "none", opacity: 1 },
        ],
        exit: [
          { transformOrigin: s > 0 ? "100% 0%" : "0% 0%", transform: "none", opacity: 1 },
          { transformOrigin: s > 0 ? "100% 0%" : "0% 0%", transform: `rotate(${90 * s}deg)`, opacity: 0.4 },
        ],
      };
    }
    // Las que necesitan pedazos de la diapositiva anterior (puertas, cortinas) o una capa (destello): ver playTransition.
    case "doors":
    case "curtains":
      return { enter: [{ transform: "scale(.86)", filter: "brightness(.5)" }, { transform: "none", filter: "brightness(1)" }], exit: null, perspective: true };
    case "flash":
      return {
        easing: "linear",
        enter: [{ opacity: 0 }, { opacity: 0, offset: 0.45 }, { opacity: 1, offset: 0.55 }, { opacity: 1 }],
        exit: [{ opacity: 1 }, { opacity: 1, offset: 0.45 }, { opacity: 0, offset: 0.55 }, { opacity: 0 }],
      };
  }
}

/** Una copia de la diapositiva anterior, encima de todo (para partirla en dos). */
function cloneOver(exit: HTMLElement): HTMLElement {
  const copy = exit.cloneNode(true) as HTMLElement;
  copy.removeAttribute("id");
  copy.style.position = "absolute";
  copy.style.inset = "0";
  copy.style.zIndex = "3";
  copy.style.pointerEvents = "none";
  copy.setAttribute("aria-hidden", "true");
  exit.parentElement?.appendChild(copy);
  return copy;
}

/** Corre la transición sobre los dos elementos; avisa cuando termina. */
export function playTransition(t: Transition, enter: HTMLElement, exit: HTMLElement | null, done: () => void): () => void {
  const frames = simpleFrames(t);
  if (!frames.enter.length || t.duration <= 0) {
    done();
    return () => {};
  }
  const timing: KeyframeAnimationOptions = { duration: t.duration, easing: frames.easing ?? "cubic-bezier(.2,.7,.2,1)", fill: "both" };
  const parent = enter.parentElement;
  const restore: (() => void)[] = [];
  if (frames.perspective && parent) {
    const before = parent.style.perspective;
    parent.style.perspective = "1800px";
    restore.push(() => (parent.style.perspective = before));
  }
  const animations: Animation[] = [enter.animate(frames.enter, timing)];
  if (exit && frames.exit) animations.push(exit.animate(frames.exit, timing));
  if (exit && frames.exitOnTop) {
    const z = exit.style.zIndex;
    exit.style.zIndex = "2";
    restore.push(() => (exit.style.zIndex = z));
  }
  const extras: HTMLElement[] = [];
  if (exit && (t.kind === "doors" || t.kind === "curtains")) {
    // La diapositiva anterior se parte en dos mitades que se abren.
    const left = cloneOver(exit);
    const right = cloneOver(exit);
    extras.push(left, right);
    left.style.clipPath = "inset(0 50% 0 0)";
    right.style.clipPath = "inset(0 0 0 50%)";
    exit.style.visibility = "hidden";
    restore.push(() => (exit.style.visibility = ""));
    const open: KeyframeAnimationOptions = { ...timing, easing: "cubic-bezier(.5,0,.4,1)" };
    if (t.kind === "doors") {
      const door = (o: string, deg: number): Keyframe[] => [
        { transformOrigin: o, transform: "none", filter: "brightness(1)", opacity: 1 },
        { transformOrigin: o, transform: `rotateY(${deg * 0.8}deg)`, filter: "brightness(.7)", opacity: 1, offset: 0.8 },
        { transformOrigin: o, transform: `rotateY(${deg}deg)`, filter: "brightness(.6)", opacity: 0 },
      ];
      animations.push(left.animate(door("0% 50%", -100), open), right.animate(door("100% 50%", 100), open));
    } else {
      // Cortinas: cada mitad se recoge hacia su lado, ondulando.
      const wave = (dir: number): Keyframe[] => [
        { transformOrigin: dir < 0 ? "0% 0%" : "100% 0%", transform: "none" },
        { transformOrigin: dir < 0 ? "0% 0%" : "100% 0%", transform: `translateX(${dir * 20}%) scaleX(.7) skewY(${dir * 3}deg)`, offset: 0.5 },
        { transformOrigin: dir < 0 ? "0% 0%" : "100% 0%", transform: `translateX(${dir * 45}%) scaleX(.3) skewY(${dir * 5}deg)`, opacity: 1, offset: 0.85 },
        { transformOrigin: dir < 0 ? "0% 0%" : "100% 0%", transform: `translateX(${dir * 55}%) scaleX(.2) skewY(${dir * 6}deg)`, opacity: 0 },
      ];
      animations.push(left.animate(wave(-1), open), right.animate(wave(1), open));
    }
  }
  if (t.kind === "flash" && parent) {
    const light = document.createElement("div");
    light.setAttribute("aria-hidden", "true");
    Object.assign(light.style, { position: "absolute", inset: "0", zIndex: "4", background: "#fff", pointerEvents: "none" });
    parent.appendChild(light);
    extras.push(light);
    animations.push(light.animate([{ opacity: 0 }, { opacity: 1, offset: 0.5 }, { opacity: 0 }], { ...timing, easing: "ease-in-out" }));
  }
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    for (const el of extras) el.remove();
    for (const r of restore) r();
    done();
  };
  Promise.all(animations.map((a) => a.finished)).then(finish, finish);
  return () => {
    for (const a of animations) a.cancel();
    finish();
  };
}

// ───────────── .pptx ─────────────

const DIR_TO_PPTX: Record<Direction, string> = { left: "l", right: "r", up: "u", down: "d" };
const PPTX_TO_DIR: Record<string, Direction> = { l: "left", r: "right", u: "up", d: "down" };

function speedOf(ms: number): "fast" | "med" | "slow" {
  return ms <= 500 ? "fast" : ms <= 750 ? "med" : "slow";
}

const P14 = "http://schemas.microsoft.com/office/powerpoint/2010/main";
const P15 = "http://schemas.microsoft.com/office/powerpoint/2012/main";

/** Cómo va cada transición en el .pptx: la de PowerPoint 2010/2013 y la de respaldo para lectores viejos. */
function pptxEffect(t: Transition): { inner: string; fallback: string; needs: "" | "p14" | "p15" } {
  const dir = ` dir="${DIR_TO_PPTX[t.direction ?? "left"]}"`;
  const lr = ` dir="${t.direction === "right" ? "r" : "l"}"`;
  switch (t.kind) {
    case "fade":
      return { inner: "<p:fade/>", fallback: "<p:fade/>", needs: "" };
    case "push":
      return { inner: `<p:push${dir}/>`, fallback: `<p:push${dir}/>`, needs: "" };
    case "wipe":
      return { inner: `<p:wipe${dir}/>`, fallback: `<p:wipe${dir}/>`, needs: "" };
    case "cover":
      return { inner: `<p:cover${dir}/>`, fallback: `<p:cover${dir}/>`, needs: "" };
    case "zoom":
      return { inner: "<p:zoom/>", fallback: "<p:zoom/>", needs: "" };
    case "split":
      return { inner: '<p:split orient="vert" dir="out"/>', fallback: '<p:split orient="vert" dir="out"/>', needs: "" };
    case "wheel":
      return { inner: '<p:wheel spokes="1"/>', fallback: '<p:wheel spokes="1"/>', needs: "" };
    case "blinds":
      return { inner: '<p:blinds dir="horz"/>', fallback: '<p:blinds dir="horz"/>', needs: "" };
    case "newsflash":
      return { inner: "<p:newsflash/>", fallback: "<p:newsflash/>", needs: "" };
    case "ripple":
      return { inner: '<p14:ripple dir="center"/>', fallback: "<p:circle/>", needs: "p14" };
    case "cube":
      return { inner: `<p14:prism${dir}/>`, fallback: `<p:push${dir}/>`, needs: "p14" };
    case "flip":
      return { inner: `<p14:flip${lr}/>`, fallback: "<p:fade/>", needs: "p14" };
    case "gallery":
      return { inner: `<p14:gallery${lr}/>`, fallback: `<p:push${lr}/>`, needs: "p14" };
    case "doors":
      return { inner: '<p14:doors dir="vert"/>', fallback: '<p:split orient="vert" dir="out"/>', needs: "p14" };
    case "vortex":
      return { inner: `<p14:vortex${dir}/>`, fallback: "<p:fade/>", needs: "p14" };
    case "flash":
      return { inner: "<p14:flash/>", fallback: "<p:fade/>", needs: "p14" };
    case "ferris":
      return { inner: `<p14:ferris${lr}/>`, fallback: "<p:fade/>", needs: "p14" };
    case "curtains":
      return { inner: '<p15:prstTrans prst="curtains"/>', fallback: '<p:split orient="vert" dir="out"/>', needs: "p15" };
    case "fallOver":
      return { inner: '<p15:prstTrans prst="fallOver"/>', fallback: "<p:fade/>", needs: "p15" };
    default:
      return { inner: "<p:fade/>", fallback: "<p:fade/>", needs: "" };
  }
}

/** <p:transition> (con la duración exacta para PowerPoint 2010 en adelante). Va después de <p:clrMapOvr>. */
export function transitionXml(t: Transition | null | undefined): string {
  if (!t) return "";
  if (t.kind === "none") return t.advanceAfter ? `<p:transition advTm="${Math.round(t.advanceAfter)}"/>` : "";
  const { inner, fallback, needs } = pptxEffect(t);
  const adv = t.advanceAfter ? ` advTm="${Math.round(t.advanceAfter)}"` : "";
  const spd = speedOf(t.duration);
  const ns = needs === "p15" ? `xmlns:p14="${P14}" xmlns:p15="${P15}" Requires="p15"` : `xmlns:p14="${P14}" Requires="p14"`;
  return `<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice ${ns}><p:transition spd="${spd}" p14:dur="${Math.round(t.duration)}"${adv}>${inner}</p:transition></mc:Choice><mc:Fallback><p:transition spd="${spd}"${adv}>${fallback}</p:transition></mc:Fallback></mc:AlternateContent>`;
}

/**
 * Lee la transición de una diapositiva (directa o dentro de mc:AlternateContent).
 * `other` es true si era una que WEPO no tiene (se cambia por Desvanecer).
 */
export function readTransition(slideRoot: Element): { transition: Transition | null; other: boolean } {
  const kids = (el: Element) => Array.from(el.children);
  let tr = kids(slideRoot).find((c) => c.localName === "transition");
  if (!tr) {
    for (const alt of kids(slideRoot).filter((c) => c.localName === "AlternateContent")) {
      const choice = kids(alt).find((c) => c.localName === "Choice");
      const fallback = kids(alt).find((c) => c.localName === "Fallback");
      tr = (choice && kids(choice).find((c) => c.localName === "transition")) ?? (fallback && kids(fallback).find((c) => c.localName === "transition"));
      if (tr) break;
    }
  }
  if (!tr) return { transition: null, other: false };
  const dur = Number(tr.getAttribute("p14:dur") ?? tr.getAttributeNS("http://schemas.microsoft.com/office/powerpoint/2010/main", "dur") ?? NaN);
  const spd = tr.getAttribute("spd");
  const duration = Number.isFinite(dur) && dur > 0 ? dur : spd === "fast" ? 500 : spd === "slow" ? 1000 : 750;
  const advTm = Number(tr.getAttribute("advTm") ?? NaN);
  const advanceAfter = Number.isFinite(advTm) ? advTm : null;
  const effect = kids(tr).find((c) => c.localName !== "sndAc" && c.localName !== "extLst");
  const base = { duration, advanceAfter };
  if (!effect) return { transition: advanceAfter ? { kind: "none", ...base } : null, other: false };
  const name = effect.localName;
  const dir = PPTX_TO_DIR[effect.getAttribute("dir") ?? "l"] ?? "left";
  if (name === "fade") return { transition: { kind: "fade", ...base }, other: false };
  if (name === "push") return { transition: { kind: "push", direction: dir, ...base }, other: false };
  if (name === "wipe") return { transition: { kind: "wipe", direction: dir, ...base }, other: false };
  if (name === "cover" || name === "pull") return { transition: { kind: "cover", direction: dir, ...base }, other: name === "pull" };
  if (name === "zoom") return { transition: { kind: "zoom", ...base }, other: false };
  if (name === "split") return { transition: { kind: "split", ...base }, other: false };
  // Las vistosas de PowerPoint 2010 (p14) y 2013 (p15), y las de siempre que WEPO también tiene.
  const lr: Direction = effect.getAttribute("dir") === "r" ? "right" : "left";
  const fancy: Record<string, Transition> = {
    prism: { kind: "cube", direction: dir, ...base },
    flip: { kind: "flip", direction: lr, ...base },
    gallery: { kind: "gallery", direction: lr, ...base },
    doors: { kind: "doors", ...base },
    vortex: { kind: "vortex", ...base },
    ripple: { kind: "ripple", ...base },
    circle: { kind: "ripple", ...base },
    flash: { kind: "flash", ...base },
    ferris: { kind: "ferris", direction: lr, ...base },
    wheel: { kind: "wheel", ...base },
    wheelReverse: { kind: "wheel", ...base },
    blinds: { kind: "blinds", ...base },
    newsflash: { kind: "newsflash", ...base },
  };
  if (fancy[name]) return { transition: fancy[name], other: false };
  if (name === "prstTrans") {
    const prst = effect.getAttribute("prst");
    if (prst === "curtains") return { transition: { kind: "curtains", ...base }, other: false };
    if (prst === "fallOver") return { transition: { kind: "fallOver", ...base }, other: false };
  }
  if (name === "cut") return { transition: advanceAfter ? { kind: "none", ...base } : null, other: false };
  return { transition: { kind: "fade", ...base }, other: true };
}
