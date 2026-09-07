import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreModel } from "../src/router/scorer.js";
import type { ModelConfig, TaskClassification } from "../src/types.js";

function makeModel(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    provider: "anthropic",
    model: "test-model",
    capabilities: ["coding"],
    contextWindow: 100000,
    tier: "frontier",
    ...overrides,
  };
}

function makeTask(overrides: Partial<TaskClassification> = {}): TaskClassification {
  return {
    taskType: "coding",
    role: "implementer",
    complexity: 0.5,
    costSensitive: false,
    matchedKeywords: [],
    ...overrides,
  };
}

test("scoreModel rewards a matching capability", () => {
  const withMatch = scoreModel(makeModel({ capabilities: ["coding"] }), makeTask({ taskType: "coding" }), {}, "m1", 1000);
  const withoutMatch = scoreModel(makeModel({ capabilities: ["research"] }), makeTask({ taskType: "coding" }), {}, "m1", 1000);
  assert.ok(withMatch > withoutMatch);
});

test("scoreModel penalises prompts that exceed the context window", () => {
  const fits = scoreModel(makeModel({ contextWindow: 10000 }), makeTask(), {}, "m1", 5000);
  const overflows = scoreModel(makeModel({ contextWindow: 10000 }), makeTask(), {}, "m1", 50000);
  assert.ok(fits > overflows);
});

test("scoreModel favours frontier tier for high complexity tasks", () => {
  const frontier = scoreModel(makeModel({ tier: "frontier" }), makeTask({ complexity: 0.9 }), {}, "m1", 1000);
  const open = scoreModel(makeModel({ tier: "open" }), makeTask({ complexity: 0.9 }), {}, "m1", 1000);
  assert.ok(frontier > open);
});

test("scoreModel favours local tier for cost sensitive tasks", () => {
  const local = scoreModel(makeModel({ tier: "local" }), makeTask({ costSensitive: true }), {}, "m1", 1000);
  const frontier = scoreModel(makeModel({ tier: "frontier" }), makeTask({ costSensitive: true }), {}, "m1", 1000);
  assert.ok(local > frontier);
});

test("scoreModel adds a bonus when the model is the configured role owner", () => {
  const asOwner = scoreModel(makeModel(), makeTask({ role: "implementer" }), { implementer: "m1" }, "m1", 1000);
  const asOther = scoreModel(makeModel(), makeTask({ role: "implementer" }), { implementer: "m2" }, "m1", 1000);
  assert.ok(asOwner > asOther);
});

test("scoreModel handles a zero-token prompt without throwing", () => {
  const score = scoreModel(makeModel(), makeTask(), {}, "m1", 0);
  assert.equal(typeof score, "number");
  assert.ok(Number.isFinite(score));
});

test("scoreModel applies a small penalty for higher output pricing", () => {
  const cheap = scoreModel(makeModel({ pricePerMOutputUsd: 1 }), makeTask(), {}, "m1", 1000);
  const expensive = scoreModel(makeModel({ pricePerMOutputUsd: 75 }), makeTask(), {}, "m1", 1000);
  assert.ok(cheap > expensive);
});

test("scoreModel ignores historical performance below the minimum sample threshold", () => {
  const withFewFailures = scoreModel(makeModel(), makeTask(), {}, "m1", 1000, { requests: 2, successes: 0 });
  const withNoHistory = scoreModel(makeModel(), makeTask(), {}, "m1", 1000);
  assert.equal(withFewFailures, withNoHistory);
});

test("scoreModel rewards a model with a strong track record once it has enough samples", () => {
  const strongHistory = scoreModel(makeModel(), makeTask(), {}, "m1", 1000, { requests: 20, successes: 19 });
  const noHistory = scoreModel(makeModel(), makeTask(), {}, "m1", 1000);
  assert.ok(strongHistory > noHistory);
});

test("scoreModel penalises a model with a poor track record once it has enough samples", () => {
  const poorHistory = scoreModel(makeModel(), makeTask(), {}, "m1", 1000, { requests: 20, successes: 2 });
  const noHistory = scoreModel(makeModel(), makeTask(), {}, "m1", 1000);
  assert.ok(poorHistory < noHistory);
});

test("scoreModel caps the historical bonus rather than letting it dominate the score", () => {
  const perfectHistory = scoreModel(makeModel(), makeTask(), {}, "m1", 1000, { requests: 1000, successes: 1000 });
  const noHistory = scoreModel(makeModel(), makeTask(), {}, "m1", 1000);
  // Base score here is 50 (capability) + 20 (context fit) = 70, minus 0 price penalty.
  // The bonus is capped at +15, so perfect history should land at exactly 85, not run away further.
  assert.equal(perfectHistory, noHistory + 15);
});

test("scoreModel treats exactly the threshold sample count as enough to apply a bonus", () => {
  const atThreshold = scoreModel(makeModel(), makeTask(), {}, "m1", 1000, { requests: 5, successes: 5 });
  const belowThreshold = scoreModel(makeModel(), makeTask(), {}, "m1", 1000, { requests: 4, successes: 4 });
  assert.ok(atThreshold > belowThreshold);
});
