import { useEffect, useRef, useState } from "react";
import { ask, open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import Home from "./screens/Home";
import SheetEditor from "./editors/sheets/SheetEditor";
import ComingSoon from "./editors/ComingSoon";
import type { DocKind } from "./lib/documents";
import { ALL_EXTENSIONS, DOC_KINDS, extensionOf, fileNameOf, kindFromPath } from "./lib/documents";
import type { SheetView } from "./lib/spreadsheet";
import { sheetApi } from "./lib/spreadsheet";
import "./App.css";

/** Documento abierto actualmente. `id` cambia con cada apertura para reiniciar el editor. */
type OpenDocument = {
  id: number;
  kind: DocKind;
  fileName: string;
  path: string | null;
  sheet?: SheetView;
};

export default function App() {
  const [doc, setDoc] = useState<OpenDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const nextId = useRef(1);
  const dirty = useRef(false); // el editor avisa si hay cambios sin guardar

  /** Pregunta antes de cerrar un documento con cambios sin guardar. */
  async function confirmDiscard(): Promise<boolean> {
    if (!dirty.current) return true;
    return ask("Tienes cambios sin guardar. ¿Quieres descartarlos?", {
      title: "WEPO",
      kind: "warning",
      okLabel: "Descartar",
      cancelLabel: "Cancelar",
    });
  }

  function show(next: OpenDocument | null, message: string | null = null) {
    dirty.current = false;
    setError(message);
    setDoc(next);
  }

  async function newDocument(kind: DocKind) {
    try {
      const sheet = kind === "sheets" ? await sheetApi.create() : undefined;
      show({ id: nextId.current++, kind, fileName: "Sin título", path: null, sheet });
    } catch (e) {
      show(null, `No se pudo crear el documento: ${e}`);
    }
  }

  async function openPath(path: string) {
    if (!(await confirmDiscard())) return;
    const name = fileNameOf(path);
    const kind = kindFromPath(path);
    if (!kind) {
      show(null, `WEPO todavía no puede abrir archivos .${extensionOf(path) || "sin extensión"} (${name}).`);
      return;
    }
    try {
      const sheet = kind === "sheets" ? await sheetApi.open(path) : undefined;
      show({ id: nextId.current++, kind, fileName: name, path, sheet });
    } catch (e) {
      show(null, `No se pudo abrir ${name}: ${e}`);
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

  async function goHome() {
    if (await confirmDiscard()) show(null);
  }

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
    return <Home onNew={newDocument} onOpen={openDialog} dragging={dragging} error={error} />;
  }

  const common = { fileName: doc.fileName, onHome: goHome, onOpen: openDialog };

  if (doc.kind === "sheets" && doc.sheet) {
    return (
      <SheetEditor
        key={doc.id}
        initialView={doc.sheet}
        path={doc.path}
        onDirtyChange={(value) => (dirty.current = value)}
        {...common}
      />
    );
  }
  return <ComingSoon key={doc.id} kind={doc.kind} {...common} />;
}
