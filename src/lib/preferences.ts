// Preferencias de WEPO que se recuerdan entre sesiones (en este equipo).

export type FormulaLanguage = "es" | "en";

const KEY_LANGUAGE = "wepo.formulaLanguage";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Sin almacenamiento disponible: la preferencia dura solo esta sesión.
  }
}

/** Idioma de las funciones: español (SUMA, BUSCARV…) por defecto. */
export function getFormulaLanguage(): FormulaLanguage {
  return read(KEY_LANGUAGE) === "en" ? "en" : "es";
}

export function setFormulaLanguage(language: FormulaLanguage) {
  write(KEY_LANGUAGE, language);
}
