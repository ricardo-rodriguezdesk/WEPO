import { expect, test } from "@playwright/test";
import { collectErrors, home } from "./helpers";

test("la pantalla de inicio muestra las cuatro apps", async ({ page }) => {
  const errors = collectErrors(page);
  await home(page);
  for (const kind of ["sheets", "write", "present", "pdf"]) await expect(page.locator(`.home-card.kind-${kind}`)).toBeVisible();
  await expect(page.getByText("Abrir archivo…")).toBeVisible();
  expect(errors).toEqual([]);
});

test("documentos nuevos de cada app", async ({ page }) => {
  await home(page);
  await page.locator(".home-card.kind-sheets").click();
  await expect(page.locator(".grid-scroll")).toBeVisible();
  await home(page);
  await page.locator(".home-card.kind-write").click();
  await expect(page.locator(".write-content")).toBeVisible();
  await home(page);
  await page.locator(".home-card.kind-present").click();
  await expect(page.getByLabel("Imprimir", { exact: true })).toBeVisible();
});
