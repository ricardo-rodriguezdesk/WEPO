import type { DocKind } from "../lib/documents";

/** Ícono sencillo para cada tipo de documento, dibujado con SVG. */
export default function KindIcon({ kind, size = 28 }: { kind: DocKind; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };

  if (kind === "write") {
    return (
      <svg {...common}>
        <path d="M6 3h8l4 4v14H6z" />
        <path d="M14 3v4h4" />
        <path d="M9 12h6M9 15h6M9 18h4" />
      </svg>
    );
  }
  if (kind === "sheets") {
    return (
      <svg {...common}>
        <rect x="3.5" y="4.5" width="17" height="15" rx="1.5" />
        <path d="M3.5 9.5h17M3.5 14.5h17M9.5 4.5v15" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <rect x="3" y="4.5" width="18" height="12" rx="1.5" />
      <path d="M12 16.5v3.5M8.5 20h7" />
      <path d="M7.5 12.5l3-3 2 2 3.5-3.5" />
    </svg>
  );
}
