import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TextLayer } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFPageProxy, RenderTask } from "pdfjs-dist/legacy/build/pdf.mjs";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save } from "@tauri-apps/plugin-dialog";
import EditorToolbar from "../../components/EditorToolbar";
import ContextMenu from "../../components/ContextMenu";
import type { MenuItem } from "../../components/ContextMenu";
import ZoomControl from "../sheets/ZoomControl";
import { clampZoom, stepZoom } from "../sheets/layout";
import { Separator, ToolButton } from "../sheets/FormatBar";
import { loadPdf, readPdf } from "../../lib/pdf";
import { fileNameOf } from "../../lib/documents";
import { onCommand, runCommand } from "../../lib/commands";
import { hasModifier, keys } from "../../lib/platform";
import { loadZoom, saveZoom } from "../../lib/zoom";
import type { PageRef, Source } from "./pdfEdit";
import { pagesOf, pid, savePdf, shownSize } from "./pdfEdit";
import "../sheets/FormatBar.css";
import "./PdfViewer.css";

type Props = {
  data: Uint8Array;
  path: string | null;
  fileName: string;
  onHome: () => void;
  onOpen: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onSaved: (path: string) => void;
};

/** 100 % es el tamaño real: un punto del PDF mide 96/72 píxeles de pantalla. */
const CSS_PER_PT = 96 / 72;
const PAGE_GAP = 16;

/** Herramientas de anotación que llegarán en el siguiente paso. */
const FUTURE_TOOLS: { id: string; label: string; icon: string[] }[] = [
  { id: "highlight", label: "Resaltar texto", icon: ["M9 11l-4 4v3h3l4-4", "M9 11l5-5 4 4-5 5", "M9 11l4 4"] },
  { id: "text", label: "Agregar texto", icon: ["M5 6V4h14v2", "M12 4v16", "M9 20h6"] },
  { id: "draw", label: "Dibujar a mano", icon: ["M4 20c3-1 4-4 7-7s6-4 7-7", "M15 4l5 5"] },
  { id: "note", label: "Nota o comentario", icon: ["M4 5h16v11H9l-5 4z"] },
  { id: "sign", label: "Firmar", icon: ["M3 17c2-4 4-9 6-9s-1 9 1 9 3-5 5-5 1 4 3 4h3", "M3 21h18"] },
  { id: "form", label: "Rellenar formulario", icon: ["M4 4h16v16H4z", "M8 9h8M8 13h8M8 17h4"] },
];

