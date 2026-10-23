// Medidas de filas y columnas.
//
// Casi todas miden lo normal; solo unas pocas tienen tamaño propio. Por eso
// guardamos únicamente las excepciones y calculamos posiciones a partir de ellas.

/** Medidas por defecto de IronCalc, en píxeles (iguales a las de Rust). */
export const DEFAULT_COL_WIDTH = 90;
export const DEFAULT_ROW_HEIGHT = 25;
export const HEADER_HEIGHT = 24;
export const HEADER_WIDTH = 50;

export class Axis {
  private custom: Map<number, number>;
  private sortedKeys: number[];

  /** `custom` viene de Rust: pares [índice desde 1, tamaño]. */
  constructor(
    private defaultSize: number,
    custom: [number, number][],
  ) {
    this.custom = new Map(custom.map(([index, size]) => [index - 1, size]));
    this.sortedKeys = [...this.custom.keys()].sort((a, b) => a - b);
  }

  size(index: number): number {
    return this.custom.get(index) ?? this.defaultSize;
  }

  /** Distancia desde el inicio hasta el borde izquierdo/superior de `index`. */
  start(index: number): number {
    let offset = index * this.defaultSize;
    for (const key of this.sortedKeys) {
      if (key >= index) break;
      offset += this.size(key) - this.defaultSize;
    }
    return offset;
  }

  /** Clave para saber si las medidas cambiaron y hay que volver a medir. */
  signature(): string {
    return this.sortedKeys.map((k) => `${k}:${this.size(k)}`).join(",");
  }
}
