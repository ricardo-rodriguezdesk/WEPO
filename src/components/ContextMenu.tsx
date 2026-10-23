import { useEffect, useLayoutEffect, useRef, useState } from "react";
import "./ContextMenu.css";

export type MenuItem =
  | { label: string; shortcut?: string; disabled?: boolean; danger?: boolean; action: () => void }
  | "separator";

type Props = {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
};

/** Menú de clic derecho. Se cierra al elegir algo, al hacer clic fuera o con Esc. */
export default function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });

  // Si no cabe en la ventana, se abre hacia arriba o hacia la izquierda.
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    setPosition({
      left: Math.max(4, Math.min(x, window.innerWidth - box.width - 4)),
      top: Math.max(4, y + box.height > window.innerHeight ? y - box.height : y),
    });
  }, [x, y]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  return (
    <div className="context-menu" ref={ref} role="menu" style={position} onContextMenu={(e) => e.preventDefault()}>
      {items.map((item, i) =>
        item === "separator" ? (
          <div key={i} className="context-separator" role="separator" />
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            className={`context-item${item.danger ? " danger" : ""}`}
            disabled={item.disabled}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              onClose();
              item.action();
            }}
          >
            <span>{item.label}</span>
            {item.shortcut && <span className="context-shortcut">{item.shortcut}</span>}
          </button>
        ),
      )}
    </div>
  );
}
