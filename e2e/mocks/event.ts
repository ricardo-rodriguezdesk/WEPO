// Eventos de Tauri (menú, archivos abiertos): la prueba los manda con window.__emit.
type W = Window & Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Handler = (e: { payload: unknown }) => void;

export async function listen(name: string, handler: Handler) {
  const w = window as unknown as W;
  w.__listeners = w.__listeners ?? {};
  (w.__listeners[name] = w.__listeners[name] ?? []).push(handler);
  w.__emit = (n: string, payload: unknown) => (w.__listeners[n] ?? []).forEach((f: Handler) => f({ payload }));
  return () => {};
}
