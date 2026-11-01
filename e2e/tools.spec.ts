import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { collectErrors, finishExport, fixture, home, outDir, outFile, pdfInfo, pdfText } from "./helpers";

/** Lo que se ve de cada página (la CropBox), en puntos. */
async function visible(path: string) {
  const doc = await PDFDocument.load(readFileSync(path));
  return doc.getPages().map((p) => {
    const b = p.getCropBox();
    return { width: Math.round(b.width), height: Math.round(b.height) };
  });
}

type W = Record<string, unknown>;
const set = (page: Page, key: string, value: unknown) => page.evaluate(([k, v]) => ((window as unknown as W)[k as string] = v), [key, value] as const);

/** Abre WEPO Convertir y la herramienta con ese nombre. */
async function openTool(page: Page, name: string) {
  await home(page);
  await page.getByRole("button", { name: /WEPO Convertir/ }).click();
  await page.getByRole("button", { name: new RegExp(`^${name}`) }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
}

/** «Elige» archivos de ejemplo en la herramienta abierta. */
async function chooseFiles(page: Page, names: string[], button = /^Elegir archivos?$/) {
  await set(page, "__openPath", names.length === 1 ? fixture(names[0]) : names.map(fixture));
  await page.getByRole("button", { name: button }).click();
  for (const n of names) await expect(page.locator(".tool-file-name", { hasText: n }).first()).toBeVisible();
}

/** Una carpeta vacía para lo que guarda una herramienta con varios archivos. */
function emptyFolder(name: string) {
  const dir = join(outDir(), name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

test.describe("WEPO Convertir", () => {
  test("dividir: un archivo por página y por rangos", async ({ page }) => {
    const errors = collectErrors(page);
    await openTool(page, "Dividir PDF");
    await chooseFiles(page, ["hojas-a.pdf"]);
    await expect(page.getByText("Cómo dividir (3 páginas)")).toBeVisible();
    const dir = emptyFolder("dividir");
    await set(page, "__folderPath", dir);
    await page.getByRole("button", { name: "Dividir", exact: true }).click();
    await expect(page.locator(".tool-result")).toContainText("3 archivos PDF");
    expect(readdirSync(dir).sort()).toEqual(["hojas-a - página 1.pdf", "hojas-a - página 2.pdf", "hojas-a - página 3.pdf"]);
    expect((await pdfText(join(dir, "hojas-a - página 2.pdf")))[0]).toContain("Hoja A2");

    // Por rangos: 1-2 y 3.
    await page.getByRole("button", { name: "Empezar de nuevo" }).click();
    await chooseFiles(page, ["hojas-a.pdf"]);
    await page.getByText("Por rangos", { exact: true }).click();
    await page.getByLabel("Rangos de páginas").fill("1-2, 9");
    await expect(page.getByText("«9»: el PDF tiene 3 páginas")).toBeVisible();
    await page.getByLabel("Rangos de páginas").fill("1-2, 3");
    await expect(page.getByText("2 archivos: 1-2 · 3")).toBeVisible();
    await page.getByRole("button", { name: "Dividir", exact: true }).click();
    await expect(page.locator(".tool-result")).toContainText("2 archivos PDF");
    // No encima lo que ya estaba en la carpeta.
    expect(readdirSync(dir)).toContain("hojas-a - páginas 1-2.pdf");
    expect(readdirSync(dir)).toContain("hojas-a - página 3 (2).pdf");
    expect((await pdfInfo(join(dir, "hojas-a - páginas 1-2.pdf"))).length).toBe(2);
    expect(errors).toEqual([]);
  });

  test("números de página: vista previa y «Página 1 de 3» abajo a la derecha", async ({ page }) => {
    const errors = collectErrors(page);
    await openTool(page, "Números de página");
    await chooseFiles(page, ["hojas-a.pdf"]);
    await page.getByRole("radio", { name: "Abajo a la derecha" }).click();
    await page.getByLabel("Formato del número").selectOption("page-n-of");
    // En la vista previa ya se ve.
    const preview = page.locator(".tool-number-preview");
    await expect(preview).toHaveText("Página 1 de 3");
    const pv = (await page.locator(".tool-preview").boundingBox())!;
    const nb = (await preview.boundingBox())!;
    expect(nb.x + nb.width).toBeGreaterThan(pv.x + pv.width * 0.75);
    expect(nb.y).toBeGreaterThan(pv.y + pv.height * 0.85);

    const out = outFile("numerado.pdf");
    await set(page, "__savePath", out);
    await page.getByRole("button", { name: "Poner números" }).click();
    await expect(page.locator(".tool-result")).toBeVisible();
    const text = await pdfText(out);
    expect(text[0]).toContain("Página 1 de 3");
    expect(text[2]).toContain("Página 3 de 3");

    // Desde la página 2 (la portada sin número), empezando en 1.
    await page.getByRole("button", { name: "Empezar de nuevo" }).click();
    await chooseFiles(page, ["hojas-a.pdf"]);
    await page.getByLabel("Formato del número").selectOption("n");
    await page.getByLabel("Desde la página").fill("2");
    const out2 = outFile("numerado-desde-2.pdf");
    await set(page, "__savePath", out2);
    await page.getByRole("button", { name: "Poner números" }).click();
    await expect(page.locator(".tool-result")).toBeVisible();
    const t2 = await pdfText(out2);
    expect(t2[0]).not.toMatch(/\b1\b\s*$/);
    expect(t2[1].trim()).toMatch(/1$/);
    expect(t2[2].trim()).toMatch(/2$/);
    expect(errors).toEqual([]);
  });

  test("JPG a PDF y PDF a JPG", async ({ page }) => {
    const errors = collectErrors(page);
    await openTool(page, "JPG a PDF");
    await chooseFiles(page, ["foto.jpg", "foto-vertical.jpg"], /^Elegir archivos$/);
    // El orden se cambia con las flechas.
    await page.getByRole("button", { name: "Bajar foto.jpg" }).click();
    await expect(page.locator(".tool-file-name").first()).toHaveText("foto-vertical.jpg");
    await page.getByLabel("Tamaño de la página").selectOption("a4");
    await page.getByLabel("Margen").selectOption("18");
    const out = outFile("fotos-a4.pdf");
    await set(page, "__savePath", out);
    await page.getByRole("button", { name: "Convertir a PDF" }).click();
    await expect(page.locator(".tool-result")).toContainText("2 imágenes en un PDF de 2 páginas");
    // A4: la vertical en hoja vertical, la horizontal en hoja horizontal.
    expect(await pdfInfo(out)).toEqual([
      { width: 595, height: 842, rotation: 0 },
      { width: 842, height: 595, rotation: 0 },
    ]);

    await page.getByRole("button", { name: "← Herramientas" }).click();
    await page.getByRole("button", { name: /^PDF a JPG/ }).click();
    await chooseFiles(page, ["hojas-b.pdf"], /^Elegir archivos$/);
    await page.getByLabel("Nitidez").selectOption("72");
    const dir = emptyFolder("imagenes");
    await set(page, "__folderPath", dir);
    await page.getByRole("button", { name: "Convertir a imágenes" }).click();
    await expect(page.locator(".tool-result")).toContainText("2 imágenes JPG a 72 puntos por pulgada");
    expect(readdirSync(dir).sort()).toEqual(["hojas-b - 1.jpg", "hojas-b - 2.jpg"]);
    const jpg = readFileSync(join(dir, "hojas-b - 1.jpg"));
    expect(jpg[0]).toBe(0xff);
    expect(jpg[1]).toBe(0xd8);
    expect(errors).toEqual([]);
  });

  test("comprimir: las fotos pesan menos y el PDF se ve igual", async ({ page }) => {
    const errors = collectErrors(page);
    await openTool(page, "Comprimir PDF");
    await chooseFiles(page, ["fotos.pdf"], /^Elegir archivos$/);
    const out = outFile("fotos-comprimido.pdf");
    await set(page, "__savePath", out);
    await page.getByRole("button", { name: "Comprimir", exact: true }).click();
    await expect(page.locator(".tool-result")).toContainText(/% menos/);
    const before = statSync(fixture("fotos.pdf")).size;
    const after = statSync(out).size;
    expect(after).toBeLessThan(before * 0.6);
    expect((await pdfInfo(out)).length).toBe(2);
    expect((await pdfText(out))[0]).toContain("Album de fotos, pagina 1");
    expect(errors).toEqual([]);
  });

  test("recortar: quitar los márgenes en blanco y recorte a mano", async ({ page }) => {
    const errors = collectErrors(page);
    await openTool(page, "Recortar PDF");
    await chooseFiles(page, ["margenes.pdf"]);
    await expect(page.getByTestId("crop-box")).toBeVisible();
    // «Ajustar a lo que hay»: el recuadro llega hasta el contenido (un rectángulo azul de 212 × 200).
    await page.getByRole("button", { name: "Ajustar a lo que hay" }).click();
    await expect(page.getByLabel("Recorte arriba (mm)")).not.toHaveValue("0");
    const out = outFile("recortado.pdf");
    await set(page, "__savePath", out);
    await page.getByRole("button", { name: "Recortar", exact: true }).click();
    await expect(page.locator(".tool-result")).toContainText("Se recortaron las 1 páginas");
    const [p] = await visible(out);
    expect(p.width).toBeGreaterThan(212);
    expect(p.width).toBeLessThan(240);
    expect(p.height).toBeGreaterThan(200);
    expect(p.height).toBeLessThan(228);

    // A mano: arrastrar la esquina de abajo a la derecha hacia adentro.
    await page.getByRole("button", { name: "Empezar de nuevo" }).click();
    await chooseFiles(page, ["hojas-a.pdf"]);
    const handle = page.locator("[data-handle=se]");
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x - 60, box.y - 40, { steps: 5 });
    await page.mouse.up();
    await expect(page.getByLabel("Recorte derecha (mm)")).not.toHaveValue("0");
    await expect(page.getByLabel("Recorte abajo (mm)")).not.toHaveValue("0");
    await page.getByText("Solo esta página").click();
    const out2 = outFile("recortado-a-mano.pdf");
    await set(page, "__savePath", out2);
    await page.getByRole("button", { name: "Recortar", exact: true }).click();
    await expect(page.locator(".tool-result")).toContainText("Se recortó la página 1");
    const pages = await visible(out2);
    const original = await visible(fixture("hojas-a.pdf"));
    expect(pages[0].width).toBeLessThan(original[0].width - 30);
    expect(pages[1]).toEqual(original[1]);
    expect(errors).toEqual([]);
  });

  test("marca de agua con imagen, en mosaico y debajo del texto", async ({ page }) => {
    const errors = collectErrors(page);
    await openTool(page, "Marca de agua");
    await chooseFiles(page, ["contrato-v1.pdf"], /^Elegir archivos$/);
    await page.getByRole("tab", { name: "Imagen" }).click();
    await set(page, "__openPath", fixture("logo.png"));
    await page.getByRole("button", { name: "Elegir imagen…" }).click();
    await expect(page.locator(".tool-mark-image img")).toBeVisible();
    await expect(page.locator(".tool-mark-preview img").first()).toBeVisible();
    await page.getByText("En mosaico (repetida)").click();
    expect(await page.locator(".tool-mark-preview").count()).toBeGreaterThan(4);
    await page.getByLabel("Capa").selectOption("under");
    await page.getByLabel("Páginas con marca de agua").fill("1");
    const out = outFile("marca-imagen.pdf");
    await set(page, "__savePath", out);
    await page.getByRole("button", { name: "Poner marca de agua" }).click();
    await expect(page.locator(".tool-result")).toContainText("Marca de agua con imagen puesta");
    // El texto sigue ahí (la marca va debajo) y la imagen se guarda una sola vez.
    expect((await pdfText(out))[0]).toContain("Contrato de servicios");
    const bytes = readFileSync(out).toString("latin1");
    expect(bytes.match(/\/Subtype\s*\/Image/g)?.length).toBe(1);
    expect(bytes).toContain("/WepoMark");
    expect(errors).toEqual([]);
  });

  test("PDF a PowerPoint: diapositivas con el texto editable", async ({ page }) => {
    const errors = collectErrors(page);
    await openTool(page, "PDF a PowerPoint");
    await chooseFiles(page, ["contrato-v1.pdf"]);
    const out = outFile("contrato.pptx");
    await set(page, "__savePath", out);
    await page.getByRole("button", { name: "Convertir a PowerPoint" }).click();
    await expect(page.locator(".tool-result")).toContainText("Una diapositiva por página");
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(readFileSync(out));
    const slide1 = await zip.file("ppt/slides/slide1.xml")!.async("string");
    expect(slide1).toContain("Contrato de servicios");
    expect(slide1).toContain("plazo de 30 dias");
    expect(slide1).toContain('b="1"');
    expect(zip.file("ppt/slides/slide2.xml")).toBeTruthy();
    // Se abre en WEPO Present.
    await page.getByRole("button", { name: "Abrir en WEPO Present" }).click();
    await expect(page.locator(".present-thumb")).toHaveCount(2);
    await expect(page.locator(".present-main-slide")).toContainText("Contrato de servicios");
    expect(errors).toEqual([]);
  });

  test("comparar: lo que se quitó, lo que se agregó y lo que cambió", async ({ page }) => {
    const errors = collectErrors(page);
    await openTool(page, "Comparar PDF");
    await set(page, "__openPath", fixture("contrato-v1.pdf"));
    await page.getByRole("button", { name: "Elegir el PDF de antes" }).click();
    await expect(page.locator(".tool-compare-slot").first()).toContainText("contrato-v1.pdf");
    await set(page, "__openPath", fixture("contrato-v2.pdf"));
    await page.getByRole("button", { name: "Elegir el PDF de después" }).click();
    await expect(page.locator(".tool-compare-slot").nth(1)).toContainText("contrato-v2.pdf");
    await page.getByRole("button", { name: "Comparar", exact: true }).click();
    await expect(page.locator(".tool-compare-summary")).toContainText("4 diferencias en el texto: 1 quitada, 1 agregada, 2 cambiadas");
    const list = page.getByLabel("Diferencias");
    await expect(list.locator(".tool-change.changed").first()).toContainText("30");
    await expect(list.locator(".tool-change.changed").first()).toContainText("45");
    await expect(list.locator(".tool-change.removed")).toContainText("Las partes acuerdan revisar el avance cada semana.");
    await expect(list.locator(".tool-change.added")).toContainText("garantia de seis meses");
    expect(await page.locator(".tool-hl.removed").count()).toBeGreaterThan(5);
    expect(await page.locator(".tool-hl.added").count()).toBeGreaterThan(5);
    // Cambios de dibujo: el rectángulo rojo nuevo.
    await page.getByText("Marcar también los cambios de dibujo").click();
    await expect(page.locator(".tool-hl.visual").first()).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("reparar un PDF dañado", async ({ page }) => {
    const errors = collectErrors(page);
    await openTool(page, "Reparar PDF");
    await chooseFiles(page, ["danado.pdf"], /^Elegir archivos$/);
    const out = outFile("reparado.pdf");
    await set(page, "__savePath", out);
    await page.getByRole("button", { name: "Reparar", exact: true }).click();
    await expect(page.locator(".tool-result")).toContainText("danado.pdf");
    const text = await pdfText(out);
    expect(text.length).toBe(3);
    expect(text[2]).toContain("Hoja A3");
    expect(readFileSync(out).subarray(0, 5).toString()).toBe("%PDF-");
    expect(errors).toEqual([]);
  });

  test("PDF a PDF/A: metadatos, perfil de color y letras incrustadas", async ({ page }) => {
    const errors = collectErrors(page);
    await openTool(page, "PDF a PDF/A");
    await chooseFiles(page, ["contrato-v1.pdf"], /^Elegir archivos$/);
    const out = outFile("contrato-pdfa.pdf");
    await set(page, "__savePath", out);
    await page.getByRole("button", { name: "Convertir a PDF/A" }).click();
    // Helvetica no viene dentro del PDF: las páginas quedan como imagen con su texto.
    await expect(page.locator(".tool-result")).toContainText("PDF/A-2b");
    await expect(page.locator(".tool-result")).toContainText("las páginas 1, 2 quedaron como imagen");
    const raw = readFileSync(out).toString("latin1");
    expect(raw).toContain("<pdfaid:part>2</pdfaid:part>");
    expect(raw).toContain("/GTS_PDFA1");
    expect(raw).toMatch(/\/ID\s*\[/);
    // El texto se sigue pudiendo buscar.
    expect((await pdfText(out))[0]).toContain("Contrato de servicios");
    expect(errors).toEqual([]);
  });

  test("HTML a PDF: con sus estilos e imagen, sin scripts", async ({ page }) => {
    const errors = collectErrors(page);
    await openTool(page, "HTML a PDF");
    await chooseFiles(page, ["pagina.html"]);
    // La vista previa (sin scripts: el iframe no los deja correr).
    const preview = page.locator(".tool-html-preview iframe");
    await expect(preview).toBeVisible();
    const srcdoc = (await preview.getAttribute("srcdoc")) ?? "";
    expect(srcdoc).toContain("<h1>Boletín de noviembre</h1>");
    expect(srcdoc).toContain('src="data:image/png;base64,');
    expect(srcdoc).toContain("border-collapse: collapse");
    expect(srcdoc).not.toContain("NO DEBE SALIR");
    await page.getByLabel("Tamaño de la hoja").selectOption("a4");
    const out = outFile("boletin.pdf");
    await set(page, "__savePath", out);
    await page.getByRole("button", { name: "Convertir a PDF" }).click();
    const asked = await finishExport(page, out);
    expect(asked).toEqual({ width: 595.28, height: 841.89, margin: 36 });
    await expect(page.locator(".tool-result")).toContainText("Boletín de noviembre quedó como PDF en hojas A4");
    const text = (await pdfText(out)).join(" ");
    expect(text).toContain("Boletín de noviembre");
    expect(text).toContain("Pruebas");
    expect(text).not.toContain("NO DEBE SALIR");
    // Lo que no se imprime de la app no sale.
    expect(text).not.toContain("WEPO Convertir");
    const bytes = readFileSync(out).toString("latin1");
    expect(bytes).toMatch(/\/Subtype\s*\/Image/);
    // El iframe de la vista previa no deja correr nada; Chromium a veces avisa cuando las
    // herramientas de prueba se asoman a él (la página ya va sin scripts, ver arriba).
    expect(errors.filter((e) => !e.includes("about:srcdoc"))).toEqual([]);
  });

  test("unir, girar y ordenar", async ({ page }) => {
    const errors = collectErrors(page);
    await openTool(page, "Unir PDF");
    await chooseFiles(page, ["hojas-a.pdf", "hojas-b.pdf"], /^Elegir archivos$/);
    await page.getByRole("button", { name: "Subir hojas-b.pdf" }).click();
    const merged = outFile("unido.pdf");
    await set(page, "__savePath", merged);
    await page.getByRole("button", { name: "Unir", exact: true }).click();
    await expect(page.locator(".tool-result")).toContainText("2 PDF unidos en uno");
    const text = await pdfText(merged);
    expect(text.length).toBe(5);
    expect(text[0]).toContain("Hoja B1");
    expect(text[2]).toContain("Hoja A1");

    await page.getByRole("button", { name: "← Herramientas" }).click();
    await page.getByRole("button", { name: /^Girar PDF/ }).click();
    await chooseFiles(page, ["hojas-b.pdf"], /^Elegir archivos$/);
    await page.getByText("Darle la vuelta (180°)").click();
    await page.getByLabel("Páginas que se giran").fill("2");
    const turned = outFile("girado.pdf");
    await set(page, "__savePath", turned);
    await page.getByRole("button", { name: "Girar", exact: true }).click();
    await expect(page.locator(".tool-result")).toContainText("Páginas 2 giradas 180°");
    expect((await pdfInfo(turned)).map((p) => p.rotation)).toEqual([0, 180]);

    await page.getByRole("button", { name: "← Herramientas" }).click();
    await page.getByRole("button", { name: /^Ordenar PDF/ }).click();
    await chooseFiles(page, ["hojas-a.pdf"]);
    const thumbs = page.locator(".tool-thumb");
    await expect(thumbs).toHaveCount(3);
    // La 3 se arrastra al principio, la 2 se quita y la 1 se gira.
    await thumbs.nth(2).dragTo(thumbs.nth(0));
    await expect(thumbs.nth(0)).toHaveAttribute("data-page", "3");
    await page.getByRole("button", { name: "Quitar la página 2" }).click({ force: true });
    await page.getByRole("button", { name: "Girar la página 1 a la derecha" }).click({ force: true });
    await expect(thumbs).toHaveCount(2);
    const ordered = outFile("ordenado.pdf");
    await set(page, "__savePath", ordered);
    await page.getByRole("button", { name: "Guardar el PDF ordenado" }).click();
    await expect(page.locator(".tool-result")).toContainText("2 páginas, 1 quitada, 1 girada");
    const t2 = await pdfText(ordered);
    expect(t2[0]).toContain("Hoja A3");
    expect(t2[1]).toContain("Hoja A1");
    expect((await pdfInfo(ordered)).map((p) => p.rotation)).toEqual([0, 90]);
    expect(errors).toEqual([]);
  });

  test("proteger y desbloquear", async ({ page }) => {
    const errors = collectErrors(page);
    await openTool(page, "Proteger PDF");
    await chooseFiles(page, ["hojas-b.pdf"], /^Elegir archivos$/);
    await page.getByLabel("Contraseña nueva").fill("clave1");
    await page.getByLabel("Repetir la contraseña").fill("clave2");
    await expect(page.getByText("Las dos no coinciden.")).toBeVisible();
    await page.getByLabel("Repetir la contraseña").fill("clave1");
    const locked = outFile("protegido-herramienta.pdf");
    await set(page, "__savePath", locked);
    await page.getByRole("button", { name: "Proteger", exact: true }).click();
    await expect(page.locator(".tool-result")).toContainText("pide contraseña");
    await expect(pdfInfo(locked)).rejects.toThrow();
    expect((await pdfInfo(locked, "clave1")).length).toBe(2);

    await page.getByRole("button", { name: "← Herramientas" }).click();
    await page.getByRole("button", { name: /^Desbloquear PDF/ }).click();
    await chooseFiles(page, ["protegido.pdf", "permisos.pdf"], /^Elegir archivos$/);
    await page.getByLabel("Contraseña del PDF").fill("mala");
    const dir = emptyFolder("desbloqueados");
    await set(page, "__folderPath", dir);
    await page.getByRole("button", { name: "Desbloquear", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("La contraseña de protegido.pdf no es correcta");
    await page.getByLabel("Contraseña del PDF").fill("wepo");
    await page.getByRole("button", { name: "Desbloquear", exact: true }).click();
    await expect(page.locator(".tool-result")).toContainText("protegido.pdf: se quitó la contraseña");
    await expect(page.locator(".tool-result")).toContainText("permisos.pdf: se quitaron los permisos");
    expect((await pdfInfo(join(dir, "protegido (desbloqueado).pdf"))).length).toBe(3);
    expect(readFileSync(join(dir, "permisos (desbloqueado).pdf")).toString("latin1")).not.toContain("/Encrypt");
    expect(errors).toEqual([]);
  });

  test("OCR, PDF a Word y PDF a Excel", async ({ page }) => {
    const errors = collectErrors(page);
    await openTool(page, "OCR PDF");
    await chooseFiles(page, ["escaneo.pdf"], /^Elegir archivos$/);
    const ocr = outFile("escaneo-texto.pdf");
    await set(page, "__savePath", ocr);
    await page.getByRole("button", { name: "Reconocer texto" }).click();
    await expect(page.locator(".tool-result")).toContainText("se reconoció el texto de 1 página", { timeout: 30_000 });
    expect((await pdfText(ocr))[0].length).toBeGreaterThan(20);

    await page.getByRole("button", { name: "← Herramientas" }).click();
    await page.getByRole("button", { name: /^PDF a Word/ }).click();
    await chooseFiles(page, ["tablas.pdf"], /^Elegir archivos$/);
    const docx = outFile("tablas.docx");
    await set(page, "__savePath", docx);
    await page.getByRole("button", { name: "Convertir a Word" }).click();
    await expect(page.locator(".tool-result")).toContainText("Un documento de Word");
    const JSZip = (await import("jszip")).default;
    const xml = await (await JSZip.loadAsync(readFileSync(docx))).file("word/document.xml")!.async("string");
    expect(xml).toContain("Reporte de prueba para WEPO");
    expect(xml).toContain("<w:tbl>");

    await page.getByRole("button", { name: "← Herramientas" }).click();
    await page.getByRole("button", { name: /^PDF a Excel/ }).click();
    await chooseFiles(page, ["tablas.pdf"], /^Elegir archivos$/);
    const xlsx = outFile("tablas.xlsx");
    await set(page, "__savePath", xlsx);
    await page.getByRole("button", { name: "Convertir a Excel" }).click();
    await expect(page.locator(".tool-result")).toContainText("4 tablas, una por hoja");
    const book = await JSZip.loadAsync(readFileSync(xlsx));
    expect(Object.keys(book.files).filter((f) => /^xl\/worksheets\/sheet\d+\.xml$/.test(f)).length).toBe(4);
    await page.getByRole("button", { name: "Abrir en WEPO Sheets" }).click();
    await expect(page.locator(".sheet-tabs button[title=\"Doble clic para renombrar\"]")).toHaveCount(4);
    expect(errors).toEqual([]);
  });

  test("Word, Excel y PowerPoint a PDF", async ({ page }) => {
    const errors = collectErrors(page);
    await openTool(page, "Word a PDF");
    await chooseFiles(page, ["informe.docx"], /^Elegir archivos$/);
    const word = outFile("informe-herramienta.pdf");
    await set(page, "__savePath", word);
    await page.getByRole("button", { name: "Convertir a PDF" }).click();
    await finishExport(page, word);
    await expect(page.locator(".tool-result")).toContainText("informe.docx quedó como PDF");
    expect((await pdfInfo(word)).length).toBe(3);

    await page.getByRole("button", { name: "← Herramientas" }).click();
    await page.getByRole("button", { name: /^Excel a PDF/ }).click();
    await chooseFiles(page, ["ventas.xlsx"], /^Elegir archivos$/);
    const excel = outFile("ventas-herramienta.pdf");
    await set(page, "__savePath", excel);
    await page.getByRole("button", { name: "Convertir a PDF" }).click();
    await finishExport(page, excel);
    await expect(page.locator(".tool-result")).toContainText("ventas.xlsx quedó como PDF");
    expect((await pdfText(excel)).join(" ").length).toBeGreaterThan(20);

    await page.getByRole("button", { name: "← Herramientas" }).click();
    await page.getByRole("button", { name: /^PowerPoint a PDF/ }).click();
    await chooseFiles(page, ["presentacion.pptx"], /^Elegir archivos$/);
    const ppt = outFile("presentacion-herramienta.pdf");
    await set(page, "__savePath", ppt);
    await page.getByRole("button", { name: "Convertir a PDF" }).click();
    await finishExport(page, ppt);
    await expect(page.locator(".tool-result")).toContainText("presentacion.pptx quedó como PDF");
    // 7 diapositivas, una oculta: 6 hojas horizontales.
    const info = await pdfInfo(ppt);
    expect(info.length).toBe(6);
    expect(info[0].width).toBeGreaterThan(info[0].height);
    // Lo escondido de la app no sale en el PDF.
    expect((await pdfText(ppt)).join(" ")).not.toContain("WEPO Convertir");
    expect(errors).toEqual([]);
  });
});
