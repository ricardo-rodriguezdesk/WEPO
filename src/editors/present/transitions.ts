// Transiciones entre diapositivas de WEPO Present: cómo se ven al presentar
// (con la API de animaciones del navegador) y cómo van en el .pptx
// (<p:transition>, con la duración exacta de PowerPoint 2010 y su respaldo).

import type { Direction, Transition, TransitionKind } from "./model";

export const TRANSITIONS: { id: TransitionKind; name: string; directions: boolean }[] = [
  { id: "none", name: "Ninguna", directions: false },
  { id: "fade", name: "Desvanecer", directions: false },
  { id: "push", name: "Empujar", directions: true },
  { id: "wipe", name: "Barrido", directions: true },
  { id: "cover", name: "Cubrir", directions: true },
  { id: "zoom", name: "Acercar", directions: false },
  { id: "split", name: "Dividir", directions: false },
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

/** Cuadros clave de la diapositiva que entra y de la que sale. */
export function transitionFrames(t: Transition): { enter: Keyframe[]; exit: Keyframe[] | null } {
  switch (t.kind) {
    case "none":
      return { enter: [], exit: null };
    case "fade":
      return { enter: [{ opacity: 0 }, { opacity: 1 }], exit: [{ opacity: 1 }, { opacity: 0 }] };
    case "push":
      return { enter: [{ transform: offset(t.direction) }, { transform: "none" }], exit: [{ transform: "none" }, { transform: exitOffset(t.direction) }] };
    case "cover":
      return { enter: [{ transform: offset(t.direction) }, { transform: "none" }], exit: null };
    case "wipe":
      return { enter: [{ clipPath: wipeStart(t.direction) }, { clipPath: "inset(0 0 0 0)" }], exit: null };
    case "zoom":
      return { enter: [{ transform: "scale(0.3)", opacity: 0 }, { transform: "none", opacity: 1 }], exit: [{ opacity: 1 }, { opacity: 0 }] };
    case "split":
      return { enter: [{ clipPath: "inset(0 50% 0 50%)" }, { clipPath: "inset(0 0 0 0)" }], exit: null };
  }
}

/** Corre la transición sobre los dos elementos; avisa cuando termina. */
export function playTransition(t: Transition, enter: HTMLElement, exit: HTMLElement | null, done: () => void): () => void {
  const frames = transitionFrames(t);
  if (!frames.enter.length || t.duration <= 0) {
    done();
    return () => {};
  }
  const timing: KeyframeAnimationOptions = { duration: t.duration, easing: t.kind === "fade" ? "linear" : "cubic-bezier(.2,.7,.2,1)", fill: "both" };
  const animations = [enter.animate(frames.enter, timing)];
  if (exit && frames.exit) animations.push(exit.animate(frames.exit, timing));
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    done();
  };
  animations[0].finished.then(finish, finish);
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

/** <p:transition> (con la duración exacta para PowerPoint 2010 en adelante). Va después de <p:clrMapOvr>. */
export function transitionXml(t: Transition | null | undefined): string {
  if (!t) return "";
  if (t.kind === "none") return t.advanceAfter ? `<p:transition advTm="${Math.round(t.advanceAfter)}"/>` : "";
  const dir = t.direction ? ` dir="${DIR_TO_PPTX[t.direction]}"` : ' dir="l"';
  const inner =
    t.kind === "fade"
      ? "<p:fade/>"
      : t.kind === "push"
        ? `<p:push${dir}/>`
        : t.kind === "wipe"
          ? `<p:wipe${dir}/>`
          : t.kind === "cover"
            ? `<p:cover${dir}/>`
            : t.kind === "zoom"
              ? "<p:zoom/>"
              : '<p:split orient="vert" dir="out"/>';
  const adv = t.advanceAfter ? ` advTm="${Math.round(t.advanceAfter)}"` : "";
  const spd = speedOf(t.duration);
  return `<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" Requires="p14"><p:transition spd="${spd}" p14:dur="${Math.round(t.duration)}"${adv}>${inner}</p:transition></mc:Choice><mc:Fallback><p:transition spd="${spd}"${adv}>${inner}</p:transition></mc:Fallback></mc:AlternateContent>`;
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
  if (name === "cut") return { transition: advanceAfter ? { kind: "none", ...base } : null, other: false };
  return { transition: { kind: "fade", ...base }, other: true };
}
