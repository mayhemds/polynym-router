import type { ModelConfig, TaskClassification } from "../types.js";
import { loadConfig } from "../config.js";
import { classifyTask } from "./classifier.js";
import { scoreModel } from "./scorer.js";
import { getProvider } from "../providers/index.js";
import { loadProjectContext } from "../projects/context.js";
import { logRequest, readStats } from "../telemetry/log.js";

export interface RouteRequestInput {
  task: string;
  project?: string;
  projectPath?: string;
  role?: string;
  costSensitive?: boolean;
  maxTokens?: number;
}

export interface RouteResult {
  model: string;
  provider: string;
  role: string;
  taskType: string;
  reason: string;
  response: string;
  costUsd: number;
  latencyMs: number;
  attempts: number;
  detectedStack: string[];
  contextTruncated: boolean;
}

/** Thrown for routing failures where the caller should see a specific HTTP status. */
export class RoutingError extends Error {
  public readonly statusHint: number;

  constructor(message: string, statusHint: number) {
    super(message);
    this.name = "RoutingError";
    this.statusHint = statusHint;
  }
}

const MAX_ATTEMPTS = 3;
const CHARS_PER_TOKEN_ESTIMATE = 4;

export async function routeRequest(input: RouteRequestInput): Promise<RouteResult> {
  const config = loadConfig();

  const classification = classifyTask(input.task, config.rules, input.role, input.costSensitive);

  let context;
  try {
    context = await loadProjectContext(input.project, input.projectPath, config.projects, config.allowedRoots);
  } catch (error) {
    throw new RoutingError(error instanceof Error ? error.message : "Invalid project path", 400);
  }

  const estimatedPromptTokens = estimateTokens(input.task + (context.text ?? ""));

  // Phase 5: read once per request, cheap at current log sizes. Below
  // MIN_HISTORICAL_SAMPLES for a given model this has zero effect on its
  // score, see scorer.ts.
  const stats = await readStats();

  const candidates = Object.entries(config.models)
    .filter(([, model]) => model.enabled !== false)
    .map(([key, model]) => ({
      key,
      model,
      score: scoreModel(model, classification, config.roles, key, estimatedPromptTokens, stats.byModel[key]),
    }))
    .sort((a, b) => b.score - a.score);

  if (candidates.length === 0) {
    throw new RoutingError(
      "No enabled models found in config/models.json. Add at least one model, or set \"enabled\": true on an existing one.",
      500
    );
  }

  const attemptCount = Math.min(MAX_ATTEMPTS, candidates.length);
  const errors: string[] = [];

  for (let i = 0; i < attemptCount; i++) {
    const candidate = candidates[i];
    const started = Date.now();
    try {
      const provider = getProvider(candidate.model.provider);
      const systemPrompt = buildSystemPrompt(context.text, classification);
      const aiResponse = await provider.generate(
        {
          prompt: input.task,
          system: systemPrompt,
          project: input.project,
          maxTokens: input.maxTokens,
        },
        candidate.model
      );

      const costUsd = estimateCost(candidate.model, aiResponse.inputTokens, aiResponse.outputTokens);
      const latencyMs = Date.now() - started;

      await logRequest({
        project: input.project ?? null,
        task: input.task,
        role: classification.role,
        taskType: classification.taskType,
        modelKey: candidate.key,
        model: candidate.model.model,
        provider: candidate.model.provider,
        costUsd,
        latencyMs,
        success: true,
        attempts: i + 1,
      });

      return {
        model: candidate.model.model,
        provider: candidate.model.provider,
        role: classification.role,
        taskType: classification.taskType,
        reason: buildReason(classification, candidate.key, i),
        response: aiResponse.text,
        costUsd,
        latencyMs,
        attempts: i + 1,
        detectedStack: context.detectedStack,
        contextTruncated: context.truncated,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${candidate.key}: ${message}`);
      await logRequest({
        project: input.project ?? null,
        task: input.task,
        role: classification.role,
        taskType: classification.taskType,
        modelKey: candidate.key,
        model: candidate.model.model,
        provider: candidate.model.provider,
        costUsd: 0,
        latencyMs: Date.now() - started,
        success: false,
        attempts: i + 1,
        error: message,
      });
    }
  }

  throw new RoutingError(`All ${attemptCount} candidate model(s) failed. Details: ${errors.join(" | ")}`, 502);
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
}

function estimateCost(model: ModelConfig, inputTokens?: number, outputTokens?: number): number {
  const inPrice = model.pricePerMInputUsd ?? 0;
  const outPrice = model.pricePerMOutputUsd ?? 0;
  const inCost = ((inputTokens ?? 0) / 1_000_000) * inPrice;
  const outCost = ((outputTokens ?? 0) / 1_000_000) * outPrice;
  return Math.round((inCost + outCost) * 10000) / 10000;
}

function buildSystemPrompt(contextText: string | undefined, classification: TaskClassification): string {
  const parts: string[] = [
    `You are acting as the "${classification.role}" for this task. Task type: ${classification.taskType}.`,
  ];
  if (contextText) {
    parts.push(
      "Project context follows. Use it to stay consistent with the existing codebase, whatever language or framework it uses."
    );
    parts.push(contextText);
  }
  return parts.join("\n\n");
}

function buildReason(classification: TaskClassification, modelKey: string, attemptIndex: number): string {
  const base = `Matched keywords [${classification.matchedKeywords.join(", ") || "none"}] to role "${classification.role}", selected "${modelKey}" as the top-scoring enabled model.`;
  return attemptIndex === 0 ? base : `${base} Escalated after ${attemptIndex} earlier failure(s).`;
}
