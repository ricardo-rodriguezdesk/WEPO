# Cambios

Todos los cambios importantes de WEPO, de la versión más nueva a la más vieja.

## 0.3.1 (24 de octubre de 2026)

Vista previa de impresión en Write y Present, igual que en Sheets, y pruebas automáticas de la interfaz.

### Imprimir en WEPO Write, con vista previa
- Pantalla de impresión como la de Sheets: las páginas a la derecha, tal como van a salir.
- Imprimir o exportar a PDF todas las páginas, la página actual o un rango («1-3, 5»).
- Tamaño (Carta, A4, Oficio) y orientación de la hoja: el documento se vuelve a acomodar y la vista previa lo muestra.
- Los comentarios se pueden imprimir al final, con su autor, el texto comentado y las respuestas.
- Arreglo: en algunos documentos, un párrafo que terminaba justo al pie de la hoja hacía que todo lo siguiente quedara encimado en esa página (se veía al poner la hoja horizontal).

### Imprimir en WEPO Present, con vista previa
- Pantalla de impresión con vista previa: diapositivas (una por hoja), diapositivas con notas, o documentos con 2, 3 (con renglones para apuntes) o 6 diapositivas por hoja, en Carta o A4.
- Todas las diapositivas, la actual o un rango («1-3, 5»), con o sin las ocultas.

### Pruebas automáticas
- 19 pruebas que usan WEPO como lo haría una persona: abren archivos, imprimen, exportan a PDF, convierten y guardan, y revisan los archivos que salen. GitHub las corre en cada cambio; en la computadora, con `npm run test:e2e`.
- Arreglo: los botones *Convertir* del visor de PDF se podían pulsar antes de que el PDF terminara de cargar («El PDF no tiene páginas»).

## 0.3.0 (23 de octubre de 2026)

WEPO PDF ya edita, y los documentos pasan de un formato a otro: exportar a PDF desde los tres editores y convertir un PDF en documento de Write o en hojas de Sheets.

### Imprimir en WEPO Sheets, como en Excel
- Nueva pantalla de impresión con vista previa: las páginas se ven tal como van a salir (impresas o en PDF) y cambian con cada opción.
- Papel (Carta, A4, Oficio), orientación, márgenes y escala: tamaño real, todas las columnas en una página o toda la hoja en una página.
- El área de impresión se elige con el mouse («Seleccionar en la hoja…») o desde el menú de la celda («Establecer área de impresión»).
- Encabezado y pie con número de página («Página [Página] de [Páginas]»), y filas que se repiten arriba en cada página.
- Si convertir un PDF falla, el aviso aparece en el visor y el PDF sigue abierto.

### Exportar como PDF
- Nuevo botón «PDF» y opción *Archivo → Exportar como PDF…* en Sheets, Write y Present: pide el nombre y guarda el PDF directo, igual que se vería impreso (sin pasar por el diálogo de impresión). Usa el motor de impresión de cada sistema (macOS, Windows y Linux).
- En Sheets y Present, el diálogo de impresión tiene «Exportar PDF…» junto a «Imprimir…», con las mismas opciones (área, orientación, notas).
- Arreglo: WEPO Write volvía a imprimir hojas en blanco desde que se agregó el panel de comentarios.

### Convertir un PDF en documento de WEPO Write
- Botón *Convertir: Write* en el visor de PDF: reconstruye títulos, párrafos (con negritas, cursivas, colores, tamaños y fuente), listas con viñetas o numeradas, tablas con sus celdas combinadas y colores, recuadros, bloques de código, citas, imágenes, encabezado y pie con número de página, y el tamaño de la hoja.
- Queda como documento nuevo sin guardar: se revisa y se guarda como .docx.
- Con diseños complicados (columnas, cosas encimadas) puede hacer falta acomodar a mano; un escaneo sin texto se convierte en imágenes.

### Pasar las tablas de un PDF a WEPO Sheets
- Botón *Convertir: Sheets* en el visor de PDF: cada tabla con bordes queda en su propia hoja, con el encabezado en negrita, colores de fondo, celdas combinadas, y anchos y altos como en el PDF.
- Las cantidades quedan como números de verdad (con su formato de moneda o porcentaje), para poder sumar y hacer gráficas.
- Una tabla que sigue en la página siguiente del PDF queda como una sola tabla (en Sheets y en Write).

