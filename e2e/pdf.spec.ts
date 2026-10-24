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

  test("contraseñas: abrir, editar y guardar protegido; quitar o poner la contraseña", async ({ page }) => {
    const errors = collectErrors(page);
    await openFile(page, "protegido.pdf");
    const input = page.getByLabel("Contraseña del PDF");
    await input.fill("mala");
    await input.press("Enter");
    await expect(page.getByText("La contraseña no es correcta.")).toBeVisible();
    await input.fill("wepo");
    await input.press("Enter");
    const thumbs = page.locator(".pdf-thumb");
    await expect(thumbs).toHaveCount(3);
    await expect(page.locator(".sheet-notice")).toHaveCount(0);

    // Se edita y se guarda con la misma contraseña.
    await thumbs.nth(0).click();
    await page.getByLabel("Girar a la derecha").click();
    const out = outFile("protegido-editado.pdf");
    await saveAs(page, out);
    await page.keyboard.press("ControlOrMeta+Shift+s");
    await expect.poll(async () => (await pdfInfo(out, "wepo").catch(() => [])).length).toBe(3);
    await expect(pdfInfo(out)).rejects.toThrow();
    expect((await pdfInfo(out, "wepo"))[0].rotation).toBe(90);

    // Quitar la contraseña.
    await page.getByLabel(/^Contraseña: el PDF se guarda protegido/).click();
    await page.getByRole("dialog").getByRole("button", { name: "Quitar la contraseña" }).click();
    const plain = outFile("sin-contrasena.pdf");
    await saveAs(page, plain);
    await page.keyboard.press("ControlOrMeta+Shift+s");
    await expect.poll(async () => (await pdfInfo(plain).catch(() => [])).length).toBe(3);

    // Poner una contraseña nueva a un PDF que no tenía.
    await openPdf(page, "hojas-b.pdf");
    await expect(page.locator(".pdf-thumb")).toHaveCount(2);
    await page.getByLabel("Proteger con contraseña").click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Contraseña nueva").fill("nueva1");
    await dialog.getByLabel("Repetir la contraseña").fill("nueva2");
    await expect(dialog.getByText("Las dos no coinciden.")).toBeVisible();
    await dialog.getByLabel("Repetir la contraseña").fill("nueva1");
    await dialog.getByRole("button", { name: "Proteger" }).click();
    const locked = outFile("nueva-contrasena.pdf");
    await saveAs(page, locked);
    await page.keyboard.press("ControlOrMeta+Shift+s");
    await expect.poll(async () => (await pdfInfo(locked, "nueva1").catch(() => [])).length).toBe(2);
    await expect(pdfInfo(locked)).rejects.toThrow();
    expect((await pdfText(locked, "nueva1"))[0]).toContain("Hoja B1");
    expect(errors).toEqual([]);
  });

  test("combinar con un PDF que tiene contraseña: la pide", async ({ page }) => {
    await openPdf(page, "hojas-a.pdf");
    await page.evaluate((p) => ((window as unknown as Record<string, unknown>).__openPath = p), fixture("protegido.pdf"));
    await page.getByLabel("Combinar: agregar páginas de otro PDF").click();
    const ask = page.getByLabel("Contraseña del PDF que se agrega");
    await ask.fill("otra");
    await ask.press("Enter");
    await expect(page.getByText("La contraseña no es correcta.")).toBeVisible();
    await page.getByLabel("Contraseña del PDF que se agrega").fill("wepo");
    await page.getByLabel("Contraseña del PDF que se agrega").press("Enter");
    await expect(page.locator(".pdf-thumb")).toHaveCount(6);
    const out = outFile("combinado-protegido.pdf");
    await saveAs(page, out);
    await page.keyboard.press("ControlOrMeta+Shift+s");
    await expect.poll(async () => (await pdfInfo(out).catch(() => [])).length).toBe(6);
  });

  test("un PDF cuyo autor no permite cambios se ve, pero no se edita", async ({ page }) => {
    await openPdf(page, "permisos.pdf");
    await expect(page.locator(".sheet-notice")).toContainText("no permite modificarlo");
    await page.locator(".pdf-thumb").first().click();
    await page.getByLabel("Girar a la derecha").click();
    await expect(page.locator(".pdf-footer .sheet-status, .sheet-status").first()).toContainText("no permite modificarlo");
  });

  test("OCR: un escaneo se vuelve texto que se busca, se resalta, se convierte y se guarda", async ({ page }) => {
    test.setTimeout(120_000);
    const errors = collectErrors(page);
    await openFile(page, "escaneo-carta.pdf");
    const notice = page.locator(".pdf-scan-notice");
    await expect(notice).toContainText("parece escaneado");
    await notice.getByRole("button", { name: "Reconocer texto" }).click();
    await expect(page.locator(".sheet-status")).toContainText("Listo", { timeout: 90_000 });

    // El texto reconocido está encima de la imagen (se puede seleccionar y resaltar).
    const first = page.locator(".pdf-page").nth(0).locator(".textLayer");
    await expect(first).toContainText("Factura de servicios");
    await expect(first).toContainText("Cliente");
    await expect(page.locator(".pdf-page").nth(1).locator(".textLayer")).toContainText("girada");
    await page.locator("[aria-label^='Resaltar']").click();
    const word = (await first.locator("span", { hasText: "Cliente" }).first().boundingBox())!;
    await page.mouse.dblclick(word.x + 8, word.y + word.height / 2);
    await expect.poll(async () => (await highlights(page)).length).toBe(1);

    // Guardado: el PDF trae el texto (se busca en cualquier programa).
    const out = outFile("escaneo-con-texto.pdf");
    await saveAs(page, out);
    await page.keyboard.press("ControlOrMeta+Shift+s");
    await expect.poll(async () => (await pdfText(out).catch(() => [""]))[0]).toContain("Factura de servicios");
    expect((await pdfText(out))[1]).toContain("girada");

    // Y se convierte en documento de Write con texto (sin la imagen del escaneo).
    await page.locator("button.pdf-convert", { hasText: "Write" }).click();
    const content = page.locator(".write-content");
    await expect(content).toContainText("Factura de servicios", { timeout: 30_000 });
    await expect(content).toContainText("Total a pagar");
    await expect(content.locator("img")).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});
