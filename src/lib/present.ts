// Abrir y guardar presentaciones de WEPO Present (.pptx). Los archivos se leen y
// escriben enteros desde Rust (src-tauri/src/files.rs); la conversión se hace en
// editors/present/pptxRead.ts y pptxWrite.ts.

import { invoke } from "@tauri-apps/api/core";
import type { Deck } from "../editors/present/model";
import { newDeck } from "../editors/present/model";
import { readPptx } from "../editors/present/pptxRead";
import { writePptx } from "../editors/present/pptxWrite";
import { extensionOf } from "./documents";

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function emptyPresentation(): Deck {
  return newDeck();
}

export async function openPresentation(path: string): Promise<Deck> {
  const ext = extensionOf(path);
  if (ext !== "pptx") throw new Error(`WEPO Present todavía no abre archivos .${ext}`);
  return readPptx(fromBase64(await invoke<string>("file_read", { path })));
}

export async function savePresentation(path: string, deck: Deck, title: string) {
  await invoke("file_write", { path, data: toBase64(await writePptx(deck, title)) });
}

/** La presentación como .pptx en base64 (para la copia de recuperación). */
export async function presentationBase64(deck: Deck, title: string) {
  return toBase64(await writePptx(deck, title));
}
