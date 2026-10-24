import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Deck, Slide } from "./model";
import SlideView from "./SlideView";
import { playTransition } from "./transitions";
import { animationSteps, hiddenCss, playStep } from "./animations";

type Props = {
  deck: Deck;
  /** Diapositiva con la que empieza (índice en toda la presentación). */
  start: number;
  onExit: (lastSlide: number) => void;
};

/** Pone la ventana en pantalla completa (la de la app y, si no se puede, la del navegador). */
async function setFullscreen(on: boolean) {
  try {
    await getCurrentWindow().setFullscreen(on);
    return;
  } catch {
    // Fuera de la app de escritorio (o sin permiso) se usa la del navegador.
  }
  try {
    if (on && !document.fullscreenElement) await document.documentElement.requestFullscreen();
    if (!on && document.fullscreenElement) await document.exitFullscreen();
  } catch {
    // Sin pantalla completa, la presentación igual ocupa toda la ventana.
  }
}

function clock(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const two = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${two(m)}:${two(s % 60)}` : `${two(m)}:${two(s % 60)}`;
}

/**
 * Modo presentación: las diapositivas a pantalla completa (sin las ocultas).
 * Con la vista del presentador se ven además la siguiente, las notas y el tiempo.
 */
export default function Presenter({ deck, start, onExit }: Props) {
  // Solo las diapositivas visibles, con su número en la presentación.
  const visible = deck.slides.map((s, i) => ({ s, i })).filter(({ s, i }) => !s.hidden || i === start);
  const [pos, setPos] = useState(() => Math.max(0, visible.findIndex((v) => v.i === start)));
  const [presenter, setPresenter] = useState(false);
  const [blank, setBlank] = useState<"black" | "white" | null>(null);
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [startedAt, setStartedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const [controls, setControls] = useState(true);
  const typed = useRef("");
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const exiting = useRef(false);

  const current = visible[Math.min(pos, visible.length - 1)];
  const next = visible[pos + 1];

  // Animaciones: cuántos clics de la diapositiva ya se vieron. Lo de los clics que faltan está escondido.
  const [step, setStep] = useState(0);
  const steps = useMemo(() => (current && pos < visible.length ? animationSteps(current.s) : []), [current, pos, visible.length]);
  /** El paso que se tiene que animar en cuanto se dibuje (con su espera extra, p. ej. la transición). */
  const play = useRef<{ pos: number; step: number; offset: number } | null>(null);
  const transitionTime = (n: number) => {
    const t = visible[n]?.s.transition;
    return t && t.kind !== "none" ? t.duration : 0;
  };
  /** Llega a la diapositiva `n`: sin nada revelado (o todo, si se regresa), y si empieza sola, se anima. */
  function enter(n: number, revealAll: boolean) {
    setPos(n);
    if (n >= visible.length) return setStep(0);
    const st = animationSteps(visible[n].s);
    if (revealAll) return setStep(st.length);
    if (st[0]?.auto) {
      play.current = { pos: n, step: 1, offset: transitionTime(n) };
      return setStep(1);
    }
    setStep(0);
  }
  useEffect(() => {
    if (pos < visible.length) enter(pos, false);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const p = play.current;
    if (!p || p.pos !== pos || p.step !== step) return;
    play.current = null;
    const root = document.querySelector<HTMLElement>(".presenter-scope");
    const st = steps[step - 1];
    if (!root || !st) return;
    const running = playStep(st, root, current.s, deck, p.offset);
    return () => running.forEach((a) => a.finish());
  }, [pos, step]); // eslint-disable-line react-hooks/exhaustive-deps

  // Transición: al avanzar, la diapositiva anterior se queda debajo mientras entra la nueva.
  const [leaving, setLeaving] = useState<Slide | null>(null);
  const lastPos = useRef(pos);
  const enterRef = useRef<HTMLDivElement>(null);
  const exitRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const before = lastPos.current;
    lastPos.current = pos;
    const t = visible[pos]?.s.transition;
    if (pos === before + 1 && pos < visible.length && t && t.kind !== "none" && !presenter) setLeaving(visible[before].s);
    else setLeaving(null);
  }, [pos]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const t = visible[pos]?.s.transition;
    if (!enterRef.current || !t || t.kind === "none" || pos !== lastPos.current || (!leaving && pos !== 0)) return;
    return playTransition(t, enterRef.current, exitRef.current, () => setLeaving(null));
  }, [leaving]); // eslint-disable-line react-hooks/exhaustive-deps

  // Pasar sola a la siguiente (si la diapositiva lo pide), cuando ya entró todo lo de sus clics.
  useEffect(() => {
    const t = visible[pos]?.s.transition;
    if (!t?.advanceAfter || pos >= visible.length || blank || step < steps.length) return;
    const lastEnd = steps.length ? Math.max(0, ...steps[steps.length - 1].items.map((i) => i.end)) : 0;
    const timer = setTimeout(() => actions.current.go(1), t.advanceAfter + (steps.length ? lastEnd : transitionTime(pos)));
    return () => clearTimeout(timer);
  }, [pos, step, blank]); // eslint-disable-line react-hooks/exhaustive-deps

  function exit() {
    if (exiting.current) return;
    exiting.current = true;
    setFullscreen(false);
    onExit(current?.i ?? start);
  }

  useEffect(() => {
    setFullscreen(true);
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      window.removeEventListener("resize", onResize);
      clearInterval(tick);
    };
  }, []);

  function go(delta: number) {
    setBlank(null);
    // Primero los clics de la diapositiva (lo que falta por entrar), luego la siguiente.
    if (delta > 0 && pos < visible.length && step < steps.length) {
      play.current = { pos, step: step + 1, offset: 0 };
      setStep(step + 1);
      return;
    }
    if (delta < 0 && pos < visible.length && step > (steps[0]?.auto ? 1 : 0)) {
      setStep(step - 1);
      return;
    }
    const n = pos + delta;
    // Después de la última, una pantalla negra; otra vez avanzar sale de la presentación.
    if (n >= visible.length) {
      if (pos === visible.length) setTimeout(exit);
      else enter(visible.length, false);
      return;
    }
    if (n < 0) return;
    enter(n, delta < 0);
  }

  function jump(n: number) {
    setBlank(null);
    enter(Math.max(0, Math.min(visible.length - 1, n)), false);
  }

  // Teclas como en PowerPoint y Keynote.
  const actions = useRef({ go, exit, jump, visible });
  actions.current = { go, exit, jump, visible };
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const a = actions.current;
      const k = e.key;
      if (/^\d$/.test(k)) {
        typed.current += k;
        return;
      }
      if (k === "Enter" && typed.current) {
        // Escribir un número y ↩ salta a esa diapositiva.
        const n = Number(typed.current) - 1;
        typed.current = "";
        const index = a.visible.findIndex((v) => v.i === n);
        if (index >= 0) a.jump(index);
        return;
      }
      typed.current = "";
      if (["ArrowRight", "ArrowDown", "PageDown", " ", "Enter", "n"].includes(k)) (e.preventDefault(), a.go(1));
      else if (["ArrowLeft", "ArrowUp", "PageUp", "Backspace", "p"].includes(k)) (e.preventDefault(), a.go(-1));
      else if (k === "Home") a.jump(0);
      else if (k === "End") a.jump(a.visible.length - 1);
      else if (k === "Escape") (e.preventDefault(), a.exit());
      else if (k.toLowerCase() === "b" || k === ".") setBlank((b) => (b === "black" ? null : "black"));
      else if (k.toLowerCase() === "w" || k === ",") setBlank((b) => (b === "white" ? null : "white"));
      else if (k.toLowerCase() === "v") setPresenter((v) => !v);
      else return;
      e.stopPropagation();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  function showControls() {
    setControls(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setControls(false), 2500);
  }

  const finished = pos >= visible.length;
  const fit = (w: number, h: number) => Math.min(w / deck.width, h / deck.height);

  const bar = (
    <div className={`presenter-bar${controls || presenter ? " show" : ""}`} onClick={(e) => e.stopPropagation()}>
      <button type="button" onClick={() => go(-1)} aria-label="Anterior">
        ‹
      </button>
      <span>
        {Math.min(pos + 1, visible.length)} / {visible.length}
      </span>
      <button type="button" onClick={() => go(1)} aria-label="Siguiente">
        ›
      </button>
      <button type="button" onClick={() => setPresenter((v) => !v)} title="Vista del presentador (V)">
        {presenter ? "Vista normal" : "Vista del presentador"}
      </button>
      <button type="button" onClick={exit} title="Salir (Esc)">
        Salir
      </button>
    </div>
  );

  if (presenter) {
    const mainW = size.w * 0.62 - 48;
    const mainH = size.h - 220;
    return (
      <div className="presenter presenter-view" onMouseMove={showControls}>
        <style>{hiddenCss(steps, step, ".presenter-scope")}</style>
        <div className="presenter-main presenter-scope">
          {finished ? (
            <div className="presenter-end">Fin de la presentación</div>
          ) : (
            <SlideView slide={current.s} deck={deck} scale={fit(mainW, mainH)} />
          )}
        </div>
        <aside className="presenter-side">
          <div className="presenter-times">
            <span title="Tiempo de la presentación">{clock(now - startedAt)}</span>
            <button type="button" onClick={() => (setStartedAt(Date.now()), setNow(Date.now()))}>
              Reiniciar
            </button>
            <span title="Hora">{new Date(now).toLocaleTimeString("es-MX", { hour: "numeric", minute: "2-digit" })}</span>
          </div>
          <p className="presenter-label">Siguiente</p>
          {next ? <SlideView slide={next.s} deck={deck} scale={fit(size.w * 0.38 - 48, size.h * 0.3)} /> : <div className="presenter-next-end">Fin</div>}
          <p className="presenter-label">Notas</p>
          <div className="presenter-notes">{finished ? "" : current.s.notes || <i>Esta diapositiva no tiene notas.</i>}</div>
        </aside>
        {bar}
      </div>
    );
  }

  return (
    <div className={`presenter${controls ? "" : " hide-cursor"}`} onMouseMove={showControls} onClick={() => go(1)} onContextMenu={(e) => (e.preventDefault(), go(-1))}>
      <style>{hiddenCss(steps, step, ".presenter-scope")}</style>
      {finished ? (
        <div className="presenter-end">Fin de la presentación. Haz clic para salir.</div>
      ) : (
        <div className="presenter-stage">
          {leaving && (
            <div ref={exitRef} className="presenter-layer" key={`out-${leaving.id}`}>
              <SlideView slide={leaving} deck={deck} scale={fit(size.w, size.h)} />
            </div>
          )}
          <div ref={enterRef} key={current.s.id} className="presenter-layer presenter-slide presenter-scope">
            <SlideView slide={current.s} deck={deck} scale={fit(size.w, size.h)} />
          </div>
        </div>
      )}
      {blank && <div className={`presenter-blank ${blank}`} />}
      {bar}
    </div>
  );
}
