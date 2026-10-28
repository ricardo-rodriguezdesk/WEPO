import { expect, test } from "@playwright/test";
import { cellPoint, collectErrors, home, openFile } from "./helpers";

const hiddenRows = (page: import("@playwright/test").Page) =>
  page.evaluate(async () => {
    const res = await fetch("http://127.0.0.1:5199/sheet_view", { method: "POST", body: JSON.stringify({ sheet: 0 }) });
    return ((await res.json()).hidden_rows as number[]).sort((a, b) => a - b);
  });

test("agrupar filas y columnas: contraer, niveles y guardar en Excel", async ({ page }) => {
  const errors = collectErrors(page);
  const copy = await openFile(page, "ventas.xlsx");
  const a2 = await cellPoint(page, "A2");
  const a7 = await cellPoint(page, "A7");
  await page.mouse.click(a2.x, a2.y);
  await page.keyboard.down("Shift");
  await page.mouse.click(a7.x, a7.y);
  await page.keyboard.up("Shift");
  await page.keyboard.press("Alt+Shift+ArrowRight");
  await expect(page.locator(".sheet-status")).toContainText("Agrupadas las filas 2–7");
  const collapse = page.getByRole("button", { name: "Contraer el grupo de filas 2 a 7" });
  await expect(collapse).toBeVisible();

  // Un grupo adentro, desde el menú: filas 3–4.
  const a3 = await cellPoint(page, "A3");
  const a4 = await cellPoint(page, "A4");
  await page.mouse.click(a3.x, a3.y);
  await page.keyboard.down("Shift");
  await page.mouse.click(a4.x, a4.y);
  await page.keyboard.up("Shift");
  await page.mouse.click(a4.x, a4.y, { button: "right" });
  await page.locator(".context-item", { hasText: "Agrupar filas 3–4" }).click();
  await expect(page.getByRole("button", { name: "Nivel 3 de filas" })).toBeVisible();

  // − contrae: las filas se esconden. + las vuelve a mostrar.
  await page.getByRole("button", { name: "Contraer el grupo de filas 3 a 4" }).click();
  await expect.poll(() => hiddenRows(page)).toEqual([3, 4]);
  await collapse.click();
  await expect.poll(() => hiddenRows(page)).toEqual([2, 3, 4, 5, 6, 7]);
  await page.getByRole("button", { name: "Expandir el grupo de filas 2 a 7" }).click();
  await expect.poll(() => hiddenRows(page)).toEqual([3, 4]);
  // Botón «3» de la esquina: todo a la vista.
  await page.getByRole("button", { name: "Nivel 3 de filas" }).click();
  await expect.poll(() => hiddenRows(page)).toEqual([]);
  await page.getByRole("button", { name: "Nivel 1 de filas" }).click();
  await expect.poll(() => hiddenRows(page)).toEqual([2, 3, 4, 5, 6, 7]);

  // Columnas: B–C.
  await page.locator(".col-header", { hasText: /^B$/ }).click();
  await page.locator(".col-header", { hasText: /^C$/ }).click({ modifiers: ["Shift"] });
  await page.keyboard.press("Alt+Shift+ArrowRight");
  await expect(page.getByRole("button", { name: "Contraer el grupo de columnas 2–3" })).toBeVisible();

  // Se guarda y vuelve igual (contraído).
  await page.locator("button[title^='Guardar']").first().click();
  await expect(page.locator(".sheet-status")).toHaveText("Guardado");
  await home(page);
  await page.evaluate((p) => ((window as unknown as Record<string, unknown>).__openPath = p), copy);
  await page.getByText("Abrir archivo…").click();
  await expect(page.getByRole("button", { name: "Expandir el grupo de filas 2 a 7" })).toBeVisible();
  await expect.poll(() => hiddenRows(page)).toEqual([2, 3, 4, 5, 6, 7]);
  await expect(page.getByRole("button", { name: "Contraer el grupo de columnas 2–3" })).toBeVisible();

  // Desagrupar todo con «Borrar el esquema de filas».
  await page.locator(".row-header", { hasText: /^1$/ }).click({ button: "right" });
  await page.locator(".context-item", { hasText: "Borrar el esquema de filas" }).click();
  await expect(page.locator(".outline-gutter.rows")).toHaveCount(0);
  await expect.poll(() => hiddenRows(page)).toEqual([]);
  expect(errors).toEqual([]);
});
