import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TextLayer } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist/legacy/build/pdf.mjs";
import EditorToolbar from "../../components/EditorToolbar";
import ZoomControl from "../sheets/ZoomControl";
import { clampZoom, stepZoom } from "../sheets/layout";
import { Separator } from "../sheets/FormatBar";
import { loadPdf } from "../../lib/pdf";
import { onCommand, runCommand } from "../../lib/commands";
import { hasModifier, keys } from "../../lib/platform";
import { loadZoom, saveZoom } from "../../lib/zoom";
import "../sheets/FormatBar.css";
import "./PdfViewer.css";

type Props = {
  data: Uint8Array;
  path: string | null;
  fileName: string;
  onHome: () => void;
  onOpen: () => void;
};

/** Tamaño de cada página en puntos (1/72 de pulgada), ya girada. */
type PageSize = { width: number; height: number };

/** 100 % es el tamaño real: un punto del PDF mide 96/72 píxeles de pantalla. */
const CSS_PER_PT = 96 / 72;
const PAGE_GAP = 16;

/** Herramientas de edición que llegarán más adelante (se ven, pero todavía no hacen nada). */
const FUTURE_TOOLS: { id: string; label: string; icon: string[] }[] = [
  { id: "highlight", label: "Resaltar texto", icon: ["M9 11l-4 4v3h3l4-4", "M9 11l5-5 4 4-5 5", "M9 11l4 4"] },
  { id: "text", label: "Agregar texto", icon: ["M5 6V4h14v2", "M12 4v16", "M9 20h6"] },
  { id: "draw", label: "Dibujar a mano", icon: ["M4 20c3-1 4-4 7-7s6-4 7-7", "M15 4l5 5"] },
  { id: "note", label: "Nota o comentario", icon: ["M4 5h16v11H9l-5 4z"] },
  { id: "sign", label: "Firmar", icon: ["M3 17c2-4 4-9 6-9s-1 9 1 9 3-5 5-5 1 4 3 4h3", "M3 21h18"] },
  { id: "form", label: "Rellenar formulario", icon: ["M4 4h16v16H4z", "M8 9h8M8 13h8M8 17h4"] },
  { id: "pages", label: "Ordenar, girar o quitar páginas", icon: ["M7 3h8l4 4v10H7z", "M3 7v14h12"] },
  { id: "merge", label: "Combinar con otro PDF", icon: ["M6 3v6a6 6 0 006 6h6", "M15 12l3 3-3 3", "M6 21v-4"] },
];

