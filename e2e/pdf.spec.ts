import { expect, test, type Page } from "@playwright/test";
import { collectErrors, home, openFile, outFile, pdfInfo, pdfText, saveAs, fixture } from "./helpers";

/** Resaltados de la primera página: cuántos rectángulos tiene cada uno y dónde quedó. */
function highlights(page: Page) {
  return page.evaluate(() =>
    [...document.querySelector(".pdf-page")!.querySelectorAll(".pdf-annot-svg g")].map((g) => {
      const rs = [...g.querySelectorAll("rect")].map((r) => r.getBoundingClientRect());
      return {
        n: rs.length,
        top: Math.min(...rs.map((r) => r.top)),
        bottom: Math.max(...rs.map((r) => r.bottom)),
        left: Math.min(...rs.map((r) => r.left)),
        right: Math.max(...rs.map((r) => r.right)),
      };
    }),
  );
}
const span = (page: Page, text: string) => page.locator(".pdf-page").first().locator(".textLayer span", { hasText: text }).first();

async function openPdf(page: Page, name: string) {
  await openFile(page, name);
  await expect(page.locator(".pdf-page canvas").first()).toBeVisible();
  await expect(span(page, "")).toBeAttached();
}

test.describe("WEPO PDF", () => {
  test("girar, eliminar, combinar y guardar páginas", async ({ page }) => {
    const errors = collectErrors(page);
    await openPdf(page, "hojas-a.pdf");
    const thumbs = page.locator(".pdf-thumb");
    await expect(thumbs).toHaveCount(3);

    await thumbs.nth(1).click();
    await page.getByLabel("Girar a la derecha").click();
    await thumbs.nth(2).click();
    await page.keyboard.press("Delete");
    await expect(thumbs).toHaveCount(2);

    // Combinar con otro PDF: sus páginas entran después de la elegida.
    await thumbs.nth(0).click();
    await page.evaluate((p) => ((window as unknown as Record<string, unknown>).__openPath = p), fixture("hojas-b.pdf"));
    await page.getByLabel("Combinar: agregar páginas de otro PDF").click();
    await expect(thumbs).toHaveCount(4);

    const out = outFile("combinado.pdf");
    await saveAs(page, out);
    await page.keyboard.press("ControlOrMeta+Shift+s");
    await expect.poll(async () => (await pdfInfo(out).catch(() => [])).length).toBe(4);
    const pages = await pdfInfo(out);
    expect(pages.map((p) => p.rotation)).toEqual([0, 0, 0, 90]);
    const text = await pdfText(out);
    expect(text.map((t) => t.slice(0, 7))).toEqual(["Hoja A1", "Hoja B1", "Hoja B2", "Hoja A2"]);

    // Deshacer todo deja el documento como estaba.
    for (let i = 0; i < 3; i++) await page.keyboard.press("ControlOrMeta+z");
    await expect(thumbs).toHaveCount(3);
    expect(errors).toEqual([]);
  });

  test("resaltar: varios dobles clics en la misma palabra no oscurecen el color", async ({ page }) => {
    await openPdf(page, "tablas.pdf");
    await page.locator("[aria-label^='Resaltar']").click();
    const w = (await span(page, "Reporte de prueba").boundingBox())!;
    for (let i = 0; i < 3; i++) {
      await page.mouse.dblclick(w.x + 12, w.y + w.height / 2);
      await page.waitForTimeout(150);
    }
    await expect.poll(async () => (await highlights(page)).length).toBe(1);
    expect((await highlights(page))[0].n).toBe(1);
  });

  test("resaltar desde el margen solo marca esos renglones (no toda la hoja)", async ({ page }) => {
    await openPdf(page, "tablas.pdf");
    await page.locator("[aria-label^='Resaltar']").click();
    const box = (await page.locator(".pdf-page").first().boundingBox())!;
    const a = (await span(page, "Este PDF sirve").boundingBox())!;
    const z = (await span(page, "moneda y porcentajes").boundingBox())!;
    await page.mouse.move(box.x + 10, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 60, (a.y + z.y) / 2, { steps: 4 });
    await page.mouse.move(box.x + box.width - 10, z.y + z.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect.poll(async () => (await highlights(page)).length).toBe(1);
    const h = (await highlights(page))[0];
    expect(h.top).toBeGreaterThan(a.y - 4);
    expect(h.bottom).toBeLessThan(z.y + z.height + 4);

    // Arrastrar en el espacio en blanco del pie no resalta nada.
    await page.keyboard.press("ControlOrMeta+z");
    await page.mouse.move(box.x + box.width - 8, box.y + box.height - 40);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 200, box.y + box.height - 60, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    expect(await highlights(page)).toEqual([]);
  });

  test("el resaltado sigue sobre el texto al girar la página", async ({ page }) => {
    await openPdf(page, "tablas.pdf");
    await page.locator("[aria-label^='Resaltar']").click();
    const w = (await span(page, "Reporte de prueba").boundingBox())!;
    await page.mouse.dblclick(w.x + 12, w.y + w.height / 2);
    await expect.poll(async () => (await highlights(page)).length).toBe(1);
    for (let turn = 1; turn <= 4; turn++) {
      await page.locator(".pdf-thumb").first().click();
      await page.getByLabel("Girar a la derecha").click();
      await page.waitForTimeout(800);
      const word = (await span(page, "Reporte de prueba").boundingBox())!;
      const h = (await highlights(page))[0];
      const cx = (h.left + h.right) / 2;
      const cy = (h.top + h.bottom) / 2;
      // El centro del resaltado cae dentro del renglón, gire como gire.
      expect(cx, `giro ${turn * 90}`).toBeGreaterThan(word.x - 2);
      expect(cx, `giro ${turn * 90}`).toBeLessThan(word.x + word.width + 2);
      expect(cy, `giro ${turn * 90}`).toBeGreaterThan(word.y - 2);
      expect(cy, `giro ${turn * 90}`).toBeLessThan(word.y + word.height + 2);
    }
  });

  test("la nota se lee en modo oscuro y se guarda en el PDF", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await openPdf(page, "hojas-a.pdf");
    const box = (await page.locator(".pdf-page").first().boundingBox())!;
    await page.locator("[aria-label^='Nota adhesiva']").click();
    await page.mouse.click(box.x + 200, box.y + 100);
    await page.keyboard.type("Revisar la categoría ñ");
    const color = await page.locator(".pdf-note-popup textarea").evaluate((e) => getComputedStyle(e).color);
    expect(color).toBe("rgb(29, 29, 31)");
    await page.locator(".pdf-note-popup").getByText("Listo").click();
    await page.emulateMedia({ colorScheme: "light" });

    const out = outFile("con-nota.pdf");
    await saveAs(page, out);
    await page.keyboard.press("ControlOrMeta+Shift+s");
    await expect.poll(async () => (await pdfInfo(out).catch(() => [])).length).toBe(3);

    // Al volver a abrirlo, la nota está ahí con su texto.
    await home(page);
    await page.evaluate((p) => ((window as unknown as Record<string, unknown>).__openPath = p), out);
    await page.getByText("Abrir archivo…").click();
    await expect(page.locator(".pdf-file-note")).toHaveCount(1);
    await page.locator(".pdf-file-note button").click();
    await expect(page.locator(".pdf-file-note .pdf-note-text")).toHaveText("Revisar la categoría ñ");
  });
});
