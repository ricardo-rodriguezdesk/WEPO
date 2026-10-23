// Medidas de filas y columnas.
//
// Casi todas miden lo normal; solo unas pocas tienen tamaño propio. Por eso
// guardamos únicamente las excepciones y calculamos posiciones a partir de ellas.

/** Medidas por defecto de IronCalc, en píxeles (iguales a las de Rust). */
export const DEFAULT_COL_WIDTH = 90;
export const DEFAULT_ROW_HEIGHT = 25;
export const HEADER_HEIGHT = 24;
export const HEADER_WIDTH = 50;

/** Límites del zoom de la hoja. */
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 4;
export const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];

export function clampZoom(zoom: number): number {
  return Math.round(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom)) * 100) / 100;
}

/** Siguiente paso de zoom hacia arriba o hacia abajo (como ⌘+ y ⌘− en Excel). */
export function stepZoom(zoom: number, direction: 1 | -1): number {
  const next = direction > 0 ? ZOOM_STEPS.find((z) => z > zoom + 0.001) : [...ZOOM_STEPS].reverse().find((z) => z < zoom - 0.001);
  return next ?? zoom;
}

export class Axis {
  private custom: Map<number, number>;
  private sortedKeys: number[];

  /**
   * `custom` viene de Rust: pares [índice desde 1, tamaño].
   * `scale` es el zoom: todas las medidas salen multiplicadas por él.
   */
  constructor(
    private defaultSize: number,
    custom: [number, number][],
    readonly scale = 1,
  ) {
    this.custom = new Map(custom.map(([index, size]) => [index - 1, size]));
    this.sortedKeys = [...this.custom.keys()].sort((a, b) => a - b);
  }

  size(index: number): number {
    return this.rawSize(index) * this.scale;
  }

  /** Tamaño sin zoom (el que se guarda en el archivo). */
  rawSize(index: number): number {
    return this.custom.get(index) ?? this.defaultSize;
  }

  /** Distancia desde el inicio hasta el borde izquierdo/superior de `index`. */
  start(index: number): number {
    let offset = index * this.defaultSize;
    for (const key of this.sortedKeys) {
      if (key >= index) break;
      offset += this.rawSize(key) - this.defaultSize;
    }
    return offset * this.scale;
  }

  /** Clave para saber si las medidas cambiaron y hay que volver a medir. */
  signature(): string {
    return `${this.scale}|` + this.sortedKeys.map((k) => `${k}:${this.rawSize(k)}`).join(",");
  }
}
