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
└── lib/                  Tipos de documento, recientes, órdenes del menú y comunicación con Rust

src-tauri/                Núcleo nativo (Rust)
├── src/lib.rs            Comandos que la interfaz puede llamar
├── src/mac.rs            Menú de la app, archivos abiertos desde Finder e impresión
├── src/sheets.rs         Hojas de cálculo: abrir, editar, calcular, copiar/pegar, deshacer y guardar
├── src/sheets/
│   ├── structure.rs      Filas, columnas, celdas combinadas, paneles inmovilizados, pestañas, autollenado
│   ├── data.rs           Ordenar, filtrar, buscar y reemplazar
│   ├── conditional.rs    Formato condicional (reglas, barras de datos, íconos)
│   ├── validation.rs     Listas desplegables
│   └── drawings.rs       Gráficas e imágenes
├── src/xlsx_extras.rs    Partes del .xlsx que el motor no maneja (se leen y escriben aparte)
└── src/sheet_format.rs   Formato de celdas (fuentes, colores, bordes, alineación)

src/editors/sheets/functions.ts  Catálogo de funciones en español e inglés (generado del motor)
src/editors/sheets/PrintSheet.tsx Versión de la hoja para imprimir o guardar como PDF
.github/workflows/        Revisión automática y creación del instalador .dmg
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

## Crear la app e instalarla

Para generar `WEPO.app` y el instalador `.dmg` en tu Mac:

```bash
npm run tauri build
```

Al terminar quedan en `src-tauri/target/release/bundle/macos/WEPO.app` y `src-tauri/target/release/bundle/dmg/`. Abre el .dmg y arrastra WEPO a la carpeta Aplicaciones.

También puedes dejar que GitHub lo haga: al subir una etiqueta de versión (`git tag v0.1.0 && git push origin v0.1.0`) el flujo `.github/workflows/release.yml` crea un borrador en **Releases** con un .dmg para Mac con chip Apple y otro para Mac con Intel.

**Primera vez que la abres:** WEPO todavía no está firmado por Apple, así que macOS no la deja abrir con doble clic. Haz clic derecho sobre WEPO en Aplicaciones → **Abrir** → **Abrir**. Solo hace falta una vez.

**Abrir archivos con WEPO desde Finder:** WEPO se registra para .xlsx, .xlsm, .xls, .ods y .csv. Haz clic derecho en un archivo → **Abrir con** → WEPO. Para que siempre se abran con WEPO: clic derecho → **Obtener información** → **Abrir con:** WEPO → **Cambiar todo…**

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
| Seleccionar fila o columna completa | Clic en su número o letra |
| Menú con más opciones | Clic derecho en una celda, encabezado o pestaña |
| Autollenar una serie o fórmula | Arrastra la esquina inferior derecha de la selección |
| Llenar hacia abajo | ⌘D, o doble clic en la esquina de la selección |
| Seleccionar la tabla actual | ⌘A |
| Buscar y reemplazar | ⌘F |
| Renombrar una hoja | Doble clic en su pestaña |
| Insertar una función sugerida | ↑↓ para elegir, Tab o ↩ para insertar |
| Insertar una referencia en una fórmula | Clic (o arrastrar) en las celdas, o flechas justo después de `=`, `(`, `,` o un operador |
| Alternar referencia relativa/absoluta | F4 (A1 → $A$1 → A$1 → $A1) |
| Abrir la lista desplegable de una celda | ⌥↓ o clic en su flecha |
| Ajustar el ancho de una columna a su texto | Doble clic en el borde de su encabezado |
| Editar una gráfica | Doble clic sobre ella |
| Mover una gráfica o imagen seleccionada | Arrastrar, o flechas (⇧ para 10 px) |
| Borrar una gráfica o imagen seleccionada | Delete |
| Deshacer / rehacer | ⌘Z / ⌘⇧Z |
| Guardar / guardar como | ⌘S / ⌘⇧S |
| Imprimir o exportar a PDF | ⌘P |
| Nueva hoja de cálculo / abrir archivo | ⌘N / ⌘O |
| Salir de WEPO | ⌘Q (avisa si hay cambios sin guardar) |

## Fórmulas en español o en inglés

WEPO entiende más de 490 funciones. Puedes escribirlas en español (`=SUMA`, `=SI`, `=BUSCARV`, `=SUMAR.SI.CONJUNTO`) o en inglés (`=SUM`, `=IF`, `=VLOOKUP`); el botón **ES/EN** de la barra de fórmulas cambia el idioma. En el archivo .xlsx siempre se guardan en inglés, así que se abren bien en cualquier versión de Excel.

## Hoja de ruta

- [x] Abrir hojas de cálculo (.xlsx, .xls, .ods, .csv) con todas sus hojas
- [x] Pantalla de inicio y apertura de archivos por extensión o arrastrándolos a la ventana
- [x] WEPO Sheets: editar celdas, navegar con el teclado, fórmulas, deshacer/rehacer y guardar en .xlsx y .csv
- [x] WEPO Sheets: formato de celdas (fuente, tamaño, negrita, colores, bordes, alineación, formato de número)
- [x] WEPO Sheets: copiar, cortar y pegar con fórmulas y formato; ancho de columnas y alto de filas
- [x] WEPO Sheets: insertar, eliminar y ocultar filas/columnas, combinar celdas, inmovilizar paneles, autollenado
- [x] WEPO Sheets: ordenar, filtrar, buscar y reemplazar; renombrar, duplicar, mover y eliminar hojas
- [x] WEPO Sheets: fórmulas en español o inglés, autocompletado con ayuda de argumentos, referencias de colores, F4
- [x] WEPO Sheets: formato condicional (resaltar, superiores/inferiores, barras de datos, escalas de color, íconos)
- [x] WEPO Sheets: listas desplegables, texto que se desborda, alto automático de filas, autoajuste de columnas
- [x] WEPO Sheets: gráficas (columnas, barras, líneas, áreas, pastel, dona, dispersión) que se leen y guardan en .xlsx
- [x] WEPO Sheets: imágenes (PNG, JPEG, GIF)
- [ ] WEPO Write: abrir, editar y guardar .docx
- [ ] WEPO Present: abrir, editar y guardar .pptx, y modo presentación
- [x] App de Mac: menú en español, imprimir y exportar a PDF, archivos recientes, aviso de cambios sin guardar
- [x] App de Mac: abrir archivos desde Finder, ícono propio e instalador .dmg

## Licencia

MIT
