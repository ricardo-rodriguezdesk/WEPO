# Cambios

Todos los cambios importantes de WEPO, de la versión más nueva a la más vieja.

## 0.4.0 (29 de octubre de 2026)

Sheets se acerca a Excel —tablas dinámicas, comentarios con respuestas, agrupar, proteger hojas y acomodar las páginas a mano— y llegan el índice y las notas al pie en Write, transiciones, gráficas y animaciones en Present, y contraseñas, OCR, tachado y marca de agua en PDF. Ahora hay 35 pruebas automáticas de la interfaz.

### Tachar información y marca de agua en WEPO PDF
- Herramienta *Tachar información*: arrastra un recuadro sobre lo que quieras ocultar (texto, una foto, una firma) o escribe un texto en *Tachar todas las veces que aparece* (un RFC, un nombre, una cuenta) para tacharlo en todo el PDF.
- Al guardar se borra de verdad, no solo se tapa: las páginas con tachones se guardan como imagen con los recuadros negros, y su texto (menos lo tachado) se vuelve a poner invisible para que se pueda seguir buscando y copiando.
- *Marca de agua*: un texto (CONFIDENCIAL, BORRADOR, COPIA…) en todas las páginas, en diagonal u horizontal, con color y transparencia. Se ve antes de guardar y se puede quitar.

### Proteger hojas en WEPO Sheets
- Clic derecho en la pestaña → *Proteger hoja…*, con contraseña opcional para quitarla. Con la hoja protegida no se pueden cambiar sus celdas, su formato ni sus filas y columnas (la barra de formato se apaga y la pestaña lleva un candado).
- Antes de proteger, marca las celdas que sí se pueden llenar: clic derecho → *Permitir editar estas celdas con la hoja protegida* (como quitar «Bloqueada» en Excel).
- *Quitar la protección…* pide la contraseña si la tiene. Se puede deshacer.
- Se guarda en el .xlsx como en Excel (contraseña con SHA-512 y celdas desbloqueadas) y se leen las hojas protegidas de Excel y LibreOffice, también con contraseñas del método viejo.

### Agrupar filas y columnas en WEPO Sheets
- Elige filas o columnas y presiona ⌥⇧→ (Alt+Mayús+→ en Windows), o clic derecho → *Agrupar*. A la orilla de los encabezados aparece la barra del grupo con su botón − para contraerlo (las filas se esconden) y + para volver a abrirlo, como en Excel.
- Grupos dentro de grupos (hasta 7 niveles) y los botones 1, 2, 3… en la esquina para ver todo hasta ese nivel de una vez.
- *Desagrupar* (⌥⇧←) y *Borrar el esquema* en el clic derecho. Los grupos crecen si insertas filas adentro. Todo se puede deshacer.
- Se guardan en el .xlsx como los de Excel (niveles y lo que está contraído) y se leen los de Excel y LibreOffice.

### Comentarios en WEPO Sheets
- Comentarios con respuestas, como los de Excel 365: clic derecho → *Nuevo comentario* (o ⌘⌥M / Ctrl+Alt+M). La celda lleva una esquina morada; al pasar el mouse se ve la conversación con quién escribió y cuándo.
- Responder, editar, borrar una respuesta o toda la conversación, y marcarla como *Resuelta* (la esquina se pone gris; responder la vuelve a abrir). Todo se puede deshacer.
- Se guardan en el .xlsx como los de Excel (con respuestas, autores y «resuelto») y se leen los de Excel. LibreOffice y los Excel viejitos ven la conversación como una nota. Antes, al abrir un archivo con comentarios de Excel, salían como notas con un aviso en inglés.
- Siguen a su celda al insertar o borrar filas y columnas. Las notas de siempre siguen igual (⇧F2).

### Tablas dinámicas en WEPO Sheets
- Botón *Insertar tabla dinámica* (y en el clic derecho): eliges los datos con sus encabezados y si va en una hoja nueva o en una celda de esta hoja.
- Panel *Campos de tabla dinámica*, como el de Excel: marca un campo (el texto va a Filas y los números a Valores) o arrástralo a Filtros, Columnas, Filas o Valores. Cada valor se resume con Suma, Cuenta, Promedio, Máx. o Mín.; los filtros de arriba se eligen con casillas.
- Totales por fila, por columna y general; los valores salen con el formato de los datos (pesos, por ejemplo) y las columnas se ensanchan para que se lea todo.
- *Actualizar* vuelve a leer los datos si cambiaron; *Eliminar tabla dinámica* la quita. Todo se puede deshacer.
- Se guarda como tabla dinámica de verdad en el .xlsx (Excel y LibreOffice la reconocen y la pueden seguir moviendo) y se leen las de Excel y LibreOffice: un archivo con tablas dinámicas ya no obliga a guardar una copia. Las que tienen campos calculados o agrupados (por ejemplo, fechas por mes) todavía se conservan solo como copia.

