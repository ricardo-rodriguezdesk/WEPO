// Pruebas de la interfaz de WEPO (carpeta e2e/). Antes de empezar se levantan
// el puente de Rust (con el motor de hojas de cálculo y los archivos de verdad)
// y la interfaz en Vite. Se corren con:  npm run test:e2e
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  // El puente atiende una hoja de cálculo a la vez: las pruebas van una tras otra.
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: "http://localhost:5194",
    viewport: { width: 1400, height: 900 },
    locale: "es-MX",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1400, height: 900 } } }],
  webServer: [
    {
      command: "cargo run --quiet --manifest-path src-tauri/Cargo.toml --example e2e_bridge",
      url: "http://127.0.0.1:5199/",
      timeout: 15 * 60_000,
      reuseExistingServer: !process.env.CI,
      stdout: "ignore",
    },
    {
      command: "npx vite --config e2e/vite.config.ts",
      url: "http://localhost:5194",
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
