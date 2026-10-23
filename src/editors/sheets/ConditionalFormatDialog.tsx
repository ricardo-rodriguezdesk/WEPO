import { useEffect, useState } from "react";
import Dialog from "../../components/Dialog";
import type { ConditionalRule, Range } from "../../lib/spreadsheet";
import { cellName, sheetApi } from "../../lib/spreadsheet";

type Props = {
  sheet: number;
  /** Rango al que se aplica una regla nueva. */
  range: Range;
  /** Agrega una regla y devuelve si salió bien. */
  onAdd: (rule: object | { iconSet: string }) => Promise<boolean>;
  onDelete: (index: number) => Promise<boolean>;
  onClose: () => void;
};

type Kind =
  | "greater" | "less" | "between" | "equal" | "text" | "duplicates" | "blanks"
  | "top" | "bottom" | "above" | "below" | "bars" | "scale" | "icons";

const KINDS: { value: Kind; label: string; group: string }[] = [
  { value: "greater", label: "Mayor que…", group: "Resaltar celdas" },
  { value: "less", label: "Menor que…", group: "Resaltar celdas" },
  { value: "between", label: "Entre…", group: "Resaltar celdas" },
  { value: "equal", label: "Igual a…", group: "Resaltar celdas" },
  { value: "text", label: "Texto que contiene…", group: "Resaltar celdas" },
  { value: "duplicates", label: "Valores duplicados", group: "Resaltar celdas" },
  { value: "blanks", label: "Celdas vacías", group: "Resaltar celdas" },
  { value: "top", label: "Valores más altos", group: "Superiores e inferiores" },
  { value: "bottom", label: "Valores más bajos", group: "Superiores e inferiores" },
  { value: "above", label: "Por encima del promedio", group: "Superiores e inferiores" },
  { value: "below", label: "Por debajo del promedio", group: "Superiores e inferiores" },
  { value: "bars", label: "Barras de datos", group: "Visualización" },
  { value: "scale", label: "Escala de colores", group: "Visualización" },
  { value: "icons", label: "Conjunto de íconos", group: "Visualización" },
];

/** Formatos predefinidos, los mismos que ofrece Excel. */
const STYLES = [
  { label: "Relleno rojo claro con texto rojo oscuro", fill: "#FFC7CE", color: "#9C0006" },
  { label: "Relleno amarillo con texto amarillo oscuro", fill: "#FFEB9C", color: "#9C5700" },
  { label: "Relleno verde con texto verde oscuro", fill: "#C6EFCE", color: "#006100" },
  { label: "Relleno rojo claro", fill: "#FFC7CE", color: null },
  { label: "Texto rojo", fill: null, color: "#C00000" },
];

const BAR_COLORS = [
  { label: "Azul", color: "#638EC6" },
  { label: "Verde", color: "#63C384" },
  { label: "Rojo", color: "#FF555A" },
  { label: "Naranja", color: "#FFB628" },
  { label: "Morado", color: "#B255BB" },
];

const SCALES = [
  { label: "Verde - amarillo - rojo", colors: ["#63BE7B", "#FFEB84", "#F8696B"] },
  { label: "Rojo - amarillo - verde", colors: ["#F8696B", "#FFEB84", "#63BE7B"] },
  { label: "Blanco - verde", colors: ["#FFFFFF", "#63BE7B"] },
  { label: "Blanco - rojo", colors: ["#FFFFFF", "#F8696B"] },
  { label: "Azul - blanco - rojo", colors: ["#5A8AC6", "#FFFFFF", "#F8696B"] },
];

const ICON_SETS = [
  { label: "3 flechas", preset: "3Arrows", preview: "↓ → ↑" },
  { label: "3 semáforos", preset: "3TrafficLights1", preview: "● ● ●" },
  { label: "3 símbolos", preset: "3Symbols", preview: "✕ ! ✓" },
  { label: "3 banderas", preset: "3Flags", preview: "⚑ ⚑ ⚑" },
  { label: "5 flechas", preset: "5Arrows", preview: "↓ ↘ → ↗ ↑" },
];

/** Un número se manda tal cual; un texto, entre comillas (así lo espera la fórmula). */
function asFormula(value: string): string {
  const v = value.trim();
  if (v.startsWith("=")) return v.slice(1);
  return v !== "" && !isNaN(Number(v)) ? v : `"${v.replace(/"/g, '""')}"`;
}

const OPERATORS: Record<string, string> = {
  GreaterThan: "mayor que",
  GreaterThanOrEqual: "mayor o igual que",
  LessThan: "menor que",
  LessThanOrEqual: "menor o igual que",
  Equal: "igual a",
  NotEqual: "distinto de",
  Between: "entre",
  NotBetween: "fuera de",
};

