import { useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import type { Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import TextAlign from "@tiptap/extension-text-align";
import { Color, FontFamily, FontSize, TextStyle } from "@tiptap/extension-text-style";
import Highlight from "@tiptap/extension-highlight";
import Image from "@tiptap/extension-image";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import { CharacterCount, Placeholder } from "@tiptap/extensions";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import EditorToolbar from "../../components/EditorToolbar";
import { AlignIcon, ColorButton, FONTS, SIZES, Separator, ToolButton } from "../sheets/FormatBar";
import ZoomControl from "../sheets/ZoomControl";
import LinkDialog from "../sheets/LinkDialog";
import { clampZoom, stepZoom } from "../sheets/layout";
import type { PageSize, WriteDocument } from "./docx";
import { LETTER } from "./docx";
import { imageDataUrl, saveWriteDocument } from "../../lib/write";
import { extensionOf, fileNameOf } from "../../lib/documents";
import { onCommand, runCommand } from "../../lib/commands";
import { hasModifier, isMac, isWindows, keys } from "../../lib/platform";
import { loadZoom, saveZoom } from "../../lib/zoom";
import "../sheets/FormatBar.css";
import "./WriteEditor.css";

type Props = {
  initial: WriteDocument;
  path: string | null;
  fileName: string;
  onHome: () => void;
  onOpen: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onSaved: (path: string) => void;
};

/** Tamaños de página comunes, en twips (1/1440 de pulgada). */
const PAGE_SIZES: { label: string; width: number; height: number }[] = [
  { label: "Carta", width: 12240, height: 15840 },
  { label: "A4", width: 11906, height: 16838 },
  { label: "Oficio", width: 12240, height: 20160 },
];

const STYLES = [
  { value: "p", label: "Normal" },
  { value: "1", label: "Título 1" },
  { value: "2", label: "Título 2" },
  { value: "3", label: "Título 3" },
  { value: "quote", label: "Cita" },
];

/** twips → píxeles de pantalla (96 por pulgada). */
const px = (twips: number) => (twips / 1440) * 96;

/** WEPO Write: documentos con formato que se abren y guardan como .docx (y .txt o .md). */
export default function WriteEditor(props: Props) {
  const { initial, onHome, onOpen, onDirtyChange, onSaved } = props;
  const [path, setPath] = useState(props.path);
  const [fileName, setFileName] = useState(props.fileName);
  const [page, setPage] = useState<PageSize>(initial.page ?? LETTER);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState<{ text: string; error?: boolean } | null>(null);
  const [zoom, setZoomState] = useState(() => loadZoom(props.path));
  const [linkDialog, setLinkDialog] = useState<{ text: string; href: string | null } | null>(null);
  // Un archivo con cosas que WEPO todavía no conserva se guarda como copia.
  const [protectedPath] = useState(initial.unsupported.length ? props.path : null);
  const [notice, setNotice] = useState(initial.unsupported.length > 0);
  const loading = useRef(true);

  const extensions = useMemo(
    () => [
      StarterKit.configure({ link: { openOnClick: false, autolink: true, defaultProtocol: "https" } }),
      TextStyle,
      Color,
      FontFamily,
      FontSize,
      Highlight.configure({ multicolor: true }),
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      Image.configure({ inline: true, allowBase64: true, resize: { enabled: true, minWidth: 40, minHeight: 30, alwaysPreserveAspectRatio: true } }),
      Table.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
      CharacterCount,
      Placeholder.configure({ placeholder: "Escribe aquí…" }),
    ],
    [],
  );

  const editor = useEditor({
    extensions,
    content: initial.content,
    autofocus: "start",
    editorProps: { attributes: { class: "write-content", spellcheck: "true", lang: "es" } },
    onUpdate: () => {
      if (loading.current) return;
      setDirty(true);
      onDirtyChange(true);
    },
  });

  useEffect(() => {
    loading.current = false;
  }, []);

  // Los mensajes normales desaparecen solos; los errores se quedan.
  useEffect(() => {
    if (!status || status.error) return;
    const timer = setTimeout(() => setStatus(null), 4000);
    return () => clearTimeout(timer);
  }, [status]);

  // ───────────── guardar ─────────────

  function markSaved(target: string) {
    setPath(target);
    setFileName(fileNameOf(target));
    setDirty(false);
    onDirtyChange(false);
    onSaved(target);
  }

  async function saveTo(target: string) {
    if (!editor) return false;
    try {
      await saveWriteDocument(target, editor.getJSON(), page, editor.getText({ blockSeparator: "\n" }), fileNameOf(target).replace(/\.[^.]+$/, ""));
      markSaved(target);
      const note = extensionOf(target) === "docx" ? "" : " (como texto: sin imágenes ni la mayoría del formato)";
      setStatus({ text: `Guardado${note}` });
      return true;
    } catch (e) {
      setStatus({ text: `No se pudo guardar: ${e}`, error: true });
      return false;
    }
  }

  async function saveDocument(saveAs = false) {
    const ext = path ? extensionOf(path) : "";
    const canOverwrite = path && path !== protectedPath && ["docx", "md", "txt"].includes(ext);
    if (!saveAs && canOverwrite) return saveTo(path);
    const base = (fileName.replace(/\.[^.]+$/, "") || "Sin título") + (protectedPath && path === protectedPath ? " (copia)" : "");
    const target = await save({
      defaultPath: `${base}.docx`,
      filters: [
        { name: "Documento de Word (.docx)", extensions: ["docx"] },
        { name: "Markdown (.md)", extensions: ["md"] },
        { name: "Texto (.txt)", extensions: ["txt"] },
      ],
    });
    if (!target) return false;
    const finalPath = /\.(docx|md|txt)$/i.test(target) ? target : `${target}.docx`;
    if (finalPath === protectedPath) {
      setStatus({ text: "Elige otro nombre: así no se pierde lo que WEPO no conserva del original.", error: true });
      return false;
    }
    return saveTo(finalPath);
  }

  // ───────────── zoom e impresión ─────────────

  function setZoom(next: number) {
    const value = clampZoom(next);
    setZoomState(value);
    saveZoom(path, value);
  }

  function print() {
    invoke("print_window").catch(() => window.print());
  }

  // ───────────── vínculos e imágenes ─────────────

  function openLinkDialog() {
    if (!editor) return;
    const { from, to } = editor.state.selection;
    editor.chain().focus().extendMarkRange("link").run();
    const href = (editor.getAttributes("link").href as string | undefined) ?? null;
    const text = editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to, " ") || editor.state.doc.textBetween(from, to, " ");
    setLinkDialog({ text, href });
  }

  async function saveLink(target: string, text: string) {
    if (!editor) return false;
    const href = /^(https?:|mailto:|tel:|#)/.test(target) ? target : target.includes("@") && !target.includes("/") ? `mailto:${target}` : `https://${target}`;
    const { empty } = editor.state.selection;
    if (empty || (text && text !== editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to, " "))) {
      editor.chain().focus().insertContent({ type: "text", text: text || target, marks: [{ type: "link", attrs: { href } }] }).run();
    } else {
      editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
    }
    return true;
  }

  async function insertImage() {
    const file = await openDialog({ multiple: false, filters: [{ name: "Imágenes", extensions: ["png", "jpg", "jpeg", "gif"] }] });
    if (!file || !editor) return;
    try {
      const src = await imageDataUrl(file);
      editor.chain().focus().setImage({ src, alt: fileNameOf(file) }).run();
    } catch (e) {
      setStatus({ text: `No se pudo insertar la imagen: ${e}`, error: true });
    }
  }

  // ───────────── órdenes del menú y atajos ─────────────

  const commands = useRef({ saveDocument, print, setZoom, zoom, openLinkDialog });
  commands.current = { saveDocument, print, setZoom, zoom, openLinkDialog };
  useEffect(() => {
    const stop = onCommand((command) => {
      const c = commands.current;
      if (command === "save") c.saveDocument(false);
      else if (command === "save-as") c.saveDocument(true);
      else if (command === "print") c.print();
      else if (command === "zoom-in") c.setZoom(stepZoom(c.zoom, 1));
      else if (command === "zoom-out") c.setZoom(stepZoom(c.zoom, -1));
      else if (command === "zoom-reset") c.setZoom(1);
    });
    function onKey(e: globalThis.KeyboardEvent) {
      if (!hasModifier(e)) return;
      const key = e.key.toLowerCase();
      const command =
        key === "s" ? (e.shiftKey ? "save-as" : "save")
        : key === "p" ? "print"
        : key === "=" || key === "+" ? "zoom-in"
        : key === "-" ? "zoom-out"
        : key === "0" ? "zoom-reset"
        : null;
      if (command) {
        e.preventDefault();
        runCommand(command);
      } else if (key === "k") {
        e.preventDefault();
        commands.current.openLinkDialog();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => {
      stop();
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  // ⌘ + clic (Ctrl en Windows) en un vínculo lo abre en el navegador.
  function onContentMouseDown(e: React.MouseEvent) {
    const link = (e.target as HTMLElement).closest("a[href]") as HTMLAnchorElement | null;
    if (!link || !hasModifier(e)) return;
    e.preventDefault();
    const href = link.getAttribute("href") ?? "";
    if (!href.startsWith("#")) openUrl(href).catch((err) => setStatus({ text: `No se pudo abrir el vínculo: ${err}`, error: true }));
  }

  const counts = useEditorState({
    editor,
    selector: ({ editor }) => ({
      words: editor?.storage.characterCount?.words() ?? 0,
      characters: editor?.storage.characterCount?.characters() ?? 0,
    }),
  });

  const pageLabel = PAGE_SIZES.find((s) => s.width === page.width && s.height === page.height)?.label ?? "Personalizado";
  const pageCss = `@page { size: ${page.width / 1440}in ${page.height / 1440}in; margin: ${page.top / 1440}in ${page.right / 1440}in ${page.bottom / 1440}in ${page.left / 1440}in; }`;

  const toolbarActions = (
    <div className="toolbar-group">
      <button className="btn btn-icon" onClick={() => editor?.chain().focus().undo().run()} title={keys("Deshacer (⌘Z)")} aria-label="Deshacer">
        ↶
      </button>
      <button className="btn btn-icon" onClick={() => editor?.chain().focus().redo().run()} title={keys("Rehacer (⌘⇧Z)")} aria-label="Rehacer">
        ↷
      </button>
      <button className="btn btn-icon" onClick={print} title={keys("Imprimir o exportar a PDF (⌘P)")} aria-label="Imprimir">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
          <path d="M7 8V3h10v5M7 17H4v-7a2 2 0 012-2h12a2 2 0 012 2v7h-3" />
          <rect x="7" y="14" width="10" height="7" rx="1" />
        </svg>
      </button>
      <button className="btn" onClick={() => saveDocument()} title={keys("Guardar (⌘S)")}>
        Guardar
      </button>
    </div>
  );

  return (
    <div className="editor kind-write">
      <style>{`@media print { ${pageCss} }`}</style>
      <EditorToolbar kind="write" fileName={fileName} dirty={dirty} onHome={onHome} onOpen={onOpen} actions={toolbarActions} />
      {editor && <WriteBar editor={editor} onLink={openLinkDialog} onImage={insertImage} />}

      {notice && (
        <div className="sheet-notice write-notice" role="status">
          <span>
            Este documento tiene cosas que WEPO Write todavía no conserva ({initial.unsupported.join(", ")}). Al guardar se crea una
            copia y el original queda intacto.
          </span>
          <button className="btn btn-icon" aria-label="Cerrar aviso" onClick={() => setNotice(false)}>
            ×
          </button>
        </div>
      )}

      <div className="write-canvas">
        <div
          className="write-page"
          style={{
            width: px(page.width),
            minHeight: px(page.height),
            padding: `${px(page.top)}px ${px(page.right)}px ${px(page.bottom)}px ${px(page.left)}px`,
            zoom,
          }}
          onMouseDown={onContentMouseDown}
        >
          <EditorContent editor={editor} />
        </div>
      </div>

      <footer className="write-footer">
        <span>
          {counts?.words ?? 0} {counts?.words === 1 ? "palabra" : "palabras"} · {counts?.characters ?? 0} caracteres
        </span>
        <label className="write-page-size">
          Página:
          <select
            value={pageLabel}
            onChange={(e) => {
              const size = PAGE_SIZES.find((s) => s.label === e.target.value);
              if (!size) return;
              setPage((p) => ({ ...p, width: size.width, height: size.height }));
              setDirty(true);
              onDirtyChange(true);
            }}
          >
            {PAGE_SIZES.map((s) => (
              <option key={s.label}>{s.label}</option>
            ))}
            {pageLabel === "Personalizado" && <option>Personalizado</option>}
          </select>
        </label>
        {status && <span className={`sheet-status ${status.error ? "error" : ""}`}>{status.text}</span>}
        <ZoomControl zoom={zoom} onChange={setZoom} />
      </footer>

      {linkDialog && (
        <LinkDialog
          text={linkDialog.text}
          target={linkDialog.href}
          onSave={saveLink}
          onRemove={() => {
            editor?.chain().focus().extendMarkRange("link").unsetLink().run();
            setLinkDialog(null);
          }}
          onClose={() => {
            setLinkDialog(null);
            editor?.commands.focus();
          }}
        />
      )}
      <p className="write-print-hint" hidden>
        {isMac ? "Guardar como PDF" : isWindows ? "Microsoft Print to PDF" : "Imprimir a un archivo"}
      </p>
    </div>
  );
}

/** Barra de formato de WEPO Write. */
function WriteBar({ editor, onLink, onImage }: { editor: Editor; onLink: () => void; onImage: () => void }) {
  // Se vuelve a dibujar cuando cambia la selección o el formato.
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      style: e.isActive("heading", { level: 1 }) ? "1" : e.isActive("heading", { level: 2 }) ? "2" : e.isActive("heading", { level: 3 }) ? "3" : e.isActive("blockquote") ? "quote" : "p",
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      underline: e.isActive("underline"),
      strike: e.isActive("strike"),
      font: (e.getAttributes("textStyle").fontFamily as string | undefined) ?? "",
      size: (e.getAttributes("textStyle").fontSize as string | undefined) ?? "",
      color: (e.getAttributes("textStyle").color as string | undefined) ?? null,
      highlight: (e.getAttributes("highlight").color as string | undefined) ?? null,
      align: e.isActive({ textAlign: "center" }) ? "center" : e.isActive({ textAlign: "right" }) ? "right" : e.isActive({ textAlign: "justify" }) ? "justify" : "left",
      bullet: e.isActive("bulletList"),
      ordered: e.isActive("orderedList"),
      link: e.isActive("link"),
      table: e.isActive("table"),
    }),
  });
  const chain = () => editor.chain().focus();
  const sizeNumber = s.size ? Math.round(parseFloat(s.size) * (s.size.endsWith("px") ? 0.75 : 1)) : 11;
  const sizes = SIZES.includes(sizeNumber) ? SIZES : [...SIZES, sizeNumber].sort((a, b) => a - b);
  const fontName = s.font.split(",")[0].replace(/["']/g, "").trim();
  const fonts = !fontName || FONTS.includes(fontName) ? FONTS : [fontName, ...FONTS];

  return (
    <div className="format-bar" role="toolbar" aria-label="Formato del texto">
      <select
        className="fb-select write-style"
        aria-label="Estilo del párrafo"
        value={s.style}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "p") chain().setParagraph().run();
          else if (v === "quote") chain().setParagraph().toggleBlockquote().run();
          else chain().setHeading({ level: Number(v) as 1 | 2 | 3 }).run();
        }}
      >
        {STYLES.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <select
        className="fb-select fb-font"
        aria-label="Fuente"
        value={fontName}
        onChange={(e) => (e.target.value ? chain().setFontFamily(e.target.value).run() : chain().unsetFontFamily().run())}
      >
        <option value="">Predeterminada</option>
        {fonts.map((f) => (
          <option key={f} value={f} style={{ fontFamily: f }}>
            {f}
          </option>
        ))}
      </select>
      <select className="fb-select fb-size" aria-label="Tamaño de letra" value={sizeNumber} onChange={(e) => chain().setFontSize(`${e.target.value}pt`).run()}>
        {sizes.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>

      <Separator />
      <ToolButton label={keys("Negrita (⌘B)")} pressed={s.bold} onClick={() => chain().toggleBold().run()}>
        <b>B</b>
      </ToolButton>
      <ToolButton label={keys("Cursiva (⌘I)")} pressed={s.italic} onClick={() => chain().toggleItalic().run()}>
        <i style={{ fontFamily: "Georgia, serif" }}>I</i>
      </ToolButton>
      <ToolButton label={keys("Subrayado (⌘U)")} pressed={s.underline} onClick={() => chain().toggleUnderline().run()}>
        <u>U</u>
      </ToolButton>
      <ToolButton label="Tachado" pressed={s.strike} onClick={() => chain().toggleStrike().run()}>
        <s>S</s>
      </ToolButton>
      <ColorButton
        label="Color de texto"
        current={s.color}
        emptyLabel="Automático"
        onPick={(color) => (color ? chain().setColor(color).run() : chain().unsetColor().run())}
        icon={<span className="fb-letter">A</span>}
      />
      <ColorButton
        label="Resaltado"
        current={s.highlight}
        emptyLabel="Sin resaltado"
        onPick={(color) => (color ? chain().setHighlight({ color }).run() : chain().unsetHighlight().run())}
        icon={
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
            <path d="M9 11l-4 4v3h3l4-4M9 11l5-5 4 4-5 5M9 11l4 4" />
          </svg>
        }
      />

      <Separator />
      <ToolButton label="Alinear a la izquierda" pressed={s.align === "left"} onClick={() => chain().setTextAlign("left").run()}>
        <AlignIcon lines={["M4 6h16", "M4 10h10", "M4 14h16", "M4 18h10"]} />
      </ToolButton>
      <ToolButton label="Centrar" pressed={s.align === "center"} onClick={() => chain().setTextAlign("center").run()}>
        <AlignIcon lines={["M4 6h16", "M7 10h10", "M4 14h16", "M7 18h10"]} />
      </ToolButton>
      <ToolButton label="Alinear a la derecha" pressed={s.align === "right"} onClick={() => chain().setTextAlign("right").run()}>
        <AlignIcon lines={["M4 6h16", "M10 10h10", "M4 14h16", "M10 18h10"]} />
      </ToolButton>
      <ToolButton label="Justificar" pressed={s.align === "justify"} onClick={() => chain().setTextAlign("justify").run()}>
        <AlignIcon lines={["M4 6h16", "M4 10h16", "M4 14h16", "M4 18h16"]} />
      </ToolButton>

      <Separator />
      <ToolButton label="Lista con viñetas" pressed={s.bullet} onClick={() => chain().toggleBulletList().run()}>
        <AlignIcon lines={["M9 6h11", "M9 12h11", "M9 18h11", "M4.5 6h.01", "M4.5 12h.01", "M4.5 18h.01"]} />
      </ToolButton>
      <ToolButton label="Lista numerada" pressed={s.ordered} onClick={() => chain().toggleOrderedList().run()}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
          <path d="M10 6h10M10 12h10M10 18h10" />
          <text x="2" y="8.5" fontSize="7" fill="currentColor" stroke="none">1</text>
          <text x="2" y="14.5" fontSize="7" fill="currentColor" stroke="none">2</text>
          <text x="2" y="20.5" fontSize="7" fill="currentColor" stroke="none">3</text>
        </svg>
      </ToolButton>
      <ToolButton label="Reducir sangría (⇧Tab)" onClick={() => chain().liftListItem("listItem").run()}>
        <AlignIcon lines={["M11 6h9", "M11 12h9", "M11 18h9", "M7 9l-3 3 3 3"]} />
      </ToolButton>
      <ToolButton label="Aumentar sangría (Tab)" onClick={() => chain().sinkListItem("listItem").run()}>
        <AlignIcon lines={["M11 6h9", "M11 12h9", "M11 18h9", "M4 9l3 3-3 3"]} />
      </ToolButton>

      <Separator />
      <ToolButton label={keys("Vínculo (⌘K)")} pressed={s.link} onClick={onLink}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
          <path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1" />
        </svg>
      </ToolButton>
      <ToolButton label="Insertar imagen" onClick={onImage}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <circle cx="9" cy="10" r="2" />
          <path d="M21 17l-5-5-9 8" />
        </svg>
      </ToolButton>
      <ToolButton label="Insertar tabla" onClick={() => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
          <rect x="3" y="4" width="18" height="16" rx="1.5" />
          <path d="M3 9h18M3 14h18M9 4v16M15 4v16" />
        </svg>
      </ToolButton>
      <ToolButton label="Quitar formato" onClick={() => chain().unsetAllMarks().clearNodes().run()}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
          <path d="M6 5h12M12 5l-3 14M4 20l16-16" />
        </svg>
      </ToolButton>

      {s.table && (
        <>
          <Separator />
          <span className="write-table-label">Tabla:</span>
          <button type="button" className="btn write-table-btn" onClick={() => chain().addRowAfter().run()}>
            + Fila
          </button>
          <button type="button" className="btn write-table-btn" onClick={() => chain().addColumnAfter().run()}>
            + Columna
          </button>
          <button type="button" className="btn write-table-btn" onClick={() => chain().deleteRow().run()}>
            − Fila
          </button>
          <button type="button" className="btn write-table-btn" onClick={() => chain().deleteColumn().run()}>
            − Columna
          </button>
          <button type="button" className="btn write-table-btn" onClick={() => chain().deleteTable().run()}>
            Borrar tabla
          </button>
        </>
      )}
    </div>
  );
}