/** WEPO PDF: ver un PDF y editar sus páginas (ordenar, girar, quitar, combinar con otro PDF). */
export default function PdfViewer({ data, path: initialPath, fileName: initialName, onHome, onOpen, onDirtyChange, onSaved }: Props) {
  const [sources, setSources] = useState<Source[]>([]);
  const [pages, setPagesState] = useState<PageRef[]>([]);
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  const history = useRef<{ past: PageRef[][]; future: PageRef[][] }>({ past: [], future: [] });
  const [error, setError] = useState<string | null>(null);
  const [needsPassword, setNeedsPassword] = useState<"ask" | "wrong" | null>(null);
  const [password, setPassword] = useState("");
  /** Con contraseña, el PDF solo se puede ver: pdf-lib no guarda PDF cifrados. */
  const [locked, setLocked] = useState(false);
  const [path, setPath] = useState(initialPath);
  const [fileName, setFileName] = useState(initialName);
  const [dirty, setDirty] = useState(false);
  const [zoom, setZoomState] = useState<number | null>(() => (initialPath ? loadZoom(`pdf:${initialPath}`, 0) || null : null));
  const [current, setCurrent] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sidebar, setSidebar] = useState(true);
  const [status, setStatus] = useState<{ text: string; error?: boolean } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  // ───────────── abrir ─────────────

  const open = useCallback(
    async (pass?: string) => {
      try {
        const doc = await loadPdf(data, pass);
        const source: Source = { id: "original", name: initialName, data, doc };
        setNeedsPassword(null);
        setLocked(Boolean(pass));
        setSources([source]);
        setPagesState(await pagesOf(source));
      } catch (e) {
        const name = (e as { name?: string })?.name;
        if (name === "PasswordException") setNeedsPassword(pass ? "wrong" : "ask");
        else setError(`No se pudo abrir el PDF: ${(e as Error)?.message ?? e}`);
      }
    },
    [data, initialName],
  );

  useEffect(() => {
    open();
  }, [open]);

  // Los PDF abiertos se cierran al salir del editor (no al agregar otro).
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;
  useEffect(() => () => sourcesRef.current.forEach((s) => void s.doc.destroy()), []);

  // Sin zoom guardado, la página cabe a lo ancho (hasta 125 %).
  useEffect(() => {
    if (!pages.length || zoom !== null || !scroller.current) return;
    setZoomState(fitWidth(1.25));
  }, [pages.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const sizes = useMemo(() => pages.map(shownSize), [pages]);

  function fitWidth(max = 4) {
    const widest = Math.max(...sizes.map((s) => s.width), 1);
    const room = (scroller.current?.clientWidth ?? 800) - 48;
    return clampZoom(Math.min(max, room / (widest * CSS_PER_PT)));
  }

  const scale = (zoom ?? 1) * CSS_PER_PT;

  function setZoom(next: number) {
    const value = clampZoom(next);
    const page = current;
    setZoomState(value);
    if (path) saveZoom(`pdf:${path}`, value);
    requestAnimationFrame(() => goTo(page, "auto"));
  }

  // ───────────── páginas ─────────────

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
    const n = Math.min(Math.max(1, page), pagesRef.current.length);
    scroller.current?.scrollTo({ top: (tops[n - 1] ?? 0) - PAGE_GAP / 2, behavior });
    setCurrent(n);
    setPageInput(String(n));
  }

  function onScroll() {
    const el = scroller.current;
    if (!el || !tops.length) return;
    const middle = el.scrollTop + el.clientHeight / 3;
    let page = 1;
    for (let i = 0; i < tops.length; i++) if (tops[i] <= middle) page = i + 1;
    if (page !== current) {
      setCurrent(page);
      setPageInput(String(page));
    }
  }

  // ───────────── editar páginas (con deshacer) ─────────────

  function commit(next: PageRef[]) {
    if (locked) {
      setStatus({ text: "Este PDF tiene contraseña: por ahora WEPO solo puede mostrarlo, no editarlo." });
      return;
    }
    history.current.past.push(pagesRef.current);
    history.current.future = [];
    setPagesState(next);
    setDirty(true);
    onDirtyChange(true);
  }

  function undo() {
    const prev = history.current.past.pop();
    if (!prev) return;
    history.current.future.push(pagesRef.current);
    setPagesState(prev);
    setDirty(true);
    onDirtyChange(true);
  }

  function redo() {
    const next = history.current.future.pop();
    if (!next) return;
    history.current.past.push(pagesRef.current);
    setPagesState(next);
    setDirty(true);
    onDirtyChange(true);
  }

  /** Después de qué página se insertan otras: la última elegida en las miniaturas, o la que se ve. */
  function anchorIndex(): number {
    const list = pagesRef.current;
    const chosen = list.map((p, i) => (selected.has(p.id) ? i : -1)).filter((i) => i >= 0);
    return chosen.length ? Math.max(...chosen) : current - 1;
  }

  /** Las páginas a las que se aplica una acción: las elegidas, o la actual. */
  function targets(): Set<string> {
    if (selected.size) return selected;
    const page = pagesRef.current[current - 1];
    return new Set(page ? [page.id] : []);
  }

  function rotate(delta: 90 | -90) {
    const ids = targets();
    commit(pagesRef.current.map((p) => (ids.has(p.id) ? { ...p, rotation: (p.rotation + delta + 360) % 360 } : p)));
  }

  function remove() {
    const ids = targets();
    if (ids.size >= pagesRef.current.length) {
      setStatus({ text: "El PDF necesita al menos una página" });
      return;
    }
    commit(pagesRef.current.filter((p) => !ids.has(p.id)));
    setSelected(new Set());
    setStatus({ text: ids.size === 1 ? "Página eliminada" : `${ids.size} páginas eliminadas` });
  }

  function move(from: number, to: number) {
    if (from === to) return;
    const list = [...pagesRef.current];
    const [p] = list.splice(from, 1);
    list.splice(to, 0, p);
    commit(list);
    setCurrent(to + 1);
    setPageInput(String(to + 1));
  }

  /** Combinar: las páginas de otro PDF entran después de `after` (o al final). */
  async function insertPdf(after = pagesRef.current.length - 1) {
    if (locked) {
      setStatus({ text: "Este PDF tiene contraseña: por ahora WEPO solo puede mostrarlo, no editarlo." });
      return;
    }
    const file = await openDialog({ multiple: false, filters: [{ name: "PDF", extensions: ["pdf"] }] });
    if (!file) return;
    try {
      const bytes = await readPdf(file);
      const doc = await loadPdf(bytes);
      const source: Source = { id: pid("s"), name: fileNameOf(file), data: bytes, doc };
      const added = await pagesOf(source);
      setSources((list) => [...list, source]);
      const list = [...pagesRef.current];
      list.splice(after + 1, 0, ...added);
      commit(list);
      setStatus({ text: `Se agregaron ${added.length} ${added.length === 1 ? "página" : "páginas"} de ${source.name}` });
    } catch (e) {
      const name = (e as { name?: string })?.name;
      setStatus({ text: name === "PasswordException" ? "Ese PDF tiene contraseña: todavía no se puede combinar." : `No se pudo agregar el PDF: ${e}`, error: true });
    }
  }

  // ───────────── guardar ─────────────

  async function saveTo(target: string, only?: PageRef[]) {
    try {
      const bytes = await savePdf(sources, only ?? pagesRef.current, []);
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      await invoke("file_write", { path: target, data: btoa(binary) });
      if (!only) {
        setPath(target);
        setFileName(fileNameOf(target));
        setDirty(false);
        onDirtyChange(false);
        onSaved(target);
      }
      setStatus({ text: only ? `Se guardaron ${only.length} ${only.length === 1 ? "página" : "páginas"} en ${fileNameOf(target)}` : "Guardado" });
      return true;
    } catch (e) {
      setStatus({ text: `No se pudo guardar: ${e}`, error: true });
      return false;
    }
  }

  async function saveDocument(saveAs = false) {
    if (locked) {
      setStatus({ text: "Este PDF tiene contraseña: por ahora WEPO solo puede mostrarlo, no guardarlo." });
      return false;
    }
    if (!saveAs && path) return saveTo(path);
    const target = await save({ defaultPath: fileName.replace(/\.pdf$/i, "") + (saveAs ? " (editado)" : "") + ".pdf", filters: [{ name: "PDF", extensions: ["pdf"] }] });
    if (!target) return false;
    return saveTo(/\.pdf$/i.test(target) ? target : `${target}.pdf`);
  }

  /** Guarda las páginas elegidas en un PDF nuevo (el documento abierto no cambia). */
  async function extract() {
    const ids = targets();
    const chosen = pagesRef.current.filter((p) => ids.has(p.id));
    if (!chosen.length) return;
    const target = await save({ defaultPath: `${fileName.replace(/\.pdf$/i, "")} (páginas).pdf`, filters: [{ name: "PDF", extensions: ["pdf"] }] });
    if (target) await saveTo(/\.pdf$/i.test(target) ? target : `${target}.pdf`, chosen);
  }

  useEffect(() => {
    if (!status || status.error) return;
    const timer = setTimeout(() => setStatus(null), 5000);
    return () => clearTimeout(timer);
  }, [status]);

  function future(label: string) {
    setStatus({ text: `«${label}» llega en el siguiente paso de WEPO PDF.` });
  }

  // ───────────── miniaturas: elegir, arrastrar y menú ─────────────

  function onThumbClick(e: React.MouseEvent, index: number) {
    const id = pages[index].id;
    if (hasModifier(e)) {
      const next = new Set(selected);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setSelected(next);
    } else if (e.shiftKey && selected.size) {
      const last = pages.findIndex((p) => selected.has(p.id));
      const [a, b] = last < index ? [last, index] : [index, last];
      setSelected(new Set(pages.slice(a, b + 1).map((p) => p.id)));
    } else {
      setSelected(new Set([id]));
    }
    goTo(index + 1);
  }

  function thumbMenu(e: React.MouseEvent, index: number) {
    e.preventDefault();
    if (!selected.has(pages[index].id)) setSelected(new Set([pages[index].id]));
    setCurrent(index + 1);
    const many = selected.size > 1 && selected.has(pages[index].id);
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: "Girar a la derecha", action: () => rotate(90) },
        { label: "Girar a la izquierda", action: () => rotate(-90) },
        "separator",
        { label: "Insertar páginas de otro PDF aquí…", action: () => insertPdf(index) },
        { label: many ? "Guardar estas páginas como PDF nuevo…" : "Guardar esta página como PDF nuevo…", action: extract },
        "separator",
        { label: many ? "Eliminar páginas" : "Eliminar página", danger: true, action: remove },
      ],
    });
  }

  // ───────────── atajos ─────────────

  const actions = useRef({ setZoom, zoom: zoom ?? 1, goTo, current, saveDocument, undo, redo, remove, selected });
  actions.current = { setZoom, zoom: zoom ?? 1, goTo, current, saveDocument, undo, redo, remove, selected };
  useEffect(() => {
    const stop = onCommand((command) => {
      const c = actions.current;
      if (command === "zoom-in") c.setZoom(stepZoom(c.zoom, 1));
      else if (command === "zoom-out") c.setZoom(stepZoom(c.zoom, -1));
      else if (command === "zoom-reset") c.setZoom(1);
      else if (command === "save") c.saveDocument(false);
      else if (command === "save-as") c.saveDocument(true);
    });
    function onKey(e: KeyboardEvent) {
      const c = actions.current;
      if (hasModifier(e)) {
        const key = e.key.toLowerCase();
        const command =
          key === "=" || key === "+" ? "zoom-in" : key === "-" ? "zoom-out" : key === "0" ? "zoom-reset" : key === "s" ? (e.shiftKey ? "save-as" : "save") : null;
        if (command) {
          e.preventDefault();
          runCommand(command);
        } else if (key === "z" && !(e.target as HTMLElement).closest("input, textarea")) {
          e.preventDefault();
          if (e.shiftKey) c.redo();
          else c.undo();
        }
        return;
      }
      // Las flechas mueven de página, salvo cuando se escribe en un campo.
      if ((e.target as HTMLElement).closest("input, textarea, select")) return;
      if (e.key === "ArrowRight" || (e.key === "PageDown" && e.altKey)) (e.preventDefault(), c.goTo(c.current + 1));
      else if (e.key === "ArrowLeft" || (e.key === "PageUp" && e.altKey)) (e.preventDefault(), c.goTo(c.current - 1));
      else if (e.key === "Home" && !e.shiftKey) (e.preventDefault(), c.goTo(1));
      else if (e.key === "End" && !e.shiftKey) (e.preventDefault(), c.goTo(Number.MAX_SAFE_INTEGER));
      else if ((e.key === "Delete" || e.key === "Backspace") && c.selected.size) (e.preventDefault(), c.remove());
    }
    window.addEventListener("keydown", onKey);
    return () => {
      stop();
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const total = pages.length;
  const paper = sizes[0] ? paperName(sizes[0]) : "";
  const docs = useMemo(() => new Map(sources.map((s) => [s.id, s])), [sources]);
  const ready = total > 0 && sources.length > 0;

  return (
    <div className="editor kind-pdf pdf-viewer">
      <EditorToolbar
        kind="pdf"
        fileName={fileName}
        dirty={dirty}
        onHome={onHome}
        onOpen={onOpen}
        actions={
          <div className="toolbar-group">
            <button className="btn btn-icon" onClick={undo} title={keys("Deshacer (⌘Z)")} aria-label="Deshacer">
              ↶
            </button>
            <button className="btn btn-icon" onClick={redo} title={keys("Rehacer (⌘⇧Z)")} aria-label="Rehacer">
              ↷
            </button>
            <button className="btn" onClick={() => saveDocument()} title={keys("Guardar (⌘S)")} disabled={locked}>
              Guardar
            </button>
          </div>
        }
      />

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
        <span className="pdf-future-label">Páginas:</span>
        <ToolButton label="Girar a la izquierda" onClick={() => rotate(-90)}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
            <path d="M4 4v5h5" />
            <path d="M4.5 9A8 8 0 1112 20" />
          </svg>
        </ToolButton>
        <ToolButton label="Girar a la derecha" onClick={() => rotate(90)}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
            <path d="M20 4v5h-5" />
            <path d="M19.5 9A8 8 0 1012 20" />
          </svg>
        </ToolButton>
        <ToolButton label="Eliminar página (⌫)" onClick={remove}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
            <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
          </svg>
        </ToolButton>
        <ToolButton label="Combinar: agregar páginas de otro PDF" onClick={() => insertPdf(anchorIndex())}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
            <path d="M7 3h8l4 4v10H7z" />
            <path d="M3 7v14h12" />
            <path d="M13 9v6M10 12h6" />
          </svg>
        </ToolButton>
        <ToolButton label="Guardar las páginas elegidas como PDF nuevo" onClick={extract}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
            <path d="M6 3h8l4 4v14H6z" />
            <path d="M12 10v7M9 14l3 3 3-3" />
          </svg>
        </ToolButton>
        <Separator />
        <span className="pdf-future-label">Anotar:</span>
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

      {locked && (
        <div className="sheet-notice" role="status">
          Este PDF está protegido con contraseña: por ahora WEPO puede mostrarlo, pero no editarlo ni guardarlo.
        </div>
      )}

      <div className="pdf-body">
        {sidebar && ready && (
          <nav className="pdf-sidebar" aria-label="Páginas">
            {pages.map((p, i) => (
              <div
                key={p.id}
                role="button"
                tabIndex={0}
                className={`pdf-thumb${current === i + 1 ? " current" : ""}${selected.has(p.id) ? " chosen" : ""}${dragFrom !== null && dragFrom !== i ? " drop" : ""}`}
                draggable={!locked}
                onDragStart={(e) => {
                  setDragFrom(i);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onDragEnd={() => setDragFrom(null)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragFrom !== null) move(dragFrom, i);
                  setDragFrom(null);
                }}
                onClick={(e) => onThumbClick(e, i)}
                onContextMenu={(e) => thumbMenu(e, i)}
                aria-label={`Página ${i + 1}`}
              >
                <Thumbnail page={p} source={docs.get(p.source)!} />
                <span>{i + 1}</span>
              </div>
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
          {!ready && !error && !needsPassword && <div className="pdf-message">Abriendo…</div>}
          {ready && zoom !== null && (
            <div className="pdf-pages" style={{ paddingTop: PAGE_GAP }}>
              {pages.map((p) => (
                <PageView key={p.id} page={p} source={docs.get(p.source)!} scale={scale} root={scroller} />
              ))}
            </div>
          )}
        </div>
      </div>

      <footer className="write-footer pdf-footer">
        <span>
          {total ? `${total} ${total === 1 ? "página" : "páginas"}` : ""}
          {paper ? ` · ${paper}` : ""}
          {selected.size > 1 ? ` · ${selected.size} elegidas` : ""}
        </span>
        <span className="pdf-hint">{keys("⌘ + clic o ⇧ + clic en las miniaturas para elegir varias; arrástralas para ordenarlas")}</span>
        {status && <span className={`sheet-status ${status.error ? "error" : ""}`}>{status.text}</span>}
        <ZoomControl zoom={zoom ?? 1} onChange={setZoom} />
      </footer>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}

/** "Carta", "A4"… según el tamaño de la página (con un margen de error de unos milímetros). */
function paperName({ width, height }: { width: number; height: number }): string {
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
function PageView({ page, source, scale, root }: { page: PageRef; source: Source; scale: number; root: React.RefObject<HTMLDivElement | null> }) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const size = shownSize(page);
  const width = Math.round(size.width * scale);
  const height = Math.round(size.height * scale);
  const rotation = (page.baseRotation + page.rotation) % 360;

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
      const p: PDFPageProxy = await source.doc.getPage(page.index + 1);
      if (cancelled || !canvas.current || !text.current) return;
      const viewport = p.getViewport({ scale, rotation });
      // Más píxeles en pantallas Retina para que el texto se vea nítido.
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const c = canvas.current;
      c.width = Math.floor(viewport.width * ratio);
      c.height = Math.floor(viewport.height * ratio);
      task = p.render({ canvas: c, viewport, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined });
      try {
        await task.promise;
      } catch {
        return; // se canceló (cambió el zoom o la página salió de la vista)
      }
      if (cancelled || !text.current) return;
      text.current.replaceChildren();
      layer = new TextLayer({ textContentSource: p.streamTextContent(), container: text.current, viewport });
      await layer.render().catch(() => {});
    })();
    return () => {
      cancelled = true;
      task?.cancel();
      layer?.cancel();
    };
  }, [visible, source, page.index, scale, rotation]);

  return (
    <div
      ref={box}
      className="pdf-page"
      data-page={page.id}
      style={{ width, height, marginBottom: PAGE_GAP, ["--total-scale-factor" as string]: scale, ["--scale-factor" as string]: scale }}
    >
      <canvas ref={canvas} style={{ width, height }} aria-label={`Página ${page.index + 1}`} />
      <div ref={text} className="textLayer" />
    </div>
  );
}

/** Miniatura de una página en la barra lateral. */
function Thumbnail({ page, source }: { page: PageRef; source: Source }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const size = shownSize(page);
  const width = 120;
  const scale = width / size.width;
  const height = Math.round(size.height * scale);
  const rotation = (page.baseRotation + page.rotation) % 360;

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
      const p = await source.doc.getPage(page.index + 1);
      if (!canvas.current) return;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const viewport = p.getViewport({ scale: scale * ratio, rotation });
      canvas.current.width = Math.floor(viewport.width);
      canvas.current.height = Math.floor(viewport.height);
      task = p.render({ canvas: canvas.current, viewport });
      await task.promise.catch(() => {});
    })();
    return () => task?.cancel();
  }, [visible, source, page.index, scale, rotation]);

  return <canvas ref={canvas} style={{ width, height }} />;
}
