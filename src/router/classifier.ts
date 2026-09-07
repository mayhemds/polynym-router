import type { ClassificationRule, TaskClassification } from "../types.js";

const DEFAULT_ROLE = "implementer";
const DEFAULT_TASK_TYPE = "coding";

// Heuristic signals that push complexity up regardless of language or stack.
const HIGH_COMPLEXITY_SIGNALS = [
  "architecture",
  "multi-tenant",
  "multi tenant",
  "migrate",
  "migration",
  "security",
  "refactor",
  "distributed",
  "concurrency",
  "scale",
];

const LONG_TASK_CHAR_THRESHOLD = 400;
const LONG_TASK_COMPLEXITY_BONUS = 0.2;
const COMPLEXITY_BASE = 0.3;
const COMPLEXITY_PER_SIGNAL = 0.15;
const COMPLEXITY_PER_KEYWORD_MATCH = 0.05;

/**
 * Turns free-text task descriptions into a role and task type using
 * keyword rules loaded from config/rules.json. Retuning what counts as
 * "coding" vs "architecture" is a config edit, not a code change.
 */
export function classifyTask(
  taskText: string,
  rules: ClassificationRule[],
  roleOverride?: string,
  costSensitiveOverride?: boolean
): TaskClassification {
  const normalized = taskText.toLowerCase();

  let bestRule: ClassificationRule | undefined;
  let bestMatches: string[] = [];

  for (const rule of rules) {
    const matches = rule.keywords.filter((keyword) => normalized.includes(keyword.toLowerCase()));
    if (matches.length > bestMatches.length) {
      bestMatches = matches;
      bestRule = rule;
    }
  }

  const role = roleOverride ?? bestRule?.role ?? DEFAULT_ROLE;
  const taskType = bestRule?.taskType ?? DEFAULT_TASK_TYPE;

  const highComplexityHits = HIGH_COMPLEXITY_SIGNALS.filter((signal) => normalized.includes(signal)).length;
  const lengthSignal = taskText.trim().length > LONG_TASK_CHAR_THRESHOLD ? LONG_TASK_COMPLEXITY_BONUS : 0;
  const rawComplexity =
    COMPLEXITY_BASE + highComplexityHits * COMPLEXITY_PER_SIGNAL + lengthSignal + bestMatches.length * COMPLEXITY_PER_KEYWORD_MATCH;
  const complexity = Math.round(Math.min(1, rawComplexity) * 100) / 100;

  const costSensitive = costSensitiveOverride ?? taskType === "low_cost";

  return {
    taskType,
    role,
    complexity,
    costSensitive,
    matchedKeywords: bestMatches,
  };
}