### WEPO PDF: edición
- Ordenar páginas arrastrando las miniaturas, girarlas, quitarlas y elegir varias a la vez.
- Combinar: agregar las páginas de otro PDF donde quieras, y guardar páginas elegidas como un PDF nuevo.
- Resaltar texto (o un recuadro en un escaneo), agregar texto, dibujar a mano, notas adhesivas y firmar (dibujando o escribiendo tu nombre).
- Rellenar formularios PDF (texto, casillas y listas).
- Todo se puede deshacer y se guarda en el PDF: se ve igual en Vista Previa, Acrobat o el navegador.

### Arreglos en WEPO PDF
- Doble clic o arrastrar sobre el texto ya no resalta toda la página (pasaba en Mac).
- La selección normal ahora es azul; ya no se confunde con un resaltado.
- Al girar una página, los resaltados y dibujos se quedan sobre el texto.
- Con la página girada, lo que eliges con el mouse coincide con el texto que ves (antes el resaltado caía en otro lugar).
- Cada renglón resaltado es una franja pareja: ya no salen manchas más oscuras entre palabras, y el resaltado elegido conserva su color.
- Resaltar dos veces lo mismo con el mismo color ya no lo oscurece. El triple clic resalta solo ese renglón, y empezar a elegir desde el margen o un espacio en blanco toma el texto desde el renglón más cercano (antes se coloreaba toda la hoja).
- Elegir texto con la flecha también funciona como en Vista Previa: empezar en el margen o soltar fuera de la página ya no elige la hoja entera; doble clic elige la palabra y triple clic el renglón.
- Las notas adhesivas se leen bien en modo oscuro, se ven en cualquier lector de PDF y, al volver a abrir el archivo en WEPO, se pueden leer.
- Los resaltados quedan exactos también en PDFs hechos por programas que dejan el dibujo desplazado.
- La ventanita de una nota cerca del borde derecho se abre hacia la izquierda (ya no se sale de la página).

### Seguridad
- pdf.js actualizado a la 6.4.299: corrige una falla que permitía ejecutar código al abrir un PDF malicioso (CVE-2026-16633).

## 0.2.0

La suite completa: ya están los cuatro editores.

### WEPO Write (nuevo)
- Abre, edita y guarda documentos de Word (.docx), y también .md y .txt. Abre documentos de LibreOffice (.odt) y los guarda como .docx.
- Formato de texto: estilos, fuentes, tamaños, colores, resaltado, alineación, listas, sangrías, interlineado y espacio entre párrafos.
- Páginas reales con saltos de página, encabezado y pie con número de página, y tamaño de hoja (Carta, A4, Oficio).
- Tablas con celdas combinadas, color de celda y ancho de columnas; imágenes y vínculos.
- Comentarios con respuestas y resueltos, y control de cambios para aceptar o rechazar lo que se escribe o se borra (compatibles con Word).
- Buscar y reemplazar, imprimir y exportar a PDF (igual que en pantalla), autoguardado y recuperación.

### WEPO Present (nuevo)
- Abre, edita y guarda presentaciones de PowerPoint (.pptx), con diseños, temas, notas del orador, imágenes, formas y tablas.
- Seleccionar varios elementos, alinear y repartir, girar, cambiar el diseño, imagen de fondo y tamaño 16:9 o 4:3.
- Modo presentación a pantalla completa y vista del presentador (notas, siguiente diapositiva y tiempo).
- Imprimir y exportar a PDF (diapositivas o diapositivas con notas), autoguardado y recuperación.

### WEPO PDF (nuevo)
- Visor de PDF con miniaturas, zoom, ir a una página, seleccionar y copiar texto, y PDF con contraseña.
- Las herramientas de edición ya están en la barra y llegarán en una versión próxima.

### WEPO Sheets
- Tablas con estilo, filtros y fila de totales; gráficas apiladas y combinadas; encabezado, pie y área de impresión.
- Ventana «Insertar función», validación de números y fechas, filtros por condición y quitar duplicados.
- Barra de estado con suma, promedio y recuento; copiar formato, pegado especial, notas e hipervínculos; autoguardado y recuperación.
- Zoom de 25 % a 400 %.
- Arreglo: las celdas vacías con formato de moneda (como las que crea openpyxl) ya no muestran «$0».

### Toda la app
- Varios documentos abiertos a la vez, cada uno en su ventana.
- Compatible con Windows y Linux, además de macOS.

## 0.1.0

- Primera versión pública: WEPO Sheets para abrir, editar y guardar hojas de cálculo (.xlsx, .xls, .ods, .csv) con fórmulas en español o inglés, formato, ordenar y filtrar, formato condicional, gráficas e imágenes.
- App de Mac con menú en español, imprimir y exportar a PDF, archivos recientes y aviso de cambios sin guardar.
