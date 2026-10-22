import EditorToolbar from "../components/EditorToolbar";
import KindIcon from "../components/KindIcon";
import type { DocKind } from "../lib/documents";
import { DOC_KINDS } from "../lib/documents";

type Props = {
  kind: DocKind;
  fileName: string;
  onHome: () => void;
  onOpen: () => void;
};

/** Marcador para los editores que todavía no están construidos. */
export default function ComingSoon({ kind, fileName, onHome, onOpen }: Props) {
  return (
    <div className={`editor kind-${kind}`}>
      <EditorToolbar kind={kind} fileName={fileName} onHome={onHome} onOpen={onOpen} />
      <div className="coming-soon">
        <span className="coming-soon-icon">
          <KindIcon kind={kind} size={40} />
        </span>
        <h2>{DOC_KINDS[kind].name} está en construcción</h2>
        <p>Este editor llegará en los próximos pasos del proyecto.</p>
      </div>
    </div>
  );
}
