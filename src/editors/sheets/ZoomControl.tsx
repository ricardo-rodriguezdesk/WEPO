import { useState } from "react";
import ContextMenu from "../../components/ContextMenu";
import { MAX_ZOOM, MIN_ZOOM, stepZoom } from "./layout";
import { keys } from "../../lib/platform";

// Como en Excel, la mitad izquierda del control va de 25 % a 100 % y la derecha de 100 % a 400 %.
function toSlider(zoom: number): number {
  return zoom <= 1 ? ((zoom - MIN_ZOOM) / (1 - MIN_ZOOM)) * 50 : 50 + ((zoom - 1) / (MAX_ZOOM - 1)) * 50;
}

function fromSlider(value: number): number {
  if (Math.abs(value - 50) < 1.5) return 1; // se "pega" al 100 %
  return value <= 50 ? MIN_ZOOM + (value / 50) * (1 - MIN_ZOOM) : 1 + ((value - 50) / 50) * (MAX_ZOOM - 1);
}

const PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

type Props = { zoom: number; onChange: (zoom: number) => void };

/** Zoom de la hoja, abajo a la derecha: −, barra deslizante, + y el porcentaje (clic para elegir). */
export default function ZoomControl({ zoom, onChange }: Props) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const percent = Math.round(zoom * 100);

  return (
    <div className="zoom-control" role="group" aria-label="Zoom">
      <button
        type="button"
        className="zoom-step"
        aria-label="Alejar"
        title={keys("Alejar (⌘−)")}
        disabled={zoom <= MIN_ZOOM}
        onClick={() => onChange(stepZoom(zoom, -1))}
      >
        −
      </button>
      <input
        type="range"
        className="zoom-slider"
        min={0}
        max={100}
        step={0.5}
        value={toSlider(zoom)}
        aria-label="Zoom"
        aria-valuetext={`${percent} %`}
        onChange={(e) => onChange(fromSlider(Number(e.target.value)))}
        onDoubleClick={() => onChange(1)}
      />
      <button
        type="button"
        className="zoom-step"
        aria-label="Acercar"
        title={keys("Acercar (⌘+)")}
        disabled={zoom >= MAX_ZOOM}
        onClick={() => onChange(stepZoom(zoom, 1))}
      >
        +
      </button>
      <button
        type="button"
        className="zoom-percent"
        title={keys("Elegir el zoom (⌘0 para 100 %)")}
        onClick={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          setMenu({ x: box.left, y: box.top - 4 });
        }}
      >
        {percent} %
      </button>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={PRESETS.map((z) => ({
            label: `${Math.round(z * 100)} %${Math.abs(z - zoom) < 0.001 ? "  ✓" : ""}`,
            shortcut: z === 1 ? keys("⌘0") : undefined,
            action: () => onChange(z),
          }))}
        />
      )}
    </div>
  );
}
