import "dotenv/config";

export type JevContext = string | Record<string, unknown> | string[];
type JevDescription = string | Record<string, unknown> | unknown[] | null;
type JevInstructions = string | Record<string, unknown> | unknown[];

export type JevQuestion =
  | {
      type: "choice";
      instructions: JevInstructions;
      criteria: Record<string, JevDescription>;
    }
  | {
      type: "score";
      instructions: JevInstructions;
      criteria: JevDescription[];
    }
  | {
      type: "noul";
      instructions: JevInstructions;
      criteria?: { true: JevDescription; false: JevDescription };
    };

export type JevClassificationSchema = Record<string, JevQuestion>;

export type JevAnswer =
  | {
      type: "choice";
      choice: string;
      probabilities: Record<string, number>;
      confidence: number;
    }
  | {
      type: "score";
      score: number;
      legend: Record<string, string>;
      probabilities: Record<string, number>;
      confidence: number;
    }
  | { type: "noul"; noul: number };

export interface JevClassificationResult {
  model: string;
  answers: Record<string, JevAnswer>;
  usage?: { input_tokens: number; output_tokens: number; [key: string]: unknown };
  [key: string]: unknown;
}

export class JevApiError extends Error {
  constructor(public readonly status: number) {
    super(`Jev devolvió HTTP ${status}`);
    this.name = "JevApiError";
  }
}

export class JevClassifier {
  private readonly apiKey: string;
  private readonly apiUrl: string;
  private readonly model: string;

  constructor() {
    const apiKey = process.env.JEV_API_KEY?.trim();
    if (!apiKey) {
      throw new Error("Falta JEV_API_KEY en el archivo .env");
    }
    this.apiKey = apiKey;
    this.apiUrl = process.env.JEV_API_URL?.trim() || "https://api.typesafe.ai/v1/systemone";
    this.model = process.env.JEV_MODEL?.trim() || "jev-latest";
  }

  async classify(
    schema: JevClassificationSchema,
    context: JevContext,
  ): Promise<JevClassificationResult> {
    if (Object.keys(schema).length === 0) {
      throw new Error("El esquema debe incluir al menos una pregunta");
    }

    const response = await fetch(this.apiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: this.model, state: context, questions: schema }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      throw new JevApiError(response.status);
    }

    const result: unknown = await response.json();
    if (!isJevResult(result, schema)) {
      throw new Error("Jev devolvió una respuesta con formato inesperado");
    }
    return result;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isProbabilityMap(value: unknown): value is Record<string, number> {
  return isRecord(value) && Object.values(value).every(isProbability);
}

function isJevResult(
  value: unknown,
  schema: JevClassificationSchema,
): value is JevClassificationResult {
  if (!isRecord(value) || typeof value.model !== "string" || !isRecord(value.answers)) {
    return false;
  }

  return Object.entries(schema).every(([id, question]) => {
    const answer = (value.answers as Record<string, unknown>)[id];
    if (!isRecord(answer) || answer.type !== question.type) return false;

    switch (question.type) {
      case "choice":
        return (
          typeof answer.choice === "string" &&
          Object.hasOwn(question.criteria, answer.choice) &&
          isProbability(answer.confidence) &&
          isProbabilityMap(answer.probabilities) &&
          Object.keys(question.criteria).every((key) =>
            Object.hasOwn(answer.probabilities as Record<string, number>, key),
          )
        );
      case "score":
        return (
          typeof answer.score === "number" &&
          Number.isFinite(answer.score) &&
          isRecord(answer.legend) &&
          isProbability(answer.confidence) &&
          isProbabilityMap(answer.probabilities)
        );
      case "noul":
        return isProbability(answer.noul);
    }
  });
}
