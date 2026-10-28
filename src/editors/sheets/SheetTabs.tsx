import { useState } from "react";
import type { ReactNode } from "react";
import ContextMenu from "../../components/ContextMenu";

type Props = {
  names: string[];
  active: number;
  onSelect: (index: number) => void;
  onAdd: () => void;
  onRename: (index: number, name: string) => void;
  onDuplicate: (index: number) => void;
  onDelete: (index: number) => void;
  onMove: (index: number, to: number) => void;
  /** La hoja activa está protegida (lleva candado). */
  protectedActive?: boolean;
  /** Proteger la hoja activa o quitarle la protección. */
  onProtect?: () => void;
  /** Mensaje a la derecha (guardado, errores…). */
  children?: ReactNode;
};

/** Pestañas de hojas: doble clic para renombrar, clic derecho para más opciones. */
export default function SheetTabs(props: Props) {
  const { names, active } = props;
  const [renaming, setRenaming] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number; index: number } | null>(null);

  function startRename(index: number) {
    setRenaming(index);
    setDraft(names[index]);
  }

  function finishRename() {
    if (renaming !== null && draft.trim() && draft !== names[renaming]) props.onRename(renaming, draft.trim());
    setRenaming(null);
  }

  return (
    <footer className="sheet-tabs">
      {names.map((name, i) =>
        renaming === i ? (
          <input
            key={`${i}-edit`}
            className="sheet-tab-input"
            aria-label="Nombre de la hoja"
            value={draft}
            autoFocus
            onFocus={(e) => e.target.select()}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={finishRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") finishRename();
              if (e.key === "Escape") setRenaming(null);
            }}
          />
        ) : (
          <button
            key={`${i}-${name}`}
            className={`btn ${i === active ? "active" : ""}`}
            title="Doble clic para renombrar"
            onClick={() => props.onSelect(i)}
            onDoubleClick={() => startRename(i)}
            onContextMenu={(e) => {
              e.preventDefault();
              props.onSelect(i);
              setMenu({ x: e.clientX, y: e.clientY, index: i });
            }}
          >
            {name}
            {i === active && props.protectedActive && (
              <svg className="sheet-tab-lock" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-label="Hoja protegida" role="img">
                <rect x="5" y="11" width="14" height="10" rx="2" />
                <path d="M8 11V7a4 4 0 018 0v4" />
              </svg>
            )}
          </button>
        ),
      )}
      <button className="btn btn-icon" onClick={props.onAdd} title="Agregar hoja" aria-label="Agregar hoja">
        +
      </button>
      {props.children}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: "Renombrar", action: () => startRename(menu.index) },
            { label: "Duplicar", action: () => props.onDuplicate(menu.index) },
            "separator",
            { label: "Mover a la izquierda", disabled: menu.index === 0, action: () => props.onMove(menu.index, menu.index - 1) },
            {
              label: "Mover a la derecha",
              disabled: menu.index === names.length - 1,
              action: () => props.onMove(menu.index, menu.index + 1),
            },
            ...(props.onProtect
              ? ([
                  "separator",
                  { label: menu.index === active && props.protectedActive ? "Quitar la protección…" : "Proteger hoja…", action: () => props.onProtect?.() },
                ] as const)
              : []),
            "separator",
            { label: "Eliminar hoja", danger: true, disabled: names.length <= 1, action: () => props.onDelete(menu.index) },
          ]}
        />
      )}
    </footer>
  );
}
