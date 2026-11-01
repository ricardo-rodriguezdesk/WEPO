// «WEPO Convertir»: herramientas para PDF e imágenes, como las de iLovePDF,
// pero todo en la computadora (los archivos no se suben a ningún lado).

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { extensionOf } from "../lib/documents";
import type { PDFDocumentProxy } from "../lib/pdf";
import { GROUPS, TOOLS, toolById } from "./tools";
import type { ToolDef, ToolId } from "./tools";
import type { InputFile, Saved } from "./io";
import { pickFiles, readInput, saveOutputs, sizeLabel } from "./io";
import type { CompressLevel, ImageFormat, ImagesOptions, MarkOptions, MarkPosition, NumberFormat, NumberOptions, NumberPosition, Output, SplitMode } from "./pdfTools";
import { addPageNumbers, baseName, compressPdf, imagesToPdf, numberText, parseRanges, pdfToImages, proxyOf, repairPdf, splitPdf, watermarkPdf } from "./pdfTools";
import { toPdfA } from "./pdfa";
import { mergePdfs, ocrPdf, pdfToDocx, pdfToXlsx, protectPdf, rotatePdf, unlockPdf } from "./moreTools";
import OrganizeTool from "./OrganizeTool";
import OfficePdfTool from "./OfficePdfTool";
import { pdfToPptx } from "./pdfToPptx";
import CropTool from "./CropTool";
import CompareTool from "./CompareTool";
import HtmlTool from "./HtmlTool";
import "./Tools.css";

export type DropHandler = ((paths: string[]) => void) | null;

type Props = {
  onHome: () => void;
  /** Abrir lo que salió en la app que le toca (un .pptx en WEPO Present, un PDF en WEPO PDF). */
  onOpenPath: (path: string) => void;
  /** Para que los archivos arrastrados desde Finder lleguen a la herramienta abierta. */
  setDropHandler: (handler: DropHandler) => void;
  initial?: ToolId | null;
};

export default function ToolsScreen({ onHome, onOpenPath, setDropHandler, initial = null }: Props) {
  const [tool, setTool] = useState<ToolId | null>(initial);
  useEffect(() => {
    if (!tool) setDropHandler(null);
  }, [tool, setDropHandler]);
  if (tool) return <ToolView key={tool} def={toolById(tool)} onBack={() => setTool(null)} onOpenPath={onOpenPath} setDropHandler={setDropHandler} />;
  return (
    <main className="tools-hub">
      <header className="tools-hub-head">
        <button type="button" className="btn" onClick={onHome}>
          ← Inicio
        </button>
        <div>
          <h1>WEPO Convertir</h1>
          <p>Herramientas para tus PDF e imágenes. Todo pasa en tu computadora: tus archivos no se suben a internet.</p>
        </div>
      </header>
      {GROUPS.map((group) => (
        <section key={group} className="tools-group">
          <h2>{group}</h2>
          <div className="tools-cards">
            {TOOLS.filter((t) => t.group === group).map((t) => (
              <button key={t.id} type="button" className="tools-card" style={{ ["--tool" as string]: t.color }} onClick={() => setTool(t.id)}>
                <ToolIcon def={t} />
                <span className="tools-card-name">{t.name}</span>
                <span className="tools-card-desc">{t.desc}</span>
              </button>
            ))}
          </div>
        </section>
      ))}
    </main>
  );
}

export function ToolIcon({ def, size = 44 }: { def: ToolDef; size?: number }) {
  return (
    <span className="tools-icon" style={{ width: size, height: size, ["--tool" as string]: def.color }} aria-hidden>
      <svg width={size * 0.55} height={size * 0.55} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
        <path d={def.icon} />
      </svg>
    </span>
  );
}

// ───────────── piezas compartidas ─────────────

export type ToolResult = { lines: string[]; saved: Saved; open?: { path: string; label: string } };

