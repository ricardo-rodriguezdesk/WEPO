import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import Home from "./screens/Home";
import SheetEditor from "./editors/sheets/SheetEditor";
import ComingSoon from "./editors/ComingSoon";
import type { DocKind } from "./lib/documents";
import { ALL_EXTENSIONS, DOC_KINDS, extensionOf, fileNameOf, kindFromPath } from "./lib/documents";
import type { Workbook } from "./lib/spreadsheet";
import { emptyWorkbook, openSpreadsheet } from "./lib/spreadsheet";
import "./App.css";

/** Documento abierto actualmente. `id` cambia con cada apertura para reiniciar el editor. */
type OpenDocument = {
  id: number;
  kind: DocKind;
  fileName: string;
  workbook?: Workbook;
};

export default function App() {
  const [doc, setDoc] = useState<OpenDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const nextId = useRef(1);

  function newDocument(kind: DocKind) {
    setError(null);
    setDoc({
      id: nextId.current++,
      kind,
      fileName: "Sin título",
      workbook: kind === "sheets" ? emptyWorkbook() : undefined,
    });
  }

  async function openPath(path: string) {
    const name = fileNameOf(path);
    const kind = kindFromPath(path);
    if (!kind) {
      setDoc(null);
      setError(`WEPO todavía no puede abrir archivos .${extensionOf(path) || "sin extensión"} (${name}).`);
      return;
    }
    try {
      const workbook = kind === "sheets" ? await openSpreadsheet(path) : undefined;
      setError(null);
      setDoc({ id: nextId.current++, kind, fileName: name, workbook });
    } catch (e) {
      setDoc(null);
      setError(`No se pudo abrir ${name}: ${e}`);
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

  const common = {
    fileName: doc.fileName,
    onHome: () => setDoc(null),
    onOpen: openDialog,
  };

  if (doc.kind === "sheets" && doc.workbook) {
    return <SheetEditor key={doc.id} workbook={doc.workbook} {...common} />;
  }
  return <ComingSoon key={doc.id} kind={doc.kind} {...common} />;
}
