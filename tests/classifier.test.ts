import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyTask } from "../src/router/classifier.js";
import type { ClassificationRule } from "../src/types.js";

const rules: ClassificationRule[] = [
  { taskType: "coding", role: "implementer", keywords: ["implement", "build", "fix", "refactor"] },
  { taskType: "architecture", role: "architect", keywords: ["design", "architecture", "tradeoff"] },
  { taskType: "research", role: "researcher", keywords: ["research", "latest", "current"] },
];

test("classifyTask matches the rule with the most keyword hits", () => {
  const result = classifyTask("Please refactor and fix the auth module", rules);
  assert.equal(result.taskType, "coding");
  assert.equal(result.role, "implementer");
  assert.deepEqual(result.matchedKeywords.sort(), ["fix", "refactor"]);
});

test("classifyTask is case-insensitive", () => {
  const result = classifyTask("RESEARCH the LATEST pricing", rules);
  assert.equal(result.taskType, "research");
});

test("classifyTask falls back to coding/implementer when nothing matches", () => {
  const result = classifyTask("do the thing", rules);
  assert.equal(result.taskType, "coding");
  assert.equal(result.role, "implementer");
  assert.deepEqual(result.matchedKeywords, []);
});

test("classifyTask handles empty input without throwing", () => {
  const result = classifyTask("", rules);
  assert.equal(result.taskType, "coding");
  assert.ok(result.complexity >= 0 && result.complexity <= 1);
});

test("classifyTask respects an explicit role override", () => {
  const result = classifyTask("implement the login form", rules, "reviewer");
  assert.equal(result.role, "reviewer");
});

test("classifyTask raises complexity for high-signal terms and long text", () => {
  const shortText = "fix typo";
  const longText = `refactor the authentication system to be multi-tenant and handle migration safely. ${"padding ".repeat(60)}`;
  const shortResult = classifyTask(shortText, rules);
  const longResult = classifyTask(longText, rules);
  assert.ok(longResult.complexity > shortResult.complexity);
  assert.ok(longResult.complexity <= 1);
});

test("classifyTask marks low_cost tasks as cost sensitive by default", () => {
  const rulesWithLowCost: ClassificationRule[] = [
    ...rules,
    { taskType: "low_cost", role: "cheap_worker", keywords: ["summarise", "extract"] },
  ];
  const result = classifyTask("summarise this document", rulesWithLowCost);
  assert.equal(result.costSensitive, true);
});

test("classifyTask respects an explicit costSensitive override", () => {
  const result = classifyTask("implement the login form", rules, undefined, true);
  assert.equal(result.costSensitive, true);
});
