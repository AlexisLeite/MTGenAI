import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyPaper, CLASSIFIER_FINGERPRINT } from "./classifyPapers.js";
import type { JevClassifier } from "./jevClassifier.js";

// Contradictory criterion answers and title keywords must never override Jev.
for (const decision of ["include", "maybe", "exclude"] as const) {
  test(`preserves Jev's ${decision} decision despite contradictory evidence`, async () => {
    const answer = (choice: string) => ({ type: "choice", choice, probabilities: { [choice]: 1 }, confidence: 1 });
    const classifier = {
      classify: async () => ({
        model: "jev-test",
        answers: {
          decision: { ...answer(decision), probabilities: { include: 0.3, maybe: 0.3, exclude: 0.4 } },
          english: answer(decision === "exclude" ? "yes" : "no"),
          journalOrConference: answer("unclear"),
          evaluatesAiCoding: answer("yes"),
          empirical: answer("yes"),
          focus: answer(decision === "exclude" ? "evaluation" : "solution"),
        },
      }),
    } as unknown as JevClassifier;
    const result = await classifyPaper({
      excelRow: 2, arxivId: "test", contentHash: "test",
      title: "Evaluating AI-generated code: a systematic review", abstract: "Test input.",
    }, classifier);
    assert.equal(result.decision, decision);
    assert.equal(result.modelDecision, decision);
    assert.equal(result.classification, { include: "Definitely include", maybe: "Maybe include", exclude: "Definitely exclude" }[decision]);
    assert.equal(result.decisionSource, "jev");
    assert.equal(result.classifierFingerprint, CLASSIFIER_FINGERPRINT);
    assert.equal("screeningReason" in result, false);
  });
}
