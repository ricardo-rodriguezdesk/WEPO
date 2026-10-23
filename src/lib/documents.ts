// Tipos de documento que maneja WEPO y cómo reconocerlos por su extensión.

export type DocKind = "write" | "sheets" | "present" | "pdf";

export const DOC_KINDS: Record<
  DocKind,
  { name: string; newLabel: string; extensions: string[] }
> = {
  write: {
    name: "WEPO Write",
    newLabel: "Documento",
    extensions: ["docx", "odt", "txt", "md"],
  },
  sheets: {
    name: "WEPO Sheets",
    newLabel: "Hoja de cálculo",
    extensions: ["xlsx", "xlsm", "xlsb", "xls", "ods", "csv"],
  },
  present: {
    name: "WEPO Present",
    newLabel: "Presentación",
    extensions: ["pptx", "odp"],
  },
  // Los PDF no se crean desde cero: la tarjeta del inicio abre uno.
  pdf: {
    name: "WEPO PDF",
    newLabel: "Abrir un PDF",
    extensions: ["pdf"],
  },
};

export const ALL_EXTENSIONS = Object.values(DOC_KINDS).flatMap((k) => k.extensions);

export function extensionOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? "" : path.slice(dot + 1).toLowerCase();
}

/** Devuelve qué editor abre este archivo, o null si no lo soportamos. */
export function kindFromPath(path: string): DocKind | null {
  const ext = extensionOf(path);
  const entry = Object.entries(DOC_KINDS).find(([, k]) => k.extensions.includes(ext));
  return entry ? (entry[0] as DocKind) : null;
}

export function fileNameOf(path: string): string {
  // En Windows las carpetas se separan con "\\".
  return path.split(/[\\/]/).pop() ?? path;
}
