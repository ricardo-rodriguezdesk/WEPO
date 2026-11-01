// HTML a PDF: una página web guardada en la computadora se dibuja con sus
// estilos y sus imágenes (las que están junto al archivo) y se guarda como PDF
// con el mismo motor de «Exportar como PDF».

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import type { ToolDef } from "./tools";
import type { DropHandler, ToolResult } from "./ToolsScreen";
import { FileList, ResultBox, ToolFrame, useFiles } from "./ToolsScreen";
import { folderOf } from "./io";
import { askPdfPath, printReady, writePdf } from "../lib/exportPdf";
import type { PdfPage } from "../lib/exportPdf";
import { baseName } from "./pdfTools";
import "../editors/sheets/print.css";

const SIZES = { letter: [612, 792], a4: [595.28, 841.89] } as const;
const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml", webp: "image/webp", css: "text/css", woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf" };

/** Junta una ruta relativa con la carpeta del archivo ("img/a.png", "../x.css"). */
export function resolvePath(folder: string, rel: string): string | null {
  if (/^(?:[a-z]+:|\/\/|#)/i.test(rel)) return /^file:\/\//i.test(rel) ? decodeURIComponent(rel.replace(/^file:\/\//i, "")) : null;
  const clean = decodeURIComponent(rel.split(/[?#]/)[0]);
  if (!clean) return null;
  if (clean.startsWith("/")) return clean;
  const parts = folder.split("/");
  for (const p of clean.split("/")) {
    if (p === "..") parts.pop();
    else if (p !== "." && p) parts.push(p);
  }
  return parts.join("/");
}

async function dataUrl(path: string): Promise<string | null> {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  try {
    const b64 = await invoke<string>("file_read", { path });
    return `data:${MIME[ext] ?? "application/octet-stream"};base64,${b64}`;
  } catch {
    return null;
  }
}

async function readText(path: string): Promise<string> {
  const b64 = await invoke<string>("file_read", { path });
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  // La mayoría de las páginas son UTF-8; si no lo son, se leen como Latin-1.
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

/** Cambia los url(…) de una hoja de estilos por los archivos mismos. */
async function inlineCss(css: string, folder: string): Promise<string> {
  const urls = [...css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)];
  let out = css;
  for (const m of urls) {
    const path = resolvePath(folder, m[2]);
    if (!path) continue;
    const data = await dataUrl(path);
    if (data) out = out.split(m[0]).join(`url("${data}")`);
  }
  return out;
}

export type Prepared = { css: string; body: string; title: string; missing: number; srcdoc: string };

/** Lee la página y deja todo adentro: estilos e imágenes. Sin scripts. */
export async function prepareHtml(path: string): Promise<Prepared> {
  const folder = folderOf(path);
  const html = await readText(path);
  const doc = new DOMParser().parseFromString(html, "text/html");
  let missing = 0;
  doc.querySelectorAll("script, noscript, iframe, object, embed, base").forEach((e) => e.remove());
  doc.querySelectorAll("*").forEach((e) => {
    for (const a of Array.from(e.attributes)) if (/^on/i.test(a.name)) e.removeAttribute(a.name);
  });
  const css: string[] = [];
  for (const el of Array.from(doc.querySelectorAll("link[rel~='stylesheet'], style"))) {
    if (el.tagName === "STYLE") {
      css.push(await inlineCss(el.textContent ?? "", folder));
    } else {
      const href = el.getAttribute("href") ?? "";
      const file = resolvePath(folder, href);
      if (file) {
        try {
          css.push(await inlineCss(await readText(file), folderOf(file)));
        } catch {
          missing++;
        }
      }
    }
    el.remove();
  }
  for (const img of Array.from(doc.querySelectorAll<HTMLImageElement>("img[src], image[href], input[type=image][src]"))) {
    const attr = img.hasAttribute("src") ? "src" : "href";
    const file = resolvePath(folder, img.getAttribute(attr) ?? "");
    if (!file) continue;
    const data = await dataUrl(file);
    if (data) img.setAttribute(attr, data);
    else missing++;
    img.removeAttribute("srcset");
    img.removeAttribute("loading");
  }
  for (const el of Array.from(doc.querySelectorAll<HTMLElement>("[style*='url(']"))) el.setAttribute("style", await inlineCss(el.getAttribute("style") ?? "", folder));
  const styles = css.join("\n");
  const body = doc.body?.innerHTML ?? "";
  const bodyAttrs = doc.body ? Array.from(doc.body.attributes).map((a) => `${a.name}="${a.value.replace(/"/g, "&quot;")}"`).join(" ") : "";
  const srcdoc = `<!doctype html><html><head><meta charset="utf-8"><style>${styles}</style></head><body ${bodyAttrs}>${body}</body></html>`;
  return { css: styles, body, title: doc.title, missing, srcdoc };
}

/** Los estilos de la página, para que funcionen dentro de su caja (html y body son la caja). */
export function scopeCss(css: string): string {
  return css.replace(/(^|[\s,{}>+~(])(html|body|:root)(?=[\s,.{:#[>+~)]|$)/gim, "$1.wepo-html");
}

export default function HtmlTool({ def, onBack, onOpenPath, setDropHandler }: { def: ToolDef; onBack: () => void; onOpenPath: (p: string) => void; setDropHandler: (h: DropHandler) => void }) {
  const [error, setError] = useState<string | null>(null);
  const list = useFiles(def, setDropHandler, setError);
  const file = list.files[0];
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [size, setSize] = useState<"letter" | "a4">("letter");
  const [landscape, setLandscape] = useState(false);
  const [margin, setMargin] = useState(36);
  const [busy, setBusy] = useState<string | null>(null);
  const [printing, setPrinting] = useState(false);
  const [result, setResult] = useState<ToolResult | null>(null);

  useEffect(() => {
    setPrepared(null);
    setResult(null);
    if (!file) return;
    let gone = false;
    prepareHtml(file.path)
      .then((p) => !gone && setPrepared(p))
      .catch((e) => !gone && setError(`No se pudo leer la página: ${e}`));
    return () => {
      gone = true;
    };
  }, [file]);

  const [a, b] = SIZES[size];
  const page: PdfPage = landscape ? { width: b, height: a, margin } : { width: a, height: b, margin };

  async function run() {
    if (!file || !prepared) return;
    setError(null);
    const target = await askPdfPath(file.path, file.name);
    if (!target) return;
    try {
      setBusy("Convirtiendo…");
      setPrinting(true);
      // Que se dibuje la versión para imprimir (con sus imágenes) antes de pedir el PDF.
      await new Promise((r) => setTimeout(r, 30));
      await printReady();
      const root = document.querySelector(".html-print-root") as HTMLElement | null;
      const imgs = Array.from(root?.shadowRoot?.querySelectorAll("img") ?? []);
      await Promise.all(imgs.map((img) => (img.complete ? null : img.decode().catch(() => {}))));
      await writePdf(target, page);
      const saved = { paths: [target], folder: folderOf(target) };
      const lines = [`${prepared.title || baseName(file.name)} quedó como PDF en hojas ${size === "a4" ? "A4" : "carta"}${landscape ? " horizontales" : ""}.`];
      if (prepared.missing) lines.push(`${prepared.missing} ${prepared.missing === 1 ? "archivo (imagen o estilo) no se encontró" : "archivos (imágenes o estilos) no se encontraron"} junto a la página.`);
      setResult({ lines, saved, open: { path: target, label: "Abrir en WEPO PDF" } });
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setPrinting(false);
      setBusy(null);
    }
  }

  const previewW = 340;
  const k = previewW / (page.width * (96 / 72));
  return (
    <ToolFrame def={def} onBack={onBack}>
      <div className="tool-body">
        <div className="tool-main">
          <FileList def={def} {...list} />
          {prepared && (
            <div className="tool-html-preview" style={{ width: previewW, height: page.height * (96 / 72) * k }}>
              <iframe
                title="Vista previa de la página"
                sandbox=""
                srcDoc={prepared.srcdoc}
                style={{ width: page.width * (96 / 72), height: page.height * (96 / 72), transform: `scale(${k})`, padding: margin * (96 / 72), boxSizing: "border-box" }}
              />
            </div>
          )}
        </div>
        <aside className="tool-side">
          <fieldset className="tool-options" disabled={!!busy}>
            <legend>Hoja</legend>
            <label className="tool-field">
              Tamaño
              <select className="input" value={size} aria-label="Tamaño de la hoja" onChange={(e) => setSize(e.target.value as "letter" | "a4")}>
                <option value="letter">Carta</option>
                <option value="a4">A4</option>
              </select>
            </label>
            <label className="tool-field">
              Orientación
              <select className="input" value={landscape ? "h" : "v"} aria-label="Orientación" onChange={(e) => setLandscape(e.target.value === "h")}>
                <option value="v">Vertical</option>
                <option value="h">Horizontal</option>
              </select>
            </label>
            <label className="tool-field">
              Margen
              <select className="input" value={margin} aria-label="Margen" onChange={(e) => setMargin(Number(e.target.value))}>
                <option value={0}>Sin margen</option>
                <option value={36}>Normal (1.27 cm)</option>
                <option value={72}>Grande (2.54 cm)</option>
              </select>
            </label>
            <p className="hint">Las imágenes y estilos que estén junto al archivo se incluyen. Lo que venga de internet solo sale si hay conexión; los scripts no se ejecutan.</p>
          </fieldset>
          {error && (
            <p className="tool-error" role="alert">
              {error}
            </p>
          )}
          {result ? (
            <ResultBox result={result} onOpenPath={onOpenPath} onReset={() => (setResult(null), list.setFiles([]))} />
          ) : (
            <button type="button" className="btn btn-primary tool-run" disabled={!prepared || !!busy} onClick={run}>
              {busy ?? def.action}
            </button>
          )}
        </aside>
      </div>
      {printing && prepared && <HtmlPrint prepared={prepared} />}
    </ToolFrame>
  );
}

/** La página para imprimir, fuera de la app y en su propia caja (sus estilos no tocan a WEPO). */
function HtmlPrint({ prepared }: { prepared: Prepared }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>.wepo-html{display:block;font-family:"Times New Roman",Times,serif;font-size:16px;line-height:normal;color:#000;background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact}img{max-width:100%}</style><style>${scopeCss(prepared.css)}</style><div class="wepo-html">${prepared.body}</div>`;
  }, [prepared]);
  return createPortal(<div ref={ref} className="print-root html-print-root" aria-hidden />, document.body);
}
