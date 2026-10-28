//! Proteger una hoja, como en Excel: con la hoja protegida no se pueden cambiar
//! sus celdas (salvo las que se marcaron como editables), ni su formato ni su
//! estructura (insertar o borrar filas, combinar, gráficas…). Con contraseña
//! opcional para quitar la protección. Se lee y se guarda en el .xlsx
//! (ver xlsx_protection.rs).

use serde::{Deserialize, Serialize};

use super::{Rect, SheetDocument};
use crate::xlsx_protection::{check_password, hash_password, PasswordHash, RawProtection};

pub const LOCKED_CELLS: &str = "La hoja está protegida: estas celdas no se pueden cambiar. Para hacerlo, quita la protección (clic derecho en la pestaña de la hoja)";
pub const LOCKED_SHEET: &str = "La hoja está protegida: no se puede cambiar su formato ni su estructura. Para hacerlo, quita la protección (clic derecho en la pestaña de la hoja)";

#[derive(Clone, Debug, PartialEq, Default)]
pub struct Protection {
    pub sheet_id: u32,
    pub protected: bool,
    pub password: Option<PasswordHash>,
    /// Celdas que se pueden editar con la hoja protegida.
    pub unlocked: Vec<Rect>,
}

#[derive(Serialize, Debug, Default)]
pub struct ProtectionView {
    pub protected: bool,
    /// Pide contraseña para quitar la protección.
    pub password: bool,
    /// Celdas editables: (fila1, col1, fila2, col2), desde 1.
    pub unlocked: Vec<(i32, i32, i32, i32)>,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ProtectAction {
    Protect { password: Option<String> },
    Unprotect { password: Option<String> },
    /// Marca (o desmarca) celdas como editables con la hoja protegida.
    Unlock { row1: i32, col1: i32, row2: i32, col2: i32, unlocked: bool },
}

/// `a` sin lo que tiene de `b` (hasta cuatro pedazos).
fn subtract(a: Rect, b: Rect) -> Vec<Rect> {
    let (a, b) = (a.normalized(), b.normalized());
    if !a.intersects(&b) {
        return vec![a];
    }
    let mut out = Vec::new();
    if b.row1 > a.row1 {
        out.push(Rect { row2: b.row1 - 1, ..a });
    }
    if b.row2 < a.row2 {
        out.push(Rect { row1: b.row2 + 1, ..a });
    }
    let (r1, r2) = (a.row1.max(b.row1), a.row2.min(b.row2));
    if b.col1 > a.col1 {
        out.push(Rect { row1: r1, row2: r2, col1: a.col1, col2: b.col1 - 1 });
    }
    if b.col2 < a.col2 {
        out.push(Rect { row1: r1, row2: r2, col1: b.col2 + 1, col2: a.col2 });
    }
    out
}

impl SheetDocument {
    fn protection_of(&self, sheet: u32) -> Option<&Protection> {
        let id = self.sheet_id(sheet)?;
        self.extras.protections.iter().find(|p| p.sheet_id == id)
    }

    pub fn protection_view(&self, sheet: u32) -> ProtectionView {
        let Some(p) = self.protection_of(sheet) else { return ProtectionView::default() };
        ProtectionView {
            protected: p.protected,
            password: p.password.is_some(),
            unlocked: p.unlocked.iter().map(|r| (r.row1, r.col1, r.row2, r.col2)).collect(),
        }
    }

    /// Error si la hoja está protegida y `rect` tiene alguna celda que no es editable.
    pub(super) fn check_cells(&self, sheet: u32, rect: Rect) -> Result<(), String> {
        let Some(p) = self.protection_of(sheet).filter(|p| p.protected) else { return Ok(()) };
        // Lo que queda de `rect` después de quitarle todas las partes editables.
        let mut rest = vec![rect.normalized()];
        for u in &p.unlocked {
            rest = rest.into_iter().flat_map(|r| subtract(r, *u)).collect();
            if rest.is_empty() {
                return Ok(());
            }
        }
        Err(LOCKED_CELLS.into())
    }

    /// Error si la hoja está protegida (formato, estructura, gráficas, notas…).
    pub(super) fn check_sheet(&self, sheet: u32) -> Result<(), String> {
        match self.protection_of(sheet) {
            Some(p) if p.protected => Err(LOCKED_SHEET.into()),
            _ => Ok(()),
        }
    }

    pub fn protect(&mut self, sheet: u32, action: ProtectAction) -> Result<(), String> {
        let id = self.sheet_id(sheet).ok_or("Hoja inválida")?;
        let before = self.extras.clone();
        let index = match self.extras.protections.iter().position(|p| p.sheet_id == id) {
            Some(i) => i,
            None => {
                self.extras.protections.push(Protection { sheet_id: id, ..Default::default() });
                self.extras.protections.len() - 1
            }
        };
        let p = &mut self.extras.protections[index];
        let result = match action {
            ProtectAction::Protect { password } => {
                p.protected = true;
                p.password = password.filter(|s| !s.is_empty()).map(|s| hash_password(&s));
                Ok(())
            }
            ProtectAction::Unprotect { password } => match &p.password {
                Some(hash) if !check_password(hash, password.as_deref().unwrap_or("")) => Err("La contraseña no es correcta".to_string()),
                _ => {
                    p.protected = false;
                    p.password = None;
                    Ok(())
                }
            },
            ProtectAction::Unlock { row1, col1, row2, col2, unlocked } => {
                if p.protected {
                    Err("Para cambiar qué celdas se pueden editar, primero quita la protección de la hoja".to_string())
                } else {
                    let rect = Rect { row1, col1, row2, col2 }.normalized();
                    let mut list: Vec<Rect> = p.unlocked.iter().flat_map(|r| subtract(*r, rect)).collect();
                    if unlocked {
                        list.push(rect);
                    }
                    p.unlocked = list;
                    Ok(())
                }
            }
        };
        if let Err(e) = result {
            self.extras = before;
            return Err(e);
        }
        // Sin nada que guardar, la hoja deja de tener protección registrada.
        let empty = !self.extras.protections[index].protected && self.extras.protections[index].unlocked.is_empty();
        if empty {
            self.extras.protections.remove(index);
        }
        self.record_extras(before);
        Ok(())
    }

