// Órdenes de la aplicación (guardar, imprimir, abrir…).
//
// Pueden llegar por dos caminos a la vez: el atajo de teclado dentro de la
// página y el menú nativo de macOS (que tiene los mismos atajos). Todo pasa
// por aquí para que una sola pulsación nunca se ejecute dos veces.

export type Command =
  | "new-sheet"
  | "new-document"
  | "open"
  | "save"
  | "save-as"
  | "print"
  | "export-pdf"
  | "find"
  | "home"
  | "quit"
  | "zoom-in"
  | "zoom-out"
  | "zoom-reset";

const EVENT = "wepo-command";
let last: { command: string; source: Source; time: number } = { command: "", source: "key", time: 0 };

/** De dónde llega la orden: el atajo dentro de la página o el menú nativo. */
export type Source = "key" | "menu";

export function runCommand(command: Command, source: Source = "key") {
  const now = performance.now();
  // La misma pulsación llega por los dos caminos casi al mismo tiempo: la segunda se ignora.
  // Por el mismo camino solo se ignora si es la tecla que se quedó apretada (se repite muy rápido);
  // dos «Guardar como» seguidos a propósito sí cuentan.
  const window_ = command.startsWith("zoom") ? 120 : source === last.source ? 120 : 400;
  if (last.command === command && now - last.time < window_) return;
  last = { command, source, time: now };
  window.dispatchEvent(new CustomEvent<Command>(EVENT, { detail: command }));
}

export function onCommand(handler: (command: Command) => void): () => void {
  const listener = (e: Event) => handler((e as CustomEvent<Command>).detail);
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
