import { expect, test } from "@playwright/test";
import { cellPoint, collectErrors, finishExport, home, openFile, outFile, pdfInfo, pdfText, readSheets, saveAs, sheetCell } from "./helpers";

test.describe("WEPO Sheets", () => {
  test("abre un Excel, calcula una fórmula y la guarda", async ({ page }) => {
    const errors = collectErrors(page);
    const copy = await openFile(page, "ventas.xlsx");
    await expect(page.locator(".grid-scroll")).toBeVisible();
    expect((await sheetCell(page, "A1")).text).toBe("Mes");

    // Las funciones van en español, como en Excel en español.
    const p = await cellPoint(page, "B12");
    await page.mouse.click(p.x, p.y);
    await page.keyboard.type("=SUMA(B2:B7)");
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await sheetCell(page, "B12")).text).toMatch(/356,?700/);
    expect((await sheetCell(page, "D9")).text).toMatch(/148,?300/);

    // Guardar sobre el mismo archivo y volver a abrirlo con el motor.
    await page.locator("button[title^='Guardar']").first().click();
    await expect(page.locator(".sheet-status")).toHaveText("Guardado");
    const saved = await readSheets(copy);
    expect(saved.names[0]).toBe("Ventas 2026");
    const f2 = await saved.cell(0, "B12");
    expect(f2.number).toBe(true);
    expect(f2.text).toMatch(/356,?700/);
    expect(errors).toEqual([]);
  });

  test("imprimir: la vista previa cambia con las opciones y el PDF sale igual", async ({ page }) => {
    const errors = collectErrors(page);
    await openFile(page, "ventas.xlsx");
    await page.getByLabel("Imprimir", { exact: true }).click();
    const count = page.locator(".print-count");
    await expect(count).toHaveText("1 página");
    await page.locator(".print-settings select").nth(2).selectOption("none");
    await expect(count).toHaveText("2 páginas");

    // Elegir el área de impresión con el mouse.
    await page.getByRole("button", { name: "Seleccionar en la hoja…" }).click();
    await expect(page.locator(".print-pick-bar")).toBeVisible();
    const a = await cellPoint(page, "A1");
    const b = await cellPoint(page, "C4");
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 5 });
    await page.mouse.up();
    await expect(page.locator(".print-pick-bar b")).toHaveText("A1:C4");
    await page.locator(".print-pick-bar").getByRole("button", { name: "Listo" }).click();
    await expect(page.getByRole("textbox", { name: "Área de impresión" })).toHaveValue("A1:C4");
    await expect(count).toHaveText("1 página");

    // Pie con número de página, y el PDF con las mismas páginas que dice la vista previa (sin hoja en blanco de más).
    await page.getByPlaceholder("Por ejemplo: Página [Página] de [Páginas]").fill("Página [Página] de [Páginas]");
    await expect(page.locator(".print-preview .print-page-text")).toHaveText("Página 1 de 1");
    const out = outFile("area.pdf");
    await saveAs(page, out);
    await page.getByRole("button", { name: "Exportar PDF…" }).click();
    await finishExport(page, out);
    const pages = await pdfInfo(out);
    expect(pages).toHaveLength(1);
    expect((await pdfText(out))[0]).toContain("Página 1 de 1");
    expect(errors).toEqual([]);
  });

  test("imprimir: filas que se repiten arriba en cada página", async ({ page }) => {
    await openFile(page, "gastos.xlsx");
    await page.getByLabel("Imprimir", { exact: true }).click();
    await expect(page.locator(".print-count")).toHaveText("4 páginas");
    await page.getByPlaceholder("1 o 1:2").fill("1");
    await expect(page.locator(".print-count")).toHaveText("5 páginas");
    await page.getByLabel("Página siguiente").click();
    await expect(page.locator(".print-preview .print-table tr").first()).toContainText("Folio");
    await page.locator(".print-settings select").nth(2).selectOption("page");
    await expect(page.locator(".print-count")).toHaveText("1 página");
  });

  test("área de impresión desde el menú de la celda", async ({ page }) => {
    await openFile(page, "ventas.xlsx");
    const a = await cellPoint(page, "A1");
    const b = await cellPoint(page, "B3");
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 5 });
    await page.mouse.up();
    await page.mouse.click(a.x, a.y + 20, { button: "right" });
    await page.locator(".context-item", { hasText: "Establecer área de impresión" }).click();
    await expect(page.locator(".sheet-status")).toContainText("A1:B3");
    await page.getByLabel("Imprimir", { exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Área de impresión" })).toHaveValue("A1:B3");
  });

  test("cortes de página: líneas punteadas donde termina cada hoja impresa", async ({ page }) => {
    await openFile(page, "gastos.xlsx");
    await expect(page.locator(".page-break")).toHaveCount(0);
    const toggle = page.getByRole("button", { name: "Cortes de página" });
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    // 150 filas, ajustadas al ancho: 4 páginas hacia abajo y 1 de ancho.
    await expect(page.locator(".page-break.h")).toHaveCount(4);
    await expect(page.locator(".page-break.v")).toHaveCount(1);

    // Con otras opciones de impresión, los cortes cambian.
    await page.getByLabel("Imprimir", { exact: true }).click();
    await page.locator(".print-settings select").nth(2).selectOption("page");
    await expect(page.locator(".print-count")).toHaveText("1 página");
    await saveAs(page, outFile("gastos-una.pdf"));
    await page.getByRole("button", { name: "Exportar PDF…" }).click();
    await finishExport(page, outFile("gastos-una.pdf"));
    await expect(page.locator(".page-break.h")).toHaveCount(1);

    await toggle.click();
    await expect(page.locator(".page-break")).toHaveCount(0);
  });

  test("saltos de página a mano: insertar, mover arrastrando, imprimir y guardar en Excel", async ({ page }) => {
    const errors = collectErrors(page);
    const copy = await openFile(page, "gastos.xlsx");
    const menuAt = async (ref: string, item: string) => {
      const p = await cellPoint(page, ref);
      await page.mouse.click(p.x, p.y);
      await page.mouse.click(p.x, p.y, { button: "right" });
      await page.locator(".context-item", { hasText: item }).click();
    };
    // Salto arriba de la fila 11: la página 1 llega hasta la fila 10.
    await menuAt("A11", "Insertar salto de página");
    await expect(page.getByRole("button", { name: "Cortes de página" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".page-break.h.manual")).toHaveCount(1);
    await expect(page.locator(".page-break.h.manual")).toHaveAttribute("data-row", "10");

    await page.getByLabel("Imprimir", { exact: true }).click();
    await expect(page.locator(".print-count")).toHaveText("5 páginas");
    await expect(page.locator(".print-preview .print-table tr").last()).toContainText("Gasto número 9");
    await page.keyboard.press("Escape");

    // Arrastrar el salto a mano hasta arriba de la fila 21.
    const line = page.locator(".page-break.h.manual");
    const box = (await line.boundingBox())!;
    const target = await cellPoint(page, "A21");
    await page.mouse.move(box.x + 40, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 40, target.y - 8, { steps: 8 });
    await page.mouse.up();
    await expect(page.locator(".page-break.h.manual")).toHaveAttribute("data-row", "20");

    // Arrastrar un corte automático lo vuelve salto a mano.
    const auto = page.locator(".page-break.h.drag:not(.manual)").first();
    const autoRow = Number(await auto.getAttribute("data-row"));
    await auto.scrollIntoViewIfNeeded();
    const autoBox = (await auto.boundingBox())!;
    await page.mouse.move(autoBox.x + 40, autoBox.y + autoBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(autoBox.x + 40, autoBox.y + autoBox.height / 2 - 100, { steps: 8 });
    await page.mouse.up();
    await expect(page.locator(".page-break.h.manual")).toHaveCount(2);
    const rows = (await page.locator(".page-break.h.manual").evaluateAll((els) => els.map((e) => Number(e.getAttribute("data-row"))))).sort((a, b) => a - b);
    expect(rows[0]).toBe(20);
    expect(rows[1]).toBeLessThan(autoRow);

    // Se guarda en el .xlsx (como <rowBreaks> de Excel) y se vuelve a leer.
    await page.locator("button[title^='Guardar']").first().click();
    await expect(page.locator(".sheet-status")).toHaveText("Guardado");
    await home(page);
    await page.evaluate((p) => ((window as unknown as Record<string, unknown>).__openPath = p), copy);
    await page.getByText("Abrir archivo…").click();
    await expect(page.locator(".page-break.h.manual")).toHaveCount(2);

    // Quitar uno con el menú y restablecer todos.
    await menuAt("A21", "Quitar salto de página");
    await expect(page.locator(".page-break.h.manual")).toHaveCount(1);
    await menuAt("B5", "Restablecer todos los saltos de página");
    await expect(page.locator(".page-break.h.manual")).toHaveCount(0);
    expect(errors).toEqual([]);
  });
  test("vista previa de salto de página: páginas numeradas y el borde azul cambia lo que se imprime", async ({ page }) => {
    const errors = collectErrors(page);
    await openFile(page, "gastos.xlsx");
    await page.getByRole("button", { name: "Vista previa de salto de página" }).click();
    await expect(page.locator(".grid-scroll.break-preview")).toHaveCount(1);
    const labels = page.locator(".break-preview-label");
    await expect(labels).toHaveCount(4);
    await expect(labels.first()).toHaveText("Página 1");
    await expect(labels.last()).toHaveText("Página 4");
    await expect(page.locator(".break-preview-area")).toHaveCount(1);
    await expect(page.locator(".page-break.outer")).toHaveCount(4);

    // Subir el borde de abajo 45 filas: se imprime menos y quedan menos páginas.
    // (Ventana alta para que todo el arrastre quepa en pantalla.)
    await page.setViewportSize({ width: 1400, height: 2600 });
    const edge = page.locator(".page-break.h.outer[data-side='end']");
    await edge.scrollIntoViewIfNeeded();
    const endRow = Number(await edge.getAttribute("data-row"));
    const goal = endRow - 45;
    const box = (await edge.boundingBox())!;
    const header = (await page.locator(".row-header").filter({ hasText: new RegExp(`^${goal + 1}$`) }).first().boundingBox())!;
    await page.mouse.move(box.x + 40, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 40, header.y + 2, { steps: 10 });
    await page.mouse.up();
    await expect(page.locator(".sheet-status")).toHaveText(new RegExp(`Área de impresión: A1:[A-Z]+${goal}$`));
    await expect(page.locator(".page-break.h.outer[data-side='end']")).toHaveAttribute("data-row", String(goal));
    await expect(labels).toHaveCount(3);

    // «Dividir a lo ancho» parte la página de la celda elegida con una línea vertical.
    await page.locator(".grid-scroll").evaluate((el) => (el.scrollTop = 0));
    const a2 = await cellPoint(page, "A2");
    await page.mouse.click(a2.x, a2.y);
    await page.getByRole("button", { name: "Dividir a lo ancho" }).click();
    await expect(page.locator(".sheet-status")).toContainText("Tamaño real");
    await expect(page.locator(".page-break.v.manual")).toHaveAttribute("data-col", "1");
    await expect(page.locator(".sheet-status")).toContainText("columna B");

    // Un salto de columna en una columna vacía a la derecha: el área crece hasta ahí, la escala
    // pasa a «Tamaño real» (con «ajustar columnas» no contaría) y sale una página a la derecha.
    await page.locator(".grid-scroll").evaluate((el) => (el.scrollTop = 0));
    const e1 = await cellPoint(page, "E2");
    await page.mouse.click(e1.x, e1.y);
    await page.mouse.click(e1.x, e1.y, { button: "right" });
    await page.locator(".context-item", { hasText: "Insertar salto de página" }).click();
    await expect(page.locator(".sheet-status")).toContainText("Salto de página insertado");
    await expect(page.locator(".page-break.v.manual[data-col='4']")).toHaveCount(1);
    await expect(page.locator(".page-break.v.outer[data-side='end']")).toHaveAttribute("data-col", "5");
    const lefts = await labels.evaluateAll((els) => [...new Set(els.map((e) => (e as HTMLElement).style.left))]);
    expect(lefts.length).toBe(3);

    // De regreso a la vista normal.
    await page.getByRole("button", { name: "Normal", exact: true }).click();
    await expect(labels).toHaveCount(0);
    await expect(page.locator(".grid-scroll.break-preview")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("texto en columnas y buscar objetivo", async ({ page }) => {
    const errors = collectErrors(page);
    await home(page);
    await page.locator(".home-card.kind-sheets").click();
    const type = async (ref: string, text: string) => {
      const p = await cellPoint(page, ref);
      await page.mouse.click(p.x, p.y);
      await page.keyboard.type(text);
      await page.keyboard.press("Enter");
    };
    await type("A1", "Juan Pérez");
    await type("A2", "Ana María López");
    await type("A3", "Luis Gómez");
    const a1 = await cellPoint(page, "A1");
    await page.mouse.click(a1.x, a1.y);
    await page.getByLabel("Texto en columnas", { exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("Vista previa")).toContainText("López");
    await dialog.getByRole("button", { name: "Separar en 3 columnas" }).click();
    await expect.poll(async () => (await sheetCell(page, "B1")).text).toBe("Pérez");
    expect((await sheetCell(page, "A2")).text).toBe("Ana");
    expect((await sheetCell(page, "C2")).text).toBe("López");
    // Se deshace de una vez.
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(async () => (await sheetCell(page, "A1")).text).toBe("Juan Pérez");
    expect((await sheetCell(page, "B1")).text).toBe("");

    // Buscar objetivo: ¿qué precio da 580 con IVA?
    await type("A5", "100");
    await type("B5", "=A5*1.16");
    const b5 = await cellPoint(page, "B5");
    await page.mouse.click(b5.x, b5.y);
    await page.getByLabel("Buscar objetivo", { exact: true }).click();
    await expect(dialog.getByLabel("Definir la celda")).toHaveValue("B5");
    await dialog.getByLabel("Con el valor").fill("580");
    await dialog.getByLabel("Cambiando la celda").fill("A5");
    await dialog.getByRole("button", { name: "Buscar" }).click();
    await expect(dialog.getByRole("status")).toContainText("Se encontró una solución.");
    await expect(dialog.getByRole("status")).toContainText("A5 = 500");
    await dialog.getByRole("button", { name: "Aceptar" }).click();
    expect((await sheetCell(page, "A5")).text).toBe("500");
    // «Cancelar» regresa al valor de antes.
    await page.mouse.click(b5.x, b5.y);
    await page.getByLabel("Buscar objetivo", { exact: true }).click();
    await dialog.getByLabel("Con el valor").fill("1160");
    await dialog.getByLabel("Cambiando la celda").fill("A5");
    await dialog.getByRole("button", { name: "Buscar" }).click();
    await expect(dialog.getByRole("status")).toContainText("A5 = 1,000");
    await dialog.getByRole("button", { name: "Cancelar" }).click();
    await expect.poll(async () => (await sheetCell(page, "A5")).text).toBe("500");
    expect(errors).toEqual([]);
  });

  test("minigráficos: se insertan, cambian con los datos y se guardan en Excel", async ({ page }) => {
    const errors = collectErrors(page);
    await home(page);
    await page.locator(".home-card.kind-sheets").click();
    const click = async (ref: string, shift = false) => {
      const p = await cellPoint(page, ref);
      if (shift) await page.keyboard.down("Shift");
      await page.mouse.click(p.x, p.y);
      if (shift) await page.keyboard.up("Shift");
    };
    const type = async (ref: string, text: string) => {
      await click(ref);
      await page.keyboard.type(text);
      await page.keyboard.press("Enter");
    };
    const data = [
      ["3", "5", "2", "8"],
      ["6", "4", "7", "1"],
    ];
    for (const [r, row] of data.entries()) for (const [c, v] of row.entries()) await type(`${"BCDE"[c]}${r + 1}`, v);
    await click("B1");
    await click("E2", true);
    await page.getByLabel("Minigráficos", { exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("Rango de datos")).toHaveValue("B1:E2");
    await expect(dialog.getByLabel("Ubicación")).toHaveValue("F1:F2");
    await dialog.getByRole("radio", { name: "Columnas" }).click();
    await dialog.getByRole("button", { name: "Insertar" }).click();
    const sparks = page.locator(".grid-scroll .sparkline");
    await expect(sparks).toHaveCount(2);
    await expect(sparks.first().locator("rect")).toHaveCount(4);

    // Cambiar a línea desde la celda.
    await click("F1");
    await page.getByLabel("Minigráficos", { exact: true }).click();
    await dialog.getByRole("radio", { name: "Línea" }).click();
    await dialog.getByRole("button", { name: "Aplicar" }).click();
    await expect(sparks.first().locator("path")).toHaveCount(1);

    const out = outFile("minigraficos.xlsx");
    await saveAs(page, out);
    await page.keyboard.press("ControlOrMeta+s");
    await expect(page.locator(".sheet-status")).toHaveText("Guardado");
    const JSZip = (await import("jszip")).default;
    const { readFileSync } = await import("node:fs");
    const xml = await (await JSZip.loadAsync(readFileSync(out))).file("xl/worksheets/sheet1.xml")!.async("string");
    expect(xml).toContain("x14:sparklineGroup");
    expect(xml).toContain("<xm:sqref>F2</xm:sqref>");
    expect(xml).toMatch(/<xm:f>[^<]*!B2:E2<\/xm:f>/);

    await home(page);
    await page.evaluate((p) => ((window as unknown as Record<string, unknown>).__openPath = p), out);
    await page.getByText("Abrir archivo…").click();
    await expect(page.locator(".grid-scroll .sparkline")).toHaveCount(2);
    expect(errors).toEqual([]);
  });

  test("guardar como .ods (LibreOffice) y volver a abrirlo", async ({ page }) => {
    const errors = collectErrors(page);
    await openFile(page, "ventas.xlsx");
    const out = outFile("ventas.ods");
    await saveAs(page, out);
    const first = await cellPoint(page, "A1");
    await page.mouse.click(first.x, first.y);
    await page.keyboard.press("ControlOrMeta+Shift+s");
    await expect(page.locator(".sheet-status")).toHaveText("Guardado");
    const JSZip = (await import("jszip")).default;
    const { readFileSync } = await import("node:fs");
    const zip = await JSZip.loadAsync(readFileSync(out));
    expect(await zip.file("mimetype")!.async("string")).toBe("application/vnd.oasis.opendocument.spreadsheet");
    const content = await zip.file("content.xml")!.async("string");
    expect(content).toContain('table:name="Ventas 2026"');
    expect(content).toMatch(/table:formula="of:=[A-Z]+\(\[\.[A-Z]+\d+/);
    // Guardar otra vez va directo al mismo .ods (ya es de WEPO), sin preguntar dónde.
    await page.evaluate(() => ((window as unknown as Record<string, unknown>).__saveDialog = null));
    const a12 = await cellPoint(page, "A12");
    await page.mouse.click(a12.x, a12.y);
    await page.keyboard.type("Nota");
    await page.keyboard.press("Enter");
    await page.keyboard.press("ControlOrMeta+s");
    await expect(page.locator(".sheet-status")).toHaveText("Guardado");
    expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).__saveDialog)).toBeNull();

    await home(page);
    await page.evaluate((p) => ((window as unknown as Record<string, unknown>).__openPath = p), out);
    await page.getByText("Abrir archivo…").click();
    await expect(page.locator(".grid-scroll")).toBeVisible();
    expect((await sheetCell(page, "A1")).text).toBe("Mes");
    expect((await sheetCell(page, "D9")).text).toMatch(/148,?300/);
    expect(errors).toEqual([]);
  });
});
