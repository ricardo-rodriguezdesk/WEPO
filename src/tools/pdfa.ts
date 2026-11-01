// PDF a PDF/A-2b (el PDF «para archivar» de la norma ISO 19005-2), sin internet.
//
// Lo que pide la norma y se arregla aquí: metadatos XMP que dicen que es PDF/A,
// un perfil de color (sRGB) para que los colores signifiquen siempre lo mismo,
// un identificador del archivo, nada de JavaScript, acciones ni archivos
// adjuntos, anotaciones que se imprimen tal como se ven, y todas las letras
// incrustadas. Las páginas con letras que no vienen en el archivo (o con colores
// CMYK sin perfil) se vuelven imagen con su texto invisible encima, para que
// se sigan pudiendo buscar y copiar.

import { PDFArray, PDFDict, PDFDocument, PDFHeader, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, PDFString, decodePDFRawStream } from "pdf-lib";
import { baseName, openPdf, proxyOf, rasterizeInPlace } from "./pdfTools";

export type PdfaResult = { bytes: Uint8Array; rasterized: number[]; removed: string[] };

// ───────────── perfil de color sRGB (ICC v2), hecho aquí mismo ─────────────

/** Un perfil ICC de pantalla sRGB mínimo y válido (gamma 2.2, primarios de sRGB adaptados a D50). */
export function srgbProfile(): Uint8Array {
  const tags: [string, Uint8Array][] = [];
  const enc = new TextEncoder();
  const s15 = (v: number) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setInt32(0, Math.round(v * 65536));
    return b;
  };
  const cat = (...parts: Uint8Array[]) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) (out.set(p, o), (o += p.length));
    return out;
  };
  const u32 = (v: number) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v);
    return b;
  };
  const sig = (t: string) => enc.encode(t);
  const xyz = (x: number, y: number, z: number) => cat(sig("XYZ "), u32(0), s15(x), s15(y), s15(z));
  const name = "sRGB (WEPO)";
  const desc = cat(sig("desc"), u32(0), u32(name.length + 1), enc.encode(name), new Uint8Array(1), u32(0), u32(0), new Uint8Array(2), new Uint8Array(1), new Uint8Array(67));
  const text = cat(sig("text"), u32(0), enc.encode("Sin restricciones"), new Uint8Array(1));
  const curve = cat(sig("curv"), u32(0), u32(1), new Uint8Array([2, 51]), new Uint8Array(2)); // 2.2 en u8Fixed8 (563 = 0x0233)
  tags.push(["desc", desc], ["cprt", text], ["wtpt", xyz(0.9642, 1, 0.8249)]);
  tags.push(["rXYZ", xyz(0.4361, 0.2225, 0.0139)], ["gXYZ", xyz(0.3851, 0.7169, 0.0971)], ["bXYZ", xyz(0.1431, 0.0606, 0.7141)]);
  tags.push(["rTRC", curve], ["gTRC", curve], ["bTRC", curve]);
  const tableSize = 4 + tags.length * 12;
  let offset = 128 + tableSize;
  const entries: Uint8Array[] = [];
  const data: Uint8Array[] = [];
  for (const [t, body] of tags) {
    const padded = cat(body, new Uint8Array((4 - (body.length % 4)) % 4));
    entries.push(cat(sig(t), u32(offset), u32(body.length)));
    data.push(padded);
    offset += padded.length;
  }
  const header = new Uint8Array(128);
  const dv = new DataView(header.buffer);
  dv.setUint32(0, offset);
  dv.setUint32(8, 0x02100000);
  header.set(sig("mntr"), 12);
  header.set(sig("RGB "), 16);
  header.set(sig("XYZ "), 20);
  // Fecha: 2026-01-01.
  [2026, 1, 1, 0, 0, 0].forEach((v, i) => dv.setUint16(24 + i * 2, v));
  header.set(sig("acsp"), 36);
  header.set(s15(0.9642), 68);
  header.set(s15(1), 72);
  header.set(s15(0.8249), 76);
  return cat(header, u32(tags.length), ...entries, ...data);
}

// ───────────── revisar letras y colores ─────────────

function lookup(doc: PDFDocument, v: unknown): unknown {
  return v instanceof PDFRef ? doc.context.lookup(v) : v;
}

function embedded(doc: PDFDocument, font: PDFDict): boolean {
  const subtype = font.get(PDFName.of("Subtype"));
  if (subtype === PDFName.of("Type3")) return true;
  let target = font;
  if (subtype === PDFName.of("Type0")) {
    const desc = lookup(doc, font.get(PDFName.of("DescendantFonts")));
    const first = desc instanceof PDFArray ? lookup(doc, desc.get(0)) : null;
    if (!(first instanceof PDFDict)) return false;
    target = first;
  }
  const fd = lookup(doc, target.get(PDFName.of("FontDescriptor")));
  if (!(fd instanceof PDFDict)) return false;
  return ["FontFile", "FontFile2", "FontFile3"].some((k) => fd.has(PDFName.of(k)));
}