    pub(super) fn load_protection(&mut self, path: &str) {
        let Ok(found) = crate::xlsx_protection::read_protection(path) else { return };
        let names = self.sheet_names();
        for raw in found {
            let Some(index) = names.iter().position(|n| *n == raw.sheet) else { continue };
            let Some(sheet_id) = self.sheet_id(index as u32) else { continue };
            self.extras.protections.push(Protection {
                sheet_id,
                protected: raw.protected,
                password: raw.password,
                unlocked: raw.unlocked.iter().map(|&(row1, col1, row2, col2)| Rect { row1, col1, row2, col2 }).collect(),
            });
        }
    }

    pub(super) fn protection_for_xlsx(&self) -> Vec<RawProtection> {
        let names = self.sheet_names();
        self.extras
            .protections
            .iter()
            .filter_map(|p| {
                let index = self.sheet_index(p.sheet_id)?;
                Some(RawProtection {
                    sheet: names.get(index as usize)?.clone(),
                    protected: p.protected,
                    password: p.password.clone(),
                    unlocked: p.unlocked.iter().map(|r| (r.row1, r.col1, r.row2, r.col2)).collect(),
                })
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hoja_protegida_con_celdas_editables() {
        let mut doc = SheetDocument::new_empty().unwrap();
        doc.set_cell(0, 1, 1, "Nombre").unwrap();
        doc.set_cell(0, 2, 1, "Monto").unwrap();
        doc.protect(0, ProtectAction::Unlock { row1: 1, col1: 2, row2: 2, col2: 2, unlocked: true }).unwrap();
        doc.protect(0, ProtectAction::Protect { password: Some("wepo".into()) }).unwrap();

        // Las celdas bloqueadas no se cambian; las editables, sí.
        assert_eq!(doc.set_cell(0, 1, 1, "otro").unwrap_err(), LOCKED_CELLS);
        doc.set_cell(0, 1, 2, "Ana").unwrap();
        assert_eq!(doc.clear_range(0, Rect { row1: 1, col1: 1, row2: 2, col2: 2 }).unwrap_err(), LOCKED_CELLS);
        doc.clear_range(0, Rect { row1: 1, col1: 2, row2: 2, col2: 2 }).unwrap();
        assert_eq!(doc.insert_rows(0, 1, 1).unwrap_err(), LOCKED_SHEET);
        assert_eq!(doc.set_style(0, Rect { row1: 1, col1: 2, row2: 1, col2: 2 }, "font.b", "true").unwrap_err(), LOCKED_SHEET);
        assert!(doc.protect(0, ProtectAction::Unlock { row1: 3, col1: 3, row2: 3, col2: 3, unlocked: true }).is_err());

        // Se guarda y se lee con su contraseña.
        doc.set_cell(0, 2, 2, "150").unwrap();
        let dir = std::env::temp_dir().join("wepo-protection-test");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("protegida.xlsx");
        let path = path.to_str().unwrap();
        doc.save(path, 0).unwrap();
        let entries = crate::xlsx_pivots::entries_of(path);
        let sheet = String::from_utf8_lossy(&entries.iter().find(|(n, _)| n == "xl/worksheets/sheet1.xml").unwrap().1).into_owned();
        assert!(sheet.contains(r#"algorithmName="SHA-512""#) && sheet.contains(r#"sheet="1""#), "{sheet}");
        assert!(sheet.contains(r#"<protectedRange name="Editable1" sqref="B1:B2"/>"#));
        let styles = String::from_utf8_lossy(&entries.iter().find(|(n, _)| n == "xl/styles.xml").unwrap().1).into_owned();
        assert!(styles.contains(r#"<protection locked="0"/>"#));

        let mut reopened = SheetDocument::open(path).unwrap();
        let view = reopened.protection_view(0);
        assert!(view.protected && view.password);
        assert_eq!(view.unlocked, vec![(1, 2, 2, 2)]);
        assert!(reopened.set_cell(0, 2, 1, "x").is_err());
        assert_eq!(reopened.protect(0, ProtectAction::Unprotect { password: Some("otra".into()) }).unwrap_err(), "La contraseña no es correcta");
        reopened.protect(0, ProtectAction::Unprotect { password: Some("wepo".into()) }).unwrap();
        reopened.set_cell(0, 2, 1, "x").unwrap();
        // Deshacer vuelve a proteger la hoja.
        reopened.undo().unwrap();
        reopened.undo().unwrap();
        assert!(reopened.protection_view(0).protected);
    }

    #[test]
    fn restar_rectangulos() {
        let a = Rect { row1: 1, col1: 1, row2: 5, col2: 5 };
        let pieces = subtract(a, Rect { row1: 2, col1: 2, row2: 3, col2: 3 });
        let area: i32 = pieces.iter().map(|r| (r.row2 - r.row1 + 1) * (r.col2 - r.col1 + 1)).sum();
        assert_eq!(area, 25 - 4);
        assert!(subtract(a, a).is_empty());
    }
}
