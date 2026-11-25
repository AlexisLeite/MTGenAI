# Resumen de la revisión sistemática

La página lee la carpeta de síntesis de Google Drive al abrirse o recargarse. Usa la mayor versión numérica que tenga ambas hojas, por ejemplo `Codebook_v2` y `Coding_tanda2`. Admite el prefijo `Codex` y títulos descriptivos después del número. Si falta una de las hojas, la interfaz indica qué versiones están pendientes. Los nombres deben incluir el número de versión inmediatamente después de la etiqueta de versión o tanda.

El servicio usa la vista de carpeta y las exportaciones CSV que Drive ya hace accesibles por enlace. Si cambia esa disponibilidad, la página mostrará un error de lectura. Las hojas deben tener los datos en la primera pestaña: `Code ID, Code, Description` para el codebook y `StudyID, Challenge, Evidence Quote, Page, Justification, Context` para la codificación.

En DevMachine, systemd administra el servicio `mtgenai-review.service` en `127.0.0.1:18361`. Tailscale Serve publica el proxy HTTPS en el puerto 9443 para la tailnet.

Cada cita enlaza el PDF por nombre de archivo (`StudyID.pdf`) en la carpeta de papers. La columna `Page` usa la posición de la página en el PDF, empezando por 1. En un rango se abre la primera página. Si el valor es `N/A`, queda disponible el enlace al documento en Drive.

La interfaz presenta el codebook completo, los documentos asociados al código seleccionado y la evidencia del documento seleccionado. Cada panel se desplaza por separado. En pantallas angostas se navega entre los paneles.

La ruta pública se sirve con Tailscale Funnel en `https://devmachine.tail31d281.ts.net:8443/codebook/`.

Las fechas se leen del libro **Codex Fechas de publicación** y se unen por `StudyID`. Agregá una fila por documento con fecha en texto ISO: `AAAA-MM-DD`, `AAAA-MM` o `AAAA`, según la precisión disponible. La columna `Tipo` identifica la versión que corresponde a la fecha.

Las flechas recorren las versiones con ambas hojas disponibles. La página abre en la última versión completa y compara siempre con el número inmediatamente anterior si está disponible. Cada `+N` cuenta documentos asociados al código en destino que no estaban asociados a ese código en la versión anterior.

Cada versión muestra las asociaciones de todas las tandas completas hasta ese número. Los códigos se identifican por `Code ID` y conservan la definición más reciente hasta esa versión. Se fusionan las citas repetidas del mismo código, documento y página. La comparación usa el acumulado de ambas versiones.

**Chat de papers** usa el mismo transporte de Codex App Server que WebIR. Cada turno es efímero y recibe el historial reciente más el código y el documento abiertos. Las herramientas de solo lectura listan y buscan los PDFs de la carpeta de estudios y abren páginas concretas. Los enlaces de la respuesta apuntan a páginas abiertas durante ese turno.

En producción, systemd proporciona la credencial del App Server mediante `LoadCredential` y guarda el índice SQLite en `StateDirectory=mtgenai-review`. El servicio revisa la carpeta cada 30 minutos e indexa archivos nuevos con `pdftotext`. El chat público limita la concurrencia y las consultas. El navegador conserva la conversación hasta que se recarga la página o se inicia otra.

El chat usa GPT‑6.2‑Sol en modo rápido y renderiza Markdown a medida que llega la respuesta. Enter envía la pregunta y Shift+Enter agrega una línea.

La gráfica de barras anima los cambios del destino y respeta la preferencia de movimiento reducido. Las tandas completas ya leídas se guardan en `StateDirectory/batches`, con una clave que incluye los dos ID de Drive. Sustituir una de las hojas genera una nueva entrada. La lista de versiones y las fechas de publicación se vuelven a consultar.

El navegador también guarda cada versión acumulada ya consultada. Cambiar el origen o el destino entre versiones conocidas no hace peticiones. Al recargar, la página consulta un manifiesto de versiones y metadatos para detectar tandas nuevas. Solo descarga de nuevo una versión acumulada si falta en la caché o si cambian los archivos de los que depende.

El panel central muestra el título, la descripción y los documentos del código elegido. Los documentos se pueden ordenar por ID ascendente, fecha de publicación descendente o primera versión en la que aparecen, de menor a mayor.

El servidor revisa Drive cada minuto y guarda las tandas con ambas hojas completas, aunque no haya visitantes. El navegador precarga las versiones disponibles en segundo plano y vuelve a revisar el catálogo cada minuto mientras la página está visible. Las versiones nuevas quedan disponibles con las flechas sin cambiar la versión activa.
