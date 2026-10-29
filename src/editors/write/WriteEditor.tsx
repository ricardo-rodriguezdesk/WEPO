import { useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import type { Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import TextAlign from "@tiptap/extension-text-align";
import { Color, FontFamily, FontSize, TextStyle } from "@tiptap/extension-text-style";
import Highlight from "@tiptap/extension-highlight";
import Image from "@tiptap/extension-image";
import { Table, TableRow } from "@tiptap/extension-table";
import { CharacterCount, Placeholder } from "@tiptap/extensions";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import EditorToolbar from "../../components/EditorToolbar";
import { AlignIcon, ColorButton, FONTS, Popover, SIZES, Separator, ToolButton } from "../sheets/FormatBar";
import ZoomControl from "../sheets/ZoomControl";
import LinkDialog from "../sheets/LinkDialog";
import { clampZoom, stepZoom } from "../sheets/layout";
import type { HeaderFooterSet, PageSize, WriteDocument } from "./docx";
import { LETTER, NO_HEADER_FOOTER } from "./docx";
import type { PageLayout, ParagraphFormat } from "./extensions";
import { ColoredCell, ColoredHeader, Columns, WepoStrike, PAGE_GAP, PageBreak, Pagination, ParagraphFormatExtension, Search, columnsAt, currentParagraphFormat, fillFields } from "./extensions";
import HeaderFooterDialog from "./HeaderFooterDialog";
import FootnoteDialog from "./FootnoteDialog";
import { Footnote, TableOfContents, footnoteAt, footnotePos, withTocCache } from "./notes";
import ParagraphDialog from "./ParagraphDialog";
import WriteFindBar from "./WriteFindBar";
import ReviewPanel from "./ReviewPanel";
import type { Comment } from "./review";
import { CommentMark, DeletionMark, InsertionMark, Review, initialsOf, newId } from "./review";
import { docxBase64, imageDataUrl, loadAuthor, saveAuthor, saveWriteDocument } from "../../lib/write";
import { recoveryApi } from "../../lib/recovery";
import { extensionOf, fileNameOf } from "../../lib/documents";
import { askPdfPath, printReady, writePdf } from "../../lib/exportPdf";
import { onCommand, runCommand } from "../../lib/commands";
import { hasModifier, isMac, isWindows, keys } from "../../lib/platform";
import { loadZoom, saveZoom } from "../../lib/zoom";
import "../sheets/FormatBar.css";
import WritePrintDialog, { WritePrintPortal, snapshotPages } from "./WritePrint";
import type { CommentEntry, WritePrintJob } from "./WritePrint";
import "./WriteEditor.css";

type Props = {
  initial: WriteDocument;
  path: string | null;
  fileName: string;
  onHome: () => void;
  onOpen: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onSaved: (path: string) => void;
  /** Viene de una copia de recuperación: empieza con cambios sin guardar. */
  recovered?: boolean;
  /** Mensaje al abrir (en lugar del de "documento recuperado"). */
  notice?: string;
};

const AUTOSAVE_KEY = "wepo.autosave";
function loadAutosave(): boolean {
  try {
    return localStorage.getItem(AUTOSAVE_KEY) === "1";
  } catch {
    return false;
  }
}

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

/**
 * El editor siempre agrega un párrafo vacío después de una tabla o un salto al final del documento;
 * se agrega desde antes para que abrir un archivo no cuente como un cambio.
 */
function withTrailingParagraph(content: WriteDocument["content"]): WriteDocument["content"] {
  const blocks = content.content ?? [];
  const last = blocks[blocks.length - 1];
  if (last && (last.type === "paragraph" || last.type === "heading")) return content;
  return { ...content, content: [...blocks, { type: "paragraph" }] };
}

/** twips → píxeles de pantalla (96 por pulgada). */
const px = (twips: number) => (twips / 1440) * 96;

/** WEPO Write: documentos con formato que se abren y guardan como .docx (y .txt o .md). */
export default function WriteEditor(props: Props) {
  const { initial, onHome, onOpen, onDirtyChange, onSaved } = props;
  const [path, setPath] = useState(props.path);
  const [fileName, setFileName] = useState(props.fileName);
  const [page, setPage] = useState<PageSize>(initial.page ?? LETTER);
  const [dirty, setDirty] = useState(Boolean(props.recovered));
  const [autosave, setAutosave] = useState(loadAutosave);
  /** Cuenta los cambios: así se sabe si la copia de recuperación o el archivo ya están al día. */
  const [changes, setChanges] = useState(0);
  const changesRef = useRef(0);
  changesRef.current = changes;
  const recoveredAt = useRef(-1);
  const [status, setStatus] = useState<{ text: string; error?: boolean } | null>(null);
  const [zoom, setZoomState] = useState(() => loadZoom(props.path));
  const [linkDialog, setLinkDialog] = useState<{ text: string; href: string | null } | null>(null);
  const [headerFooter, setHeaderFooter] = useState<HeaderFooterSet>(initial.headerFooter ?? NO_HEADER_FOOTER);
  const [hfDialog, setHfDialog] = useState(false);
  const [paragraphDialog, setParagraphDialog] = useState<ParagraphFormat | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [pages, setPages] = useState(1);
  // Revisión: comentarios, control de cambios y quién firma.
  const [comments, setCommentsState] = useState<Comment[]>(initial.comments ?? []);
  const [author, setAuthorState] = useState("WEPO");
  const authorRef = useRef("WEPO");
  authorRef.current = author;
  const hasChanges = useMemo(() => JSON.stringify(initial.content).includes('"type":"insertion"') || JSON.stringify(initial.content).includes('"type":"deletion"'), [initial]);
  const [reviewOpen, setReviewOpen] = useState(() => (initial.comments?.length ?? 0) > 0 || hasChanges);
  const [editingComment, setEditingComment] = useState<string | null>(null);
  const [tracking, setTrackingState] = useState(false);
  // Un archivo con cosas que WEPO todavía no conserva se guarda como copia.
  // Los .odt se abren pero se guardan como .docx (nuevo archivo).
  const fromOdt = Boolean(props.path && extensionOf(props.path) === "odt");
  const [protectedPath] = useState(initial.unsupported.length ? props.path : null);
  const [notice, setNotice] = useState(initial.unsupported.length > 0 || fromOdt);
  const loading = useRef(true);

  // Lo que la paginación necesita saber de la hoja (se lee en cada medición).
  const layout = useRef<PageLayout>(null!);
  layout.current = {
    width: px(page.width),
    height: px(page.height),
    top: px(page.top),
    right: px(page.right),
    bottom: px(page.bottom),
    left: px(page.left),
    header: headerFooter.header,
    footer: headerFooter.footer,
    skipFirst: headerFooter.skipFirst,
    fileName,
    zoom,
  };

  // Nota al pie que se está escribiendo (posición en el documento, número y texto).
  const [noteEdit, setNoteEdit] = useState<{ pos: number; n: number; text: string; kind: "foot" | "end" } | null>(null);
  const editNote = useRef<(pos: number) => void>(() => {});

  const extensions = useMemo(
    () => [
      StarterKit.configure({ link: { openOnClick: false, autolink: true, defaultProtocol: "https" }, strike: false }),
      WepoStrike,
      TextStyle,
      Color,
      FontFamily,
      FontSize,
      Highlight.configure({ multicolor: true }),
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      Image.configure({ inline: true, allowBase64: true, resize: { enabled: true, minWidth: 40, minHeight: 30, alwaysPreserveAspectRatio: true } }),
      Table.configure({ resizable: true, cellMinWidth: 40, lastColumnResizable: false }),
      TableRow,
      ColoredHeader,
      ColoredCell,
      CharacterCount,
      PageBreak,
      Columns,
      Footnote.configure({ onEdit: (pos) => editNote.current(pos) }),
      TableOfContents,
      ParagraphFormatExtension,
      Search,
      Pagination.configure({ layout: () => layout.current, onPages: setPages }),
      CommentMark,
      InsertionMark,
      DeletionMark,
      Review.configure({ author: () => authorRef.current }),
      Placeholder.configure({ placeholder: "Escribe aquí…" }),
    ],
    [],
  );

  const editor = useEditor({
    extensions,
    content: withTrailingParagraph(initial.content),
    autofocus: "start",
    editorProps: { attributes: { class: "write-content", spellcheck: "true", lang: "es" } },
    onUpdate: () => {
      if (loading.current) return;
      markDirty();
    },
  });

  useEffect(() => {
    loading.current = false;
  }, []);

  editNote.current = (pos) => {
    if (!editor) return;
    const note = footnoteAt(editor.state, pos);
    if (note) setNoteEdit({ pos, ...note });
  };

  function saveNote(text: string) {
    if (!editor || !noteEdit) return;
    const node = editor.state.doc.nodeAt(noteEdit.pos);
    if (node?.type.name !== "footnote") return;
    editor.view.dispatch(editor.state.tr.setNodeMarkup(noteEdit.pos, undefined, { ...node.attrs, text }));
  }

  function deleteNote() {
    if (!editor || !noteEdit) return;
    const node = editor.state.doc.nodeAt(noteEdit.pos);
    if (node?.type.name !== "footnote") return;
    editor.view.dispatch(editor.state.tr.delete(noteEdit.pos, noteEdit.pos + node.nodeSize));
  }

  // Con otra hoja, otro encabezado o zoom, las páginas se vuelven a cortar.
  useEffect(() => {
    editor?.commands.refreshPages();
  }, [editor, page, headerFooter, zoom, fileName]);

  useEffect(() => {
    loadAuthor().then(setAuthorState);
  }, []);

  function setComments(next: Comment[]) {
    setCommentsState(next);
    markDirty();
  }

  function setAuthor(name: string) {
    setAuthorState(name);
    saveAuthor(name);
  }

  function setTracking(on: boolean) {
    setTrackingState(on);
    editor?.commands.setTracking(on);
    if (on) setReviewOpen(true);
    setStatus({ text: on ? "Control de cambios activado: lo que escribas o borres queda marcado" : "Control de cambios desactivado" });
  }

  function addComment() {
    if (!editor) return;
    if (editor.state.selection.empty) {
      setStatus({ text: "Selecciona el texto que quieres comentar" });
      return;
    }
    const id = newId("k");
    editor.commands.addComment(id);
    setComments([...comments, { id, author, initials: initialsOf(author), date: new Date().toISOString().replace(/\.\d+Z$/, "Z"), text: "", done: false, replies: [] }]);
    setReviewOpen(true);
    setEditingComment(id);
  }

  function markDirty() {
    setDirty(true);
    setChanges((n) => n + 1);
    onDirtyChange(true);
  }

  useEffect(() => {
    if (props.recovered) {
      onDirtyChange(true);
      setStatus({ text: props.notice ?? "Documento recuperado: guárdalo para conservar los cambios" });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Los mensajes normales desaparecen solos; los errores se quedan.
  useEffect(() => {
    if (!status || status.error) return;
    const timer = setTimeout(() => setStatus(null), 4000);
    return () => clearTimeout(timer);
  }, [status]);

  // ───────────── guardar ─────────────

  function markSaved(target: string) {
    recoveryApi.clear();
    recoveredAt.current = -1;
    setPath(target);
    setFileName(fileNameOf(target));
    setDirty(false);
    onDirtyChange(false);
    onSaved(target);
  }

  async function saveTo(target: string, quiet = false) {
    if (!editor) return false;
    const savedChanges = changesRef.current;
    try {
      await saveWriteDocument(target, withTocCache(editor.getJSON(), editor.state), page, headerFooter, editor.getText({ blockSeparator: "\n" }), fileNameOf(target).replace(/\.[^.]+$/, ""), comments);
      // Si se siguió escribiendo mientras se guardaba, sigue habiendo cambios.
      if (changesRef.current === savedChanges) markSaved(target);
      else (setPath(target), setFileName(fileNameOf(target)), onSaved(target));
      const note = extensionOf(target) === "docx" ? "" : " (como texto: sin imágenes ni la mayoría del formato)";
      if (!quiet || note) setStatus({ text: `Guardado${note}` });
      return true;
    } catch (e) {
      setStatus({ text: `No se pudo guardar: ${e}`, error: true });
      return false;
    }
  }

  /** Se puede guardar encima del archivo sin preguntar. */
  function canOverwrite(target: string | null): target is string {
    return Boolean(target && target !== protectedPath && ["docx", "md", "txt"].includes(extensionOf(target)));
  }

  async function saveDocument(saveAs = false) {
    if (!saveAs && canOverwrite(path)) return saveTo(path);
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

  // Autoguardado: con el interruptor encendido, se guarda solo un par de segundos después de cada cambio.
  useEffect(() => {
    if (!autosave || !dirty || !canOverwrite(path) || extensionOf(path) !== "docx") return;
    const timer = setTimeout(() => {
      saveTo(path, true).then((ok) => ok || setAutosave(false));
    }, 1500);
    return () => clearTimeout(timer);
  }, [autosave, dirty, changes, path]); // eslint-disable-line react-hooks/exhaustive-deps

  // Copia de recuperación cada 20 segundos mientras haya cambios sin guardar.
  const recoveryState = useRef({ dirty, fileName, path, page, headerFooter, comments });
  recoveryState.current = { dirty, fileName, path, page, headerFooter, comments };
  useEffect(() => {
    const timer = setInterval(async () => {
      const r = recoveryState.current;
      if (!r.dirty || !editor || recoveredAt.current === changesRef.current) return;
      recoveredAt.current = changesRef.current;
      try {
        const data = await docxBase64(withTocCache(editor.getJSON(), editor.state), r.page, r.headerFooter, r.fileName.replace(/\.[^.]+$/, ""), r.comments);
        await recoveryApi.saveFile(r.fileName, r.path, data);
      } catch {
        // Si no se pudo, se intenta en la siguiente vuelta.
        recoveredAt.current = -1;
      }
    }, 20000);
    return () => clearInterval(timer);
  }, [editor]);

  async function toggleAutosave() {
    const next = !autosave;
    if (next && (!canOverwrite(path) || extensionOf(path) !== "docx")) {
      // Como en Word: para autoguardar, primero el documento necesita un lugar (como .docx).
      setStatus({ text: "Elige dónde guardar el documento para activar el autoguardado" });
      if (!(await saveDocument(true))) return;
    }
    setAutosave(next);
    try {
      localStorage.setItem(AUTOSAVE_KEY, next ? "1" : "0");
    } catch {
      // Sin almacenamiento la preferencia no se recuerda.
    }
    setStatus({ text: next ? "Autoguardado activado: cada cambio se guarda solo" : "Autoguardado desactivado" });
  }

  // ───────────── zoom e impresión ─────────────

  function setZoom(next: number) {
    const value = clampZoom(next);
    setZoomState(value);
    saveZoom(path, value);
  }

  // ───────────── imprimir y exportar (con vista previa) ─────────────

  const pageEl = useRef<HTMLDivElement>(null);
  const [printDialog, setPrintDialog] = useState<false | "print" | "pdf">(false);
  const [printOpen, setPrintOpen] = useState<{ current: number; comments: CommentEntry[] } | null>(null);
  const [printJob, setPrintJob] = useState<{ job: WritePrintJob; pdf: string | null } | null>(null);

  function openPrint(mode: "print" | "pdf") {
    const el = pageEl.current;
    if (!el || !editor) return;
    // Página del cursor: dónde cae, contando las franjas entre hojas.
    let current = 0;
    try {
      const rect = el.getBoundingClientRect();
      const y = editor.view.coordsAtPos(editor.state.selection.from).top;
      current = Array.from(el.querySelectorAll(".write-gap-band")).filter((b) => b.getBoundingClientRect().bottom <= y).length;
      if (y < rect.top) current = 0;
    } catch {
      current = 0;
    }
    const entries = comments.map((comment) => ({
      comment,
      quote: Array.from(el.querySelectorAll(`span[data-comment="${CSS.escape(comment.id)}"]`))
        .map((s) => s.textContent ?? "")
        .join(" ")
        .trim(),
    }));
    setPrintOpen({ current, comments: entries });
    setPrintDialog(mode);
  }
  const print = () => openPrint("print");
  const exportPdf = () => openPrint("pdf");

  /** PDF de todo el documento, tal como se ve (el camino directo de siempre). */
  async function exportAll(target: string) {
    setStatus({ text: "Creando el PDF…" });
    try {
      await printReady();
      // Las medidas de la hoja están en vigésimos de punto; el margen ya va dentro de cada página.
      const name = await writePdf(target, { width: page.width / 20, height: page.height / 20, margin: 0 });
      setStatus({ text: `PDF guardado: ${name}` });
    } catch (e) {
      setStatus({ text: `No se pudo exportar el PDF: ${e}`, error: true });
    }
  }

  async function startPrint(job: WritePrintJob, toPdf: boolean, all: boolean) {
    setPrintDialog(false);
    let target: string | null = null;
    if (toPdf) {
      target = await askPdfPath(path, fileName);
      if (!target) return;
    }
    if (all) {
      if (target) await exportAll(target);
      else invoke("print_window").catch(() => window.print());
      return;
    }
    setPrintJob({ job, pdf: target });
  }

  // Páginas elegidas o con comentarios: se imprime la copia recortada.
  useEffect(() => {
    if (!printJob) return;
    let cancelled = false;
    const done = () => setPrintJob(null);
    (async () => {
      await printReady();
      if (cancelled) return;
      if (printJob.pdf) {
        try {
          const { snap } = printJob.job;
          const name = await writePdf(printJob.pdf, { width: (snap.width * 72) / 96, height: (snap.height * 72) / 96, margin: 0 });
          setStatus({ text: `PDF guardado: ${name}` });
        } catch (e) {
          setStatus({ text: `No se pudo exportar el PDF: ${e}`, error: true });
        }
        done();
      } else {
        window.addEventListener("afterprint", done, { once: true });
        invoke("print_window").catch(() => window.print());
      }
    })();
    return () => {
      cancelled = true;
      window.removeEventListener("afterprint", done);
    };
  }, [printJob]);

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

  const openFind = () => setFindOpen(true);
  const addFootnote = () => editor?.chain().focus().insertFootnote().run();
  const addEndnote = () => editor?.chain().focus().insertFootnote("", "end").run();
  const commands = useRef({ saveDocument, print, exportPdf, setZoom, zoom, openLinkDialog, openFind, addComment, addFootnote, addEndnote, setTracking, tracking });
  commands.current = { saveDocument, print, exportPdf, setZoom, zoom, openLinkDialog, openFind, addComment, addFootnote, addEndnote, setTracking, tracking };
  useEffect(() => {
    const stop = onCommand((command) => {
      const c = commands.current;
      if (command === "save") c.saveDocument(false);
      else if (command === "save-as") c.saveDocument(true);
      else if (command === "print") c.print();
      else if (command === "export-pdf") void c.exportPdf();
      else if (command === "zoom-in") c.setZoom(stepZoom(c.zoom, 1));
      else if (command === "zoom-out") c.setZoom(stepZoom(c.zoom, -1));
      else if (command === "zoom-reset") c.setZoom(1);
      else if (command === "find") c.openFind();
    });
    function onKey(e: globalThis.KeyboardEvent) {
      if (!hasModifier(e)) return;
      const key = e.key.toLowerCase();
      // ⌘⌥M: comentario nuevo; ⌘⇧E: control de cambios (los mismos atajos de Word).
      if (e.altKey && (e.code === "KeyM" || key === "m")) {
        e.preventDefault();
        commands.current.addComment();
        return;
      }
      // ⌘⌥F: nota al pie (como en Word).
      if (e.altKey && (e.code === "KeyF" || key === "f")) {
        e.preventDefault();
        commands.current.addFootnote();
        return;
      }
      // ⌘⌥D: nota al final (como en Word).
      if (e.altKey && (e.code === "KeyD" || key === "d")) {
        e.preventDefault();
        commands.current.addEndnote();
        return;
      }
      if (e.shiftKey && key === "e") {
        e.preventDefault();
        commands.current.setTracking(!commands.current.tracking);
        return;
      }
      const command =
        key === "s" ? (e.shiftKey ? "save-as" : "save")
        : key === "p" ? "print"
        : key === "=" || key === "+" ? "zoom-in"
        : key === "-" ? "zoom-out"
        : key === "0" ? "zoom-reset"
        : key === "f" ? "find"
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
    // Clic en una nota al pie (abajo de la hoja): escribirla.
    const note = (e.target as HTMLElement).closest<HTMLElement>(".write-footnote[data-note]");
    if (note && editor) {
      const pos = footnotePos(editor.state, Number(note.dataset.note), note.dataset.kind === "end" ? "end" : "foot");
      if (pos !== null) {
        e.preventDefault();
        editNote.current(pos);
        return;
      }
    }
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

  const landscape = page.width > page.height;
  const pageLabel = PAGE_SIZES.find((s) => (s.width === page.width && s.height === page.height) || (s.height === page.width && s.width === page.height))?.label ?? "Personalizado";
  // Las páginas ya vienen cortadas (con su encabezado y pie), así que la hoja impresa no lleva márgenes propios.
  const pageCss = `@page { size: ${page.width / 1440}in ${page.height / 1440}in; margin: 0; }`;

  // Doble clic en el encabezado o el pie: editarlos.
  function onPageDoubleClick(e: React.MouseEvent) {
    if ((e.target as HTMLElement).closest("[data-hf]")) {
      e.preventDefault();
      setHfDialog(true);
    }
  }

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
      <button className="btn btn-pdf" onClick={() => void exportPdf()} title="Exportar como PDF (guarda el archivo directo)" aria-label="Exportar como PDF">
        PDF
      </button>
      <label
        className={`autosave-toggle${autosave ? " on" : ""}`}
        title={
          autosave
            ? "Cada cambio se guarda solo en el archivo"
            : "Guardar solo cada cambio en el archivo (también hay una copia de recuperación por si la app se cierra)"
        }
      >
        <input type="checkbox" role="switch" checked={autosave} onChange={toggleAutosave} />
        <span className="autosave-track" aria-hidden />
        Autoguardado
      </label>
      <button className="btn" onClick={() => saveDocument()} title={keys("Guardar (⌘S)")}>
        Guardar
      </button>
    </div>
  );

  return (
    <div className="editor kind-write write-editor">
      <style>{`@media print { ${pageCss} }`}</style>
      <EditorToolbar kind="write" fileName={fileName} dirty={dirty} onHome={onHome} onOpen={onOpen} actions={toolbarActions} />
      {editor && (
        <WriteBar
          editor={editor}
          onLink={openLinkDialog}
          onImage={insertImage}
          onHeaderFooter={() => setHfDialog(true)}
          onParagraph={() => setParagraphDialog(currentParagraphFormat(editor))}
          onComment={addComment}
          tracking={tracking}
          onTracking={() => setTracking(!tracking)}
          reviewOpen={reviewOpen}
          onReview={() => setReviewOpen((v) => !v)}
        />
      )}
      {findOpen && editor && <WriteFindBar editor={editor} onClose={() => setFindOpen(false)} />}

      {notice && (
        <div className="sheet-notice write-notice" role="status">
          <span>
            {initial.unsupported.length
              ? `Este documento tiene cosas que WEPO Write todavía no conserva (${initial.unsupported.join(", ")}). Al guardar se crea una copia y el original queda intacto.`
              : "WEPO Write abre los documentos de LibreOffice (.odt) y los guarda como Word (.docx): al guardar se crea un archivo nuevo y el original queda intacto."}
          </span>
          <button className="btn btn-icon" aria-label="Cerrar aviso" onClick={() => setNotice(false)}>
            ×
          </button>
        </div>
      )}

      <div className="write-main">
      <div className="write-canvas">
        <div
          ref={pageEl}
          className="write-page"
          style={{ width: px(page.width), padding: `0 ${px(page.right)}px`, zoom, ["--page-gap" as string]: `${PAGE_GAP}px` }}
          onMouseDown={onContentMouseDown}
          onDoubleClick={onPageDoubleClick}
        >
          <div
            className="write-hf write-hf-header"
            data-hf="header"
            style={{ height: px(page.top), justifyContent: headerFooter.header.align === "left" ? "flex-start" : headerFooter.header.align === "right" ? "flex-end" : "center" }}
          >
            <span>{headerFooter.skipFirst ? "" : fillFields(headerFooter.header.text, 1, pages, fileName)}</span>
          </div>
          <EditorContent editor={editor} />
        </div>
      </div>
      {reviewOpen && editor && (
        <ReviewPanel
          editor={editor}
          comments={comments}
          onChange={setComments}
          editingId={editingComment}
          onEditingDone={() => setEditingComment(null)}
          author={author}
          onAuthor={setAuthor}
          tracking={tracking}
          onTracking={setTracking}
          onClose={() => setReviewOpen(false)}
        />
      )}
      </div>

      <footer className="write-footer">
        <span>
          {pages} {pages === 1 ? "página" : "páginas"} · {counts?.words ?? 0} {counts?.words === 1 ? "palabra" : "palabras"} · {counts?.characters ?? 0} caracteres
        </span>
        <label className="write-page-size">
          Página:
          <select
            value={pageLabel}
            onChange={(e) => {
              const size = PAGE_SIZES.find((s) => s.label === e.target.value);
              if (!size) return;
              setPage((p) => (p.width > p.height ? { ...p, width: size.height, height: size.width } : { ...p, width: size.width, height: size.height }));
              markDirty();
            }}
          >
            {PAGE_SIZES.map((s) => (
              <option key={s.label} value={s.label}>
                {s.label}
                {landscape ? " (horizontal)" : ""}
              </option>
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
      {hfDialog && (
        <HeaderFooterDialog
          value={headerFooter}
          onSave={(value) => {
            setHeaderFooter(value);
            markDirty();
          }}
          onClose={() => {
            setHfDialog(false);
            editor?.commands.focus();
          }}
        />
      )}
      {noteEdit && (
        <FootnoteDialog
          key={noteEdit.pos}
          n={noteEdit.n}
          kind={noteEdit.kind}
          text={noteEdit.text}
          onSave={saveNote}
          onDelete={deleteNote}
          onClose={() => {
            setNoteEdit(null);
            editor?.commands.focus();
          }}
        />
      )}
      {paragraphDialog && (
        <ParagraphDialog
          value={paragraphDialog}
          onSave={(value) => editor?.chain().focus().setParagraphFormat(value).run()}
          onClose={() => {
            setParagraphDialog(null);
            editor?.commands.focus();
          }}
        />
      )}
      {printDialog && printOpen && (
        <WritePrintDialog
          snapshot={() => snapshotPages(pageEl.current!, page)}
          page={page}
          currentPage={printOpen.current}
          comments={printOpen.comments}
          sizes={PAGE_SIZES}
          onPageChange={(next) => {
            setPage(next);
            markDirty();
          }}
          onPrint={(job, toPdf, all) => void startPrint(job, toPdf, all)}
          onClose={() => {
            setPrintDialog(false);
            editor?.commands.focus();
          }}
          pdf={printDialog === "pdf"}
        />
      )}
      {printJob && <WritePrintPortal job={printJob.job} />}
      <p className="write-print-hint" hidden>
        {isMac ? "Guardar como PDF" : isWindows ? "Microsoft Print to PDF" : "Imprimir a un archivo"}
      </p>
    </div>
  );
}

/** Barra de formato de WEPO Write. */
const LINE_SPACINGS: { value: number; label: string }[] = [
  { value: 1, label: "Sencillo" },
  { value: 1.15, label: "1.15" },
  { value: 1.5, label: "1.5" },
  { value: 2, label: "Doble" },
];
/** Media pulgada, como el tabulador de Word. */
const INDENT_STEP = 36;

function WriteBar(props: {
  editor: Editor;
  onLink: () => void;
  onImage: () => void;
  onHeaderFooter: () => void;
  onParagraph: () => void;
  onComment: () => void;
  tracking: boolean;
  onTracking: () => void;
  reviewOpen: boolean;
  onReview: () => void;
}) {
  const { editor, onLink, onImage } = props;
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
      canMerge: e.can().mergeCells(),
      canSplit: e.can().splitCell(),
      cellColor: (e.getAttributes("tableCell").backgroundColor ?? e.getAttributes("tableHeader").backgroundColor ?? null) as string | null,
      list: e.isActive("listItem"),
      format: currentParagraphFormat(e),
      columns: columnsAt(e.state),
    }),
  });
  const indent = (step: number) => {
    if (s.list) {
      if (step > 0) chain().sinkListItem("listItem").run();
      else chain().liftListItem("listItem").run();
      return;
    }
    const next = Math.max(0, (s.format.indent ?? 0) + step * INDENT_STEP);
    chain().setParagraphFormat({ indent: next || null }).run();
  };
  const chain = () => editor.chain().focus();
  const sizeNumber = s.size ? Math.round(parseFloat(s.size) * (s.size.endsWith("px") ? 0.75 : 1)) : 11;
  const sizes = SIZES.includes(sizeNumber) ? SIZES : [...SIZES, sizeNumber].sort((a, b) => a - b);
  const fontName = s.font.split(",")[0].replace(/["']/g, "").trim();
  const fonts = !fontName || FONTS.includes(fontName) ? FONTS : [fontName, ...FONTS];

  return (
    <>
      <div className="format-bar write-format-bar" role="toolbar" aria-label="Formato del texto">
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
        <ToolButton label={keys("Tachado (⌘⇧X)")} pressed={s.strike} onClick={() => chain().toggleStrike().run()}>
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
        <ToolButton label="Reducir sangría" onClick={() => indent(-1)}>
          <AlignIcon lines={["M11 6h9", "M11 12h9", "M11 18h9", "M7 9l-3 3 3 3"]} />
        </ToolButton>
        <ToolButton label="Aumentar sangría" onClick={() => indent(1)}>
          <AlignIcon lines={["M11 6h9", "M11 12h9", "M11 18h9", "M4 9l3 3-3 3"]} />
        </ToolButton>
        <Popover
          button={(toggle, open) => (
            <ToolButton label="Interlineado y espacio entre párrafos" pressed={open} onClick={toggle}>
              <AlignIcon lines={["M11 6h9", "M11 12h9", "M11 18h9", "M5 4v16", "M3 6l2-2 2 2", "M3 18l2 2 2-2"]} />
            </ToolButton>
          )}
        >
          {(close) => (
            <div className="write-menu" role="menu">
              {LINE_SPACINGS.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={s.format.lineHeight === o.value}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => (chain().setParagraphFormat({ lineHeight: o.value }).run(), close())}
                >
                  <span className="write-menu-check">{s.format.lineHeight === o.value ? "✓" : ""}</span>
                  {o.label}
                </button>
              ))}
              <hr />
              <button
                type="button"
                role="menuitem"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => (chain().setParagraphFormat({ spaceBefore: s.format.spaceBefore ? null : 12 }).run(), close())}
              >
                <span className="write-menu-check" />
                {s.format.spaceBefore ? "Quitar espacio antes del párrafo" : "Agregar espacio antes del párrafo"}
              </button>
              <button
                type="button"
                role="menuitem"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => (chain().setParagraphFormat({ spaceAfter: s.format.spaceAfter === 0 ? null : 0 }).run(), close())}
              >
                <span className="write-menu-check" />
                {s.format.spaceAfter === 0 ? "Agregar espacio después del párrafo" : "Quitar espacio después del párrafo"}
              </button>
              <hr />
              <button type="button" role="menuitem" onClick={() => (close(), props.onParagraph())}>
                <span className="write-menu-check" />
                Opciones de párrafo…
              </button>
            </div>
          )}
        </Popover>

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
        <Separator />
        <ToolButton label={keys("Nuevo comentario (⌘⌥M)")} onClick={props.onComment}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden>
            <path d="M4 5h16v11H10l-5 4v-4H4z" />
            <path d="M12 8v5M9.5 10.5h5" />
          </svg>
        </ToolButton>
        <ToolButton label={keys("Control de cambios (⌘⇧E)")} pressed={props.tracking} onClick={props.onTracking}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
            <path d="M4 20h4l10-10-4-4L4 16z" />
            <path d="M13 7l4 4" />
            <path d="M15 20h5" />
          </svg>
        </ToolButton>
        <ToolButton label="Panel de revisión" pressed={props.reviewOpen} onClick={props.onReview}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
            <rect x="3" y="4" width="18" height="16" rx="1.5" />
            <path d="M15 4v16M17.5 8h1M17.5 11h1" />
          </svg>
        </ToolButton>
        <Separator />
        <ToolButton label={keys("Salto de página (⌘↩)")} onClick={() => chain().setPageBreak().run()}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
            <path d="M6 3v5h12V3M6 21v-5h12v5" />
            <path d="M3 12h3M9 12h2M13 12h2M18 12h3" />
          </svg>
        </ToolButton>
        <ToolButton label={keys("Nota al pie (⌘⌥F)")} onClick={() => chain().insertFootnote().run()}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
            <path d="M4 6h10M4 10h10M4 14h6" />
            <path d="M17 4.5l1.6-.9V9" />
            <path d="M4 19h16" strokeDasharray="2 2" />
          </svg>
        </ToolButton>
        <Popover
          button={(toggle, open) => (
            <ToolButton label={s.columns > 1 ? `Columnas: ${s.columns}` : "Columnas"} pressed={open || s.columns > 1} onClick={toggle}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
                <path d="M3 5h7M3 9h7M3 13h7M3 17h5M14 5h7M14 9h7M14 13h7M14 17h4" />
              </svg>
            </ToolButton>
          )}
        >
          {(close) => (
            <div className="write-menu" role="menu" aria-label="Columnas">
              {[1, 2, 3].map((n) => (
                <button
                  key={n}
                  type="button"
                  role="menuitemradio"
                  aria-checked={s.columns === n}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => (chain().setColumns(n).run(), close())}
                >
                  <span className="write-menu-check">{s.columns === n ? "✓" : ""}</span>
                  {n === 1 ? "Una columna (normal)" : `${n} columnas`}
                </button>
              ))}
              <p className="write-menu-hint">Lo que elegiste (o el párrafo) va en columnas; lo demás sigue igual.</p>
            </div>
          )}
        </Popover>
        <ToolButton label={keys("Nota al final (⌘⌥D)")} onClick={() => chain().insertFootnote("", "end").run()}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
            <path d="M4 5h10M4 9h10M4 13h6" />
            <path d="M16.5 4v5M19 4v5" />
            <path d="M4 17h16M4 20.5h9" />
          </svg>
        </ToolButton>
        <ToolButton label="Índice (con los títulos y sus páginas)" onClick={() => chain().insertTableOfContents().run()}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
            <path d="M4 5h11M7 10h8M7 15h8M4 20h11" />
            <path d="M19 5h1M19 10h1M19 15h1M19 20h1" />
          </svg>
        </ToolButton>
        <ToolButton label="Encabezado y pie de página" onClick={props.onHeaderFooter}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
            <rect x="4" y="3" width="16" height="18" rx="1.5" />
            <path d="M4 7.5h16M4 16.5h16" />
          </svg>
        </ToolButton>
        <ToolButton label="Quitar formato" onClick={() => chain().unsetAllMarks().clearNodes().setParagraphFormat({ lineHeight: null, spaceBefore: null, spaceAfter: null, indent: null, firstLine: null }).run()}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
            <path d="M6 5h12M12 5l-3 14M4 20l16-16" />
          </svg>
        </ToolButton>

      </div>
        {s.table && (
          <div className="format-bar write-table-bar" role="toolbar" aria-label="Tabla">
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
            {s.canMerge && (
              <button type="button" className="btn write-table-btn" onClick={() => chain().mergeCells().run()}>
                Combinar
              </button>
            )}
            {s.canSplit && (
              <button type="button" className="btn write-table-btn" onClick={() => chain().splitCell().run()}>
                Dividir
              </button>
            )}
            <button
              type="button"
              className="btn write-table-btn"
              title="La primera fila como encabezado (en Word se repite en cada hoja)"
              onClick={() => chain().toggleHeaderRow().run()}
            >
              Encabezado
            </button>
            <ColorButton
              label="Color de la celda"
              current={s.cellColor}
              emptyLabel="Sin color"
              onPick={(color) => chain().setCellAttribute("backgroundColor", color).run()}
              icon={
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
                  <rect x="4" y="4" width="16" height="16" rx="1.5" />
                  <path d="M4 12h16M12 4v16" />
                </svg>
              }
            />
            <button type="button" className="btn write-table-btn" onClick={() => chain().deleteTable().run()}>
              Borrar tabla
            </button>
          </div>
        )}
    </>
  );
}
