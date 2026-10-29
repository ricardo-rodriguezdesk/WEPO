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
  test("notas al final: i, ii… después del texto, se guardan en Word y se vuelven a abrir", async ({ page }) => {
    const errors = collectErrors(page);
    await home(page);
    await page.locator(".home-card.kind-write").click();
    await page.locator(".write-content").click();
    const k = page.keyboard;
    await k.type("Primera idea");
    await page.locator("[aria-label^='Nota al final']").click();
    await expect(page.getByRole("dialog", { name: "Nota al final i" })).toBeVisible();
    await page.getByLabel("Texto de la nota").fill("Ver el anexo A.");
    await page.getByRole("dialog").getByRole("button", { name: "Listo" }).click();
    await k.press("End");
    await k.type(" y una nota al pie");
    await k.press("ControlOrMeta+Alt+f");
    await page.getByLabel("Texto de la nota").fill("Esta sí va al pie.");
    await k.press("Enter");
    await k.press("End");
    await k.press("Enter");
    await k.type("Segunda idea");
    await k.press("ControlOrMeta+Alt+d");
    await page.getByLabel("Texto de la nota").fill("Datos de 2025.");
    await k.press("Enter");

    const endnotes = page.locator(".write-endnotes .write-footnote");
    await expect(endnotes).toHaveText(["i Ver el anexo A.", "ii Datos de 2025."]);
    await expect(page.locator(".write-gap > .write-footnotes:not(.write-endnotes) .write-footnote")).toHaveText(["1 Esta sí va al pie."]);
    // Las llamadas en el texto: al final, al pie, al final.
    const refs = await page.locator(".write-content .write-fn-ref").evaluateAll((els) => els.map((e) => e.getAttribute("data-kind") ?? "foot"));
    expect(refs).toEqual(["end", "foot", "end"]);

    // Clic en la nota al final para cambiarla.
    await endnotes.last().click();
    await expect(page.getByRole("dialog", { name: "Nota al final ii" })).toBeVisible();
    await page.getByLabel("Texto de la nota").fill("Datos de 2026.");
    await page.getByRole("dialog").getByRole("button", { name: "Listo" }).click();

    const out = outFile("notas-al-final.docx");
    await saveAs(page, out);
    await k.press("ControlOrMeta+s");
    await expect(page.locator(".write-footer .sheet-status")).toContainText("Guardado");
    const { readFileSync } = await import("node:fs");
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(readFileSync(out));
    const endXml = (await zip.file("word/endnotes.xml")?.async("string")) ?? "";
    expect(endXml).toContain("Ver el anexo A.");
    expect(endXml).toContain("Datos de 2026.");
    expect((await zip.file("word/document.xml")!.async("string")).match(/<w:endnoteReference/g)).toHaveLength(2);

    await home(page);
    await page.evaluate((p) => ((window as unknown as Record<string, unknown>).__openPath = p), out);
    await page.getByText("Abrir archivo…").click();
    await expect(endnotes).toHaveText(["i Ver el anexo A.", "ii Datos de 2026."]);
    await expect(page.locator(".write-notice")).toHaveCount(0);
    expect(errors).toEqual([]);
  });
  test("columnas: un pedazo a dos columnas, se guarda en Word como sección y se vuelve a abrir", async ({ page }) => {
    const errors = collectErrors(page);
    await home(page);
    await page.locator(".home-card.kind-write").click();
    await page.locator(".write-content").click();
    const k = page.keyboard;
    await k.type("Título del boletín");
    await k.press("Enter");
    const long = "Este texto es largo para que se reparta en dos columnas parejas, como en un periódico o un boletín. ";
    await k.type(long.repeat(3));
    await k.press("Enter");
    await k.type(long.repeat(3));
    await k.press("Enter");
    await k.type("Texto normal al final.");
    // Elegir los dos párrafos largos y ponerlos a dos columnas.
    const paras = page.locator(".write-content > p");
    await paras.nth(1).click();
    await k.press("Home");
    await k.down("Shift");
    await paras.nth(2).click();
    await k.up("Shift");
    await page.getByRole("button", { name: "Columnas" }).click();
    await page.getByRole("menuitemradio", { name: "2 columnas" }).click();
    const block = page.locator(".write-content > .write-columns");
    await expect(block).toHaveAttribute("data-count", "2");
    await expect(block.locator("p")).toHaveCount(2);
    expect(await block.evaluate((e) => getComputedStyle(e).columnCount)).toBe("2");
    await expect(page.locator(".write-content > p")).toHaveCount(2);
    await expect(page.getByRole("button", { name: "Columnas: 2" })).toBeVisible();

    const out = outFile("columnas.docx");
    await saveAs(page, out);
    await k.press("ControlOrMeta+s");
    await expect(page.locator(".write-footer .sheet-status")).toContainText("Guardado");
    const { readFileSync } = await import("node:fs");
    const JSZip = (await import("jszip")).default;
    const xml = await (await JSZip.loadAsync(readFileSync(out))).file("word/document.xml")!.async("string");
    expect(xml).toContain('<w:cols w:num="2" w:space="720"/>');
    expect(xml.match(/<w:sectPr>/g)).toHaveLength(3);

    await home(page);
    await page.evaluate((p) => ((window as unknown as Record<string, unknown>).__openPath = p), out);
    await page.getByText("Abrir archivo…").click();
    await expect(block).toHaveAttribute("data-count", "2");
    await expect(block.locator("p")).toHaveCount(2);
    await expect(page.locator(".write-content > p")).toHaveText(["Título del boletín", "Texto normal al final."]);
    await expect(page.locator(".write-notice")).toHaveCount(0);

    // Volver a una columna.
    await block.locator("p").first().click();
    await page.getByRole("button", { name: "Columnas: 2" }).click();
    await page.getByRole("menuitemradio", { name: "Una columna (normal)" }).click();
    await expect(block).toHaveCount(0);
    await expect(page.locator(".write-content > p")).toHaveCount(4);
    expect(errors).toEqual([]);
  });
});
