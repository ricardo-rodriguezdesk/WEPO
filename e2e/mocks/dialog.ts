// Diálogos del sistema: la prueba dice qué archivo "elige" la persona.
type W = Window & Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const w = () => window as unknown as W;

export async function open(options?: { filters?: { name: string }[] }) {
  if (options?.filters?.[0]?.name === "Imágenes") return w().__imagePath ?? null;
  return w().__openPath ?? null;
}
export async function save(options: unknown) {
  w().__saveDialog = options;
  return w().__savePath ?? null;
}
export async function ask() {
  w().__asked = (w().__asked ?? 0) + 1;
  return w().__askAnswer ?? true;
}
export async function message() {
  return null;
}