### Cortes de página en WEPO Sheets
- Botón *Cortes de página* junto al zoom: líneas punteadas en la hoja donde termina cada página al imprimir, con las últimas opciones de impresión (papel, orientación, márgenes, escala, área y filas que se repiten). Como en Excel, aparecen solas después de imprimir o exportar a PDF.
- Saltos de página a mano, como en Excel: clic derecho → *Insertar salto de página* (arriba de la fila, a la izquierda de la columna, o los dos con una celda), *Quitar salto de página* y *Restablecer todos los saltos de página*. Se ven con línea continua.
- Los cortes se arrastran con el mouse: uno puesto a mano se mueve (o se quita si se saca de lo que se imprime) y uno automático se vuelve salto a mano en su lugar nuevo.
- La vista previa, la impresión y el PDF los respetan (con «toda la hoja en una página» no cuentan, y con «todas las columnas en una página», los de columna tampoco, igual que en Excel). Se guardan en el .xlsx y se leen los de Excel; al insertar o borrar filas o columnas se recorren.
- *Vista previa de salto de página*, como en Excel (selector *Normal | Saltos de página* junto al zoom): cada página con línea azul (continua si el salto es a mano, punteada si es automático), un «Página 1», «Página 2»… grande de fondo y en gris lo que no se imprime. Arrastra las líneas azules para decidir dónde empieza cada página, y el borde de afuera para cambiar el área de impresión. La vista se recuerda.
- Al insertar un salto de página fuera de lo que se imprime (por ejemplo, en una columna vacía a la derecha), el área de impresión crece hasta ahí; y si la escala lo ignoraría (con «ajustar todas las columnas en una página» los de columna no cuentan), pasa sola a «Tamaño real», como hay que hacerlo en Excel.
- Arreglo: al insertar un salto en una columna o fila fuera del área de impresión, a veces el área crecía pero el salto no aparecía (las dos órdenes al motor se cruzaban); ahora van una tras otra.
- Botones *Dividir a lo ancho* y *Dividir a lo largo* en la vista previa: parten en dos la página de la celda elegida (con línea vertical u horizontal), sin buscar en el menú; luego la línea azul se arrastra a donde quieras. El «Página N» se ve también encima de las gráficas.

### Índice y notas al pie en WEPO Write
- Botón *Índice*: arma la tabla de contenido con los títulos (1, 2 y 3) y la página donde cae cada uno; se actualiza sola al escribir y un clic en una entrada lleva a ese título.
- Botón *Nota al pie* (⌘⌥F): pone el número volado en el texto y la nota al pie de la hoja donde quedó, con su raya, como en Word. Las páginas dejan espacio para las notas; clic en el número o en la nota para cambiarla o borrarla.
- Se abren y se guardan en .docx (el índice como el de Word, con sus páginas; las notas en su lugar de Word) y se leen de .odt. En Markdown las notas van como [^1].

### Transiciones y gráficas en WEPO Present
- Botón *Transición*: Desvanecer, Empujar, Barrido, Cubrir, Acercar o Dividir, con dirección y duración, y la opción de pasar sola a la siguiente después de unos segundos. Vista previa en el editor, «Aplicar a todas» y una estrellita en la miniatura de las diapositivas que tienen transición. Al presentar, la diapositiva entra con su efecto.
- Botón *Gráfica*: columnas, barras, líneas, áreas, pastel o dona, con título, leyenda, valores y apiladas. Los datos se escriben en el panel de la derecha (categorías y series, como en PowerPoint); doble clic en la gráfica para volver a abrirlo.
- Se abren y se guardan en .pptx: las transiciones con su duración exacta y las gráficas como gráficas de PowerPoint, con su libro de Excel incrustado (en PowerPoint funciona «Editar datos»). Ya no aparece el aviso de que se pierden las transiciones o las gráficas.
- Sin transición, la diapositiva cambia de golpe, como en PowerPoint (antes siempre se desvanecía un poco).

### Animaciones en WEPO Present
- Botón *Animación* para el elemento elegido: Aparecer, Desvanecer, Entrar volando, Zoom o Barrido, con dirección, duración y retraso; que empiece al hacer clic, con la anterior o después de la anterior; y los cuadros de texto pueden entrar párrafo por párrafo.
- En el menú se ve el orden de todas las animaciones de la diapositiva (para subirlas, bajarlas o quitarlas), con vista previa; junto a cada elemento animado sale el número del clic en que entra.
- Al presentar, cada clic hace entrar lo que sigue; ← regresa un paso.
- Se abren y se guardan en .pptx con los efectos de PowerPoint. Las de salida, de énfasis o con trayectoria todavía no (avisa al abrir).

### PDF con contraseña en WEPO PDF
- Los PDF con contraseña ya se editan, se convierten y se guardan (antes solo se veían). Al guardar conservan su contraseña.
- Botón del candado: proteger un PDF con contraseña (AES de 256 bits, se abre en Acrobat, Vista Previa y los navegadores), cambiarla o quitarla.
- Combinar con un PDF que tiene contraseña: la pide y agrega sus páginas.
- Si el autor del PDF no permite modificarlo (permisos del archivo), WEPO lo muestra pero no lo cambia, y lo dice.

### Reconocer texto (OCR) en WEPO PDF
- Botón *Reconocer texto* (y un aviso al abrir un PDF escaneado): lee el texto de las páginas que son solo imagen y lo pone invisible encima, como Acrobat o Vista Previa. Después se puede buscar, seleccionar, resaltar y convertir a Write o Sheets, y al guardar el PDF lleva ese texto.
- Usa el reconocimiento de texto del sistema: Vision en Mac, el de Windows en Windows y tesseract en Linux (si está instalado). WEPO no pesa más ni necesita internet.
- Las páginas giradas también se leen bien.

### Arreglos
- WEPO Sheets: al escribir rápido una fórmula y dar ↩, a veces se colaba una función de la lista de sugerencias (por ejemplo «=SUMA(B2:BUSCAR(» en vez de «=SUMA(B2:B7)»).

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
