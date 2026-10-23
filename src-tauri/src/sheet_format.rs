//! Formato de celdas de WEPO Sheets.
//!
//! IronCalc guarda el estilo completo de cada celda (fuente, colores, bordes,
//! alineación, formato de número). Aquí lo convertimos en `StyleView`, una
//! versión compacta que la interfaz traduce directamente a CSS.

use ironcalc::base::types::{
    BorderItem, BorderStyle, Color, HorizontalAlignment, Style, VerticalAlignment,
};
use ironcalc::base::UserModel;
use serde::Serialize;

/// Un borde ya resuelto: estilo de línea y color en hexadecimal.
#[derive(Serialize, Debug, Clone, PartialEq, Eq, Hash)]
pub struct BorderView {
    pub style: String,
    pub color: String,
}

/// Estilo de una celda listo para dibujar.
#[derive(Serialize, Debug, Clone, PartialEq, Eq, Hash)]
pub struct StyleView {
    pub b: bool,
    pub i: bool,
    pub u: bool,
    pub strike: bool,
    /// Tamaño en puntos.
    pub size: i32,
    pub font: String,
    pub color: Option<String>,
    pub fill: Option<String>,
    /// left | center | right | justify (None = automático: números a la derecha).
    pub h: Option<String>,
    /// top | center | bottom (None = abajo, como en Excel).
    pub v: Option<String>,
    pub wrap: bool,
    /// Bordes en el orden de CSS: arriba, derecha, abajo, izquierda.
    pub borders: [Option<BorderView>; 4],
    pub num_fmt: String,
}

fn resolve(model: &UserModel, color: &Color) -> Option<String> {
    match color {
        Color::None => None,
        other => Some(model.resolve_color(other)),
    }
}

fn border(model: &UserModel, item: &Option<BorderItem>) -> Option<BorderView> {
    let item = item.as_ref()?;
    let style = match item.style {
        BorderStyle::Thin => "thin",
        BorderStyle::Medium => "medium",
        BorderStyle::Thick => "thick",
        BorderStyle::Double => "double",
        BorderStyle::Dotted => "dotted",
        _ => "dashed",
    };
    Some(BorderView {
        style: style.to_string(),
        color: resolve(model, &item.color).unwrap_or_else(|| "#000000".into()),
    })
}

pub fn style_view(model: &UserModel, style: &Style) -> StyleView {
    let (h, v, wrap) = match &style.alignment {
        Some(a) => (
            match a.horizontal {
                HorizontalAlignment::Left => Some("left"),
                HorizontalAlignment::Center | HorizontalAlignment::CenterContinuous => Some("center"),
                HorizontalAlignment::Right => Some("right"),
                HorizontalAlignment::Justify | HorizontalAlignment::Distributed => Some("justify"),
                _ => None,
            },
            match a.vertical {
                VerticalAlignment::Top => Some("top"),
                VerticalAlignment::Center => Some("center"),
                _ => None,
            },
            a.wrap_text,
        ),
        None => (None, None, false),
    };

    let b = &style.border;
    StyleView {
        b: style.font.b,
        i: style.font.i,
        u: style.font.u,
        strike: style.font.strike,
        size: style.font.sz,
        font: style.font.name.clone(),
        color: resolve(model, &style.font.color),
        fill: resolve(model, &style.fill.color),
        h: h.map(String::from),
        v: v.map(String::from),
        wrap,
        borders: [
            border(model, &b.top),
            border(model, &b.right),
            border(model, &b.bottom),
            border(model, &b.left),
        ],
        num_fmt: style.num_fmt.clone(),
    }
}

/// Tipo de borde que se aplica a un rango, tal como lo entiende IronCalc.
pub fn border_type(kind: &str) -> Result<&'static str, String> {
    Ok(match kind {
        "all" => "All",
        "outer" => "Outer",
        "inner" => "Inner",
        "top" => "Top",
        "bottom" => "Bottom",
        "left" => "Left",
        "right" => "Right",
        "none" => "None",
        other => return Err(format!("Tipo de borde desconocido: {other}")),
    })
}

pub fn border_style(style: &str) -> Result<BorderStyle, String> {
    Ok(match style {
        "thin" => BorderStyle::Thin,
        "medium" => BorderStyle::Medium,
        "thick" => BorderStyle::Thick,
        "double" => BorderStyle::Double,
        "dotted" => BorderStyle::Dotted,
        "dashed" => BorderStyle::MediumDashed,
        other => return Err(format!("Estilo de borde desconocido: {other}")),
    })
}
