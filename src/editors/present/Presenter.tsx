import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Deck, Slide } from "./model";
import SlideView from "./SlideView";
import { playTransition } from "./transitions";

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

  // Pasar sola a la siguiente (si la diapositiva lo pide), contando desde que terminó de entrar.
  useEffect(() => {
    const t = visible[pos]?.s.transition;
    if (!t?.advanceAfter || pos >= visible.length || blank) return;
    const timer = setTimeout(() => actions.current.go(1), t.advanceAfter + (t.kind === "none" ? 0 : t.duration));
    return () => clearTimeout(timer);
  }, [pos, blank]); // eslint-disable-line react-hooks/exhaustive-deps

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
    setPos((p) => {
      const n = p + delta;
      // Después de la última, una pantalla negra; otra vez avanzar sale de la presentación.
      if (n >= visible.length) {
        if (p === visible.length) {
          setTimeout(exit);
          return p;
        }
        return visible.length;
      }
      return Math.max(0, n);
    });
  }

  // Teclas como en PowerPoint y Keynote.
  const actions = useRef({ go, exit, setPos, visible });
  actions.current = { go, exit, setPos, visible };
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
        if (index >= 0) a.setPos(index);
        return;
      }
      typed.current = "";
      if (["ArrowRight", "ArrowDown", "PageDown", " ", "Enter", "n"].includes(k)) (e.preventDefault(), a.go(1));
      else if (["ArrowLeft", "ArrowUp", "PageUp", "Backspace", "p"].includes(k)) (e.preventDefault(), a.go(-1));
      else if (k === "Home") a.setPos(0);
      else if (k === "End") a.setPos(a.visible.length - 1);
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
        <div className="presenter-main">
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
      {finished ? (
        <div className="presenter-end">Fin de la presentación. Haz clic para salir.</div>
      ) : (
        <div className="presenter-stage">
          {leaving && (
            <div ref={exitRef} className="presenter-layer" key={`out-${leaving.id}`}>
              <SlideView slide={leaving} deck={deck} scale={fit(size.w, size.h)} />
            </div>
          )}
          <div ref={enterRef} key={current.s.id} className="presenter-layer presenter-slide">
            <SlideView slide={current.s} deck={deck} scale={fit(size.w, size.h)} />
          </div>
        </div>
      )}
      {blank && <div className={`presenter-blank ${blank}`} />}
      {bar}
    </div>
  );
}
