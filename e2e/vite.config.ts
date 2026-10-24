// La interfaz de WEPO en un navegador, para las pruebas: lo que en la app es de
// Tauri (diálogos, ventana, comandos de Rust) se cambia por e2e/mocks/.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const mock = (name: string) => fileURLToPath(new URL(`./mocks/${name}.ts`, import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL("..", import.meta.url)),
  plugins: [react()],
  clearScreen: false,
  resolve: {
    alias: {
      "@tauri-apps/api/core": mock("core"),
      "@tauri-apps/api/event": mock("event"),
      "@tauri-apps/api/window": mock("window"),
      "@tauri-apps/api/webview": mock("webview"),
      "@tauri-apps/plugin-dialog": mock("dialog"),
      "@tauri-apps/plugin-clipboard-manager": mock("clipboard"),
      "@tauri-apps/plugin-opener": mock("opener"),
    },
  },
  server: { port: 5194, strictPort: true, watch: { ignored: ["**/src-tauri/**", "**/test-results/**"] } },
});
