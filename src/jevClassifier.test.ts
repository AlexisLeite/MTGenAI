import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { JevApiError, JevClassifier } from "./jevClassifier.js";

const originalFetch = globalThis.fetch;
const originalKey = process.env.JEV_API_KEY;
const originalUrl = process.env.JEV_API_URL;
const originalModel = process.env.JEV_MODEL;

before(() => {
  process.env.JEV_API_KEY = "test-key";
  process.env.JEV_API_URL = "https://example.test/v1/systemone";
  process.env.JEV_MODEL = "jev-test";
});

after(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.JEV_API_KEY;
  else process.env.JEV_API_KEY = originalKey;
  if (originalUrl === undefined) delete process.env.JEV_API_URL;
  else process.env.JEV_API_URL = originalUrl;
  if (originalModel === undefined) delete process.env.JEV_MODEL;
  else process.env.JEV_MODEL = originalModel;
});

const schema = {
  category: {
    type: "choice" as const,
    instructions: "Which type of request is this?",
    criteria: { billing: "Payments", support: "Technical issues" },
  },
};

test("envía el esquema y contexto a Jev y devuelve la clasificación", async () => {
  globalThis.fetch = async (input, init) => {
    assert.equal(input, "https://example.test/v1/systemone");
    assert.equal(init?.method, "POST");
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer test-key");
    assert.deepEqual(JSON.parse(init?.body as string), {
      model: "jev-test",
      state: { message: "I need the invoice" },
      questions: schema,
    });
    return Response.json({
      model: "jev-test",
      answers: {
        category: {
          type: "choice",
          choice: "billing",
          probabilities: { billing: 0.9, support: 0.1 },
          confidence: 0.8,
        },
      },
    });
  };

  const result = await new JevClassifier().classify(schema, { message: "I need the invoice" });
  assert.equal(result.answers.category.type, "choice");
  if (result.answers.category.type === "choice") {
    assert.equal(result.answers.category.choice, "billing");
  }
});

test("informa los errores HTTP de Jev", async () => {
  globalThis.fetch = async () => new Response(null, { status: 401 });
  await assert.rejects(new JevClassifier().classify(schema, "text"), (error) => {
    assert.ok(error instanceof JevApiError);
    assert.equal(error.status, 401);
    return true;
  });
});

test("rechaza respuestas sin la clasificación solicitada", async () => {
  globalThis.fetch = async () => Response.json({ model: "jev-test", answers: {} });
  await assert.rejects(
    new JevClassifier().classify(schema, "text"),
    /respuesta con formato inesperado/,
  );
});
