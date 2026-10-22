import type { DocKind } from "../lib/documents";
import { DOC_KINDS } from "../lib/documents";
import KindIcon from "../components/KindIcon";
import "./Home.css";

type Props = {
  onNew: (kind: DocKind) => void;
  onOpen: () => void;
  dragging: boolean;
  error: string | null;
};

const ORDER: DocKind[] = ["write", "sheets", "present"];

/** Pantalla de inicio: crear un documento nuevo o abrir uno existente. */
export default function Home({ onNew, onOpen, dragging, error }: Props) {
  return (
    <main className={`home ${dragging ? "dragging" : ""}`}>
      <section className="home-hero">
        <h1 className="home-logo">WEPO</h1>
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

      {dragging && (
        <div className="home-drop-overlay">
          <p>Suelta el archivo para abrirlo</p>
        </div>
      )}
    </main>
  );
}