/** Descripción en español de una regla guardada. */
function describe(rule: ConditionalRule["cf_rule"]): string {
  const r = rule as Record<string, unknown>;
  switch (rule.type) {
    case "CellIs":
      return r.operator === "Between" || r.operator === "NotBetween"
        ? `Valor ${OPERATORS[r.operator as string]} ${r.formula} y ${r.formula2}`
        : `Valor ${OPERATORS[r.operator as string] ?? ""} ${r.formula}`;
    case "Text":
      return `Texto que contiene "${r.value}"`;
    case "DuplicateValues":
      return "Valores duplicados";
    case "UniqueValues":
      return "Valores únicos";
    case "Blanks":
      return "Celdas vacías";
    case "NotBlanks":
      return "Celdas con contenido";
    case "Top10":
      return `${r.rank}${r.percent ? "%" : ""} valores más altos`;
    case "Bottom10":
      return `${r.rank}${r.percent ? "%" : ""} valores más bajos`;
    case "AboveAverage":
      return "Por encima del promedio";
    case "BelowAverage":
      return "Por debajo del promedio";
    case "DataBar":
      return "Barras de datos";
    case "ColorScale":
      return "Escala de colores";
    case "IconSet":
      return "Conjunto de íconos";
    case "Formula":
      return `Fórmula: =${r.formula}`;
    default:
      return rule.type;
  }
}

