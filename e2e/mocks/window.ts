type W = Window & Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export function getCurrentWindow() {
  const w = window as unknown as W;
  return {
    label: "main",
    setTitle: async (t: string) => {
      w.__title = t;
    },
    onCloseRequested: async (cb: (e: { preventDefault: () => void }) => Promise<void> | void) => {
      w.__close = async () => {
        let prevented = false;
        await cb({ preventDefault: () => (prevented = true) });
        return prevented;
      };
      return () => {};
    },
    destroy: async () => {
      w.__destroyed = true;
    },
    setFullscreen: async (on: boolean) => {
      w.__fullscreen = on;
    },
    isFullscreen: async () => Boolean(w.__fullscreen),
  };
}
