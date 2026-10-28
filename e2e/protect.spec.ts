import { expect, test } from "@playwright/test";
import { cellPoint, collectErrors, home, openFile, sheetCell } from "./helpers";

test("proteger una hoja con contraseña, dejando celdas para llenar", async ({ page }) => {
  const errors = collectErrors(page);
  const copy = await openFile(page, "ventas.xlsx");
  const b2 = await cellPoint(page, "B2");
  const b7 = await cellPoint(page, "B7");
  await page.mouse.click(b2.x, b2.y);
  await page.keyboard.down("Shift");
  await page.mouse.click(b7.x, b7.y);
  await page.keyboard.up("Shift");
  await page.mouse.click(b7.x, b7.y, { button: "right" });
  await page.locator(".context-item", { hasText: "Permitir editar estas celdas" }).click();

  const tab = page.locator(".sheet-tabs .btn.active");
  await tab.click({ button: "right" });
  await page.locator(".context-item", { hasText: "Proteger hoja…" }).click();
  const dialog = page.getByRole("dialog", { name: /Proteger la hoja/ });
  await expect(dialog).toContainText("Las 6 celdas que marcaste como editables");
  await dialog.getByLabel("Contraseña de la hoja").fill("wepo");
  await dialog.getByLabel("Repetir la contraseña de la hoja").fill("wepo");
  await dialog.getByRole("button", { name: "Proteger" }).click();
  await expect(tab.locator(".sheet-tab-lock")).toBeVisible();

  // Una celda bloqueada no se puede escribir; una editable, sí.
  const a2 = await cellPoint(page, "A2");
  await page.mouse.click(a2.x, a2.y);
  await page.keyboard.type("X");
  await expect(page.locator(".sheet-status")).toContainText("La hoja está protegida");
  expect((await sheetCell(page, "A2")).text).toBe("Enero");
  await page.mouse.click(b2.x, b2.y);
  await page.keyboard.type("50000");
  await page.keyboard.press("Enter");
  await expect.poll(() => sheetCell(page, "B2").then((c) => c.text)).toBe("$50,000");
  // Borrar algo que incluye celdas bloqueadas tampoco se puede.
  await page.mouse.click(a2.x, a2.y);
  await page.keyboard.press("Delete");
  await expect(page.locator(".sheet-status")).toContainText("La hoja está protegida");

  // Se guarda protegida y pide la contraseña para quitarla.
  await page.locator("button[title^='Guardar']").first().click();
  await expect(page.locator(".sheet-status")).toHaveText("Guardado");
  await home(page);
  await page.evaluate((p) => ((window as unknown as Record<string, unknown>).__openPath = p), copy);
  await page.getByText("Abrir archivo…").click();
  await expect(tab.locator(".sheet-tab-lock")).toBeVisible();
  await tab.click({ button: "right" });
  await page.locator(".context-item", { hasText: "Quitar la protección…" }).click();
  const unlock = page.getByRole("dialog", { name: /Quitar la protección/ });
  await unlock.getByLabel("Contraseña de la hoja").fill("otra");
  await unlock.getByRole("button", { name: "Quitar la protección" }).click();
  await expect(unlock).toContainText("La contraseña no es correcta");
  await unlock.getByLabel("Contraseña de la hoja").fill("wepo");
  await unlock.getByRole("button", { name: "Quitar la protección" }).click();
  await expect(tab.locator(".sheet-tab-lock")).toHaveCount(0);
  await page.mouse.click(a2.x, a2.y);
  await page.keyboard.type("Ene");
  await page.keyboard.press("Enter");
  await expect.poll(() => sheetCell(page, "A2").then((c) => c.text)).toBe("Ene");
  // Los dos «no se puede» (borrar con la hoja protegida y la contraseña equivocada) llegan como error del motor.
  expect(errors.filter((e) => !e.includes("status of 500"))).toEqual([]);
});
