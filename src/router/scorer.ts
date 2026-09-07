import type { ModelConfig, RoleMap, TaskClassification } from "../types.js";

const CAPABILITY_MATCH_SCORE = 50;
const CONTEXT_FIT_SCORE = 20;
const FRONTIER_COMPLEXITY_SCORE = 20;
const LOCAL_COST_SCORE = 30;
const ROLE_PREFERENCE_SCORE = 15;
const COMPLEXITY_THRESHOLD = 0.75;
const MAX_PRICE_PENALTY = 10;
const PRICE_PENALTY_DIVISOR = 5;

/**
 * Phase 5: a model needs at least this many logged requests before its
 * historical success rate affects routing at all. Below this, the bonus is
 * exactly zero, current behavior is completely unchanged. This is what
 * makes it safe to ship before there's much real usage: it stays dormant
 * until there's enough signal to trust, then activates on its own.
 */
export const MIN_HISTORICAL_SAMPLES = 5;
const HISTORICAL_SCALE = 30;
const HISTORICAL_MAX_BONUS = 15;

export interface HistoricalPerformance {
  requests: number;
  successes: number;
}

/**
 * Scores one model against one classified task. Higher is better. This is
 * pure and deterministic on purpose, no network calls, no config reads, so
 * it stays easy to unit test and easy to reason about as the registry grows.
 */
export function scoreModel(
  model: ModelConfig,
  task: TaskClassification,
  roles: RoleMap,
  modelKey: string,
  estimatedPromptTokens: number,
  historical?: HistoricalPerformance
): number {
  let score = 0;

  if (model.capabilities.includes(task.taskType)) {
    score += CAPABILITY_MATCH_SCORE;
  }

  if (estimatedPromptTokens <= model.contextWindow) {
    score += CONTEXT_FIT_SCORE;
  }

  if (task.complexity > COMPLEXITY_THRESHOLD && model.tier === "frontier") {
    score += FRONTIER_COMPLEXITY_SCORE;
  }

  if (task.costSensitive && model.tier === "local") {
    score += LOCAL_COST_SCORE;
  }

  if (roles[task.role] === modelKey) {
    score += ROLE_PREFERENCE_SCORE;
  }

  const outputPrice = model.pricePerMOutputUsd ?? 0;
  score -= Math.min(MAX_PRICE_PENALTY, outputPrice / PRICE_PENALTY_DIVISOR);

  score += historicalBonus(historical);

  return Math.round(score * 100) / 100;
}

/**
 * Returns 0 below MIN_HISTORICAL_SAMPLES, otherwise a bonus centered on a
 * 50% success rate: a model succeeding 100% of the time earns the full
 * +15, one failing constantly earns the full -15, in between it scales
 * linearly. This never overrides a strong capability match on its own, it
 * nudges between otherwise-similar candidates.
 */
function historicalBonus(historical: HistoricalPerformance | undefined): number {
  if (!historical || historical.requests < MIN_HISTORICAL_SAMPLES) {
    return 0;
  }
  const successRate = historical.successes / historical.requests;
  const raw = (successRate - 0.5) * HISTORICAL_SCALE;
  return Math.max(-HISTORICAL_MAX_BONUS, Math.min(HISTORICAL_MAX_BONUS, raw));
}
