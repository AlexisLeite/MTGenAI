# Clasificación con Jev

Integración TypeScript con Jev mediante la [API de TypeSafe](https://github.com/typesafe-ai/typesafe-sdk-js). Requiere Node.js 20 o superior.

1. Ejecutar `npm install`.
2. Copiar `.env.example` a `.env` y definir `JEV_API_KEY` con una clave de [TypeSafe](https://console.typesafe.ai/keys).
3. Ejecutar `npm run build`.

```js
import { JevClassifier } from "./dist/jevClassifier.js";

const classifier = new JevClassifier();
const result = await classifier.classify(
  {
    category: {
      type: "choice",
      instructions: "Which category best describes this message?",
      criteria: {
        billing: "Invoices and payments",
        support: "Technical issues and errors",
      },
    },
  },
  { message: "I need a copy of my invoice" },
);

console.log(result.answers.category);
```

`classify(esquema, contexto)` acepta preguntas Jev de tipo `choice`, `score` o `noul` y devuelve las respuestas bajo los mismos IDs. El contexto puede ser texto, un objeto JSON o una lista de textos. El modelo por defecto es `jev-latest` y la URL por defecto es `https://api.typesafe.ai/v1/systemone`; ambos se pueden cambiar en `.env`. La clave debe corresponder al servicio de la URL configurada.

Las instrucciones y descripciones de las opciones enviadas a Jev están en inglés. En el filtrado de papers, el texto original de `title` y `abstract` se conserva porque el idioma es un criterio de selección.

`npm test` verifica el contrato HTTP con una respuesta simulada. Para hacer una llamada real se necesita una clave válida en `.env`.

## Leer el Excel local

El archivo se encuentra en `/repos/mtgenai/docs/Protocolo GenAIDevIssues.xlsx`. El lector usa la pestaña `Clasificación Arxiv Alexis` y toma los encabezados de la fila 1.

```bash
npm run sheet:inspect
npm run sheet:read
```

`sheet:inspect` muestra las columnas, la cantidad de registros y tres filas de ejemplo. `sheet:read` devuelve todas las filas como JSON, cada una con su número de fila en Excel. Para usarlas desde otro módulo, importa `readLocalWorkbook` de `src/localWorkbook.ts` (o de `dist/localWorkbook.js` después de compilar).

Si reemplazas el archivo o cambias de pestaña, configura `XLSX_PATH` o `XLSX_SHEET` en `.env`. `SHEET_HEADER_ROW` permite cambiar la fila de encabezados. La lectura local no requiere Google Cloud ni OAuth.

## Filtrado inicial de papers

```bash
npm run papers:preview
npm run papers:classify
```

`papers:preview` lista las filas de datos 2 a 62 sin llamar a Jev; la fila 1 contiene los encabezados. `papers:classify` usa únicamente `title` y `abstract`, evalúa los criterios del MLR con instrucciones y descripciones en inglés, y escribe en la columna J una de estas etiquetas: `Definitely include`, `Maybe include` o `Definitely exclude`. La sede de publicación y la indexación Scopus quedan sin verificar si no se mencionan en el título o resumen; esa ausencia por sí sola no excluye el paper en esta etapa.

El script guarda el detalle de los criterios y la decisión en `docs/classifyPapers-2-62.json` para revisión y continuación si se interrumpe. Antes de la primera escritura crea `docs/Protocolo GenAIDevIssues.before-classification.xlsx` como respaldo. Una ejecución posterior omite filas ya clasificadas si coinciden su título, resumen, modelo y huella de las instrucciones y política de decisión. Para volver a consultar Jev en todas las filas, ejecuta `npm run papers:classify -- --force`.

### Decisión de Jev y calibración con Seba

La etiqueta final corresponde directamente a `answers.decision.choice` de Jev. El código solo traduce `include`, `maybe` y `exclude` a las etiquetas en inglés; no modifica la decisión mediante palabras del título, probabilidades ni respuestas a otros criterios. Los criterios se conservan para auditoría. `decisionSource` identifica a Jev y `classifierFingerprint` identifica las instrucciones y la política de decisión. No se generan justificaciones textuales locales como si fueran explicaciones del modelo.

Las instrucciones se ajustaron usando los 40 ejemplos de Seba (filas 2–41). Las respuestas directas de Jev coinciden en 37/40 casos (92,5%). Es concordancia sobre los ejemplos de calibración, no una validación independiente. No hay más etiquetas de Seba disponibles. Los archivos candidatos históricos conservan las decisiones con reglas posteriores, que ya no se utilizan; el JSON principal y la columna J contienen las decisiones directas de Jev.
