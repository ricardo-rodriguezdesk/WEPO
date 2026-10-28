import { expect, test } from "@playwright/test";
import { cellPoint, collectErrors, home, openFile, sheetCell } from "./helpers";

// dinamica.xlsx: hoja «Datos» (Región, Vendedor, Mes, Ventas) y hoja «Resumen»
// con una tabla dinámica hecha por LibreOffice.

test.describe("Tablas dinámicas", () => {
  test("crear una, acomodar los campos, filtrar y guardarla en el .xlsx", async ({ page }) => {
    const errors = collectErrors(page);
    const copy = await openFile(page, "dinamica.xlsx");
    const a1 = await cellPoint(page, "A1");
    await page.mouse.click(a1.x, a1.y);
    await page.getByRole("button", { name: "Insertar tabla dinámica" }).click();
    await expect(page.getByLabel("Rango de los datos")).toHaveValue("A1:D13");
    await page.getByRole("button", { name: "Crear" }).click();

    // Queda en una hoja nueva, con el panel de campos abierto.
    await expect(page.locator(".sheet-tabs .btn.active")).toHaveText("Hoja1");
    const panel = page.getByRole("complementary", { name: "Campos de tabla dinámica" });
    await expect(panel).toBeVisible();
    await expect.poll(() => sheetCell(page, "A3", 2).then((c) => c.text)).toBe("Tabla dinámica: elige los campos en el panel");

    // Marcar un campo de texto lo pone en Filas; uno de números, en Valores.
    await panel.getByRole("checkbox", { name: "Región" }).click();
    await expect(panel.getByRole("checkbox", { name: "Región" })).toBeChecked();
    await panel.getByRole("checkbox", { name: "Ventas" }).click();
    await expect(panel.getByRole("checkbox", { name: "Ventas" })).toBeChecked();
    await expect(panel.locator("[data-area='rows'] .pivot-chip")).toHaveText(/Región/);
    await expect(panel.locator("[data-area='values'] .pivot-chip")).toHaveText(/Ventas/);
    await expect.poll(() => sheetCell(page, "B3", 2).then((c) => c.text)).toBe("Suma de Ventas");
    expect((await sheetCell(page, "A4", 2)).text).toBe("Centro");
    expect((await sheetCell(page, "B4", 2)).text).toBe("$3,750");
    expect((await sheetCell(page, "A7", 2)).text).toBe("Total general");
    expect((await sheetCell(page, "B7", 2)).text).toBe("$12,700");

    // Arrastrar «Mes» a Columnas.
    await panel.locator(".pivot-field", { hasText: "Mes" }).dragTo(panel.locator("[data-area='cols']"));
    await expect.poll(() => sheetCell(page, "B3", 2).then((c) => c.text)).toBe("Enero");
    expect((await sheetCell(page, "E3", 2)).text).toBe("Total general");
    expect((await sheetCell(page, "D5", 2)).text).toBe("$1,500");

    // Promedio en lugar de suma.
    await panel.getByLabel("Resumir Ventas por").selectOption("average");
    await expect.poll(() => sheetCell(page, "E4", 2).then((c) => c.text)).toBe("$1,250");

    // Un filtro arriba: sin Ana.
    await panel.locator(".pivot-field", { hasText: "Vendedor" }).dragTo(panel.locator("[data-area='filters']"));
    await expect.poll(() => sheetCell(page, "A3", 2).then((c) => c.text)).toBe("Vendedor");
    await panel.getByRole("button", { name: "Filtrar Vendedor" }).click();
    await page.getByRole("dialog", { name: "Elementos del filtro" }).getByRole("checkbox", { name: "Ana" }).click();
    await page.getByRole("button", { name: "Aceptar" }).click();
    await expect.poll(() => sheetCell(page, "B3", 2).then((c) => c.text)).toBe("(Varios elementos)");
    // Sin Ana, el norte de marzo queda vacío.
    expect((await sheetCell(page, "A7", 2)).text).toBe("Norte");
    expect((await sheetCell(page, "D7", 2)).text).toBe("");

    // Se guarda y, al abrirla otra vez, la tabla dinámica sigue ahí con sus campos.
    await page.locator("button[title^='Guardar']").first().click();
    await expect(page.locator(".sheet-status")).toHaveText("Guardado");
    await home(page);
    await page.evaluate((p) => ((window as unknown as Record<string, unknown>).__openPath = p), copy);
    await page.getByText("Abrir archivo…").click();
    await page.locator(".sheet-tabs .btn", { hasText: "Hoja1" }).click();
    const b6 = await cellPoint(page, "B6");
    await page.mouse.click(b6.x, b6.y);
    await expect(panel).toBeVisible();
    await expect(panel.locator("[data-area='cols'] .pivot-chip")).toHaveText(/Mes/);
    await expect(panel.getByLabel("Resumir Ventas por")).toHaveValue("average");
    await expect(panel.getByRole("button", { name: "Filtrar Vendedor" })).toHaveClass(/on/);
    expect(errors).toEqual([]);
  });

  test("un archivo con tabla dinámica se edita y se guarda en el mismo archivo", async ({ page }) => {
    const errors = collectErrors(page);
    await openFile(page, "dinamica.xlsx");
    // Ya no pide guardar una copia por la tabla dinámica.
    await expect(page.locator(".sheet-notice")).toHaveCount(0);
    await page.locator(".sheet-tabs .btn", { hasText: "Resumen" }).click();
    const b5 = await cellPoint(page, "B5");
    await page.mouse.click(b5.x, b5.y);
    const panel = page.getByRole("complementary", { name: "Campos de tabla dinámica" });
    await expect(panel).toBeVisible();
    await expect(panel.getByRole("checkbox", { name: "Región" })).toBeChecked();
    await expect(panel.getByRole("checkbox", { name: "Vendedor" })).not.toBeChecked();

    // Cambia un dato y se actualiza.
    await page.locator(".sheet-tabs .btn", { hasText: "Datos" }).click();
    const d2 = await cellPoint(page, "D2");
    await page.mouse.click(d2.x, d2.y);
    await page.keyboard.type("2200");
    await page.keyboard.press("Enter");
    await page.locator(".sheet-tabs .btn", { hasText: "Resumen" }).click();
    await page.mouse.click(b5.x, b5.y);
    await panel.getByRole("button", { name: "Actualizar" }).click();
    await expect(page.locator(".sheet-status")).toHaveText("Tabla dinámica actualizada");
    const line = (label: string) =>
      page.evaluate(async (label) => {
        const res = await fetch("http://127.0.0.1:5199/sheet_view", { method: "POST", body: JSON.stringify({ sheet: 1 }) });
        const view = await res.json();
        return (view.rows as [string][][]).find((r) => r[0]?.[0] === label)?.map((c) => c[0]);
      }, label);
    await expect.poll(() => line("Norte")).toEqual(["Norte", "$3,000", "$2,200", "$1,500", "$6,700"]);
    await expect.poll(() => line("Total general")).toEqual(["Total general", "$5,050", "$4,150", "$4,500", "$13,700"]);

    // Quitarla borra lo que tenía escrito.
    await panel.getByRole("button", { name: "Eliminar tabla dinámica" }).click();
    await expect(panel).toHaveCount(0);
    await expect.poll(() => line("Norte")).toBeUndefined();
    await page.mouse.click(b5.x, b5.y);
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => line("Norte")).toEqual(["Norte", "$3,000", "$2,200", "$1,500", "$6,700"]);
    expect(errors).toEqual([]);
  });
});
