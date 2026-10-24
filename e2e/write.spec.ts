import { expect, test, type Page } from "@playwright/test";
import { collectErrors, finishExport, openFile, outFile, pdfInfo, pdfText, saveAs } from "./helpers";

const count = (page: Page) => page.locator(".print-count");
const pager = (page: Page) => page.locator(".print-pager span");

test.describe("WEPO Write", () => {
  test("abre un Word de 3 páginas y la vista previa lo respeta", async ({ page }) => {
    const errors = collectErrors(page);
    await openFile(page, "informe.docx");
    await expect(page.locator(".write-content")).toContainText("Capítulo 1");
    await page.getByLabel("Imprimir", { exact: true }).click();
    await expect(count(page)).toHaveText("3 páginas");

    // Rango de páginas.
    const range = page.getByLabel("Páginas que se imprimen");
    await range.fill("2-3");
    await expect(count(page)).toHaveText("2 páginas");
    await range.fill("9");
    await expect(page.locator(".cf-error")).not.toHaveCount(0);
    await page.locator("label.radio", { hasText: "Todas" }).locator("input").check();

    // En horizontal el texto vuelve a repartirse: salen más páginas. (Antes se saltaba saltos de página.)
    await page.locator(".print-segment button", { hasText: "Horizontal" }).click();
    await expect(count(page)).toHaveText("4 páginas");
    await page.locator(".print-segment button", { hasText: "Vertical" }).click();
    await expect(count(page)).toHaveText("3 páginas");
    expect(errors).toEqual([]);
  });

  test("el PDF sale con las mismas páginas y con texto (no en blanco)", async ({ page }) => {
    await openFile(page, "informe.docx");
    await page.getByLabel("Imprimir", { exact: true }).click();
    await expect(count(page)).toHaveText("3 páginas");
    const out = outFile("informe.pdf");
    await saveAs(page, out);
    await page.getByRole("button", { name: "Exportar PDF…" }).click();
    await finishExport(page, out);
    const pages = await pdfInfo(out);
    expect(pages).toHaveLength(3);
    expect(pages[0]).toMatchObject({ width: 612, height: 792 });
    const text = await pdfText(out);
    expect(text[0]).toContain("Portada");
    expect(text[2]).toContain("Línea 40");
  });

  test("solo una página, desde el rango", async ({ page }) => {
    await openFile(page, "informe.docx");
    await page.getByLabel("Imprimir", { exact: true }).click();
    await page.getByLabel("Páginas que se imprimen").fill("2");
    await expect(count(page)).toHaveText("1 página");
    const out = outFile("informe-pag2.pdf");
    await saveAs(page, out);
    await page.getByRole("button", { name: "Exportar PDF…" }).click();
    await finishExport(page, out);
    expect(await pdfInfo(out)).toHaveLength(1);
    expect((await pdfText(out))[0]).not.toContain("Portada");
  });

  test("comentarios al final del documento", async ({ page }) => {
    await openFile(page, "comentarios.docx");
    await page.getByLabel("Imprimir", { exact: true }).click();
    await expect(count(page)).toHaveText("1 página");
    await page.locator("label.radio", { hasText: "comentarios al final" }).locator("input").check();
    await expect(count(page)).toHaveText("2 páginas");
    await page.getByLabel("Página siguiente").click();
    await expect(pager(page)).toContainText("2");
    const out = outFile("comentarios.pdf");
    await saveAs(page, out);
    await page.getByRole("button", { name: "Exportar PDF…" }).click();
    await finishExport(page, out);
    const text = await pdfText(out);
    expect(text).toHaveLength(2);
    expect(text[1]).toContain("Comentarios");
  });
});
