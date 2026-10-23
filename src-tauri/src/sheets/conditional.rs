//! Formato condicional: reglas que cambian el aspecto de una celda según su
//! valor (resaltar mayores que…, duplicados, escalas de color, barras de datos,
//! íconos). IronCalc las evalúa y las guarda en el .xlsx; aquí las exponemos
//! a la interfaz.

use ironcalc::base::cf_types::{icon_set_icons, Cfvo, CfRuleInput, ExtendedStyle, IconThreshold};
use ironcalc::base::types::Color;
use ironcalc::base::UserModel;
use serde::Serialize;

use super::{Rect, SheetDocument};

/// Barra de datos dentro de una celda.
#[derive(Serialize, Debug)]
pub struct BarView {
    /// Qué tanto de la celda llena la barra (0 a 1).
    pub value: f64,
    /// Dónde cae el cero dentro de la celda (0 a 1), para valores negativos.
    pub axis: f64,
    pub color: String,
    pub negative: String,
    pub gradient: bool,
}

#[derive(Serialize, Debug)]
pub struct IconView {
    pub icon: String,
    pub color: String,
}

#[derive(Serialize, Debug)]
pub struct RatingView {
    pub icon: String,
    pub count: u32,
    pub max: u32,
    pub color: String,
}

/// Decoraciones de una celda (desde 1).
#[derive(Serialize, Debug)]
pub struct Decoration {
    pub row: i32,
    pub col: i32,
    pub bar: Option<BarView>,
    pub icon: Option<IconView>,
    pub rating: Option<RatingView>,
    /// Si es falso, solo se ve la decoración y no el número.
    pub show_value: bool,
}

fn color(model: &UserModel, c: &Color, fallback: &str) -> String {
    match c {
        Color::None => fallback.to_string(),
        other => model.resolve_color(other),
    }
}

fn icon_name(icon: &impl Serialize) -> String {
    serde_json::to_value(icon).ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_default()
}

pub fn decoration(model: &UserModel, row: i32, col: i32, ext: &ExtendedStyle) -> Option<Decoration> {
    if ext.data_bar.is_none() && ext.icon.is_none() && ext.rating.is_none() {
        return None;
    }
    let mut show_value = true;
    let bar = ext.data_bar.as_ref().map(|b| {
        show_value &= b.show_value;
        BarView {
            value: b.value,
            axis: b.axis_position,
            color: color(model, &b.positive_color, "#638EC6"),
            negative: color(model, &b.negative_color, "#FF0000"),
            gradient: b.is_gradient,
        }
    });
    let icon = ext.icon.as_ref().map(|i| {
        show_value &= i.show_value;
        IconView { icon: icon_name(&i.icon), color: color(model, &i.color, "#666666") }
    });
    let rating = ext.rating.as_ref().map(|r| {
        show_value &= r.show_value;
        RatingView { icon: icon_name(&r.icon), count: r.count, max: r.max, color: color(model, &r.color, "#F2C200") }
    });
    Some(Decoration { row, col, bar, icon, rating, show_value })
}

impl SheetDocument {
    /// Reglas de la hoja, de mayor a menor prioridad. Cada una lleva su `index`
    /// (para borrarla), su rango, la regla y, si tiene, su formato.
    pub fn conditional_formats(&self, sheet: u32) -> Result<Vec<serde_json::Value>, String> {
        let mut list = Vec::new();
        for item in self.model.get_conditional_formatting_list(sheet)? {
            let mut value = serde_json::to_value(&item).map_err(|e| e.to_string())?;
            let format = self.model.get_dxf_for_conditional_formatting(sheet, item.index as u32)?;
            value["format"] = serde_json::to_value(format).map_err(|e| e.to_string())?;
            list.push(value);
        }
        Ok(list)
    }