function streamText(stream: unknown): string {
  try {
    if (stream instanceof PDFRawStream) return new TextDecoder("latin1").decode(decodePDFRawStream(stream).decode());
    if (stream instanceof PDFStream) return new TextDecoder("latin1").decode(stream.getContents());
  } catch {
    return "";
  }
  return "";
}

const CMYK_OP = /(?:^|[\s\]])-?[\d.]+\s+-?[\d.]+\s+-?[\d.]+\s+-?[\d.]+\s+[kK](?=[\s/[]|$)/;

/** ¿Qué tiene la página que PDF/A no permite y que solo se arregla dibujándola? */
function pageProblems(doc: PDFDocument, resources: unknown, contents: unknown[], seen = new Set<unknown>()): { fonts: boolean; cmyk: boolean } {
  const out = { fonts: false, cmyk: false };
  for (const c of contents) if (CMYK_OP.test(streamText(lookup(doc, c)))) out.cmyk = true;
  const res = lookup(doc, resources);
  if (!(res instanceof PDFDict) || seen.has(res)) return out;
  seen.add(res);
  const fonts = lookup(doc, res.get(PDFName.of("Font")));
  if (fonts instanceof PDFDict) {
    for (const [, ref] of fonts.entries()) {
      const font = lookup(doc, ref);
      if (font instanceof PDFDict && !embedded(doc, font)) out.fonts = true;
    }
  }
  const xobjects = lookup(doc, res.get(PDFName.of("XObject")));
  if (xobjects instanceof PDFDict) {
    for (const [, ref] of xobjects.entries()) {
      const x = lookup(doc, ref);
      if (!(x instanceof PDFStream)) continue;
      const sub = x.dict.get(PDFName.of("Subtype"));
      if (sub === PDFName.of("Image")) {
        if (lookup(doc, x.dict.get(PDFName.of("ColorSpace"))) === PDFName.of("DeviceCMYK")) out.cmyk = true;
      } else if (sub === PDFName.of("Form")) {
        const inner = pageProblems(doc, x.dict.get(PDFName.of("Resources")), [x], seen);
        out.fonts ||= inner.fonts;
        out.cmyk ||= inner.cmyk;
      }
    }
  }
  return out;
}

// ───────────── convertir ─────────────

const pad = (n: number) => String(n).padStart(2, "0");
function xmpDate(d: Date) {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`;
}
function pdfDate(d: Date) {
  return `D:${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}
const xml = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export async function toPdfA(bytes: Uint8Array, name: string, onPage?: (done: number, total: number) => void): Promise<PdfaResult> {
  const doc = await openPdf(bytes, name);
  const removed = new Set<string>();
  const rasterized: number[] = [];

  // 1. Páginas que hay que dibujar (letras sin incrustar o CMYK).
  const pages = doc.getPages();
  const problems = pages.map((p) => pageProblems(doc, p.node.get(PDFName.of("Resources")) ?? p.node.Resources(), (() => {
    const c = lookup(doc, p.node.get(PDFName.of("Contents")));
    return c instanceof PDFArray ? c.asArray() : c ? [c] : [];
  })()));
  if (problems.some((p) => p.fonts || p.cmyk)) {
    const proxy = await proxyOf(bytes, name);
    const todo = problems.filter((p) => p.fonts || p.cmyk).length;
    for (let i = 0; i < pages.length; i++) {
      if (!problems[i].fonts && !problems[i].cmyk) continue;
      await rasterizeInPlace(doc, pages[i], proxy, i, 2.5);
      rasterized.push(i + 1);
      onPage?.(rasterized.length, todo);
    }
  }

  // 2. Nada de JavaScript, acciones automáticas ni adjuntos.
  const catalog = doc.catalog;
  for (const key of ["OpenAction", "AA", "JavaScript"]) if (catalog.has(PDFName.of(key))) (catalog.delete(PDFName.of(key)), removed.add("acciones automáticas"));
  const names = lookup(doc, catalog.get(PDFName.of("Names")));
  if (names instanceof PDFDict) {
    if (names.has(PDFName.of("JavaScript"))) (names.delete(PDFName.of("JavaScript")), removed.add("JavaScript"));
    if (names.has(PDFName.of("EmbeddedFiles"))) (names.delete(PDFName.of("EmbeddedFiles")), removed.add("archivos adjuntos"));
  }
  catalog.delete(PDFName.of("Perms"));
  catalog.delete(PDFName.of("NeedsRendering"));
  const acro = lookup(doc, catalog.get(PDFName.of("AcroForm")));
  if (acro instanceof PDFDict) {
    acro.delete(PDFName.of("XFA"));
    acro.set(PDFName.of("NeedAppearances"), doc.context.obj(false));
  }

  // 3. Anotaciones: que se impriman como se ven (y fuera las que no tienen dibujo).
  for (const page of doc.getPages()) {
    page.node.delete(PDFName.of("AA"));
    const annots = lookup(doc, page.node.get(PDFName.of("Annots")));
    if (!(annots instanceof PDFArray)) continue;
    const keep = doc.context.obj([]) as PDFArray;
    for (const ref of annots.asArray()) {
      const a = lookup(doc, ref);
      if (!(a instanceof PDFDict)) continue;
      const sub = a.get(PDFName.of("Subtype"));
      if (sub === PDFName.of("FileAttachment") || sub === PDFName.of("Sound") || sub === PDFName.of("Movie") || sub === PDFName.of("Screen") || sub === PDFName.of("RichMedia")) {
        removed.add("adjuntos o multimedia en anotaciones");
        continue;
      }
      if (sub !== PDFName.of("Popup") && sub !== PDFName.of("Link") && !a.has(PDFName.of("AP"))) {
        removed.add("anotaciones sin dibujo");
        continue;
      }
      // Bandera «imprimir» puesta; «oculta», «invisible» y «no ver» quitadas.
      const flags = (lookup(doc, a.get(PDFName.of("F"))) as PDFNumber | undefined)?.asNumber?.() ?? 0;
      a.set(PDFName.of("F"), PDFNumber.of((flags | 4) & ~(1 | 2 | 32)));
      a.delete(PDFName.of("AA"));
      const action = lookup(doc, a.get(PDFName.of("A")));
      if (action instanceof PDFDict) {
        const s = action.get(PDFName.of("S"));
        if (s !== PDFName.of("GoTo") && s !== PDFName.of("URI") && s !== PDFName.of("GoToR") && s !== PDFName.of("Named")) (a.delete(PDFName.of("A")), removed.add("acciones de los enlaces"));
      }
      keep.push(ref);
    }
    page.node.set(PDFName.of("Annots"), keep);
  }

  // 4. Perfil de color para todo el documento.
  const icc = doc.context.register(doc.context.flateStream(srgbProfile(), { N: 3 }));
  const intent = doc.context.obj({ Type: "OutputIntent", S: "GTS_PDFA1", OutputConditionIdentifier: PDFString.of("sRGB IEC61966-2.1"), Info: PDFString.of("sRGB IEC61966-2.1"), DestOutputProfile: icc });
  catalog.set(PDFName.of("OutputIntents"), doc.context.obj([intent]));

  // 5. Metadatos: los mismos en el diccionario Info y en el XMP (con pdfaid:part 2, conformance B).
  const now = new Date(Math.floor(Date.now() / 1000) * 1000);
  const title = doc.getTitle() || baseName(name);
  const created = doc.getCreationDate() ?? now;
  const createdAt = new Date(Math.floor(created.getTime() / 1000) * 1000);
  const info = doc.context.obj({
    Title: PDFHexString.fromText(title),
    Producer: PDFString.of("WEPO"),
    CreationDate: PDFString.of(pdfDate(createdAt)),
    ModDate: PDFString.of(pdfDate(now)),
  });
  doc.context.trailerInfo.Info = doc.context.register(info);
  const packet = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">
   <pdfaid:part>2</pdfaid:part>
   <pdfaid:conformance>B</pdfaid:conformance>
   <dc:format>application/pdf</dc:format>
   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${xml(title)}</rdf:li></rdf:Alt></dc:title>
   <xmp:CreateDate>${xmpDate(createdAt)}</xmp:CreateDate>
   <xmp:ModifyDate>${xmpDate(now)}</xmp:ModifyDate>
   <xmp:MetadataDate>${xmpDate(now)}</xmp:MetadataDate>
   <pdf:Producer>WEPO</pdf:Producer>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
  // Sin comprimir, como pide la norma, para que otros programas lo lean.
  const metadata = doc.context.stream(new TextEncoder().encode(packet), { Type: "Metadata", Subtype: "XML" });
  catalog.set(PDFName.of("Metadata"), doc.context.register(metadata));
  catalog.delete(PDFName.of("Version"));

  // 6. Identificador del archivo (dos veces el mismo, porque es nuevo).
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  doc.context.trailerInfo.ID = doc.context.obj([PDFHexString.of(id), PDFHexString.of(id)]);

  // PDF/A-2 es PDF 1.7.
  doc.context.header = PDFHeader.forVersion(1, 7);
  // Sin flujos de objetos: así lo leen también los validadores y lectores más viejos.
  const out = await doc.save({ useObjectStreams: false, updateFieldAppearances: false });
  return { bytes: out, rasterized, removed: [...removed] };
}
