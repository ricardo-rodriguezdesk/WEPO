// Archivos recientes, guardados en el navegador interno de la app.

import type { DocKind } from "./documents";
import { fileNameOf, kindFromPath } from "./documents";

export type RecentFile = { path: string; name: string; kind: DocKind; time: number };

const KEY = "wepo.recents";
const MAX = 12;

export function loadRecents(): RecentFile[] {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(list) ? list.filter((f) => f && typeof f.path === "string") : [];
  } catch {
    return [];
  }
}

function store(list: RecentFile[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
  } catch {
    // Sin almacenamiento la lista simplemente no se recuerda.
  }
}

/** Pone el archivo al principio de la lista. */
export function addRecent(path: string) {
  const kind = kindFromPath(path);
  if (!kind) return;
  store([{ path, name: fileNameOf(path), kind, time: Date.now() }, ...loadRecents().filter((f) => f.path !== path)]);
}

export function removeRecent(path: string) {
  store(loadRecents().filter((f) => f.path !== path));
}

export function clearRecents() {
  store([]);
}

/** "hace 5 min", "ayer", "12 mar"… */
export function whenLabel(time: number): string {
  const minutes = Math.round((Date.now() - time) / 60000);
  if (minutes < 1) return "ahora";
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.round(hours / 24);
  if (days === 1) return "ayer";
  if (days < 7) return `hace ${days} días`;
  return new Date(time).toLocaleDateString("es-MX", { day: "numeric", month: "short" });
}

/** Carpeta del archivo, abreviando la carpeta personal con "~". */
export function folderLabel(path: string): string {
  const folder = path.slice(0, Math.max(0, path.lastIndexOf("/")));
  return folder.replace(/^\/Users\/[^/]+/, "~") || "/";
}
