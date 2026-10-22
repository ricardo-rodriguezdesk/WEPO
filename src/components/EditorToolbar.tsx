import type { DocKind } from "../lib/documents";
import { DOC_KINDS } from "../lib/documents";
import KindIcon from "./KindIcon";

type Props = {
  kind: DocKind;
  fileName: string;
  onHome: () => void;
  onOpen: () => void;
};

/** Barra superior común a los tres editores. */
export default function EditorToolbar({ kind, fileName, onHome, onOpen }: Props) {
  return (
    <header className="toolbar">
      <button className="btn" onClick={onHome} title="Volver al inicio">
        ← Inicio
      </button>
      <div className="toolbar-title">
        <span className="toolbar-icon">
          <KindIcon kind={kind} size={18} />
        </span>
        <span className="toolbar-app">{DOC_KINDS[kind].name}</span>
        <span className="toolbar-file">{fileName}</span>
      </div>
      <button className="btn" onClick={onOpen}>
        Abrir…
      </button>
    </header>
  );
}
