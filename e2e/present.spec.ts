import { expect, test } from "@playwright/test";
import { collectErrors, finishExport, openFile, outFile, pdfInfo, saveAs } from "./helpers";

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
});
