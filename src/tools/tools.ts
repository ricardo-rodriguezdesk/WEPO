// Las herramientas de «WEPO Convertir», como las tarjetas de iLovePDF.

export type ToolId = "compress" | "repair" | "jpg2pdf" | "html2pdf" | "pdf2jpg" | "pdf2pptx" | "pdfa" | "split" | "numbers" | "crop" | "watermark" | "compare";

export type ToolDef = {
  id: ToolId;
  name: string;
  desc: string;
  group: string;
  color: string;
  /** Trazos del ícono (SVG de 24 × 24). */
  icon: string;
  /** Qué archivos recibe. */
  accept: { name: string; extensions: string[] };
  multiple: boolean;
  /** Texto del botón principal. */
  action: string;
};

const PDF = { name: "PDF", extensions: ["pdf"] };

export const TOOLS: ToolDef[] = [
  {
    id: "compress",
    name: "Comprimir PDF",
    desc: "Que pese menos, con la mejor calidad posible: las fotos se vuelven a guardar más ligeras.",
    group: "Optimizar",
    color: "#2f9e6a",
    icon: "M8 3v5H3M16 3v5h5M8 21v-5H3M16 21v-5h5",
    accept: PDF,
    multiple: true,
    action: "Comprimir",
  },
  {
    id: "repair",
    name: "Reparar PDF",
    desc: "Recupera un PDF dañado o que no abre bien, con todo lo que se pueda leer de él.",
    group: "Optimizar",
    color: "#2f9e6a",
    icon: "M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z",
    accept: PDF,
    multiple: true,
    action: "Reparar",
  },
  {
    id: "jpg2pdf",
    name: "JPG a PDF",
    desc: "Fotos e imágenes (JPG, PNG, HEIC, GIF…) en un PDF, en el orden que quieras.",
    group: "Convertir a PDF",
    color: "#d4a017",
    icon: "M4 5h16v14H4zM4 16l5-5 4 4 2-2 5 5M15.5 9.5h.01",
    accept: { name: "Imágenes (JPG, PNG, HEIC…)", extensions: ["jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "bmp", "tif", "tiff"] },
    multiple: true,
    action: "Convertir a PDF",
  },
  {
    id: "html2pdf",
    name: "HTML a PDF",
    desc: "Una página web guardada en tu computadora (.html), como PDF con sus estilos e imágenes.",
    group: "Convertir a PDF",
    color: "#d4a017",
    icon: "M8 8l-4 4 4 4M16 8l4 4-4 4M14 5l-4 14",
    accept: { name: "Página web (.html)", extensions: ["html", "htm", "xhtml"] },
    multiple: false,
    action: "Convertir a PDF",
  },
  {
    id: "pdf2jpg",
    name: "PDF a JPG",
    desc: "Cada página como una imagen JPG o PNG, con la nitidez que elijas.",
    group: "Convertir desde PDF",
    color: "#c9a227",
    icon: "M6 3h9l4 4v14H6zM9 17l2.5-3 2 2 1.5-2 2 3",
    accept: PDF,
    multiple: true,
    action: "Convertir a imágenes",
  },
  {
    id: "pdf2pptx",
    name: "PDF a PowerPoint",
    desc: "Una diapositiva por página, con el texto en cuadros que se pueden cambiar.",
    group: "Convertir desde PDF",
    color: "#d9572b",
    icon: "M4 4h16v12H4zM12 16v4M8 20h8M8 8h5a2 2 0 0 1 0 4H8V8z",
    accept: PDF,
    multiple: false,
    action: "Convertir a PowerPoint",
  },
  {
    id: "pdfa",
    name: "PDF a PDF/A",
    desc: "El PDF para archivar (ISO 19005-2): se va a ver igual dentro de muchos años.",
    group: "Convertir desde PDF",
    color: "#3b6fd8",
    icon: "M6 3h9l4 4v14H6zM9 16l2.5-6 2.5 6M10 14h3",
    accept: PDF,
    multiple: true,
    action: "Convertir a PDF/A",
  },
  {
    id: "split",
    name: "Dividir PDF",
    desc: "Un archivo por página, por rangos o cada cierto número de páginas.",
    group: "Organizar",
    color: "#c42b45",
    icon: "M6 3h7v18H6zM16 3h2v18h-2M13 12h7M17 9l3 3-3 3",
    accept: PDF,
    multiple: false,
    action: "Dividir",
  },
  {
    id: "numbers",
    name: "Números de página",
    desc: "Numera las páginas: arriba o abajo, a la izquierda, al centro o a la derecha.",
    group: "Editar",
    color: "#8e44ad",
    icon: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
    accept: PDF,
    multiple: true,
    action: "Poner números",
  },
  {
    id: "crop",
    name: "Recortar PDF",
    desc: "Quita los márgenes en blanco o recorta a mano el área que quieres dejar.",
    group: "Editar",
    color: "#8e44ad",
    icon: "M6 2v14a2 2 0 0 0 2 2h14M2 6h14a2 2 0 0 1 2 2v14",
    accept: PDF,
    multiple: false,
    action: "Recortar",
  },
  {
    id: "watermark",
    name: "Marca de agua",
    desc: "Un texto o una imagen (tu logo) encima o debajo de las páginas, con la transparencia que quieras.",
    group: "Editar",
    color: "#8e44ad",
    icon: "M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z",
    accept: PDF,
    multiple: true,
    action: "Poner marca de agua",
  },
  {
    id: "compare",
    name: "Comparar PDF",
    desc: "Dos versiones lado a lado: qué texto se quitó, qué se agregó y qué cambió en el dibujo.",
    group: "Revisar",
    color: "#2c6db5",
    icon: "M4 4h7v16H4zM13 4h7v16h-7zM6.5 9h2M15.5 9h2M6.5 13h2M15.5 13h2",
    accept: PDF,
    multiple: false,
    action: "Comparar",
  },
];

export const GROUPS = [...new Set(TOOLS.map((t) => t.group))];
export const toolById = (id: ToolId) => TOOLS.find((t) => t.id === id)!;
