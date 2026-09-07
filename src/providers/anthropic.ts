import type { AIProvider, AIRequest, AIResponse, ModelConfig } from "../types.js";
import { fetchWithTimeout, resolveApiKey, safeReadText, ProviderError } from "./base.js";

interface AnthropicMessageResponse {
  content?: Array<{ type: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const ANTHROPIC_API_VERSION = "2023-06-01";

export class AnthropicProvider implements AIProvider {
  async generate(request: AIRequest, model: ModelConfig): Promise<AIResponse> {
    const apiKey = resolveApiKey(model.apiKeyEnv, model.provider);
    const baseUrl = (model.baseUrl ?? DEFAULT_ANTHROPIC_BASE_URL).replace(/\/$/, "");
    const started = Date.now();

    const response = await fetchWithTimeout(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_API_VERSION,
      },
      body: JSON.stringify({
        model: model.model,
        max_tokens: request.maxTokens ?? 4096,
        system: request.system,
        messages: [{ role: "user", content: request.prompt }],
      }),
    });

    if (!response.ok) {
      const bodyText = await safeReadText(response);
      throw new ProviderError(
        `anthropic (${model.model}) request failed with status ${response.status}: ${bodyText}`,
        "anthropic",
        response.status === 429 || response.status >= 500
      );
    }

    const data = (await response.json()) as AnthropicMessageResponse;
    const text = data.content?.find((block) => block.type === "text")?.text;
    if (!text) {
      throw new ProviderError(`anthropic (${model.model}) returned an empty response`, "anthropic", true);
    }

    return {
      text,
      model: model.model,
      provider: "anthropic",
      inputTokens: data.usage?.input_tokens,
      outputTokens: data.usage?.output_tokens,
      latencyMs: Date.now() - started,
    };
  }
}