/** Formato condicional: lista de reglas de la hoja y formulario para agregar una nueva. */
export default function ConditionalFormatDialog({ sheet, range, onAdd, onDelete, onClose }: Props) {
  const [rules, setRules] = useState<ConditionalRule[]>([]);
  const [kind, setKind] = useState<Kind>("greater");
  const [value1, setValue1] = useState("");
  const [value2, setValue2] = useState("");
  const [rank, setRank] = useState("10");
  const [styleIndex, setStyleIndex] = useState(0);
  const [barColor, setBarColor] = useState(BAR_COLORS[0].color);
  const [scaleIndex, setScaleIndex] = useState(0);
  const [iconIndex, setIconIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const rangeLabel =
    range.r1 === range.r2 && range.c1 === range.c2
      ? cellName({ r: range.r1, c: range.c1 })
      : `${cellName({ r: range.r1, c: range.c1 })}:${cellName({ r: range.r2, c: range.c2 })}`;

  function reload() {
    sheetApi.conditionalRules(sheet).then(setRules).catch(() => setRules([]));
  }
  useEffect(reload, [sheet]);

  function format() {
    const s = STYLES[styleIndex];
    return {
      font: s.color ? { color: s.color } : null,
      fill: s.fill ? { color: s.fill } : null,
      border: null,
      num_fmt: null,
      alignment: null,
    };
  }

  function buildRule(): object | { iconSet: string } | string {
    const base = { format: format(), stop_if_true: false };
    switch (kind) {
      case "greater":
      case "less":
      case "equal":
        if (!value1.trim()) return "Escribe un valor para comparar";
        return {
          type: "CellIs",
          operator: { greater: "GreaterThan", less: "LessThan", equal: "Equal" }[kind],
          formula: asFormula(value1),
          formula2: null,
          ...base,
        };
      case "between":
        if (!value1.trim() || !value2.trim()) return "Escribe los dos valores del intervalo";
        return { type: "CellIs", operator: "Between", formula: asFormula(value1), formula2: asFormula(value2), ...base };
      case "text":
        if (!value1.trim()) return "Escribe el texto a buscar";
        return { type: "Text", operator: "Contains", value: value1.trim(), ...base };
      case "duplicates":
        return { type: "DuplicateValues", ...base };
      case "blanks":
        return { type: "Blanks", ...base };
      case "top":
      case "bottom": {
        const n = Math.max(1, Math.round(Number(rank) || 10));
        return { type: kind === "top" ? "Top10" : "Bottom10", rank: n, percent: false, ...base };
      }
      case "above":
        return { type: "AboveAverage", ...base };
      case "below":
        return { type: "BelowAverage", ...base };
      case "bars":
        return {
          type: "DataBar",
          min: null,
          max: null,
          positive_color: barColor,
          negative_color: "#FF0000",
          is_gradient: true,
          show_value: true,
        };
      case "scale": {
        const colors = SCALES[scaleIndex].colors;
        const cfvos = colors.length === 3 ? ["Min", { Percentile: 50 }, "Max"] : ["Min", "Max"];
        return { type: "ColorScale", thresholds: colors.map((color, i) => ({ cfvo: cfvos[i], color })) };
      }
      case "icons":
        return { iconSet: ICON_SETS[iconIndex].preset };
    }
  }

  async function add() {
    const rule = buildRule();
    if (typeof rule === "string") return setError(rule);
    setError(null);
    if (await onAdd(rule)) reload();
  }

  async function remove(index: number) {
    if (await onDelete(index)) reload();
  }

  const needsStyle = !["bars", "scale", "icons"].includes(kind);

  return (
    <Dialog
      title="Formato condicional"
      onClose={onClose}
      width={600}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cerrar
          </button>
          <button className="btn btn-primary" onClick={add}>
            Agregar regla a {rangeLabel}
          </button>
        </>
      }
    >
      <div className="cf-layout">
        <section>
          <label className="field">
            <span>Tipo de regla</span>
            <select className="select" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
              {[...new Set(KINDS.map((k) => k.group))].map((group) => (
                <optgroup key={group} label={group}>
                  {KINDS.filter((k) => k.group === group).map((k) => (
                    <option key={k.value} value={k.value}>
                      {k.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>

          {["greater", "less", "equal", "text", "between"].includes(kind) && (
            <div className="field">
              <span>{kind === "text" ? "Texto" : "Valor"}</span>
              <div className="field-row">
                <input className="input" value={value1} onChange={(e) => setValue1(e.target.value)} placeholder={kind === "text" ? "p. ej. pendiente" : "p. ej. 100 o =B1"} autoFocus />
                {kind === "between" && (
                  <>
                    y
                    <input className="input" value={value2} onChange={(e) => setValue2(e.target.value)} placeholder="p. ej. 500" />
                  </>
                )}
              </div>
            </div>
          )}

          {(kind === "top" || kind === "bottom") && (
            <label className="field">
              <span>Cuántos</span>
              <input className="input" type="number" min={1} value={rank} onChange={(e) => setRank(e.target.value)} />
            </label>
          )}

          {needsStyle && (
            <label className="field">
              <span>Con formato</span>
              <select className="select" value={styleIndex} onChange={(e) => setStyleIndex(Number(e.target.value))}>
                {STYLES.map((s, i) => (
                  <option key={s.label} value={i}>
                    {s.label}
                  </option>
                ))}
              </select>
              <span className="cf-preview" style={{ background: STYLES[styleIndex].fill ?? undefined, color: STYLES[styleIndex].color ?? undefined }}>
                Vista previa 123
              </span>
            </label>
          )}

          {kind === "bars" && (
            <div className="field">
              <span>Color de las barras</span>
              <div className="field-row">
                {BAR_COLORS.map((b) => (
                  <button
                    key={b.color}
                    type="button"
                    className={`cf-swatch${barColor === b.color ? " selected" : ""}`}
                    title={b.label}
                    aria-label={b.label}
                    style={{ background: `linear-gradient(90deg, ${b.color}, ${b.color}33)` }}
                    onClick={() => setBarColor(b.color)}
                  />
                ))}
              </div>
            </div>
          )}

          {kind === "scale" && (
            <div className="field">
              <span>Colores (del valor más bajo al más alto)</span>
              {SCALES.map((scale, i) => (
                <label key={scale.label} className="radio">
                  <input type="radio" checked={scaleIndex === i} onChange={() => setScaleIndex(i)} />
                  <span className="cf-scale" style={{ background: `linear-gradient(90deg, ${scale.colors.join(", ")})` }} />
                  {scale.label}
                </label>
              ))}
            </div>
          )}

          {kind === "icons" && (
            <div className="field">
              <span>Íconos</span>
              {ICON_SETS.map((set, i) => (
                <label key={set.preset} className="radio">
                  <input type="radio" checked={iconIndex === i} onChange={() => setIconIndex(i)} />
                  <span className="cf-icons-preview">{set.preview}</span>
                  {set.label}
                </label>
              ))}
            </div>
          )}

          {error && <p className="cf-error">{error}</p>}
        </section>

        <section className="cf-rules">
          <h3>Reglas de esta hoja</h3>
          {rules.length === 0 && <p className="hint">Todavía no hay reglas.</p>}
          {rules.map((rule) => (
            <div key={rule.index} className="cf-rule">
              <span
                className="cf-rule-swatch"
                style={{
                  background: rule.format?.fill?.color ?? (rule.cf_rule.type === "DataBar" ? "#638EC6" : "transparent"),
                  color: rule.format?.font?.color ?? undefined,
                }}
              >
                A
              </span>
              <span className="cf-rule-text">
                <b>{describe(rule.cf_rule)}</b>
                <small>{rule.range}</small>
              </span>
              <button type="button" className="btn btn-icon" aria-label="Eliminar regla" title="Eliminar regla" onClick={() => remove(rule.index)}>
                🗑
              </button>
            </div>
          ))}
        </section>
      </div>
    </Dialog>
  );
}
