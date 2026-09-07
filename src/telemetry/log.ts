import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { MIN_HISTORICAL_SAMPLES } from "../router/scorer.js";

const DATA_DIR = path.resolve(process.cwd(), "data");
const LOG_FILE = path.join(DATA_DIR, "requests.jsonl");
const MAX_LOGGED_TASK_CHARS = 500;

export interface RequestLogEntry {
  timestamp: string;
  project: string | null;
  task: string;
  role: string;
  taskType: string;
  modelKey: string;
  model: string;
  provider: string;
  costUsd: number;
  latencyMs: number;
  success: boolean;
  attempts: number;
  error?: string;
}

let dirReady = false;

async function ensureDataDir(): Promise<void> {
  if (dirReady) return;
  await mkdir(DATA_DIR, { recursive: true });
  dirReady = true;
}

/**
 * Records one routing attempt. This is how the router "learns" over time,
 * per the original design: every request, success or failure, is logged
 * with enough detail to later compute per-model success rates and cost.
 * Telemetry failures are logged to stderr and swallowed, never allowed to
 * fail the actual request the user is waiting on.
 */
export async function logRequest(entry: Omit<RequestLogEntry, "timestamp">): Promise<void> {
  try {
    await ensureDataDir();
    const line = `${JSON.stringify({
      ...entry,
      timestamp: new Date().toISOString(),
      task: truncateForLog(entry.task),
    })}\n`;
    await appendFile(LOG_FILE, line, "utf8");
  } catch (error) {
    console.error("Failed to write telemetry log entry:", error instanceof Error ? error.message : error);
  }
}

export interface Stats {
  totalRequests: number;
  successRate: number;
  totalCostUsd: number;
  byModel: Record<string, { requests: number; costUsd: number; successes: number }>;
  historicalScoringMinSamples: number;
}

export async function readStats(): Promise<Stats> {
  try {
    const raw = await readFile(LOG_FILE, "utf8");
    const lines = raw.split("\n").filter((line: string) => line.trim().length > 0);
    const entries: RequestLogEntry[] = lines.map((line: string) => JSON.parse(line) as RequestLogEntry);

    const byModel: Stats["byModel"] = {};
    let totalCostUsd = 0;
    let successes = 0;

    for (const entry of entries) {
      const bucket = byModel[entry.modelKey] ?? { requests: 0, costUsd: 0, successes: 0 };
      bucket.requests += 1;
      bucket.costUsd += entry.costUsd;
      if (entry.success) {
        bucket.successes += 1;
        successes += 1;
      }
      totalCostUsd += entry.costUsd;
      byModel[entry.modelKey] = bucket;
    }

    return {
      totalRequests: entries.length,
      successRate: entries.length > 0 ? Math.round((successes / entries.length) * 1000) / 10 : 0,
      totalCostUsd: Math.round(totalCostUsd * 10000) / 10000,
      byModel,
      historicalScoringMinSamples: MIN_HISTORICAL_SAMPLES,
    };
  } catch {
    return { totalRequests: 0, successRate: 0, totalCostUsd: 0, byModel: {}, historicalScoringMinSamples: MIN_HISTORICAL_SAMPLES };
  }
}

function truncateForLog(text: string): string {
  return text.length > MAX_LOGGED_TASK_CHARS ? `${text.slice(0, MAX_LOGGED_TASK_CHARS)}... [truncated]` : text;
}
