// Órdenes de la aplicación (guardar, imprimir, abrir…).
//
// Pueden llegar por dos caminos a la vez: el atajo de teclado dentro de la
// página y el menú nativo de macOS (que tiene los mismos atajos). Todo pasa
// por aquí para que una sola pulsación nunca se ejecute dos veces.

export type Command = "new-sheet" | "open" | "save" | "save-as" | "print" | "find" | "home" | "quit";

const EVENT = "wepo-command";
let last: { command: string; time: number } = { command: "", time: 0 };

export function runCommand(command: Command) {
  const now = performance.now();
  if (last.command === command && now - last.time < 400) return;
  last = { command, time: now };
  window.dispatchEvent(new CustomEvent<Command>(EVENT, { detail: command }));
}

/** Escucha las órdenes; devuelve la función para dejar de escuchar. */
export function onCommand(handler: (command: Command) => void): () => void {
  const listener = (e: Event) => handler((e as CustomEvent<Command>).detail);
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
