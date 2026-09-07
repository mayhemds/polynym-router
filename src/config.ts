import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import "dotenv/config";
import type { ModelRegistry, RoleMap, ClassificationRule, ProjectsMap } from "./types.js";

const modelConfigSchema = z.object({
  provider: z.enum(["openai_compatible", "anthropic", "ollama"]),
  model: z.string().min(1),
  baseUrl: z.string().url().optional(),
  apiKeyEnv: z.string().min(1).optional(),
  capabilities: z.array(z.string().min(1)).min(1),
  contextWindow: z.number().int().positive(),
  tier: z.enum(["frontier", "open", "local"]),
  pricePerMInputUsd: z.number().nonnegative().optional(),
  pricePerMOutputUsd: z.number().nonnegative().optional(),
  enabled: z.boolean().optional(),
});

const modelRegistrySchema = z.record(modelConfigSchema);
const roleMapSchema = z.record(z.string().min(1));
const ruleSchema = z.object({
  taskType: z.string().min(1),
  role: z.string().min(1),
  keywords: z.array(z.string().min(1)).min(1),
});
const rulesSchema = z.array(ruleSchema).min(1);
const projectEntrySchema = z.union([
  z.string().min(1),
  z.object({
    path: z.string().min(1),
    testCommand: z.string().min(1).optional(),
  }),
]);
const projectsSchema = z.record(projectEntrySchema);

export interface AppConfig {
  models: ModelRegistry;
  roles: RoleMap;
  rules: ClassificationRule[];
  projects: ProjectsMap;
  allowedRoots: string[];
}

const CONFIG_DIR = path.resolve(process.cwd(), "config");

let cachedConfig: AppConfig | undefined;

/**
 * Loads and validates every config/*.json file. This is the single place
 * that turns "editable JSON on disk" into "typed, validated data the rest
 * of the app can trust". Adding a model, changing a role, or adding a
 * classifier keyword never requires touching this file, only the JSON.
 */
export function loadConfig(forceReload = false): AppConfig {
  if (cachedConfig && !forceReload) {
    return cachedConfig;
  }

  const models = readJsonConfig("models.json", modelRegistrySchema);
  const roles = readJsonConfig("roles.json", roleMapSchema);
  const rules = readJsonConfig("rules.json", rulesSchema);
  const projects = existsSync(path.join(CONFIG_DIR, "projects.json"))
    ? readJsonConfig("projects.json", projectsSchema)
    : {};

  validateRoleReferences(roles, models);

  const allowedRoots = parseAllowedRoots();

  cachedConfig = { models, roles, rules, projects, allowedRoots };
  return cachedConfig;
}

function readJsonConfig<T>(filename: string, schema: z.ZodType<T>): T {
  const filePath = path.join(CONFIG_DIR, filename);
  if (!existsSync(filePath)) {
    throw new Error(`Missing required config file: config/${filename}`);
  }

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    throw new Error(`Could not read config/${filename}: ${describeError(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`config/${filename} is not valid JSON: ${describeError(error)}`);
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`config/${filename} failed validation: ${result.error.message}`);
  }
  return result.data;
}

function validateRoleReferences(roles: RoleMap, models: ModelRegistry): void {
  for (const [role, modelKey] of Object.entries(roles)) {
    if (!models[modelKey]) {
      throw new Error(
        `config/roles.json assigns role "${role}" to unknown model key "${modelKey}". ` +
          `Add "${modelKey}" to config/models.json, or point the role at an existing key.`
      );
    }
  }
}

function parseAllowedRoots(): string[] {
  const raw = process.env.ALLOWED_PROJECT_ROOTS;
  if (!raw || raw.trim().length === 0) {
    return [process.cwd()];
  }
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => path.resolve(entry));
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
