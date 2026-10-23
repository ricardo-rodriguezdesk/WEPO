// Abrir y guardar documentos de WEPO Write (.docx, .txt y .md).
// Los archivos se leen y escriben enteros desde Rust (ver src-tauri/src/files.rs);
// la conversión del .docx se hace aquí (ver editors/write/docx.ts).

import { invoke } from "@tauri-apps/api/core";
import type { JSONContent } from "@tiptap/react";
import type { WriteDocument } from "../editors/write/docx";
import { LETTER, readDocx, readMarkdown, readText, writeDocx, writeMarkdown } from "../editors/write/docx";
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

const decoder = new TextDecoder("utf-8");
const encoder = new TextEncoder();

export function emptyDocument(): WriteDocument {
  return { content: { type: "doc", content: [{ type: "paragraph" }] }, page: LETTER, unsupported: [] };
}

/** Formatos que WEPO Write sabe guardar tal cual. */
export const WRITE_SAVE_FORMATS = ["docx", "txt", "md"];

export async function openWriteDocument(path: string): Promise<WriteDocument> {
  const bytes = fromBase64(await invoke<string>("file_read", { path }));
  const ext = extensionOf(path);
  if (ext === "docx") return readDocx(bytes);
  if (ext === "md") return { ...emptyDocument(), content: readMarkdown(decoder.decode(bytes)) };
  if (ext === "txt") return { ...emptyDocument(), content: readText(decoder.decode(bytes)) };
  throw new Error(`WEPO Write todavía no abre archivos .${ext}`);
}

/** Guarda en .docx, .md o .txt según la extensión. `plain` es el texto del documento (para .txt). */
export async function saveWriteDocument(path: string, content: JSONContent, page: WriteDocument["page"], plain: string, title: string) {
  const ext = extensionOf(path);
  let bytes: Uint8Array;
  if (ext === "docx") bytes = await writeDocx(content, page, title);
  else if (ext === "md") bytes = encoder.encode(writeMarkdown(content));
  else if (ext === "txt") bytes = encoder.encode(plain.endsWith("\n") ? plain : `${plain}\n`);
  else throw new Error(`WEPO Write todavía no guarda archivos .${ext}`);
  await invoke("file_write", { path, data: toBase64(bytes) });
}

/** Lee una imagen del disco como data URL (para insertarla en el documento). */
export async function imageDataUrl(path: string): Promise<string> {
  const ext = extensionOf(path);
  const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "gif" ? "image/gif" : "image/png";
  return `data:${mime};base64,${await invoke<string>("file_read", { path })}`;
}
