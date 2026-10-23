# WEPO

**Write · Edit · Present · Open**

WEPO es una suite de oficina ligera, nativa para macOS y de código abierto. Abre y edita documentos, hojas de cálculo y presentaciones en los formatos más comunes, en una sola aplicación.

> 🚧 Proyecto en desarrollo activo. Consulta la [hoja de ruta](#hoja-de-ruta) para ver qué funciona hoy.

## Editores

| Editor | Para | Formatos |
|---|---|---|
| **WEPO Write** | Documentos de texto | .docx, .odt, .txt, .md |
| **WEPO Sheets** | Hojas de cálculo | .xlsx, .xlsm, .xlsb, .xls, .ods, .csv |
| **WEPO Present** | Presentaciones | .pptx, .odp |

## Tecnología

- **[Tauri 2](https://tauri.app/)**: aplicación de escritorio de pocos MB, mucho más ligera que una basada en Electron.
- **Rust**: núcleo que lee y escribe los formatos de archivo.
  - [IronCalc](https://github.com/ironcalc/ironcalc): motor de hojas de cálculo con fórmulas, deshacer/rehacer y lectura y escritura de .xlsx.
  - [calamine](https://github.com/tafia/calamine) y [csv](https://github.com/BurntSushi/rust-csv): lectura de .xls, .xlsb, .ods y .csv.
- **React + TypeScript**: interfaz de cada editor.
- **[TanStack Virtual](https://tanstack.com/virtual)**: la cuadrícula solo dibuja las celdas visibles, así que los archivos grandes se mantienen fluidos.

## Estructura del proyecto

```
src/                      Interfaz (React + TypeScript)
├── App.tsx               Decide qué pantalla o editor mostrar
├── screens/Home.tsx      Pantalla de inicio: crear o abrir
├── editors/
│   ├── sheets/           WEPO Sheets
│   └── ComingSoon.tsx    Marcador de los editores en construcción
├── components/           Piezas compartidas (barra superior, íconos)
└── lib/                  Tipos de documento y comunicación con Rust

src-tauri/                Núcleo nativo (Rust)
├── src/lib.rs            Comandos que la interfaz puede llamar
├── src/sheets.rs         Hojas de cálculo: abrir, editar, calcular, copiar/pegar y guardar
└── src/sheet_format.rs   Formato de celdas (fuentes, colores, bordes, alineación)
```

## Ejecutar en desarrollo

Requisitos: macOS, [Rust](https://rustup.rs/), Node.js y las herramientas de línea de comandos de Xcode.

```bash
npm install
npm run tauri dev
```

Pruebas del núcleo en Rust:

```bash
cd src-tauri
cargo test
```

## Atajos de WEPO Sheets

| Acción | Atajo |
|---|---|
| Escribir en una celda | Empieza a teclear, o F2 / doble clic para editar lo que ya tiene |
| Confirmar y bajar / ir a la derecha | Enter / Tab |
| Cancelar la edición | Esc |
| Seleccionar un rango | Shift + flechas, o arrastrar con el mouse |
| Borrar la selección | Delete |
| Copiar / cortar / pegar | ⌘C / ⌘X / ⌘V (también con Excel, Numbers y Google Sheets) |
| Negrita / cursiva / subrayado | ⌘B / ⌘I / ⌘U |
| Cambiar ancho de columna o alto de fila | Arrastra el borde del encabezado |
| Deshacer / rehacer | ⌘Z / ⌘⇧Z |
| Guardar / guardar como | ⌘S / ⌘⇧S |

## Hoja de ruta

- [x] Abrir hojas de cálculo (.xlsx, .xls, .ods, .csv) con todas sus hojas
- [x] Pantalla de inicio y apertura de archivos por extensión o arrastrándolos a la ventana
- [x] WEPO Sheets: editar celdas, navegar con el teclado, fórmulas, deshacer/rehacer y guardar en .xlsx y .csv
- [x] WEPO Sheets: formato de celdas (fuente, tamaño, negrita, colores, bordes, alineación, formato de número)
- [x] WEPO Sheets: copiar, cortar y pegar con fórmulas y formato; ancho de columnas y alto de filas
- [ ] WEPO Sheets: insertar y eliminar filas/columnas, combinar celdas, inmovilizar paneles, autollenado
- [ ] WEPO Sheets: autocompletado de fórmulas (ya calcula más de 490 funciones)
- [ ] WEPO Sheets: gráficas
- [ ] WEPO Sheets: imágenes
- [ ] WEPO Write: abrir, editar y guardar .docx
- [ ] WEPO Present: abrir, editar y guardar .pptx, y modo presentación
- [ ] Exportar a PDF
- [ ] Archivos recientes

## Licencia

MIT
