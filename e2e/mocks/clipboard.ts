type W = Window & Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
export async function writeText(text: string) {
  (window as unknown as W).__clip = text;
}
export async function readText() {
  return (window as unknown as W).__clip ?? "";
}
