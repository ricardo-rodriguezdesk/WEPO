import { expect, test } from "@playwright/test";
import { collectErrors, openFile, outFile, readSheets, saveAs } from "./helpers";

test.describe("Convertir un PDF", () => {
  test("a Write: títulos, párrafos y las cuatro tablas", async ({ page }) => {
    const errors = collectErrors(page);
    await openFile(page, "tablas.pdf");
    await page.locator("button.pdf-convert", { hasText: "Write" }).click();
    const content = page.locator(".write-content");
    await expect(content).toBeVisible({ timeout: 30_000 });
    await expect(content.locator("h1, h2, h3").first()).toContainText("Reporte de prueba");
    await expect(content.locator("table")).toHaveCount(4);
    // La primera tabla: encabezado + 6 meses + total, 5 columnas.
    const first = content.locator("table").first();
    await expect(first.locator("tr")).toHaveCount(8);
    await expect(first.locator("tr").first().locator("td, th")).toHaveCount(5);
    await expect(first).toContainText("$356,700");
    expect(errors).toEqual([]);
  });

  test("a Sheets: una hoja por tabla, con números de verdad", async ({ page }) => {
    const errors = collectErrors(page);
    await openFile(page, "tablas.pdf");
    await page.locator("button.pdf-convert", { hasText: "Sheets" }).click();
    await expect(page.locator(".grid-scroll")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".sheet-status")).toContainText("4 tablas");

    const out = outFile("tablas.xlsx");
    await saveAs(page, out);
    await page.keyboard.press("ControlOrMeta+s");
    await expect(page.locator(".sheet-status")).toHaveText("Guardado");
    const book = await readSheets(out);
    expect(book.names).toHaveLength(4);
    const total = await book.cell(0, "B8");
    expect(total.number).toBe(true);
    expect(total.text).toMatch(/356,?700/);
    expect(errors).toEqual([]);
  });
});
