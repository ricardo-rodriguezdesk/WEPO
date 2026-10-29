import { expect, test } from "@playwright/test";
import { collectErrors, finishExport, fixture, home, openFile, outFile, pdfInfo, saveAs } from "./helpers";

test.describe("WEPO Present", () => {
  test("imprimir con cada diseño de hoja", async ({ page }) => {
    const errors = collectErrors(page);
    await openFile(page, "presentacion.pptx");
    await expect(page.locator(".present-thumb, .slide-thumb").first()).toBeVisible();
    await page.getByLabel("Imprimir", { exact: true }).click();
    const count = page.locator(".print-count");
    // 7 diapositivas, una oculta: se imprimen 6.
    for (const [label, sheets] of [
      ["una por hoja", 6],
      ["con sus notas", 6],
      ["2 diapositivas", 3],
      ["3 por hoja", 2],
      ["6 diapositivas", 1],
    ] as const) {
      await page.locator("label.radio", { hasText: label }).locator("input").check();
      await expect(count, label).toHaveText(`${sheets} ${sheets === 1 ? "hoja" : "hojas"}`);
    }
    await page.locator("label.radio", { hasText: "ocultas" }).locator("input").check();
    await expect(count).toHaveText("2 hojas");

    await page.getByLabel("Diapositivas que se imprimen").fill("2-3");
    await page.locator("label.radio", { hasText: "2 diapositivas" }).locator("input").check();
    await expect(count).toHaveText("1 hoja");
    expect(errors).toEqual([]);
  });

  test("el PDF tiene una hoja por diapositiva, en horizontal", async ({ page }) => {
    await openFile(page, "presentacion.pptx");
    await page.getByLabel("Imprimir", { exact: true }).click();
    await page.locator("label.radio", { hasText: "una por hoja" }).locator("input").check();
    const out = outFile("diapositivas.pdf");
    await saveAs(page, out);
    await page.getByRole("button", { name: "Exportar PDF…" }).click();
    await finishExport(page, out);
    const pages = await pdfInfo(out);
    expect(pages).toHaveLength(6);
    expect(pages[0].width).toBeGreaterThan(pages[0].height);
  });

  test("gráficas y transiciones: se editan, se presentan y se guardan en PowerPoint", async ({ page }) => {
    const errors = collectErrors(page);
    await home(page);
    await page.locator(".home-card.kind-present").click();
    await page.getByLabel("Gráfica", { exact: true }).click();
    const panel = page.locator(".present-chart-panel");
    await expect(panel).toBeVisible();
    await expect(page.locator(".present-main-slide .slide-chart")).toHaveCount(1);

    // Datos, título y tipo.
    const cell = page.getByLabel("Serie 1, Categoría 1");
    await cell.fill("10");
    await cell.press("Enter");
    await page.getByLabel("Título de la gráfica").fill("Ventas");
    await page.getByLabel("Título de la gráfica").press("Enter");
    await panel.getByRole("radio", { name: "Barras" }).click();
    await expect(page.locator(".present-main-slide .slide-chart svg text").first()).toHaveText("Ventas");

    // Segunda diapositiva con transición Empujar.
    await page.getByRole("button", { name: /\+ Diapositiva/ }).click();
    await page.getByRole("button", { name: /^Transición/ }).click();
    await page.locator(".present-transition-grid").getByRole("radio", { name: "Empujar" }).click();
    await expect(page.getByRole("button", { name: /^Transición: Empujar/ })).toBeVisible();
    await expect(page.locator(".present-thumb-transition")).toHaveCount(1);
    await page.keyboard.press("Escape");

    // Al presentar, al pasar a la 2 se ven las dos mientras entra la nueva.
    await page.getByRole("button", { name: /Presentar/ }).click();
    await expect(page.locator(".presenter")).toBeVisible();
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".presenter-layer")).toHaveCount(2);
    await expect(page.locator(".presenter-layer")).toHaveCount(1);
    await page.keyboard.press("Escape");

    // Guardar y volver a abrir: la gráfica y la transición siguen ahí.
    const out = outFile("grafica.pptx");
    await saveAs(page, out);
    await page.keyboard.press("ControlOrMeta+s");
    await expect(page.locator(".present-footer .sheet-status")).toContainText("Guardado");
    await home(page);
    await page.evaluate((p) => ((window as unknown as Record<string, unknown>).__openPath = p), out);
    await page.getByText("Abrir archivo…").click();
    await expect(page.locator(".present-main-slide .slide-chart")).toHaveCount(1);
    await expect(page.locator(".present-notice")).toHaveCount(0);
    await page.locator(".present-main-slide .slide-chart").dblclick();
    await expect(page.getByLabel("Serie 1, Categoría 1")).toHaveValue("10");
    await expect(page.locator(".present-chart-panel").getByRole("radio", { name: "Barras" })).toHaveAttribute("aria-checked", "true");
    await expect(page.getByLabel("Título de la gráfica")).toHaveValue("Ventas");
    await page.locator(".present-thumb").nth(1).click();
    await expect(page.getByRole("button", { name: /^Transición: Empujar/ })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("animaciones: entran clic por clic (también por párrafo) y se guardan en PowerPoint", async ({ page }) => {
    const errors = collectErrors(page);
    await openFile(page, "presentacion.pptx");
    await page.locator(".present-thumb").nth(1).click();
    const els = page.locator(".present-main-slide [data-el]");
    const menu = page.locator(".present-animations");
    const pick = async (index: number, effect: string) => {
      await els.nth(index).click();
      await page.getByRole("button", { name: /^Animación/ }).click();
      await menu.getByRole("radio", { name: effect }).click();
    };
    await pick(0, "Desvanecer");
    await page.keyboard.press("Escape");
    await pick(1, "Entrar volando");
    await menu.getByLabel(/Por párrafo/).check();
    await page.keyboard.press("Escape");
    await expect(page.locator(".present-anim-badge")).toHaveText(["1", "2–7"]);

    // Al presentar: primero no se ve nada animado; cada clic hace entrar lo que sigue.
    const shown = () =>
      page.evaluate(() =>
        [...document.querySelectorAll(".presenter-scope [data-anim]")].map((e) =>
          [getComputedStyle(e).visibility === "visible", ...[...e.querySelectorAll("[data-para]")].map((p) => getComputedStyle(p).visibility === "visible")].map(Number).join(""),
        ),
      );
    await page.keyboard.press("Shift+F5");
    await expect(page.locator(".presenter")).toBeVisible();
    await expect.poll(shown).toEqual(["00", "1000000"]);
    await page.keyboard.press("ArrowRight");
    await expect.poll(shown).toEqual(["11", "1000000"]);
    await page.keyboard.press("ArrowRight");
    await expect.poll(shown).toEqual(["11", "1100000"]);
    await page.keyboard.press("ArrowLeft");
    await expect.poll(shown).toEqual(["11", "1000000"]);
    await page.keyboard.press("Escape");

    // Guardar en PowerPoint y volver a abrir: siguen las mismas animaciones.
    const out = outFile("animaciones.pptx");
    await saveAs(page, out);
    await page.keyboard.press("ControlOrMeta+Shift+s");
    await expect(page.locator(".present-footer .sheet-status")).toContainText("Guardado");
    await home(page);
    await page.evaluate((p) => ((window as unknown as Record<string, unknown>).__openPath = p), out);
    await page.getByText("Abrir archivo…").click();
    await page.locator(".present-thumb").nth(1).click();
    await expect(page.locator(".present-anim-badge")).toHaveText(["1", "2–7"]);
    expect(errors).toEqual([]);
  });
  test("transiciones vistosas: se presentan y se guardan como las de PowerPoint 2010 y 2013", async ({ page }) => {
    const errors = collectErrors(page);
    await openFile(page, "presentacion.pptx");
    const pick = async (slide: number, name: string) => {
      await page.locator(".present-thumb").nth(slide).click();
      await page.getByRole("button", { name: /^Transición/ }).click();
      await page.locator(".present-transition-grid").getByRole("radio", { name, exact: true }).click();
      await page.keyboard.press("Escape");
    };
    await pick(1, "Cubo");
    await pick(2, "Cortinas");
    await expect(page.getByRole("button", { name: /^Transición: Cortinas/ })).toBeVisible();

    // Al presentar, las cortinas parten la diapositiva anterior en dos mitades que se abren.
    await page.locator(".present-thumb").nth(1).click();
    await page.keyboard.press("Shift+F5");
    await expect(page.locator(".presenter")).toBeVisible();
    await expect(page.locator(".presenter-stage > .presenter-layer")).toHaveCount(1);
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".presenter-stage > .presenter-layer")).toHaveCount(4);
    await expect(page.locator(".presenter-stage > .presenter-layer")).toHaveCount(1);
    await page.keyboard.press("Escape");

    const out = outFile("transiciones.pptx");
    await saveAs(page, out);
    await page.keyboard.press("ControlOrMeta+Shift+s");
    await expect(page.locator(".present-footer .sheet-status")).toContainText("Guardado");
    const { readFileSync } = await import("node:fs");
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(readFileSync(out));
    const slide2 = await zip.file("ppt/slides/slide2.xml")!.async("string");
    const slide3 = await zip.file("ppt/slides/slide3.xml")!.async("string");
    expect(slide2).toContain("<p14:prism");
    expect(slide2).toContain('Requires="p14"');
    expect(slide3).toContain('<p15:prstTrans prst="curtains"/>');
    // Con respaldo para programas que no las conocen.
    expect(slide3).toMatch(/<mc:Fallback><p:transition[^>]*><p:split/);

    await home(page);
    await page.evaluate((p) => ((window as unknown as Record<string, unknown>).__openPath = p), out);
    await page.getByText("Abrir archivo…").click();
    await page.locator(".present-thumb").nth(1).click();
    await expect(page.getByRole("button", { name: /^Transición: Cubo/ })).toBeVisible();
    await page.locator(".present-thumb").nth(2).click();
    await expect(page.getByRole("button", { name: /^Transición: Cortinas/ })).toBeVisible();
    await expect(page.locator(".present-notice")).toHaveCount(0);
    expect(errors).toEqual([]);
  });
  test("animaciones de énfasis y de salida: el elemento entra, gira y sale volando", async ({ page }) => {
    const errors = collectErrors(page);
    await openFile(page, "presentacion.pptx");
    await page.locator(".present-thumb").nth(1).click();
    const el = page.locator(".present-main-slide [data-el]").first();
    const menu = page.locator(".present-animations");
    const pick = async (tab: string, effect: string) => {
      await el.click();
      await page.getByRole("button", { name: /^Animación/ }).click();
      await menu.getByRole("tab", { name: tab }).click();
      await menu.getByRole("radio", { name: effect, exact: true }).click();
      await page.keyboard.press("Escape");
    };
    await pick("Entrada", "Desvanecer");
    await pick("Énfasis", "Girar");
    await pick("Salida", "Salir volando");
    await el.click();
    await expect(page.getByRole("button", { name: "Animación: Desvanecer + Girar + Salir volando ▾" })).toBeVisible();
    await expect(page.locator(".present-anim-badge").first()).toHaveText("1, 2, 3");

    const state = () =>
      page.evaluate(() => {
        const e = document.querySelector<HTMLElement>(".presenter-scope [data-anim]");
        if (!e) return "none";
        const r = e.getBoundingClientRect();
        const slide = document.querySelector(".presenter-scope .slide")!.getBoundingClientRect();
        return getComputedStyle(e).visibility !== "visible" ? "hidden" : r.top >= slide.bottom - 1 ? "gone" : "shown";
      });
    await page.keyboard.press("Shift+F5");
    await expect(page.locator(".presenter")).toBeVisible();
    await expect.poll(state).toBe("hidden");
    await page.keyboard.press("ArrowRight");
    await expect.poll(state).toBe("shown");
    await page.keyboard.press("ArrowRight");
    await expect.poll(state).toBe("shown");
    // Sale volando hacia abajo (se queda fuera de la pantalla).
    await page.keyboard.press("ArrowRight");
    await expect.poll(state).toBe("gone");
    // Regresar un clic lo vuelve a mostrar.
    await page.keyboard.press("ArrowLeft");
    await expect.poll(state).toBe("shown");
    await page.keyboard.press("Escape");

    const out = outFile("salida-enfasis.pptx");
    await saveAs(page, out);
    await page.keyboard.press("ControlOrMeta+Shift+s");
    await expect(page.locator(".present-footer .sheet-status")).toContainText("Guardado");
    const { readFileSync } = await import("node:fs");
    const JSZip = (await import("jszip")).default;
    const xml = await (await JSZip.loadAsync(readFileSync(out))).file("ppt/slides/slide2.xml")!.async("string");
    expect(xml).toContain('presetClass="emph"');
    expect(xml).toContain('presetClass="exit"');
    expect(xml).toContain('<p:animRot by="21600000">');

    await home(page);
    await page.evaluate((p) => ((window as unknown as Record<string, unknown>).__openPath = p), out);
    await page.getByText("Abrir archivo…").click();
    await page.locator(".present-thumb").nth(1).click();
    await el.click();
    await expect(page.getByRole("button", { name: "Animación: Desvanecer + Girar + Salir volando ▾" })).toBeVisible();
    await expect(page.locator(".present-notice")).toHaveCount(0);
    expect(errors).toEqual([]);
  });
  test("video y audio: se insertan, se reproducen al presentar y se guardan en el .pptx", async ({ page }) => {
    const errors = collectErrors(page);
    await openFile(page, "presentacion.pptx");
    await page.locator(".present-thumb").nth(1).click();
    const slide = page.locator(".present-main-slide");
    const setOpen = (p: string) => page.evaluate((path) => ((window as unknown as Record<string, unknown>).__openPath = path), p);
    await setOpen(fixture("video.webm"));
    await page.getByLabel("Video o audio", { exact: true }).click();
    await expect(slide.locator(".slide-video img")).toBeVisible();
    // La portada es un cuadro del video y el elemento tiene su forma (16:9).
    const box = (await slide.locator(".slide-video").boundingBox())!;
    expect(Math.abs(box.width / box.height - 16 / 9)).toBeLessThan(0.02);
    await expect(slide.locator(".slide-video .slide-media-badge")).toBeVisible();
    // Que se repita.
    await page.getByRole("button", { name: "Reproducción ▾" }).click();
    await page.getByLabel("Repetir hasta que se detenga").click();
    await expect(page.getByLabel("Repetir hasta que se detenga")).toBeChecked();
    await expect(page.getByLabel("Empezar solo al llegar a la diapositiva")).not.toBeChecked();
    await page.keyboard.press("Escape");

    await page.keyboard.press("Escape");
    await setOpen(fixture("audio.wav"));
    await page.getByLabel("Video o audio", { exact: true }).click();
    await expect(slide.locator(".slide-audio img")).toBeVisible();
    // El audio empieza solo (como la música de fondo).
    await page.getByRole("button", { name: "Reproducción ▾" }).click();
    await expect(page.getByLabel("Empezar solo al llegar a la diapositiva")).toBeChecked();
    await page.keyboard.press("Escape");

    // Al presentar hay un reproductor; un clic en él no pasa a la siguiente diapositiva.
    await page.keyboard.press("Escape");
    await page.keyboard.press("Shift+F5");
    const video = page.locator(".presenter-slide video");
    await expect(video).toBeVisible();
    await expect(video).toHaveAttribute("loop", "");
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThan(0);
    await expect(page.locator(".presenter-slide audio")).toHaveAttribute("autoplay", "");
    await video.click();
    await page.locator(".presenter-slide .slide-audio-button").click();
    await expect(page.locator(".presenter-slide video")).toBeVisible();
    await page.keyboard.press("Escape");

    const out = outFile("video-audio.pptx");
    await saveAs(page, out);
    await page.keyboard.press("ControlOrMeta+Shift+s");
    await expect(page.locator(".present-footer .sheet-status")).toContainText("Guardado");
    const { readFileSync } = await import("node:fs");
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(readFileSync(out));
    expect(zip.file("ppt/media/media1.webm")).toBeTruthy();
    expect(zip.file("ppt/media/media2.wav")).toBeTruthy();
    const xml = await zip.file("ppt/slides/slide2.xml")!.async("string");
    const rels = await zip.file("ppt/slides/_rels/slide2.xml.rels")!.async("string");
    const types = await zip.file("[Content_Types].xml")!.async("string");
    expect(xml).toMatch(/<a:videoFile r:link="rId\d+"\/>/);
    expect(xml).toMatch(/<a:audioFile r:link="rId\d+"\/>/);
    expect(xml).toContain("<p14:media");
    expect(xml).toContain('cmd="playFrom(0.0)"');
    expect(xml).toContain('repeatCount="indefinite"');
    expect(rels).toContain("relationships/video");
    expect(rels).toContain("office/2007/relationships/media");
    expect(types).toContain('Extension="webm" ContentType="video/webm"');
    expect(types).toContain('Extension="wav" ContentType="audio/wav"');

    await home(page);
    await setOpen(out);
    await page.getByText("Abrir archivo…").click();
    await page.locator(".present-thumb").nth(1).click();
    await expect(slide.locator(".slide-video")).toHaveCount(1);
    await expect(slide.locator(".slide-audio")).toHaveCount(1);
    await slide.locator(".slide-video").click();
    await page.getByRole("button", { name: "Reproducción ▾" }).click();
    await expect(page.getByLabel("Repetir hasta que se detenga")).toBeChecked();
    await expect(page.getByLabel("Empezar solo al llegar a la diapositiva")).not.toBeChecked();
    await page.keyboard.press("Escape");
    await expect(page.locator(".present-notice")).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});