/** WEPO PDF: ver un PDF (páginas, miniaturas, zoom, seleccionar y copiar texto). La edición llegará después. */
export default function PdfViewer({ data, path, fileName, onHome, onOpen }: Props) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [sizes, setSizes] = useState<PageSize[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [needsPassword, setNeedsPassword] = useState<"ask" | "wrong" | null>(null);
  const [password, setPassword] = useState("");
  const [zoom, setZoomState] = useState<number | null>(() => (path ? loadZoom(`pdf:${path}`, 0) || null : null));
  const [current, setCurrent] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [sidebar, setSidebar] = useState(true);
  const [status, setStatus] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  // ───────────── abrir ─────────────

  const open = useCallback(
    async (pass?: string) => {
      try {
        const doc = await loadPdf(data, pass);
        const list: PageSize[] = [];
        for (let i = 1; i <= doc.numPages; i++) {
          const page = await doc.getPage(i);
          const v = page.getViewport({ scale: 1 });
          list.push({ width: v.width, height: v.height });
        }
        setNeedsPassword(null);
        setSizes(list);
        setPdf(doc);
      } catch (e) {
        const name = (e as { name?: string })?.name;
        if (name === "PasswordException") setNeedsPassword(pass ? "wrong" : "ask");
        else setError(`No se pudo abrir el PDF: ${(e as Error)?.message ?? e}`);
      }
    },
    [data],
  );

  useEffect(() => {
    open();
  }, [open]);

  useEffect(() => () => void pdf?.destroy(), [pdf]);

  // Sin zoom guardado, la página cabe a lo ancho (hasta 125 %).
  useEffect(() => {
    if (!sizes.length || zoom !== null || !scroller.current) return;
    setZoomState(fitWidth(1.25));
  }, [sizes]); // eslint-disable-line react-hooks/exhaustive-deps

  function fitWidth(max = 4) {
    const widest = Math.max(...sizes.map((s) => s.width));
    const room = (scroller.current?.clientWidth ?? 800) - 48;
    return clampZoom(Math.min(max, room / (widest * CSS_PER_PT)));
  }

  const scale = (zoom ?? 1) * CSS_PER_PT;

  // ───────────── zoom ─────────────

  function setZoom(next: number) {
    const value = clampZoom(next);
    // Al cambiar el zoom se queda en la misma página.
    const page = current;
    setZoomState(value);
    if (path) saveZoom(`pdf:${path}`, value);
    requestAnimationFrame(() => goTo(page, "auto"));
  }

  // ───────────── páginas ─────────────

  /** Dónde empieza cada página (en píxeles) dentro del área que se desplaza. */
  const tops = useMemo(() => {
    const out: number[] = [];
    let y = PAGE_GAP;
    for (const s of sizes) {
      out.push(y);
      y += s.height * scale + PAGE_GAP;
    }
    return out;
  }, [sizes, scale]);

  function goTo(page: number, behavior: ScrollBehavior = "smooth") {
    const n = Math.min(Math.max(1, page), sizes.length);
    scroller.current?.scrollTo({ top: tops[n - 1] - PAGE_GAP / 2, behavior });
    setCurrent(n);
    setPageInput(String(n));
  }

  function onScroll() {
    const el = scroller.current;
    if (!el || !tops.length) return;
    // La página actual es la que ocupa el centro de la vista.
    const middle = el.scrollTop + el.clientHeight / 3;
    let page = 1;
    for (let i = 0; i < tops.length; i++) if (tops[i] <= middle) page = i + 1;
    if (page !== current) {
      setCurrent(page);
      setPageInput(String(page));
    }
  }

  function future(label: string) {
    setStatus(`«${label}» llega en una próxima versión de WEPO PDF. Por ahora puedes ver el PDF, seleccionar y copiar su texto.`);
  }

  useEffect(() => {
    if (!status) return;
    const timer = setTimeout(() => setStatus(null), 5000);
    return () => clearTimeout(timer);
  }, [status]);

  // ───────────── atajos ─────────────

  const commands = useRef({ setZoom, zoom: zoom ?? 1, goTo, current });
  commands.current = { setZoom, zoom: zoom ?? 1, goTo, current };
  useEffect(() => {
    const stop = onCommand((command) => {
      const c = commands.current;
      if (command === "zoom-in") c.setZoom(stepZoom(c.zoom, 1));
      else if (command === "zoom-out") c.setZoom(stepZoom(c.zoom, -1));
      else if (command === "zoom-reset") c.setZoom(1);
    });
    function onKey(e: KeyboardEvent) {
      if (hasModifier(e)) {
        const key = e.key.toLowerCase();
        const command = key === "=" || key === "+" ? "zoom-in" : key === "-" ? "zoom-out" : key === "0" ? "zoom-reset" : null;
        if (command) {
          e.preventDefault();
          runCommand(command);
        }
        return;
      }
      // Las flechas mueven de página, salvo cuando se escribe en un campo.
      if ((e.target as HTMLElement).closest("input, textarea, select")) return;
      const c = commands.current;
      if (e.key === "ArrowRight" || (e.key === "PageDown" && e.altKey)) (e.preventDefault(), c.goTo(c.current + 1));
      else if (e.key === "ArrowLeft" || (e.key === "PageUp" && e.altKey)) (e.preventDefault(), c.goTo(c.current - 1));
      else if (e.key === "Home" && !e.shiftKey) (e.preventDefault(), c.goTo(1));
      else if (e.key === "End" && !e.shiftKey) (e.preventDefault(), c.goTo(Number.MAX_SAFE_INTEGER));
    }
    window.addEventListener("keydown", onKey);
    return () => {
      stop();
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const total = sizes.length;
  const first = sizes[0];
  const paper = first ? paperName(first) : "";

  return (
    <div className="editor kind-pdf pdf-viewer">
      <EditorToolbar kind="pdf" fileName={fileName} onHome={onHome} onOpen={onOpen} />

      <div className="format-bar pdf-bar" role="toolbar" aria-label="PDF">
        <button
          type="button"
          className={`fb-button${sidebar ? " pressed" : ""}`}
          title="Miniaturas"
          aria-label="Miniaturas"
          aria-pressed={sidebar}
          onClick={() => setSidebar((v) => !v)}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
            <rect x="3" y="4" width="18" height="16" rx="1.5" />
            <path d="M9 4v16" />
          </svg>
        </button>
        <Separator />
        <button type="button" className="fb-button" title="Página anterior (←)" aria-label="Página anterior" onClick={() => goTo(current - 1)} disabled={current <= 1}>
          ‹
        </button>
        <form
          className="pdf-page-nav"
          onSubmit={(e) => {
            e.preventDefault();
            const n = Number(pageInput);
            if (Number.isFinite(n) && n >= 1) goTo(n);
            else setPageInput(String(current));
          }}
        >
          <input className="pdf-page-input" value={pageInput} onChange={(e) => setPageInput(e.target.value)} aria-label="Ir a la página" inputMode="numeric" />
          <span>de {total || "…"}</span>
        </form>
        <button type="button" className="fb-button" title="Página siguiente (→)" aria-label="Página siguiente" onClick={() => goTo(current + 1)} disabled={current >= total}>
          ›
        </button>
        <Separator />
        <button type="button" className="btn pdf-fit" onClick={() => setZoom(fitWidth())} disabled={!total}>
          Ajustar al ancho
        </button>
        <Separator />
        <span className="pdf-future-label">Editar:</span>
        {FUTURE_TOOLS.map((t) => (
          <button key={t.id} type="button" className="fb-button pdf-future" title={`${t.label} (próximamente)`} aria-label={`${t.label} (próximamente)`} onClick={() => future(t.label)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              {t.icon.map((d) => (
                <path key={d} d={d} />
              ))}
            </svg>
          </button>
        ))}
        <span className="pdf-soon">Próximamente</span>
      </div>

      <div className="pdf-body">
        {sidebar && pdf && (
          <nav className="pdf-sidebar" aria-label="Páginas">
            {sizes.map((s, i) => (
              <button key={i} type="button" className={`pdf-thumb${current === i + 1 ? " current" : ""}`} onClick={() => goTo(i + 1)} aria-label={`Página ${i + 1}`}>
                <Thumbnail pdf={pdf} number={i + 1} size={s} />
                <span>{i + 1}</span>
              </button>
            ))}
          </nav>
        )}

        <div className="pdf-scroller" ref={scroller} onScroll={onScroll}>
          {error && <div className="pdf-message error">{error}</div>}
          {needsPassword && (
            <form
              className="pdf-message pdf-password"
              onSubmit={(e) => {
                e.preventDefault();
                open(password);
              }}
            >
              <b>Este PDF está protegido con contraseña.</b>
              <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Contraseña" autoFocus aria-label="Contraseña del PDF" />
              {needsPassword === "wrong" && <span className="cf-error">La contraseña no es correcta.</span>}
              <button className="btn btn-primary" type="submit">
                Abrir
              </button>
            </form>
          )}
          {!pdf && !error && !needsPassword && <div className="pdf-message">Abriendo…</div>}
          {pdf && zoom !== null && (
            <div className="pdf-pages" style={{ paddingTop: PAGE_GAP }}>
              {sizes.map((s, i) => (
                <PageView key={i} pdf={pdf} number={i + 1} size={s} scale={scale} root={scroller} />
              ))}
            </div>
          )}
        </div>
      </div>

      <footer className="write-footer pdf-footer">
        <span>
          {total ? `${total} ${total === 1 ? "página" : "páginas"}` : ""}
          {paper ? ` · ${paper}` : ""}
        </span>
        <span className="pdf-hint">{keys("Selecciona texto y cópialo con ⌘C")}</span>
        {status && <span className="sheet-status">{status}</span>}
        <ZoomControl zoom={zoom ?? 1} onChange={setZoom} />
      </footer>
    </div>
  );
}

/** "Carta", "A4"… según el tamaño de la página (con un margen de error de unos milímetros). */
function paperName({ width, height }: PageSize): string {
  const [w, h] = [Math.min(width, height), Math.max(width, height)];
  const sizes: [string, number, number][] = [
    ["Carta", 612, 792],
    ["Oficio", 612, 1008],
    ["A4", 595, 842],
    ["A3", 842, 1191],
    ["A5", 420, 595],
    ["Tabloide", 792, 1224],
  ];
  const found = sizes.find(([, a, b]) => Math.abs(a - w) < 6 && Math.abs(b - h) < 6);
  const orientation = width > height ? " horizontal" : "";
  return found ? `${found[0]}${orientation}` : `${Math.round((width / 72) * 25.4)} × ${Math.round((height / 72) * 25.4)} mm`;
}

/** Una página: se dibuja solo cuando está cerca de la vista (los PDF largos no se dibujan enteros). */
function PageView({ pdf, number, size, scale, root }: { pdf: PDFDocumentProxy; number: number; size: PageSize; scale: number; root: React.RefObject<HTMLDivElement | null> }) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const width = Math.round(size.width * scale);
  const height = Math.round(size.height * scale);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { root: root.current, rootMargin: "800px 0px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, [root]);

  useEffect(() => {
    if (!visible) return;
    let task: RenderTask | null = null;
    let layer: TextLayer | null = null;
    let cancelled = false;
    (async () => {
      const page: PDFPageProxy = await pdf.getPage(number);
      if (cancelled || !canvas.current || !text.current) return;
      const viewport = page.getViewport({ scale });
      // Más píxeles en pantallas Retina para que el texto se vea nítido.
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const c = canvas.current;
      c.width = Math.floor(viewport.width * ratio);
      c.height = Math.floor(viewport.height * ratio);
      task = page.render({ canvas: c, viewport, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined });
      try {
        await task.promise;
      } catch {
        return; // se canceló (cambió el zoom o la página salió de la vista)
      }
      if (cancelled || !text.current) return;
      text.current.replaceChildren();
      layer = new TextLayer({ textContentSource: page.streamTextContent(), container: text.current, viewport });
      await layer.render().catch(() => {});
    })();
    return () => {
      cancelled = true;
      task?.cancel();
      layer?.cancel();
    };
  }, [visible, pdf, number, scale]);

  return (
    <div
      ref={box}
      className="pdf-page"
      data-page={number}
      style={{ width, height, marginBottom: PAGE_GAP, ["--total-scale-factor" as string]: scale, ["--scale-factor" as string]: scale }}
    >
      <canvas ref={canvas} style={{ width, height }} aria-label={`Página ${number}`} />
      <div ref={text} className="textLayer" />
    </div>
  );
}

/** Miniatura de una página en la barra lateral. */
function Thumbnail({ pdf, number, size }: { pdf: PDFDocumentProxy; number: number; size: PageSize }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const width = 120;
  const scale = width / size.width;
  const height = Math.round(size.height * scale);

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) => entry.isIntersecting && setVisible(true), { rootMargin: "400px 0px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let task: RenderTask | null = null;
    (async () => {
      const page = await pdf.getPage(number);
      if (!canvas.current) return;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const viewport = page.getViewport({ scale: scale * ratio });
      canvas.current.width = Math.floor(viewport.width);
      canvas.current.height = Math.floor(viewport.height);
      task = page.render({ canvas: canvas.current, viewport });
      await task.promise.catch(() => {});
    })();
    return () => task?.cancel();
  }, [visible, pdf, number, scale]);

  return <canvas ref={canvas} style={{ width, height }} />;
}
