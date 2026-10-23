// Diferencias entre Mac y Windows/Linux para atajos y textos.

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** La tecla de los atajos: ⌘ en Mac, Ctrl en Windows y Linux. */
export function hasModifier(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return isMac ? e.metaKey : e.ctrlKey;
}

/** Escribe un atajo como se ve en cada sistema: "⌘S" en Mac, "Ctrl+S" en Windows. */
export function keys(text: string): string {
  return isMac ? text : text.replace(/⌘⇧/g, "Ctrl+Mayús+").replace(/⌘/g, "Ctrl+");
}
