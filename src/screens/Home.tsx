import type { DocKind } from "../lib/documents";
import { DOC_KINDS } from "../lib/documents";
import KindIcon from "../components/KindIcon";
import appIcon from "../assets/wepo-icon.png";
import type { RecentFile } from "../lib/recents";
import { folderLabel, whenLabel } from "../lib/recents";
import "./Home.css";

type Props = {
  onNew: (kind: DocKind) => void;
  onOpen: () => void;
  onOpenRecent: (path: string) => void;
  onRemoveRecent: (path: string) => void;
  onClearRecents: () => void;
  recents: RecentFile[];
  dragging: boolean;
  error: string | null;
};

const ORDER: DocKind[] = ["write", "sheets", "present"];

/** Pantalla de inicio: crear un documento nuevo o abrir uno existente. */
export default function Home({ onNew, onOpen, onOpenRecent, onRemoveRecent, onClearRecents, recents, dragging, error }: Props) {
  return (
    <main className={`home ${dragging ? "dragging" : ""}`}>
      <section className="home-hero">
        <h1 className="home-logo">
          <img src={appIcon} alt="" width={52} height={52} />
          WEPO
        </h1>
        <p className="home-tagline">Write · Edit · Present · Open</p>
      </section>

      <section className="home-section">
        <h2>Crear</h2>
        <div className="home-cards">
          {ORDER.map((kind) => (
            <button key={kind} className={`home-card kind-${kind}`} onClick={() => onNew(kind)}>
              <span className="home-card-icon">
                <KindIcon kind={kind} size={30} />
              </span>
              <span className="home-card-label">{DOC_KINDS[kind].newLabel}</span>
              <span className="home-card-app">{DOC_KINDS[kind].name}</span>
              <span className="home-card-formats">
                {DOC_KINDS[kind].extensions.map((e) => `.${e}`).join("  ")}
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className="home-section">
        <h2>Abrir</h2>
        <div className="home-open">
          <button className="btn btn-primary" onClick={onOpen}>
            Abrir archivo…
          </button>
          <span className="home-drop-hint">o arrastra un archivo a esta ventana</span>
        </div>
        {error && <p className="home-error">{error}</p>}
      </section>

      {recents.length > 0 && (
        <section className="home-section">
          <div className="home-section-head">
            <h2>Recientes</h2>
            <button type="button" className="home-link" onClick={onClearRecents}>
              Borrar lista
            </button>
          </div>
          <ul className="home-recents">
            {recents.map((file) => (
              <li key={file.path} className={`kind-${file.kind}`}>
                <button type="button" className="home-recent" onClick={() => onOpenRecent(file.path)} title={file.path}>
                  <span className="home-recent-icon">
                    <KindIcon kind={file.kind} size={18} />
                  </span>
                  <span className="home-recent-name">{file.name}</span>
                  <span className="home-recent-folder">{folderLabel(file.path)}</span>
                  <span className="home-recent-when">{whenLabel(file.time)}</span>
                </button>
                <button
                  type="button"
                  className="home-recent-remove"
                  aria-label={`Quitar ${file.name} de recientes`}
                  title="Quitar de la lista"
                  onClick={() => onRemoveRecent(file.path)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {dragging && (
        <div className="home-drop-overlay">
          <p>Suelta el archivo para abrirlo</p>
        </div>
      )}
    </main>
  );
}
