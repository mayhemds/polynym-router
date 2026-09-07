export type ProviderKind = "openai_compatible" | "anthropic" | "ollama";

export interface AIRequest {
  prompt: string;
  system?: string;
  project?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface AIResponse {
  text: string;
  model: string;
  provider: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs: number;
}

export interface ModelConfig {
  provider: ProviderKind;
  model: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  capabilities: string[];
  contextWindow: number;
  tier: "frontier" | "open" | "local";
  pricePerMInputUsd?: number;
  pricePerMOutputUsd?: number;
  enabled?: boolean;
}

export type ModelRegistry = Record<string, ModelConfig>;
export type RoleMap = Record<string, string>;

export interface ProjectEntryConfig {
  path: string;
  /** Overrides auto-detection. Runs from the project root, e.g. "pytest -q" or "npm test". */
  testCommand?: string;
}
export type ProjectsMap = Record<string, string | ProjectEntryConfig>;

export interface ClassificationRule {
  taskType: string;
  role: string;
  keywords: string[];
}

export interface TaskClassification {
  taskType: string;
  role: string;
  complexity: number;
  costSensitive: boolean;
  matchedKeywords: string[];
}

/**
 * Every provider adapter implements this one interface. The router never
 * talks to Anthropic, OpenAI, Kimi, or Ollama directly, only through this
 * shape. That is what lets the model registry change without the router
 * code changing.
 */
export interface AIProvider {
  generate(request: AIRequest, model: ModelConfig): Promise<AIResponse>;
}
