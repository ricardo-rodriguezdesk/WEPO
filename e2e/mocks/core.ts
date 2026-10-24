// En las pruebas, `invoke` (lo que en la app va a Rust) se atiende así: unas
// pocas órdenes aquí mismo y el resto en el puente (src-tauri/examples/e2e_bridge.rs),
// que usa el mismo código de Rust de la app.
type W = Window & Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export async function invoke(cmd: string, args: Record<string, unknown> = {}) {
  const w = window as unknown as W;
  if (cmd === "take_opened_files") {
    const f = w.__opened ?? [];
    w.__opened = [];
    return f;
  }
  if (cmd === "print_window") {
    w.__printed = (w.__printed ?? 0) + 1;
    return null;
  }
  if (cmd === "export_pdf") {
    // La prueba crea el PDF con el motor de Chromium (page.pdf) y avisa con __exportRelease.
    w.__exported = args;
    await new Promise((resolve) => {
      const timer = setInterval(() => {
        if (w.__exportRelease) {
          clearInterval(timer);
          w.__exportRelease = false;
          resolve(null);
        }
      }, 40);
    });
    return null;
  }
  if (cmd === "quit_app") {
    w.__quit = true;
    return null;
  }
  if (cmd === "open_window") {
    (w.__windows = w.__windows ?? []).push(args);
    return null;
  }
  const res = await fetch(`http://127.0.0.1:5199/${cmd}`, { method: "POST", body: JSON.stringify(args) });
  const data = await res.json();
  if (!res.ok) throw data;
  return data;
}
