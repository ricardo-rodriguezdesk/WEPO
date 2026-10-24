import { expect, test, type Page } from "@playwright/test";
import { collectErrors, finishExport, home, openFile, outFile, pdfInfo, pdfText, saveAs } from "./helpers";

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

  test("índice y notas al pie: se ven, se guardan en Word y se vuelven a abrir", async ({ page }) => {
    const errors = collectErrors(page);
    await home(page);
    await page.locator(".home-card.kind-write").click();
    await page.locator(".write-content").click();
    const k = page.keyboard;
    await page.getByLabel("Índice (con los títulos y sus páginas)").click();
    const heading = async (level: number, text: string) => {
      await page.getByLabel("Estilo del párrafo").selectOption(String(level));
      await k.type(text);
      await k.press("Enter");
    };
    await heading(1, "Introducción");
    await k.type("Texto con nota");
    await page.locator("[aria-label^='Nota al pie']").click();
    await page.getByLabel("Texto de la nota").fill("Fuente: INEGI, 2025.");
    await page.getByRole("dialog").getByRole("button", { name: "Listo" }).click();
    await k.press("End");
    await k.press("Enter");
    for (let i = 1; i <= 30; i++) {
      await k.type(`Renglón de relleno ${i}.`);
      await k.press("Enter");
    }
    await heading(2, "Detalle");
    await k.type("Otra nota");
    await k.press("ControlOrMeta+Alt+f");
    await page.getByLabel("Texto de la nota").fill("Segunda nota.");
    await k.press("Enter");

    // Las notas van al pie de la hoja donde está su número; el índice dice en qué página está cada título.
    await expect(page.locator(".write-fn-ref")).toHaveCount(2);
    await expect(page.locator(".write-gap .write-footnote")).toHaveText(["1 Fuente: INEGI, 2025.", "2 Segunda nota."]);
    await expect(page.locator(".write-toc-entry")).toHaveText(["Introducción1", "Detalle2"]);

    // Clic en la nota de abajo: se puede cambiar.
    await page.locator(".write-gap .write-footnote").first().click();
    await expect(page.getByRole("dialog", { name: "Nota al pie 1" })).toBeVisible();
    await page.getByLabel("Texto de la nota").fill("Fuente: INEGI.");
    await page.getByRole("dialog").getByRole("button", { name: "Listo" }).click();
    await expect(page.locator(".write-gap .write-footnote").first()).toHaveText("1 Fuente: INEGI.");

    // Guardar en Word y volver a abrir.
    const out = outFile("indice-notas.docx");
    await saveAs(page, out);
    await k.press("ControlOrMeta+s");
    await expect(page.locator(".write-footer .sheet-status")).toContainText("Guardado");
    await home(page);
    await page.evaluate((p) => ((window as unknown as Record<string, unknown>).__openPath = p), out);
    await page.getByText("Abrir archivo…").click();
    await expect(page.locator(".write-toc-entry")).toHaveText(["Introducción1", "Detalle2"]);
    await expect(page.locator(".write-gap .write-footnote")).toHaveText(["1 Fuente: INEGI.", "2 Segunda nota."]);
    await expect(page.locator(".write-notice")).toHaveCount(0);

    // Y en el PDF las notas salen al pie de su hoja.
    await page.getByLabel("Imprimir", { exact: true }).click();
    await expect(page.locator(".print-count")).toHaveText("2 páginas");
    const pdf = outFile("indice-notas.pdf");
    await saveAs(page, pdf);
    await page.getByRole("button", { name: "Exportar PDF…" }).click();
    await finishExport(page, pdf);
    const text = await pdfText(pdf);
    expect(text).toHaveLength(2);
    expect(text[0]).toMatch(/Índice.*Introducción.*1.*Detalle.*2/);
    expect(text[0]).toMatch(/1 Fuente: INEGI\.$/);
    expect(text[1]).toMatch(/2 Segunda nota\.$/);
    expect(errors).toEqual([]);
  });
});
