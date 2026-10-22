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
- **Rust**: núcleo que lee y escribe los formatos de archivo ([calamine](https://github.com/tafia/calamine), [csv](https://github.com/BurntSushi/rust-csv)).
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
└── src/lib.rs            Lectura de hojas de cálculo
```

## Ejecutar en desarrollo

Requisitos: macOS, [Rust](https://rustup.rs/), Node.js y las herramientas de línea de comandos de Xcode.

```bash
npm install
npm run tauri dev
```

## Hoja de ruta

- [x] Abrir hojas de cálculo (.xlsx, .xls, .ods, .csv) con todas sus hojas
- [x] Pantalla de inicio y apertura de archivos por extensión o arrastrándolos a la ventana
- [ ] WEPO Sheets: editar celdas, navegar con el teclado, fórmulas y guardar en .xlsx y .csv
- [ ] WEPO Write: abrir, editar y guardar .docx
- [ ] WEPO Present: abrir, editar y guardar .pptx, y modo presentación
- [ ] Exportar a PDF
- [ ] Archivos recientes

## Licencia

MIT
