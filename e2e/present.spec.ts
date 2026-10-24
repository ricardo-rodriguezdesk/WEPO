import { expect, test } from "@playwright/test";
import { collectErrors, finishExport, home, openFile, outFile, pdfInfo, saveAs } from "./helpers";

test.describe("WEPO Present", () => {
  test("imprimir con cada diseño de hoja", async ({ page }) => {
    const errors = collectErrors(page);
    await openFile(page, "presentacion.pptx");
    await expect(page.locator(".present-thumb, .slide-thumb").first()).toBeVisible();
    await page.getByLabel("Imprimir", { exact: true }).click();
    const count = page.locator(".print-count");
    // 7 diapositivas, una oculta: se imprimen 6.
    for (const [label, sheets] of [
      ["una por hoja", 6],
      ["con sus notas", 6],
      ["2 diapositivas", 3],
      ["3 por hoja", 2],
      ["6 diapositivas", 1],
    ] as const) {
      await page.locator("label.radio", { hasText: label }).locator("input").check();
      await expect(count, label).toHaveText(`${sheets} ${sheets === 1 ? "hoja" : "hojas"}`);
    }
    await page.locator("label.radio", { hasText: "ocultas" }).locator("input").check();
    await expect(count).toHaveText("2 hojas");

    await page.getByLabel("Diapositivas que se imprimen").fill("2-3");
    await page.locator("label.radio", { hasText: "2 diapositivas" }).locator("input").check();
    await expect(count).toHaveText("1 hoja");
    expect(errors).toEqual([]);
  });

  test("el PDF tiene una hoja por diapositiva, en horizontal", async ({ page }) => {
    await openFile(page, "presentacion.pptx");
    await page.getByLabel("Imprimir", { exact: true }).click();
    await page.locator("label.radio", { hasText: "una por hoja" }).locator("input").check();
    const out = outFile("diapositivas.pdf");
    await saveAs(page, out);
    await page.getByRole("button", { name: "Exportar PDF…" }).click();
    await finishExport(page, out);
    const pages = await pdfInfo(out);
    expect(pages).toHaveLength(6);
    expect(pages[0].width).toBeGreaterThan(pages[0].height);
  });

  test("gráficas y transiciones: se editan, se presentan y se guardan en PowerPoint", async ({ page }) => {
    const errors = collectErrors(page);
    await home(page);
    await page.locator(".home-card.kind-present").click();
    await page.getByLabel("Gráfica", { exact: true }).click();
    const panel = page.locator(".present-chart-panel");
    await expect(panel).toBeVisible();
    await expect(page.locator(".present-main-slide .slide-chart")).toHaveCount(1);

    // Datos, título y tipo.
    const cell = page.getByLabel("Serie 1, Categoría 1");
    await cell.fill("10");
    await cell.press("Enter");
    await page.getByLabel("Título de la gráfica").fill("Ventas");
    await page.getByLabel("Título de la gráfica").press("Enter");
    await panel.getByRole("radio", { name: "Barras" }).click();
    await expect(page.locator(".present-main-slide .slide-chart svg text").first()).toHaveText("Ventas");

    // Segunda diapositiva con transición Empujar.
    await page.getByRole("button", { name: /\+ Diapositiva/ }).click();
    await page.getByRole("button", { name: /^Transición/ }).click();
    await page.locator(".present-transition-grid").getByRole("radio", { name: "Empujar" }).click();
    await expect(page.getByRole("button", { name: /^Transición: Empujar/ })).toBeVisible();
    await expect(page.locator(".present-thumb-transition")).toHaveCount(1);
    await page.keyboard.press("Escape");

    // Al presentar, al pasar a la 2 se ven las dos mientras entra la nueva.
    await page.getByRole("button", { name: /Presentar/ }).click();
    await expect(page.locator(".presenter")).toBeVisible();
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".presenter-layer")).toHaveCount(2);
    await expect(page.locator(".presenter-layer")).toHaveCount(1);
    await page.keyboard.press("Escape");

    // Guardar y volver a abrir: la gráfica y la transición siguen ahí.
    const out = outFile("grafica.pptx");
    await saveAs(page, out);
    await page.keyboard.press("ControlOrMeta+s");
    await expect(page.locator(".present-footer .sheet-status")).toContainText("Guardado");
    await home(page);
    await page.evaluate((p) => ((window as unknown as Record<string, unknown>).__openPath = p), out);
    await page.getByText("Abrir archivo…").click();
    await expect(page.locator(".present-main-slide .slide-chart")).toHaveCount(1);
    await expect(page.locator(".present-notice")).toHaveCount(0);
    await page.locator(".present-main-slide .slide-chart").dblclick();
    await expect(page.getByLabel("Serie 1, Categoría 1")).toHaveValue("10");
    await expect(page.locator(".present-chart-panel").getByRole("radio", { name: "Barras" })).toHaveAttribute("aria-checked", "true");
    await expect(page.getByLabel("Título de la gráfica")).toHaveValue("Ventas");
    await page.locator(".present-thumb").nth(1).click();
    await expect(page.getByRole("button", { name: /^Transición: Empujar/ })).toBeVisible();
    expect(errors).toEqual([]);
  });
});
