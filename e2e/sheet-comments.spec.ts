import { expect, test } from "@playwright/test";
import { cellPoint, collectErrors, home, openFile } from "./helpers";

test("comentarios en Sheets: conversación con respuestas, resolver y guardar en Excel", async ({ page }) => {
  const errors = collectErrors(page);
  const copy = await openFile(page, "ventas.xlsx");
  const b3 = await cellPoint(page, "B3");
  await page.mouse.click(b3.x, b3.y);
  await page.keyboard.press("ControlOrMeta+Alt+m");
  const card = page.getByRole("dialog", { name: /Comentario/ });
  await expect(page.getByRole("textbox", { name: "Comentario nuevo" })).toBeFocused();
  await page.keyboard.type("¿Febrero está bien?");
  await card.getByRole("button", { name: "Publicar" }).click();
  await expect(page.locator(".comment-mark")).toHaveCount(1);
  await expect(card.locator(".comment-message")).toHaveCount(1);
  await expect(card.locator(".comment-author")).toHaveText("Prueba");

  // Responder y resolver.
  await card.getByRole("textbox", { name: "Responder" }).fill("Sí, ya lo revisé");
  await card.getByRole("button", { name: "Responder" }).click();
  await expect(card.locator(".comment-message")).toHaveCount(2);
  await expect(card.locator(".comment-text").last()).toHaveText("Sí, ya lo revisé");
  await card.getByRole("button", { name: "Resolver" }).click();
  await expect(card.locator(".comment-done-label")).toHaveText("Resuelto");
  await expect(page.locator(".comment-mark.done")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(card).toHaveCount(0);

  // Se guarda en el .xlsx y vuelve con sus respuestas.
  await page.locator("button[title^='Guardar']").first().click();
  await expect(page.locator(".sheet-status")).toHaveText("Guardado");
  await home(page);
  await page.evaluate((p) => ((window as unknown as Record<string, unknown>).__openPath = p), copy);
  await page.getByText("Abrir archivo…").click();
  await expect(page.locator(".comment-mark.done")).toHaveCount(1);
  await page.locator(".comment-mark").click();
  await expect(card.locator(".comment-message")).toHaveCount(2);
  await expect(card.locator(".comment-text").first()).toHaveText("¿Febrero está bien?");
  await expect(card.locator(".comment-done-label")).toHaveText("Resuelto");

  // Editar el primer mensaje y borrar la conversación (se puede deshacer).
  await card.locator(".comment-message").first().hover();
  await card.getByRole("button", { name: "Editar" }).first().click();
  await card.getByLabel("Editar el comentario").fill("¿Febrero cuadra con el banco?");
  await card.getByRole("button", { name: "Guardar" }).click();
  await expect(card.locator(".comment-text").first()).toHaveText("¿Febrero cuadra con el banco?");
  await card.locator("header").getByRole("button", { name: "Eliminar" }).click();
  await expect(page.locator(".comment-mark")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.locator(".comment-mark")).toHaveCount(1);
  expect(errors).toEqual([]);
});