/** Los archivos de la herramienta: elegirlos, arrastrarlos, ordenarlos y quitarlos. */
export function useFiles(def: ToolDef, setDropHandler: (h: DropHandler) => void, onError: (msg: string | null) => void, accept = def.accept, multiple = def.multiple) {
  const [files, setFiles] = useState<InputFile[]>([]);
  const add = async (paths: string[]) => {
    const ok = paths.filter((p) => accept.extensions.includes(extensionOf(p)));
    if (paths.length && !ok.length) {
      onError(`Esta herramienta recibe ${accept.extensions.map((e) => `.${e}`).join(", ")}`);
      return;
    }
    onError(null);
    try {
      const read = await Promise.all(ok.map(readInput));
      setFiles((list) => (multiple ? [...list, ...read] : read.slice(-1)));
    } catch (e) {
      onError(`No se pudo leer el archivo: ${e}`);
    }
  };
  const addRef = useRef(add);
  addRef.current = add;
  useEffect(() => {
    setDropHandler((paths) => void addRef.current(paths));
    return () => setDropHandler(null);
  }, [setDropHandler]);
  const choose = async () => add(await pickFiles(accept.name, accept.extensions, multiple));
  const remove = (id: string) => setFiles((list) => list.filter((f) => f.id !== id));
  const move = (id: string, delta: number) =>
    setFiles((list) => {
      const i = list.findIndex((f) => f.id === id);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= list.length) return list;
      const next = [...list];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  return { files, setFiles, add, choose, remove, move };
}

export function ToolFrame({ def, onBack, children }: { def: ToolDef; onBack: () => void; children: ReactNode }) {
  return (
    <main className="tool-view" style={{ ["--tool" as string]: def.color }}>
      <header className="tool-head">
        <button type="button" className="btn" onClick={onBack}>
          ← Herramientas
        </button>
        <ToolIcon def={def} size={36} />
        <div>
          <h1>{def.name}</h1>
          <p>{def.desc}</p>
        </div>
      </header>
      {children}
    </main>
  );
}

export function FileList({ def, files, choose, remove, move, label, accept = def.accept, multiple = def.multiple }: ReturnType<typeof useFiles> & { def: ToolDef; label?: string; accept?: ToolDef["accept"]; multiple?: boolean }) {
  if (!files.length) {
    return (
      <div className="tool-drop">
        <ToolIcon def={def} size={56} />
        <button type="button" className="btn btn-primary tool-pick" onClick={choose}>
          {label ?? (multiple ? "Elegir archivos" : "Elegir archivo")}
        </button>
        <span>o arrástra{multiple ? "los" : "lo"} aquí ({accept.extensions.slice(0, 5).map((e) => `.${e}`).join(", ")})</span>
      </div>
    );
  }
  return (
    <div className="tool-files">
      <ul aria-label="Archivos">
        {files.map((f, i) => (
          <li key={f.id} className="tool-file">
            <span className="tool-file-ext">{extensionOf(f.name).toUpperCase()}</span>
            <span className="tool-file-name" title={f.path}>
              {f.name}
            </span>
            <span className="tool-file-size">{sizeLabel(f.bytes.length)}</span>
            {multiple && files.length > 1 && (
              <>
                <button type="button" className="btn btn-icon" aria-label={`Subir ${f.name}`} disabled={i === 0} onClick={() => move(f.id, -1)}>
                  ↑
                </button>
                <button type="button" className="btn btn-icon" aria-label={`Bajar ${f.name}`} disabled={i === files.length - 1} onClick={() => move(f.id, 1)}>
                  ↓
                </button>
              </>
            )}
            <button type="button" className="btn btn-icon" aria-label={`Quitar ${f.name}`} onClick={() => remove(f.id)}>
              ×
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="btn" onClick={choose}>
        {multiple ? "+ Agregar más" : "Cambiar archivo"}
      </button>
    </div>
  );
}

export function ResultBox({ result, onOpenPath, onReset }: { result: ToolResult; onOpenPath: (p: string) => void; onReset: () => void }) {
  const { saved } = result;
  return (
    <div className="tool-result" role="status">
      <b>✓ Listo</b>
      {result.lines.map((l, i) => (
        <p key={i}>{l}</p>
      ))}
      <div className="tool-result-actions">
        <button type="button" className="btn" onClick={() => revealItemInDir(saved.paths[0]).catch(() => {})}>
          Mostrar en Finder
        </button>
        {result.open && (
          <button type="button" className="btn" onClick={() => onOpenPath(result.open!.path)}>
            {result.open.label}
          </button>
        )}
        <button type="button" className="btn" onClick={onReset}>
          Empezar de nuevo
        </button>
      </div>
    </div>
  );
}

/** Una página del PDF dibujada chica, con lo que se le quiera poner encima (en puntos × escala). */
export function PagePreview({ bytes, page = 0, width = 300, children, onSize, open = false }: { bytes: Uint8Array; page?: number; width?: number; children?: (s: number, size: { width: number; height: number }) => ReactNode; onSize?: (doc: PDFDocumentProxy) => void; open?: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const onSizeRef = useRef(onSize);
  onSizeRef.current = onSize;
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const doc = await proxyOf(bytes);
        onSizeRef.current?.(doc);
        const p = await doc.getPage(Math.min(page, doc.numPages - 1) + 1);
        const view = p.getViewport({ scale: 1 });
        const s = width / view.width;
        const vp = p.getViewport({ scale: s * (window.devicePixelRatio || 1) });
        const c = canvas.current;
        if (!c || cancelled) return;
        c.width = vp.width;
        c.height = vp.height;
        const ctx = c.getContext("2d")!;
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, c.width, c.height);
        await p.render({ canvasContext: ctx, viewport: vp, canvas: c } as Parameters<typeof p.render>[0]).promise;
        if (!cancelled) setSize({ width: view.width, height: view.height });
      } catch (e) {
        if (!cancelled) setError(String((e as Error)?.message ?? e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bytes, page, width]);
  if (error) return <div className="tool-preview tool-preview-error">{error}</div>;
  const s = size ? width / size.width : 0;
  return (
    <div className={`tool-preview${open ? " open" : ""}`} style={{ width, height: size ? size.height * s : width * 1.3 }}>
      <canvas ref={canvas} style={{ width, height: size ? size.height * s : undefined }} />
      {size && children?.(s, size)}
    </div>
  );
}

// ───────────── la herramienta abierta ─────────────

function ToolView({ def, onBack, onOpenPath, setDropHandler }: { def: ToolDef; onBack: () => void; onOpenPath: (p: string) => void; setDropHandler: (h: DropHandler) => void }) {
  if (def.id === "organize") return <OrganizeTool def={def} onBack={onBack} onOpenPath={onOpenPath} setDropHandler={setDropHandler} />;
  if (def.id === "word2pdf" || def.id === "excel2pdf" || def.id === "ppt2pdf") return <OfficePdfTool def={def} onBack={onBack} onOpenPath={onOpenPath} setDropHandler={setDropHandler} />;
  if (def.id === "crop") return <CropTool def={def} onBack={onBack} onOpenPath={onOpenPath} setDropHandler={setDropHandler} />;
  if (def.id === "compare") return <CompareTool def={def} onBack={onBack} setDropHandler={setDropHandler} />;
  if (def.id === "html2pdf") return <HtmlTool def={def} onBack={onBack} onOpenPath={onOpenPath} setDropHandler={setDropHandler} />;
  return <SimpleTool def={def} onBack={onBack} onOpenPath={onOpenPath} setDropHandler={setDropHandler} />;
}

const DEFAULT_NUMBERS: NumberOptions = { position: "bottom-center", format: "n", start: 1, from: 1, size: 11, margin: 28, color: "#333333" };
const DEFAULT_MARK: MarkOptions = { kind: "text", text: "CONFIDENCIAL", color: "#C42B45", image: null, scale: 0.6, opacity: 0.3, rotation: 45, position: "center", layer: "over", pages: "" };

function SimpleTool({ def, onBack, onOpenPath, setDropHandler }: { def: ToolDef; onBack: () => void; onOpenPath: (p: string) => void; setDropHandler: (h: DropHandler) => void }) {
  const [error, setError] = useState<string | null>(null);
  const list = useFiles(def, setDropHandler, setError);
  const { files } = list;
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<ToolResult | null>(null);
  // Opciones de cada herramienta.
  const [level, setLevel] = useState<CompressLevel>("recommended");
  const [split, setSplit] = useState<SplitMode>({ kind: "each" });
  const [ranges, setRanges] = useState("");
  const [every, setEvery] = useState(2);
  const [numbers, setNumbers] = useState<NumberOptions>(DEFAULT_NUMBERS);
  const [images, setImages] = useState<ImagesOptions>({ size: "fit", orientation: "auto", margin: 0, single: true });
  const [dpi, setDpi] = useState(150);
  const [format, setFormat] = useState<ImageFormat>("jpg");
  const [editable, setEditable] = useState(true);
  const [mark, setMark] = useState<MarkOptions>(DEFAULT_MARK);
  const [markImage, setMarkImage] = useState<{ name: string; url: string } | null>(null);
  const [pages, setPages] = useState(0);
  const [angle, setAngle] = useState(90);
  const [rotatePages, setRotatePages] = useState("");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");

  const total = files.reduce((n, f) => n + f.bytes.length, 0);
  const first = files[0];

  async function run() {
    if (!files.length) return;
    setError(null);
    setResult(null);
    try {
      const outputs: Output[] = [];
      const lines: string[] = [];
      let ext = "pdf";
      let filter = "PDF";
      let open: ToolResult["open"];
      const each = async (fn: (f: InputFile, i: number) => Promise<void>) => {
        for (const [i, f] of files.entries()) {
          setBusy(files.length > 1 ? `${def.action}… (${i + 1} de ${files.length})` : `${def.action}…`);
          await fn(f, i);
        }
      };
      switch (def.id) {
        case "compress": {
          let before = 0,
            after = 0;
          await each(async (f) => {
            const out = await compressPdf(f.bytes, f.name, level);
            before += f.bytes.length;
            after += out.length;
            outputs.push({ name: `${baseName(f.name)} (comprimido).pdf`, bytes: out });
          });
          const saved = before - after;
          lines.push(
            saved > 0
              ? `De ${sizeLabel(before)} a ${sizeLabel(after)}: ${Math.round((saved / before) * 100)} % menos.`
              : files.length === 1
                ? "Ya estaba bien comprimido: no se pudo hacer más ligero sin que se viera peor (se guardó igual)."
                : "Ya estaban bien comprimidos: no se pudieron hacer más ligeros.",
          );
          break;
        }
        case "repair": {
          await each(async (f) => {
            const r = await repairPdf(f.bytes, f.name);
            outputs.push({ name: `${baseName(f.name)} (reparado).pdf`, bytes: r.bytes });
            lines.push(
              r.how === "rewritten"
                ? `${f.name}: se reescribió completo (${r.pages} ${r.pages === 1 ? "página" : "páginas"}).`
                : `${f.name}: estaba muy dañado; se rehizo desde lo que se alcanzó a ver (${r.pages} ${r.pages === 1 ? "página" : "páginas"}${r.lost ? `, ${r.lost} no se pudieron leer` : ""}). Las páginas quedan como imagen con su texto para buscar y copiar.`,
            );
          });
          break;
        }
        case "jpg2pdf": {
          setBusy("Convirtiendo…");
          outputs.push(...(await imagesToPdf(files, images)));
          lines.push(images.single ? `${files.length} ${files.length === 1 ? "imagen" : "imágenes"} en un PDF de ${files.length} ${files.length === 1 ? "página" : "páginas"}.` : `${files.length} PDF, uno por imagen.`);
          break;
        }
        case "pdf2jpg": {
          ext = format;
          filter = format === "png" ? "Imagen PNG" : "Imagen JPG";
          await each(async (f) => {
            outputs.push(...(await pdfToImages(f.bytes, f.name, dpi, format, (d, t) => setBusy(`Convirtiendo… página ${d} de ${t}`))));
          });
          lines.push(`${outputs.length} ${outputs.length === 1 ? "imagen" : "imágenes"} ${format.toUpperCase()} a ${dpi} puntos por pulgada.`);
          break;
        }
        case "pdf2pptx": {
          ext = "pptx";
          filter = "Presentación de PowerPoint";
          const bytes = await pdfToPptx(first.bytes, first.name, editable, (d, t) => setBusy(`Convirtiendo… página ${d} de ${t}`));
          outputs.push({ name: `${baseName(first.name)}.pptx`, bytes });
          lines.push(editable ? "Una diapositiva por página, con el texto en cuadros que se pueden cambiar (el fondo, las fotos y las formas quedan como imagen)." : "Una diapositiva por página, cada una como imagen (se ve exactamente igual).");
          break;
        }
        case "pdfa": {
          await each(async (f) => {
            const r = await toPdfA(f.bytes, f.name);
            outputs.push({ name: `${baseName(f.name)} (PDF-A).pdf`, bytes: r.bytes });
            const notes: string[] = [];
            if (r.rasterized.length) notes.push(`${r.rasterized.length === 1 ? "la página" : "las páginas"} ${r.rasterized.join(", ")} ${r.rasterized.length === 1 ? "quedó" : "quedaron"} como imagen con su texto (tenía${r.rasterized.length === 1 ? "" : "n"} letras que no venían en el archivo o colores CMYK)`);
            if (r.removed.length) notes.push(`se quitó lo que PDF/A no permite: ${r.removed.join(", ")}`);
            lines.push(`${f.name}: PDF/A-2b${notes.length ? `; ${notes.join("; ")}` : ""}.`);
          });
          break;
        }
        case "split": {
          setBusy("Dividiendo…");
          const mode: SplitMode = split.kind === "ranges" ? { kind: "ranges", text: ranges } : split.kind === "every" ? { kind: "every", n: Math.max(1, every) } : split;
          outputs.push(...(await splitPdf(first.bytes, first.name, mode)));
          lines.push(`${outputs.length} ${outputs.length === 1 ? "archivo" : "archivos"} PDF.`);
          break;
        }
        case "numbers": {
          await each(async (f) => {
            outputs.push({ name: `${baseName(f.name)} (numerado).pdf`, bytes: await addPageNumbers(f.bytes, f.name, numbers) });
          });
          lines.push(`Números de página puestos (${numberText(numbers.format, numbers.start, numbers.start + Math.max(0, pages - numbers.from))}…).`);
          break;
        }
        case "watermark": {
          await each(async (f) => {
            outputs.push({ name: `${baseName(f.name)} (marca de agua).pdf`, bytes: await watermarkPdf(f.bytes, f.name, mark) });
          });
          lines.push(mark.kind === "text" ? `Marca de agua «${mark.text.trim()}» puesta.` : "Marca de agua con imagen puesta.");
          break;
        }
        case "merge": {
          if (files.length < 2) throw new Error("Agrega al menos dos PDF para unirlos");
          setBusy("Uniendo…");
          outputs.push({ name: `${baseName(first.name)} (unido).pdf`, bytes: await mergePdfs(files) });
          lines.push(`${files.length} PDF unidos en uno, en el orden de la lista.`);
          break;
        }
        case "rotate": {
          await each(async (f) => {
            outputs.push({ name: `${baseName(f.name)} (girado).pdf`, bytes: await rotatePdf(f.bytes, f.name, angle, rotatePages) });
          });
          lines.push(`${rotatePages.trim() ? `Páginas ${rotatePages.trim()}` : "Todas las páginas"} giradas ${angle === 270 ? "90° a la izquierda" : angle === 180 ? "180°" : "90° a la derecha"}.`);
          break;
        }
        case "protect": {
          if (password.length < 4) throw new Error("La contraseña debe tener al menos 4 caracteres");
          if (password !== password2) throw new Error("Las dos contraseñas no coinciden");
          await each(async (f) => {
            outputs.push({ name: `${baseName(f.name)} (protegido).pdf`, bytes: await protectPdf(f.bytes, f.name, password) });
          });
          lines.push(`Ahora ${files.length === 1 ? "pide" : "piden"} contraseña para abrirse (AES de 256 bits). Guárdala bien: no hay manera de recuperarla.`);
          break;
        }
        case "unlock": {
          await each(async (f) => {
            const r = await unlockPdf(f.bytes, f.name, password);
            outputs.push({ name: `${baseName(f.name)} (desbloqueado).pdf`, bytes: r.bytes });
            lines.push(`${f.name}: ${r.had === "password" ? "se quitó la contraseña" : r.had === "permissions" ? "se quitaron los permisos (ya se puede imprimir, copiar y editar)" : "no tenía contraseña ni permisos"}.`);
          });
          break;
        }
        case "ocr": {
          await each(async (f, i) => {
            const r = await ocrPdf(f.bytes, f.name, (d, t) => setBusy(`Reconociendo texto${files.length > 1 ? ` (${i + 1} de ${files.length})` : ""}… página ${d} de ${t}`));
            outputs.push({ name: `${baseName(f.name)} (con texto).pdf`, bytes: r.bytes });
            lines.push(r.pages ? `${f.name}: se reconoció el texto de ${r.pages} ${r.pages === 1 ? "página" : "páginas"}.` : `${f.name}: ya tenía texto en todas sus páginas.`);
          });
          break;
        }
        case "pdf2docx": {
          ext = "docx";
          filter = "Documento de Word";
          await each(async (f) => {
            outputs.push({ name: `${baseName(f.name)}.docx`, bytes: await pdfToDocx(f.bytes, f.name, (d, t) => setBusy(`Convirtiendo… página ${d} de ${t}`)) });
          });
          lines.push(`${files.length === 1 ? "Un documento" : `${files.length} documentos`} de Word que se ${files.length === 1 ? "puede" : "pueden"} editar.`);
          break;
        }
        case "pdf2xlsx": {
          ext = "xlsx";
          filter = "Libro de Excel";
          await each(async (f) => {
            const out = await pdfToXlsx(f.bytes, f.name, (d, t) => setBusy(`Convirtiendo… página ${d} de ${t}`));
            outputs.push(out);
            lines.push(`${f.name}: ${out.tables} ${out.tables === 1 ? "tabla" : "tablas"}, una por hoja.`);
          });
          break;
        }
        default:
          return;
      }
      setBusy("Guardando…");
      const saved = await saveOutputs(outputs, first?.path ?? null, filter, ext);
      if (!saved) return;
      if (saved.paths.length > 1) lines.push(`Se guardaron ${saved.paths.length} archivos en la carpeta que elegiste.`);
      if (def.id === "pdf2pptx") open = { path: saved.paths[0], label: "Abrir en WEPO Present" };
      else if (def.id === "pdf2docx" && saved.paths.length === 1) open = { path: saved.paths[0], label: "Abrir en WEPO Write" };
      else if (def.id === "pdf2xlsx" && saved.paths.length === 1) open = { path: saved.paths[0], label: "Abrir en WEPO Sheets" };
      else if (ext === "pdf" && saved.paths.length === 1) open = { path: saved.paths[0], label: "Abrir en WEPO PDF" };
      setResult({ lines, saved, open });
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(null);
    }
  }

  const options = (() => {
    switch (def.id) {
      case "compress":
        return (
          <fieldset className="tool-options" disabled={!!busy}>
            <legend>Qué tanto</legend>
            {(
              [
                ["low", "Poca", "Casi no se nota la diferencia; pesa un poco menos."],
                ["recommended", "Recomendada", "Buena calidad y bastante más ligero."],
                ["extreme", "Mucha", "Lo más ligero posible; las fotos pierden detalle."],
              ] as [CompressLevel, string, string][]
            ).map(([id, name, hint]) => (
              <label key={id} className={`tool-choice${level === id ? " on" : ""}`}>
                <input type="radio" name="level" checked={level === id} onChange={() => setLevel(id)} />
                <span>
                  <b>{name}</b>
                  <small>{hint}</small>
                </span>
              </label>
            ))}
          </fieldset>
        );
      case "split":
        return (
          <fieldset className="tool-options" disabled={!!busy}>
            <legend>Cómo dividir{pages ? ` (${pages} páginas)` : ""}</legend>
            <label className={`tool-choice${split.kind === "each" ? " on" : ""}`}>
              <input type="radio" name="split" checked={split.kind === "each"} onChange={() => setSplit({ kind: "each" })} />
              <span>
                <b>Un archivo por página</b>
              </span>
            </label>
            <label className={`tool-choice${split.kind === "ranges" ? " on" : ""}`}>
              <input type="radio" name="split" checked={split.kind === "ranges"} onChange={() => setSplit({ kind: "ranges", text: ranges })} />
              <span>
                <b>Por rangos</b>
                <small>Un archivo por cada rango</small>
              </span>
            </label>
            {split.kind === "ranges" && (
              <input className="input" placeholder="Por ejemplo: 1-3, 4, 5-8" value={ranges} aria-label="Rangos de páginas" onChange={(e) => setRanges(e.target.value)} autoFocus />
            )}
            <label className={`tool-choice${split.kind === "every" ? " on" : ""}`}>
              <input type="radio" name="split" checked={split.kind === "every"} onChange={() => setSplit({ kind: "every", n: every })} />
              <span>
                <b>Cada cierto número de páginas</b>
              </span>
            </label>
            {split.kind === "every" && (
              <label className="tool-field">
                Páginas por archivo
                <input className="input" type="number" min={1} value={every} aria-label="Páginas por archivo" onChange={(e) => setEvery(Math.max(1, Number(e.target.value) || 1))} />
              </label>
            )}
            {split.kind === "ranges" && pages > 0 && ranges.trim() && <RangeHint text={ranges} total={pages} />}
          </fieldset>
        );
      case "numbers":
        return <NumbersOptions o={numbers} set={setNumbers} pages={pages} disabled={!!busy} />;
      case "jpg2pdf":
        return (
          <fieldset className="tool-options" disabled={!!busy}>
            <legend>Página</legend>
            <label className="tool-field">
              Tamaño
              <select className="input" value={images.size} aria-label="Tamaño de la página" onChange={(e) => setImages({ ...images, size: e.target.value as ImagesOptions["size"] })}>
                <option value="fit">Del tamaño de cada imagen</option>
                <option value="letter">Carta</option>
                <option value="a4">A4</option>
              </select>
            </label>
            {images.size !== "fit" && (
              <label className="tool-field">
                Orientación
                <select className="input" value={images.orientation} aria-label="Orientación" onChange={(e) => setImages({ ...images, orientation: e.target.value as ImagesOptions["orientation"] })}>
                  <option value="auto">Según la imagen</option>
                  <option value="portrait">Vertical</option>
                  <option value="landscape">Horizontal</option>
                </select>
              </label>
            )}
            <label className="tool-field">
              Margen
              <select className="input" value={images.margin} aria-label="Margen" onChange={(e) => setImages({ ...images, margin: Number(e.target.value) })}>
                <option value={0}>Sin margen</option>
                <option value={18}>Pequeño</option>
                <option value={40}>Grande</option>
              </select>
            </label>
            <label className="tool-check">
              <input type="checkbox" checked={images.single} onChange={(e) => setImages({ ...images, single: e.target.checked })} />
              Juntar todas en un solo PDF
            </label>
            {files.length > 1 && <p className="hint">Las páginas van en el orden de la lista (con ↑ ↓ lo cambias).</p>}
          </fieldset>
        );
      case "pdf2jpg":
        return (
          <fieldset className="tool-options" disabled={!!busy}>
            <legend>Imágenes</legend>
            <label className="tool-field">
              Nitidez
              <select className="input" value={dpi} aria-label="Nitidez" onChange={(e) => setDpi(Number(e.target.value))}>
                <option value={72}>Normal (72 ppp): para ver en pantalla</option>
                <option value={150}>Alta (150 ppp)</option>
                <option value={300}>Para imprimir (300 ppp)</option>
              </select>
            </label>
            <label className="tool-field">
              Formato
              <select className="input" value={format} aria-label="Formato" onChange={(e) => setFormat(e.target.value as ImageFormat)}>
                <option value="jpg">JPG (más ligero)</option>
                <option value="png">PNG (sin pérdida)</option>
              </select>
            </label>
          </fieldset>
        );
      case "pdf2pptx":
        return (
          <fieldset className="tool-options" disabled={!!busy}>
            <legend>Cómo</legend>
            <label className={`tool-choice${editable ? " on" : ""}`}>
              <input type="radio" name="pptx" checked={editable} onChange={() => setEditable(true)} />
              <span>
                <b>Editable</b>
                <small>El texto en cuadros que se pueden cambiar; el resto, como imagen de fondo.</small>
              </span>
            </label>
            <label className={`tool-choice${!editable ? " on" : ""}`}>
              <input type="radio" name="pptx" checked={!editable} onChange={() => setEditable(false)} />
              <span>
                <b>Como imagen</b>
                <small>Cada página idéntica, pero sin poder cambiar el texto.</small>
              </span>
            </label>
          </fieldset>
        );
      case "watermark":
        return <MarkOptionsPanel o={mark} set={setMark} image={markImage} setImage={setMarkImage} disabled={!!busy} />;
      case "pdfa":
        return (
          <div className="tool-options tool-note">
            <p>
              Se convierte a <b>PDF/A-2b</b>: lleva sus letras, su perfil de color y sus datos dentro, sin nada que dependa de afuera (como JavaScript o archivos adjuntos).
            </p>
            <p className="hint">Si una página usa letras que no vienen dentro del PDF, esa página queda como imagen con su texto encima para buscar y copiar.</p>
          </div>
        );
      case "repair":
        return (
          <div className="tool-options tool-note">
            <p>Se lee todo lo que se pueda del PDF y se escribe uno nuevo, limpio.</p>
            <p className="hint">El original no se toca: el reparado se guarda aparte.</p>
          </div>
        );
      case "merge":
        return (
          <div className="tool-options tool-note">
            <p>Se juntan en el orden de la lista: con ↑ ↓ lo cambias.</p>
            {files.length < 2 && <p className="hint">Agrega al menos dos PDF.</p>}
          </div>
        );
      case "rotate":
        return (
          <fieldset className="tool-options" disabled={!!busy}>
            <legend>Cómo girar</legend>
            {(
              [
                [90, "90° a la derecha"],
                [270, "90° a la izquierda"],
                [180, "Darle la vuelta (180°)"],
              ] as [number, string][]
            ).map(([a, name]) => (
              <label key={a} className={`tool-choice${angle === a ? " on" : ""}`}>
                <input type="radio" name="angle" checked={angle === a} onChange={() => setAngle(a)} />
                <span>
                  <b>{name}</b>
                </span>
              </label>
            ))}
            <label className="tool-field">
              Páginas
              <input className="input" value={rotatePages} placeholder="Todas (o por ejemplo 1-3, 5)" aria-label="Páginas que se giran" onChange={(e) => setRotatePages(e.target.value)} />
            </label>
          </fieldset>
        );
      case "protect":
        return (
          <fieldset className="tool-options" disabled={!!busy}>
            <legend>Contraseña</legend>
            <label className="tool-field">
              Contraseña para abrirlo
              <input className="input" type="password" value={password} autoComplete="new-password" aria-label="Contraseña nueva" onChange={(e) => setPassword(e.target.value)} />
            </label>
            <label className="tool-field">
              Escríbela otra vez
              <input className="input" type="password" value={password2} autoComplete="new-password" aria-label="Repetir la contraseña" onChange={(e) => setPassword2(e.target.value)} />
            </label>
            {password && password.length < 4 && <p className="tool-error">Usa al menos 4 caracteres.</p>}
            {password2 && password !== password2 && <p className="tool-error">Las dos no coinciden.</p>}
            <p className="hint">Si se te olvida, no hay manera de recuperarla.</p>
          </fieldset>
        );
      case "unlock":
        return (
          <fieldset className="tool-options" disabled={!!busy}>
            <legend>Contraseña</legend>
            <label className="tool-field">
              La contraseña del PDF
              <input className="input" type="password" value={password} aria-label="Contraseña del PDF" onChange={(e) => setPassword(e.target.value)} />
            </label>
            <p className="hint">Si solo tiene permisos (no deja imprimir o copiar) no hace falta escribir nada.</p>
          </fieldset>
        );
      case "ocr":
        return (
          <div className="tool-options tool-note">
            <p>Se lee el texto de las páginas escaneadas con el reconocimiento de texto de tu sistema (en español e inglés).</p>
            <p className="hint">Las páginas se ven igual; el texto queda invisible encima, para buscar y copiar.</p>
          </div>
        );
      case "pdf2docx":
      case "pdf2xlsx":
        return (
          <div className="tool-options tool-note">
            <p>{def.id === "pdf2docx" ? "Títulos, párrafos, listas, tablas, imágenes, encabezado y pie se vuelven parte del documento de Word." : "Cada tabla con bordes del PDF va en su propia hoja, con números de verdad y celdas combinadas."}</p>
            <p className="hint">Si el PDF es un escaneo, primero pásalo por «OCR PDF».</p>
          </div>
        );
      default:
        return null;
    }
  })();

  const preview = first && (def.id === "numbers" || def.id === "watermark") && extensionOf(first.name) === "pdf" && (
    <PagePreview bytes={first.bytes} width={260} onSize={(doc) => setPages(doc.numPages)}>
      {(s, size) => (def.id === "numbers" ? <NumbersOverlay o={numbers} s={s} size={size} total={pages} /> : <MarkOverlay o={mark} image={markImage?.url ?? null} s={s} size={size} />)}
    </PagePreview>
  );

  // Cuántas páginas tiene (para dividir).
  useEffect(() => {
    if (def.id !== "split" || !first) return;
    let gone = false;
    proxyOf(first.bytes, first.name)
      .then((d) => !gone && setPages(d.numPages))
      .catch((e) => !gone && setError(String(e?.message ?? e)));
    return () => {
      gone = true;
    };
  }, [def.id, first]);

  return (
    <ToolFrame def={def} onBack={onBack}>
      <div className="tool-body">
        <div className="tool-main">
          <FileList def={def} {...list} />
          {preview && <div className="tool-preview-wrap">{preview}</div>}
        </div>
        <aside className="tool-side">
          {options}
          {error && (
            <p className="tool-error" role="alert">
              {error}
            </p>
          )}
          {result ? (
            <ResultBox
              result={result}
              onOpenPath={onOpenPath}
              onReset={() => {
                setResult(null);
                list.setFiles([]);
              }}
            />
          ) : (
            <button type="button" className="btn btn-primary tool-run" disabled={!files.length || !!busy} onClick={run}>
              {busy ?? def.action}
            </button>
          )}
          {files.length > 1 && !result && <p className="hint">{`${files.length} archivos · ${sizeLabel(total)}`}</p>}
        </aside>
      </div>
    </ToolFrame>
  );
}

function RangeHint({ text, total }: { text: string; total: number }) {
  try {
    const r = parseRanges(text, total);
    return <p className="hint">{`${r.length} ${r.length === 1 ? "archivo" : "archivos"}: ${r.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(" · ")}`}</p>;
  } catch (e) {
    return <p className="tool-error">{String((e as Error).message)}</p>;
  }
}

// ───────────── números de página ─────────────

const POSITIONS: [NumberPosition, string][] = [
  ["top-left", "Arriba a la izquierda"],
  ["top-center", "Arriba al centro"],
  ["top-right", "Arriba a la derecha"],
  ["bottom-left", "Abajo a la izquierda"],
  ["bottom-center", "Abajo al centro"],
  ["bottom-right", "Abajo a la derecha"],
];

function NumbersOptions({ o, set, pages, disabled }: { o: NumberOptions; set: (o: NumberOptions) => void; pages: number; disabled: boolean }) {
  return (
    <fieldset className="tool-options" disabled={disabled}>
      <legend>Dónde</legend>
      <div className="tool-positions six" role="radiogroup" aria-label="Posición del número">
        {POSITIONS.map(([id, name]) => (
          <button key={id} type="button" role="radio" aria-checked={o.position === id} aria-label={name} title={name} className={o.position === id ? "on" : ""} onClick={() => set({ ...o, position: id })}>
            <span />
          </button>
        ))}
      </div>
      <label className="tool-field">
        Cómo
        <select className="input" value={o.format} aria-label="Formato del número" onChange={(e) => set({ ...o, format: e.target.value as NumberFormat })}>
          {(["n", "page-n", "page-n-of", "n-of"] as NumberFormat[]).map((f) => (
            <option key={f} value={f}>
              {numberText(f, 1, Math.max(pages, 1))}
            </option>
          ))}
        </select>
      </label>
      <div className="tool-row">
        <label className="tool-field">
          Primer número
          <input className="input" type="number" min={0} value={o.start} aria-label="Primer número" onChange={(e) => set({ ...o, start: Math.max(0, Number(e.target.value) || 0) })} />
        </label>
        <label className="tool-field">
          Desde la página
          <input className="input" type="number" min={1} max={pages || undefined} value={o.from} aria-label="Desde la página" onChange={(e) => set({ ...o, from: Math.max(1, Math.min(pages || 9999, Number(e.target.value) || 1)) })} />
        </label>
      </div>
      <div className="tool-row">
        <label className="tool-field">
          Tamaño
          <select className="input" value={o.size} aria-label="Tamaño de letra" onChange={(e) => set({ ...o, size: Number(e.target.value) })}>
            {[8, 9, 10, 11, 12, 14, 16, 20].map((n) => (
              <option key={n} value={n}>
                {n} pt
              </option>
            ))}
          </select>
        </label>
        <label className="tool-field">
          Margen
          <select className="input" value={o.margin} aria-label="Margen del número" onChange={(e) => set({ ...o, margin: Number(e.target.value) })}>
            <option value={16}>Pequeño</option>
            <option value={28}>Normal</option>
            <option value={48}>Grande</option>
          </select>
        </label>
        <label className="tool-field tool-color">
          Color
          <input type="color" value={o.color} aria-label="Color del número" onChange={(e) => set({ ...o, color: e.target.value })} />
        </label>
      </div>
      {o.from > 1 && <p className="hint">{`Las páginas 1 a ${o.from - 1} quedan sin número (por ejemplo, la portada).`}</p>}
    </fieldset>
  );
}

function NumbersOverlay({ o, s, size, total }: { o: NumberOptions; s: number; size: { width: number; height: number }; total: number }) {
  if (o.from > 1) return null;
  const [v, h] = o.position.split("-");
  const text = numberText(o.format, o.start, o.start + Math.max(0, total - o.from));
  const style: React.CSSProperties = { position: "absolute", fontSize: o.size * s, color: o.color, fontFamily: "Helvetica, Arial, sans-serif", whiteSpace: "nowrap", lineHeight: 1 };
  if (v === "top") style.top = (o.margin - o.size * 0.05) * s;
  else style.bottom = (o.margin - o.size * 0.2) * s;
  if (h === "left") style.left = o.margin * s;
  else if (h === "right") style.right = o.margin * s;
  else (style.left = (size.width / 2) * s, (style.transform = "translateX(-50%)"));
  return (
    <span className="tool-number-preview" style={style}>
      {text}
    </span>
  );
}

// ───────────── marca de agua ─────────────

const MARK_POSITIONS: [MarkPosition, string][] = [
  ["top-left", "Arriba a la izquierda"],
  ["top-center", "Arriba al centro"],
  ["top-right", "Arriba a la derecha"],
  ["middle-left", "En medio a la izquierda"],
  ["center", "En el centro"],
  ["middle-right", "En medio a la derecha"],
  ["bottom-left", "Abajo a la izquierda"],
  ["bottom-center", "Abajo al centro"],
  ["bottom-right", "Abajo a la derecha"],
];

function MarkOptionsPanel({ o, set, image, setImage, disabled }: { o: MarkOptions; set: (o: MarkOptions) => void; image: { name: string; url: string } | null; setImage: (i: { name: string; url: string } | null) => void; disabled: boolean }) {
  const [err, setErr] = useState<string | null>(null);
  async function chooseImage() {
    const [path] = await pickFiles("Imagen (PNG, JPG)", ["png", "jpg", "jpeg", "gif", "webp"], false);
    if (!path) return;
    try {
      const file = await readInput(path);
      const ext = extensionOf(path);
      const mime = ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : ext === "webp" ? "image/webp" : "image/jpeg";
      const url = URL.createObjectURL(new Blob([file.bytes as BlobPart], { type: mime }));
      setImage({ name: file.name, url });
      set({ ...o, kind: "image", image: file.bytes, scale: Math.min(o.scale, 0.4) });
      setErr(null);
    } catch (e) {
      setErr(String(e));
    }
  }
  return (
    <fieldset className="tool-options" disabled={disabled}>
      <div className="tool-tabs" role="tablist" aria-label="Tipo de marca de agua">
        <button type="button" role="tab" aria-selected={o.kind === "text"} className={o.kind === "text" ? "on" : ""} onClick={() => set({ ...o, kind: "text" })}>
          Texto
        </button>
        <button type="button" role="tab" aria-selected={o.kind === "image"} className={o.kind === "image" ? "on" : ""} onClick={() => set({ ...o, kind: "image" })}>
          Imagen
        </button>
      </div>
      {o.kind === "text" ? (
        <div className="tool-row">
          <label className="tool-field" style={{ flex: 1 }}>
            Texto
            <input className="input" value={o.text} maxLength={60} aria-label="Texto de la marca de agua" onChange={(e) => set({ ...o, text: e.target.value })} />
          </label>
          <label className="tool-field tool-color">
            Color
            <input type="color" value={o.color} aria-label="Color de la marca de agua" onChange={(e) => set({ ...o, color: e.target.value })} />
          </label>
        </div>
      ) : (
        <div className="tool-mark-image">
          {image ? <img src={image.url} alt="" /> : <span className="hint">Por ejemplo, el logo de tu empresa (mejor PNG con fondo transparente).</span>}
          <button type="button" className="btn" onClick={chooseImage}>
            {image ? "Cambiar imagen" : "Elegir imagen…"}
          </button>
        </div>
      )}
      {err && <p className="tool-error">{err}</p>}
      <div className="tool-row tool-mark-pos">
        <div>
          <span className="tool-label">Dónde</span>
          <div className="tool-positions nine" role="radiogroup" aria-label="Posición de la marca de agua">
            {MARK_POSITIONS.map(([id, name]) => (
              <button key={id} type="button" role="radio" aria-checked={o.position === id} aria-label={name} title={name} className={o.position === id ? "on" : ""} onClick={() => set({ ...o, position: id })}>
                <span />
              </button>
            ))}
          </div>
          <label className="tool-check">
            <input type="checkbox" checked={o.position === "tile"} onChange={(e) => set({ ...o, position: e.target.checked ? "tile" : "center", scale: e.target.checked ? Math.min(o.scale, 0.3) : o.scale })} />
            En mosaico (repetida)
          </label>
        </div>
        <div className="tool-mark-sliders">
          <label className="tool-field">
            {`Tamaño: ${Math.round(o.scale * 100)} % del ancho`}
            <input type="range" min={0.05} max={1} step={0.05} value={o.scale} aria-label="Tamaño de la marca" onChange={(e) => set({ ...o, scale: Number(e.target.value) })} />
          </label>
          <label className="tool-field">
            {`Transparencia: ${Math.round((1 - o.opacity) * 100)} %`}
            <input type="range" min={0.05} max={1} step={0.05} value={o.opacity} aria-label="Qué tanto se ve" onChange={(e) => set({ ...o, opacity: Number(e.target.value) })} />
          </label>
          <label className="tool-field">
            Giro
            <select className="input" value={o.rotation} aria-label="Giro de la marca" onChange={(e) => set({ ...o, rotation: Number(e.target.value) })}>
              <option value={0}>Sin girar</option>
              <option value={45}>45°</option>
              <option value={90}>90°</option>
              <option value={-45}>−45°</option>
            </select>
          </label>
        </div>
      </div>
      <div className="tool-row">
        <label className="tool-field">
          Capa
          <select className="input" value={o.layer} aria-label="Capa" onChange={(e) => set({ ...o, layer: e.target.value as MarkOptions["layer"] })}>
            <option value="over">Encima del contenido</option>
            <option value="under">Debajo del contenido</option>
          </select>
        </label>
        <label className="tool-field" style={{ flex: 1 }}>
          Páginas
          <input className="input" value={o.pages} placeholder="Todas (o por ejemplo 1-3, 5)" aria-label="Páginas con marca de agua" onChange={(e) => set({ ...o, pages: e.target.value })} />
        </label>
      </div>
    </fieldset>
  );
}

function MarkOverlay({ o, image, s, size }: { o: MarkOptions; image: string | null; s: number; size: { width: number; height: number } }) {
  const mw = size.width * o.scale * s;
  const content =
    o.kind === "image" ? (
      image ? (
        <img src={image} alt="" style={{ width: mw, display: "block" }} />
      ) : null
    ) : (
      <span style={{ fontFamily: "Helvetica, Arial, sans-serif", fontWeight: 700, color: o.color, whiteSpace: "nowrap", fontSize: mw / Math.max(1, o.text.trim().length * 0.62), lineHeight: 1 }}>{o.text.trim()}</span>
    );
  if (!content) return null;
  const item = (key: string | number, left: number, top: number) => (
    <div key={key} className="tool-mark-preview" style={{ left, top, opacity: o.opacity, transform: `translate(-50%, -50%) rotate(${-o.rotation}deg)` }}>
      {content}
    </div>
  );
  const W = size.width * s;
  const H = size.height * s;
  if (o.position === "tile") {
    const out: ReactNode[] = [];
    const stepX = mw * 1.6;
    const stepY = Math.max(mw * 0.8, 30);
    let k = 0;
    for (let y = stepY / 2, row = 0; y < H + stepY; y += stepY, row++) for (let x = (row % 2 ? stepX / 2 : 0) + mw / 2; x < W + stepX; x += stepX) out.push(item(k++, x, y));
    return <div className="tool-mark-tiles">{out}</div>;
  }
  const pad = Math.min(W, H) * 0.05;
  const [v, h] = o.position === "center" ? ["middle", "center"] : o.position.split("-");
  const left = h === "left" ? pad + mw / 2 : h === "right" ? W - pad - mw / 2 : W / 2;
  const top = v === "top" ? pad + 20 : v === "bottom" ? H - pad - 20 : H / 2;
  return item(0, left, top);
}
