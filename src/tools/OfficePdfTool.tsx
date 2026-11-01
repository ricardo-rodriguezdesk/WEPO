// Word, Excel o PowerPoint a PDF: cada archivo se abre en su editor (sin que se
// vea) y se exporta con el mismo «Exportar como PDF» de la app, así el PDF sale
// igual que si lo hicieras tú desde WEPO Write, Sheets o Present.

import { useState } from "react";
import type { ToolDef } from "./tools";
import type { DropHandler, ToolResult } from "./ToolsScreen";
import { FileList, ResultBox, ToolFrame, useFiles } from "./ToolsScreen";
import type { InputFile } from "./io";
import { saveOutputs } from "./io";
import { baseName } from "./pdfTools";
import type { Output } from "./pdfTools";
import { expectPdf, failExpectedPdf } from "../lib/exportPdf";
import { openWriteDocument } from "../lib/write";
import { openPresentation } from "../lib/present";
import { sheetApi } from "../lib/spreadsheet";
import type { SheetView } from "../lib/spreadsheet";
import type { WriteDocument } from "../editors/write/docx";
import type { Deck } from "../editors/present/model";
import WriteEditor from "../editors/write/WriteEditor";
import SheetEditor from "../editors/sheets/SheetEditor";
import PresentEditor from "../editors/present/PresentEditor";

type Job = { key: number; path: string; fileName: string } & ({ kind: "write"; write: WriteDocument } | { kind: "sheets"; sheet: SheetView } | { kind: "present"; deck: Deck });

const noop = () => {};
let counter = 0;

export default function OfficePdfTool({ def, onBack, onOpenPath, setDropHandler }: { def: ToolDef; onBack: () => void; onOpenPath: (p: string) => void; setDropHandler: (h: DropHandler) => void }) {
  const [error, setError] = useState<string | null>(null);
  const list = useFiles(def, setDropHandler, setError);
  const { files } = list;
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<ToolResult | null>(null);
  const [job, setJob] = useState<Job | null>(null);

  /** Abre el archivo en su editor escondido y espera a que el PDF quede escrito. */
  async function exportOne(file: InputFile, target: string) {
    const written = expectPdf(target);
    const timer = setTimeout(() => failExpectedPdf(new Error(`${file.name}: el PDF tardó demasiado`)), 120_000);
    try {
      const base = { key: ++counter, path: file.path, fileName: file.name };
      if (def.id === "word2pdf") setJob({ ...base, kind: "write", write: await openWriteDocument(file.path) });
      else if (def.id === "excel2pdf") setJob({ ...base, kind: "sheets", sheet: await sheetApi.open(file.path) });
      else setJob({ ...base, kind: "present", deck: await openPresentation(file.path) });
      await written;
    } catch (e) {
      failExpectedPdf(e);
      throw new Error(`${file.name}: ${(e as Error)?.message ?? e}`);
    } finally {
      clearTimeout(timer);
      setJob(null);
      // Que el editor se desmonte antes del siguiente.
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  async function run() {
    if (!files.length) return;
    setError(null);
    setResult(null);
    try {
      const outputs: Output[] = files.map((f) => ({ name: `${baseName(f.name)}.pdf`, bytes: new Uint8Array(), write: (path: string) => exportOne(f, path) }));
      setBusy(files.length > 1 ? `Convirtiendo… (1 de ${files.length})` : "Convirtiendo…");
      const saved = await saveOutputs(outputs, files[0].path, "PDF", "pdf", (d, t) => setBusy(`Convirtiendo… (${d} de ${t})`));
      if (!saved) return;
      const lines = [files.length === 1 ? `${files[0].name} quedó como PDF.` : `${files.length} archivos quedaron como PDF en la carpeta que elegiste.`];
      if (def.id === "excel2pdf") lines.push("De cada libro se exporta la hoja que estaba abierta al guardarlo, con su área de impresión y su configuración de página.");
      setResult({ lines, saved, open: saved.paths.length === 1 ? { path: saved.paths[0], label: "Abrir en WEPO PDF" } : undefined });
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(null);
    }
  }

  const app = def.id === "word2pdf" ? "WEPO Write" : def.id === "excel2pdf" ? "WEPO Sheets" : "WEPO Present";
  return (
    <ToolFrame def={def} onBack={onBack}>
      <div className="tool-body">
        <div className="tool-main">
          <FileList def={def} {...list} />
        </div>
        <aside className="tool-side">
          <div className="tool-options tool-note">
            <p>{`Cada archivo se exporta igual que con «Exportar como PDF» en ${app}.`}</p>
            {def.id === "ppt2pdf" && <p className="hint">Una diapositiva por hoja; las ocultas no salen.</p>}
          </div>
          {error && (
            <p className="tool-error" role="alert">
              {error}
            </p>
          )}
          {result ? (
            <ResultBox result={result} onOpenPath={onOpenPath} onReset={() => (setResult(null), list.setFiles([]))} />
          ) : (
            <button type="button" className="btn btn-primary tool-run" disabled={!files.length || !!busy} onClick={run}>
              {busy ?? def.action}
            </button>
          )}
        </aside>
      </div>
      {job && (
        <div className="tool-office-host" aria-hidden>
          {job.kind === "write" && <WriteEditor key={job.key} initial={job.write} path={job.path} fileName={job.fileName} onHome={noop} onOpen={noop} onDirtyChange={noop} onSaved={noop} autoPdf />}
          {job.kind === "sheets" && <SheetEditor key={job.key} initialView={job.sheet} path={job.path} fileName={job.fileName} onHome={noop} onOpen={noop} onDirtyChange={noop} onSaved={noop} autoPdf />}
          {job.kind === "present" && <PresentEditor key={job.key} initial={job.deck} path={job.path} fileName={job.fileName} onHome={noop} onOpen={noop} onDirtyChange={noop} onSaved={noop} autoPdf />}
        </div>
      )}
    </ToolFrame>
  );
}
