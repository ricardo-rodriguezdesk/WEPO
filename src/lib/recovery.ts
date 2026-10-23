// Copias de recuperación (ver src-tauri/src/recovery.rs). Cada ventana tiene la suya.

import { invoke } from "@tauri-apps/api/core";

export type RecoveryInfo = { name: string; original: string | null; time: number; path: string };

export const recoveryApi = {
  /** Guarda la copia del libro de esta ventana. */
  save: (name: string, original: string | null) => invoke<void>("recovery_save", { name, original }).catch(() => {}),
  /** Guarda la copia de un documento de WEPO Write (.docx en base64). */
  saveFile: (name: string, original: string | null, data: string) => invoke<void>("recovery_save_file", { name, original, data }).catch(() => {}),
  /** Copias que quedaron de la última vez, la más reciente primero. */
  list: () => invoke<RecoveryInfo[]>("recovery_info").catch(() => [] as RecoveryInfo[]),
  /** Borra la copia de esta ventana. */
  clear: () => invoke<void>("recovery_clear").catch(() => {}),
  /** Borra una copia de la lista. */
  discard: (path: string) => invoke<void>("recovery_discard", { path }).catch(() => {}),
  /** Saca la copia de la lista para abrirla; devuelve dónde quedó. */
  take: (path: string) => invoke<string>("recovery_take", { path }),
};
