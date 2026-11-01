export async function openUrl(url: string) {
  (window as unknown as Record<string, unknown>).__openedUrl = url;
}
export async function revealItemInDir(path: string) {
  (window as unknown as Record<string, unknown>).__revealed = path;
}
