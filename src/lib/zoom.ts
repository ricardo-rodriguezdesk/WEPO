// Zoom de cada archivo, recordado en esta Mac (no se guarda dentro del archivo).

const KEY = "wepo.zoom";
const MAX_FILES = 50;

function load(): Record<string, number> {
  try {
    const data = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

export function loadZoom(path: string | null): number {
  const value = path ? load()[path] : undefined;
  return typeof value === "number" && value >= 0.25 && value <= 4 ? value : 1;
}

export function saveZoom(path: string | null, zoom: number) {
  if (!path) return;
  try {
    const data = load();
    delete data[path];
    if (zoom !== 1) data[path] = zoom;
    const entries = Object.entries(data).slice(-MAX_FILES);
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Sin almacenamiento el zoom simplemente no se recuerda.
  }
}
