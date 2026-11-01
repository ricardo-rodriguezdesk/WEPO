// Leer y guardar los archivos de «WEPO Convertir».

import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { fileNameOf } from "../lib/documents";
import type { Output } from "./pdfTools";

export type InputFile = { id: string; path: string; name: string; bytes: Uint8Array };

let counter = 0;
export const fid = () => `f${Date.now().toString(36)}${(counter++).toString(36)}`;

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export async function readInput(path: string): Promise<InputFile> {
  return { id: fid(), path, name: fileNameOf(path), bytes: fromBase64(await invoke<string>("file_read", { path })) };
}

/** Elegir archivos con el diálogo del sistema. */
export async function pickFiles(name: string, extensions: string[], multiple: boolean): Promise<string[]> {
  const chosen = await open({ multiple, filters: [{ name, extensions }] });
  if (!chosen) return [];
  return Array.isArray(chosen) ? chosen : [chosen];
}

export function folderOf(path: string): string {
  return path.replace(/[/\\][^/\\]*$/, "");
}

export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/** Un nombre que no encime otro archivo: «nombre (2).pdf», «nombre (3).pdf»… */
async function freeName(folder: string, name: string, taken: Set<string>): Promise<string> {
  const sep = folder.includes("\\") && !folder.includes("/") ? "\\" : "/";
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 1; ; n++) {
    const candidate = `${folder}${sep}${n === 1 ? base : `${base} (${n})`}${ext}`;
    if (taken.has(candidate)) continue;
    if (!(await invoke<boolean>("file_exists", { path: candidate }).catch(() => false))) return candidate;
  }
}

export type Saved = { paths: string[]; folder: string };

/**
 * Guarda lo que salió: un archivo, con «Guardar como»; varios, en la carpeta
 * que se elija (sin encimar los que ya estén ahí). null si se canceló.
 */
export async function saveOutputs(outputs: Output[], near: string | null, filterName: string, ext: string): Promise<Saved | null> {
  if (!outputs.length) return null;
  if (outputs.length === 1) {
    const [out] = outputs;
    const defaultPath = near ? `${folderOf(near)}/${out.name}` : out.name;
    let target = await save({ defaultPath, filters: [{ name: filterName, extensions: [ext] }] });
    if (!target) return null;
    if (!target.toLowerCase().endsWith(`.${ext}`)) target += `.${ext}`;
    await invoke("file_write", { path: target, data: toBase64(out.bytes) });
    return { paths: [target], folder: folderOf(target) };
  }
  const folder = await open({ directory: true, defaultPath: near ? folderOf(near) : undefined, title: `Elige la carpeta para los ${outputs.length} archivos` });
  if (!folder || Array.isArray(folder)) return null;
  const taken = new Set<string>();
  const paths: string[] = [];
  for (const out of outputs) {
    const path = await freeName(folder, out.name, taken);
    taken.add(path);
    await invoke("file_write", { path, data: toBase64(out.bytes) });
    paths.push(path);
  }
  return { paths, folder };
}
