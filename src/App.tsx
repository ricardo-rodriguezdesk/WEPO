import { useEffect, useRef, useState } from "react";
import { ask, open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import Home from "./screens/Home";
import SheetEditor from "./editors/sheets/SheetEditor";
import WriteEditor from "./editors/write/WriteEditor";
import type { WriteDocument } from "./editors/write/docx";
import { emptyDocument, openWriteDocument } from "./lib/write";
import ComingSoon from "./editors/ComingSoon";
import type { DocKind } from "./lib/documents";
import { ALL_EXTENSIONS, DOC_KINDS, extensionOf, fileNameOf, kindFromPath } from "./lib/documents";
import type { SheetView } from "./lib/spreadsheet";
import { sheetApi } from "./lib/spreadsheet";
import type { Command } from "./lib/commands";
import { onCommand, runCommand } from "./lib/commands";
import { hasModifier } from "./lib/platform";
import { addRecent, clearRecents, loadRecents, removeRecent } from "./lib/recents";
import type { RecoveryInfo } from "./lib/recovery";
import { recoveryApi } from "./lib/recovery";
import "./App.css";

/** Documento abierto actualmente. `id` cambia con cada apertura para reiniciar el editor. */
type OpenDocument = {
  id: number;
  kind: DocKind;
  fileName: string;
  path: string | null;
  sheet?: SheetView;
  write?: WriteDocument;
  /** Viene de la copia de recuperación: empieza con cambios sin guardar. */
  recovered?: boolean;
};

export default function App() {
  const [doc, setDoc] = useState<OpenDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [recents, setRecents] = useState(loadRecents);
  // Copias que quedaron de documentos sin guardar (si WEPO se cerró de golpe).
  // Solo la primera ventana las ofrece, para no repetirlas en cada ventana nueva.
  const [recovery, setRecovery] = useState<RecoveryInfo[]>([]);
  useEffect(() => {
    if (getCurrentWindow().label === "main") recoveryApi.list().then(setRecovery);
  }, []);
  const nextId = useRef(1);
  const dirty = useRef(false); // el editor avisa si hay cambios sin guardar

  /** Pregunta antes de cerrar un documento con cambios sin guardar. */
  async function confirmDiscard(): Promise<boolean> {
    if (!dirty.current) return true;
    const discard = await ask("Tienes cambios sin guardar. ¿Quieres descartarlos?", {
      title: "WEPO",
      kind: "warning",
      okLabel: "Descartar",
      cancelLabel: "Cancelar",
    });
    // Si se descartan a propósito, la copia de recuperación ya no sirve.
    if (discard) await recoveryApi.clear();
    return discard;
  }

  async function recover(info: RecoveryInfo) {
    if (!(await confirmDiscard())) return;
    try {
      const copy = await recoveryApi.take(info.path);
      const sheet = await sheetApi.open(copy);
      const base = info.name.replace(/\.[^.]+$/, "") || "Sin título";
      show({ id: nextId.current++, kind: "sheets", fileName: `${base} (recuperado)`, path: null, sheet, recovered: true });
      dirty.current = true;
      setRecovery((list) => list.filter((r) => r.path !== info.path));
    } catch (e) {
      show(null, `No se pudo recuperar el documento: ${e}`);
    }
  }

  /** Abre algo en otra ventana (cuando esta ya tiene un documento), como en Excel. */
  function openWindow(target: { path?: string; kind?: DocKind }) {
    invoke("open_window", { path: target.path ?? null, kind: target.kind ?? null }).catch((e) =>
      setError(`No se pudo abrir otra ventana: ${e}`),
    );
  }

  function show(next: OpenDocument | null, message: string | null = null) {
    dirty.current = false;
    setError(message);
    setDoc(next);
    setTitle(next?.fileName ?? null);
  }

  function setTitle(fileName: string | null) {
    getCurrentWindow()
      .setTitle(fileName ? `${fileName} — WEPO` : "WEPO")
      .catch(() => {});
  }

  function rememberRecent(path: string) {
    addRecent(path);
    setRecents(loadRecents());
    setTitle(fileNameOf(path));
  }

  async function newDocument(kind: DocKind, here = false) {
    // Con un documento abierto, el nuevo va en otra ventana.
    if (doc && !here) return openWindow({ kind });
    try {
      const sheet = kind === "sheets" ? await sheetApi.create() : undefined;
      const write = kind === "write" ? emptyDocument() : undefined;
      show({ id: nextId.current++, kind, fileName: "Sin título", path: null, sheet, write });
    } catch (e) {
      show(null, `No se pudo crear el documento: ${e}`);
    }
  }

  async function openPath(path: string, here = false) {
    if (doc && !here) return openWindow({ path });
    const name = fileNameOf(path);
    const kind = kindFromPath(path);
    if (!kind) {
      show(null, `WEPO todavía no puede abrir archivos .${extensionOf(path) || "sin extensión"} (${name}).`);
      return;
    }
    try {
      const sheet = kind === "sheets" ? await sheetApi.open(path) : undefined;
      const write = kind === "write" ? await openWriteDocument(path) : undefined;
      show({ id: nextId.current++, kind, fileName: name, path, sheet, write });
      if (kind !== "present") rememberRecent(path);
    } catch (e) {
      // Un reciente que ya no existe (se movió o se borró) sale de la lista.
      if (/no such file|not found|os error 2/i.test(String(e))) {
        show(null, `No se encontró ${name}. Puede que se haya movido o borrado.`);
        removeRecent(path);
        setRecents(loadRecents());
      } else {
        show(null, `No se pudo abrir ${name}: ${e}`);
      }
    }
  }

  async function openDialog() {
    const path = await open({
      multiple: false,
      filters: [
        { name: "Todos los documentos", extensions: ALL_EXTENSIONS },
        ...Object.values(DOC_KINDS).map((k) => ({ name: k.name, extensions: k.extensions })),
      ],
    });
    if (path) await openPath(path);
  }

  /** Salir (⌘Q): se cierran todas las ventanas; cada una pregunta si tiene cambios sin guardar. */
  async function quit() {
    await invoke("quit_app");
  }

  async function goHome() {
    if (await confirmDiscard()) show(null);
  }

  // Órdenes del menú de la app y de los atajos de teclado.
  const actions = useRef({ newDocument, openDialog, goHome, quit, openPath });
  actions.current = { newDocument, openDialog, goHome, quit, openPath };
  useEffect(() => {
    const stopCommands = onCommand((command: Command) => {
      const a = actions.current;
      if (command === "new-sheet") a.newDocument("sheets");
      else if (command === "new-document") a.newDocument("write");
      else if (command === "open") a.openDialog();
      else if (command === "home") a.goHome();
      else if (command === "quit") a.quit();
      // guardar, imprimir y buscar los atiende el editor abierto.
    });
    const stopMenu = listen<string>("menu", (event) => runCommand(event.payload as Command));
    // ⌘O, ⌘N y ⌘Q también desde el teclado (Ctrl en Windows; en macOS además los atiende el menú).
    function onKey(e: KeyboardEvent) {
      if (!hasModifier(e) || e.altKey) return;
      const key = e.key.toLowerCase();
      // ⌘⇧N: documento nuevo de WEPO Write.
      if (key === "n" && e.shiftKey) {
        e.preventDefault();
        runCommand("new-document");
        return;
      }
      if (e.shiftKey) return;
      if (key === "o" || key === "n") {
        e.preventDefault();
        runCommand(key === "o" ? "open" : "new-sheet");
      } else if (key === "q") {
        e.preventDefault();
        runCommand("quit");
      }
    }
    window.addEventListener("keydown", onKey);

    // Archivos abiertos desde Finder (doble clic, "Abrir con…" o arrastrados al Dock).
    // Se piden a Rust para no abrir dos veces el mismo si llega también el evento.
    async function openFromFinder() {
      const files = await invoke<string[]>("take_opened_files").catch(() => [] as string[]);
      // El primero se abre aquí si la ventana está libre; los demás, cada uno en su ventana.
      for (const file of files) await actions.current.openPath(file);
    }
    // Una ventana nueva trae en su dirección qué abrir (?open=… o ?new=…).
    const params = new URLSearchParams(window.location.search);
    const toOpen = params.get("open");
    const toCreate = params.get("new") as DocKind | null;
    if (toOpen) actions.current.openPath(toOpen, true);
    else if (toCreate && toCreate in DOC_KINDS) actions.current.newDocument(toCreate, true);
    else openFromFinder();
    const stopFiles = listen("open-files", openFromFinder);

    // Aviso al cerrar la ventana con cambios sin guardar.
    const stopClose = getCurrentWindow().onCloseRequested(async (event) => {
      if (!dirty.current) return;
      event.preventDefault();
      if (await confirmDiscard()) {
        dirty.current = false;
        await getCurrentWindow().destroy();
      }
    });
    return () => {
      stopCommands();
      window.removeEventListener("keydown", onKey);
      for (const stop of [stopMenu, stopFiles, stopClose]) stop.then((f) => f());
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Abrir archivos arrastrados desde Finder a la ventana.
  const openPathRef = useRef(openPath);
  openPathRef.current = openPath;
  useEffect(() => {
    const unlisten = getCurrentWebview().onDragDropEvent((event) => {
      const { type } = event.payload;
      if (type === "enter" || type === "over") setDragging(true);
      else if (type === "leave") setDragging(false);
      else if (type === "drop") {
        setDragging(false);
        const [first] = event.payload.paths;
        if (first) openPathRef.current(first);
      }
    });
    return () => {
      unlisten.then((stop) => stop());
    };
  }, []);

  if (!doc) {
    return (
      <Home
        onNew={newDocument}
        onOpen={openDialog}
        onOpenRecent={openPath}
        onRemoveRecent={(path) => {
          removeRecent(path);
          setRecents(loadRecents());
        }}
        onClearRecents={() => {
          clearRecents();
          setRecents([]);
        }}
        recents={recents}
        recovery={recovery}
        onRecover={recover}
        onDiscardRecovery={(info) => {
          recoveryApi.discard(info.path);
          setRecovery((list) => list.filter((r) => r.path !== info.path));
        }}
        dragging={dragging}
        error={error}
      />
    );
  }

  const common = { fileName: doc.fileName, onHome: goHome, onOpen: openDialog };

  if (doc.kind === "sheets" && doc.sheet) {
    return (
      <SheetEditor
        key={doc.id}
        initialView={doc.sheet}
        path={doc.path}
        onDirtyChange={(value) => (dirty.current = value)}
        onSaved={rememberRecent}
        recovered={doc.recovered}
        {...common}
      />
    );
  }
  if (doc.kind === "write" && doc.write) {
    return (
      <WriteEditor
        key={doc.id}
        initial={doc.write}
        path={doc.path}
        onDirtyChange={(value) => (dirty.current = value)}
        onSaved={rememberRecent}
        {...common}
      />
    );
  }
  return <ComingSoon key={doc.id} kind={doc.kind} {...common} />;
}