    /// Agrega una regla. `rule` es un `CfRuleInput` de IronCalc en JSON, por ejemplo:
    /// `{"type":"CellIs","operator":"GreaterThan","formula":"10",…}`.
    pub fn add_conditional_format(&mut self, sheet: u32, rect: Rect, rule: serde_json::Value) -> Result<(), String> {
        let rule: CfRuleInput = serde_json::from_value(rule).map_err(|e| format!("Regla inválida: {e}"))?;
        let range = rect.to_a1();
        self.step(|m| m.add_conditional_formatting(sheet, &range, rule))
    }

    /// Conjunto de íconos predefinido de Excel ("3Arrows", "3TrafficLights1", "3Symbols"…),
    /// repartido en partes iguales por percentil.
    pub fn add_icon_set(&mut self, sheet: u32, rect: Rect, preset: &str) -> Result<(), String> {
        let icons = icon_set_icons(preset).ok_or_else(|| format!("Conjunto de íconos desconocido: {preset}"))?;
        let count = icons.len() as f64;
        let thresholds = icons
            .into_iter()
            .enumerate()
            .map(|(i, (icon, color))| IconThreshold {
                icon,
                cfvo: Cfvo::Percent((100.0 * i as f64 / count).round()),
                color,
                is_strict: false,
            })
            .collect();
        let range = rect.to_a1();
        self.step(|m| m.add_conditional_formatting(sheet, &range, CfRuleInput::IconSet { thresholds, show_value: true }))
    }

    pub fn delete_conditional_format(&mut self, sheet: u32, index: u32) -> Result<(), String> {
        self.step(|m| m.delete_conditional_formatting(sheet, index))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reglas_barras_e_iconos() {
        let mut doc = SheetDocument::new_empty().unwrap();
        for r in 1..=5 {
            doc.set_cell(0, r, 1, &(r * 10).to_string()).unwrap();
        }
        let all = Rect { row1: 1, col1: 1, row2: 5, col2: 1 };
        let rule = json!({
            "type": "CellIs", "operator": "GreaterThan", "formula": "30", "formula2": null,
            "format": { "font": { "color": "#9C0006" }, "fill": { "color": "#FFC7CE" }, "border": null, "num_fmt": null, "alignment": null },
            "stop_if_true": false
        });
        doc.add_conditional_format(0, all, rule).unwrap();
        doc.add_conditional_format(0, all, json!({
            "type": "DataBar", "min": null, "max": null, "positive_color": "#638EC6",
            "negative_color": "#FF0000", "is_gradient": true, "show_value": true
        })).unwrap();
        doc.add_icon_set(0, all, "3Arrows").unwrap();

        let view = doc.view(0).unwrap();
        let fill = |row: usize| view.styles[view.rows[row][0].2 as usize].fill.clone();
        assert_eq!(fill(4).as_deref(), Some("#FFC7CE"), "50 > 30: resaltado");
        assert_eq!(fill(0), None, "10 no");
        assert_eq!(view.decorations.len(), 5);
        let last = view.decorations.iter().find(|d| d.row == 5).unwrap();
        assert!(last.bar.as_ref().unwrap().value > 0.9);
        assert_eq!(last.icon.as_ref().unwrap().icon, "ArrowUp");

        let list = doc.conditional_formats(0).unwrap();
        assert_eq!(list.len(), 3);
        // Borrar una regla y deshacer.
        let index = list.iter().find(|r| r["cf_rule"]["type"] == "DataBar").unwrap()["index"].as_u64().unwrap();
        doc.delete_conditional_format(0, index as u32).unwrap();
        assert!(doc.view(0).unwrap().decorations.iter().all(|d| d.bar.is_none()));
        doc.undo().unwrap();
        assert!(doc.view(0).unwrap().decorations.iter().any(|d| d.bar.is_some()));

        // Se guardan en el .xlsx.
        let path = std::env::temp_dir().join(format!("wepo-cf-{}.xlsx", std::process::id()));
        let path = path.to_str().unwrap();
        doc.save(path, 0).unwrap();
        let reopened = SheetDocument::open(path).unwrap();
        assert_eq!(reopened.conditional_formats(0).unwrap().len(), 3);
        std::fs::remove_file(path).unwrap();
    }
}
