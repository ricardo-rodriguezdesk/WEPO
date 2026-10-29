import type { Media } from "./model";

/** Formatos que se pueden poner en una diapositiva. */
export const VIDEO_EXTENSIONS = ["mp4", "m4v", "mov", "webm"];
export const AUDIO_EXTENSIONS = ["mp3", "m4a", "wav", "aac", "ogg"];

const MIME: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/x-m4v",
  mov: "video/quicktime",
  webm: "video/webm",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  aac: "audio/aac",
  ogg: "audio/ogg",
};

/** Extensión para guardar el archivo (según su tipo). */
const EXT: Record<string, string> = {
  "video/mp4": "mp4",
  "video/x-m4v": "m4v",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/aac": "aac",
  "audio/ogg": "ogg",
};

export function mediaMime(ext: string): string | null {
  return MIME[ext.toLowerCase()] ?? null;
}

/** Tipo (content type) del .pptx para cada extensión. */
export function mediaContentType(ext: string): string {
  return MIME[ext] ?? "application/octet-stream";
}

export function mediaKindOf(ext: string): Media["type"] | null {
  const e = ext.toLowerCase();
  return VIDEO_EXTENSIONS.includes(e) ? "video" : AUDIO_EXTENSIONS.includes(e) ? "audio" : null;
}

/** Bytes y extensión de un archivo guardado como data:. */
export function mediaBytes(src: string): { bytes: Uint8Array; ext: string } | null {
  const m = /^data:([\w/+.-]+);base64,(.*)$/.exec(src);
  if (!m) return null;
  const ext = EXT[m[1].toLowerCase()];
  if (!ext) return null;
  const binary = atob(m[2]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { bytes, ext };
}

// Los videos se reproducen desde un blob: (con data: algunos visores no pueden adelantar).
const urls = new Map<string, string>();
export function mediaUrl(src: string): string {
  const known = urls.get(src);
  if (known) return known;
  const m = /^data:([\w/+.-]+);base64,(.*)$/.exec(src);
  if (!m) return src;
  const binary = atob(m[2]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: m[1] }));
  urls.set(src, url);
  return url;
}

/** Ícono de bocina para los audios (como en PowerPoint), en PNG para que también se vea allá. */
export function audioIcon(): string {
  const size = 160;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const g = canvas.getContext("2d");
  if (!g) return "";
  g.fillStyle = "#1A73E8";
  g.beginPath();
  g.roundRect(8, 8, size - 16, size - 16, 30);
  g.fill();
  g.fillStyle = "#FFFFFF";
  g.beginPath();
  g.moveTo(40, 64);
  g.lineTo(60, 64);
  g.lineTo(86, 40);
  g.lineTo(86, 120);
  g.lineTo(60, 96);
  g.lineTo(40, 96);
  g.closePath();
  g.fill();
  g.strokeStyle = "#FFFFFF";
  g.lineWidth = 8;
  g.lineCap = "round";
  for (const r of [18, 34]) {
    g.beginPath();
    g.arc(90, 80, r, -Math.PI / 4, Math.PI / 4);
    g.stroke();
  }
  return canvas.toDataURL("image/png");
}

/** Portada (un cuadro del principio) y tamaño de un video. */
export function videoPoster(src: string): Promise<{ poster: string; w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "auto";
    video.playsInline = true;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      const w = video.videoWidth || 640;
      const h = video.videoHeight || 360;
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const g = canvas.getContext("2d");
      let poster = "";
      try {
        if (g) {
          g.fillStyle = "#000";
          g.fillRect(0, 0, w, h);
          g.drawImage(video, 0, 0, w, h);
          poster = canvas.toDataURL("image/jpeg", 0.85);
        }
      } catch {
        poster = "";
      }
      if (!poster && g) poster = canvas.toDataURL("image/png");
      resolve({ poster, w, h });
    };
    video.onloadeddata = () => {
      // Un poco después del inicio (el primer cuadro suele ser negro).
      const t = Number.isFinite(video.duration) ? Math.min(0.5, video.duration / 10) : 0;
      if (t > 0) video.currentTime = t;
      else finish();
    };
    video.onseeked = finish;
    video.onerror = () => reject(new Error("este video no se puede abrir (prueba con MP4)"));
    setTimeout(() => (video.readyState >= 2 ? finish() : !done && reject(new Error("el video tardó demasiado en abrir"))), 15000);
    video.src = mediaUrl(src);
  });
}
