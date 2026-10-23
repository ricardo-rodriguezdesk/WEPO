// Copia de recuperación (ver src-tauri/src/recovery.rs).

import { invoke } from "@tauri-apps/api/core";

export type RecoveryInfo = { name: string; original: string | null; time: number; path: string };

export const recoveryApi = {
  save: (name: string, original: string | null) => invoke<void>("recovery_save", { name, original }).catch(() => {}),
  info: () => invoke<RecoveryInfo | null>("recovery_info").catch(() => null),
  clear: () => invoke<void>("recovery_clear").catch(() => {}),
};
