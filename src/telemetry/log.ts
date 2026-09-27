import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { MIN_HISTORICAL_SAMPLES } from "../router/scorer.js";

function dataDir(): string {
  return process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.resolve(process.cwd(), "data");
}

function logFile(): string {
  return path.join(dataDir(), "requests.jsonl");
}

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
  await mkdir(dataDir(), { recursive: true });
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
    await appendFile(logFile(), line, "utf8");
    // A new line invalidates the cached aggregate.
    statsCache = undefined;
  } catch (error) {
    console.error("Failed to write telemetry log entry:", error instanceof Error ? error.message : error);
  }
}

export interface ModelStats {
  requests: number;
  costUsd: number;
  successes: number;
  /** Success/failure broken down by task type, for per-task-type routing. */
  byTaskType: Record<string, { requests: number; successes: number }>;
}

export interface Stats {
  totalRequests: number;
  successRate: number;
  totalCostUsd: number;
  byModel: Record<string, ModelStats>;
  historicalScoringMinSamples: number;
}

interface CachedStats {
  size: number;
  mtimeMs: number;
  stats: Stats;
}

let statsCache: CachedStats | undefined;

/**
 * Reads and aggregates the telemetry log. The result is cached and only
 * re-read when the file actually changed (size/mtime), so the per-request
 * O(n) re-parse cost is gone. A malformed line is skipped (and counted)
 * rather than zeroing the whole result; a truncated tail from a crash
 * mid-write no longer silently discards every stat that came before it.
 */
export async function readStats(): Promise<Stats> {
  let fileStat;
  try {
    fileStat = await stat(logFile());
  } catch {
    return emptyStats();
  }

  if (statsCache && statsCache.size === fileStat.size && statsCache.mtimeMs === fileStat.mtimeMs) {
    return statsCache.stats;
  }

  let raw: string;
  try {
    raw = await readFile(logFile(), "utf8");
  } catch {
    return emptyStats();
  }

  const byModel: Stats["byModel"] = {};
  let totalCostUsd = 0;
  let successes = 0;
  let validEntries = 0;
  let malformedLines = 0;

  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;

    let entry: RequestLogEntry;
    try {
      entry = JSON.parse(line) as RequestLogEntry;
    } catch {
      malformedLines += 1;
      continue;
    }
    if (typeof entry.modelKey !== "string" || typeof entry.success !== "boolean") {
      malformedLines += 1;
      continue;
    }

    validEntries += 1;
    const cost = typeof entry.costUsd === "number" ? entry.costUsd : 0;
    const bucket = byModel[entry.modelKey] ?? { requests: 0, costUsd: 0, successes: 0, byTaskType: {} };
    bucket.requests += 1;
    bucket.costUsd += cost;
    if (entry.success) {
      bucket.successes += 1;
      successes += 1;
    }
    const taskBucket = bucket.byTaskType[entry.taskType] ?? { requests: 0, successes: 0 };
    taskBucket.requests += 1;
    if (entry.success) {
      taskBucket.successes += 1;
    }
    bucket.byTaskType[entry.taskType] = taskBucket;
    byModel[entry.modelKey] = bucket;
    totalCostUsd += cost;
  }

  if (malformedLines > 0) {
    console.warn(`Skipped ${malformedLines} malformed line(s) in the telemetry log.`);
  }

  const stats: Stats = {
    totalRequests: validEntries,
    successRate: validEntries > 0 ? Math.round((successes / validEntries) * 1000) / 10 : 0,
    totalCostUsd: Math.round(totalCostUsd * 10000) / 10000,
    byModel,
    historicalScoringMinSamples: MIN_HISTORICAL_SAMPLES,
  };

  statsCache = { size: fileStat.size, mtimeMs: fileStat.mtimeMs, stats };
  return stats;
}

function emptyStats(): Stats {
  return { totalRequests: 0, successRate: 0, totalCostUsd: 0, byModel: {}, historicalScoringMinSamples: MIN_HISTORICAL_SAMPLES };
}

function truncateForLog(text: string): string {
  return text.length > MAX_LOGGED_TASK_CHARS ? `${text.slice(0, MAX_LOGGED_TASK_CHARS)}... [truncated]` : text;
}
