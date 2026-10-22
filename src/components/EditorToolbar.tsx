import type { ReactNode } from "react";
import type { DocKind } from "../lib/documents";
import { DOC_KINDS } from "../lib/documents";
import KindIcon from "./KindIcon";

type Props = {
  kind: DocKind;
  fileName: string;
  /** Hay cambios sin guardar: se muestra un punto junto al nombre. */
  dirty?: boolean;
  onHome: () => void;
  onOpen: () => void;
  /** Botones propios de cada editor (guardar, deshacer…). */
  actions?: ReactNode;
};

/** Barra superior común a los tres editores. */
export default function EditorToolbar({ kind, fileName, dirty, onHome, onOpen, actions }: Props) {
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
        <span className="toolbar-file">
          {fileName}
          {dirty && <span className="toolbar-dirty" title="Cambios sin guardar"> •</span>}
        </span>
      </div>
      {actions}
      <button className="btn" onClick={onOpen}>
        Abrir…
      </button>
    </header>
  );
}
