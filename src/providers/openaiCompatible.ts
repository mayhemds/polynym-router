import type { AIProvider, AIRequest, AIResponse, ModelConfig } from "../types.js";
import { fetchWithTimeout, resolveApiKey, safeReadText, ProviderError } from "./base.js";

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * Handles any provider that speaks the OpenAI chat completions wire format.
 * This covers OpenAI itself, Kimi/Moonshot (documented as OpenAI-compatible),
 * and most new model providers that show up going forward, since that shape
 * has become a de facto standard. Adding one of these to the system is a
 * config/models.json entry, not a code change.
 */
export class OpenAICompatibleProvider implements AIProvider {
  async generate(request: AIRequest, model: ModelConfig): Promise<AIResponse> {
    if (!model.baseUrl) {
      throw new ProviderError(`Model "${model.model}" is missing "baseUrl" in config/models.json`, model.provider, false);
    }

    const apiKey = resolveApiKey(model.apiKeyEnv, model.provider);
    const started = Date.now();

    const messages: Array<{ role: string; content: string }> = [];
    if (request.system) {
      messages.push({ role: "system", content: request.system });
    }
    messages.push({ role: "user", content: request.prompt });

    const response = await fetchWithTimeout(`${model.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model.model,
        messages,
        max_tokens: request.maxTokens ?? 4096,
        temperature: request.temperature ?? 0.3,
      }),
    });

    if (!response.ok) {
      const bodyText = await safeReadText(response);
      throw new ProviderError(
        `${model.provider} (${model.model}) request failed with status ${response.status}: ${bodyText}`,
        model.provider,
        response.status === 429 || response.status >= 500
      );
    }

    const data = (await response.json()) as ChatCompletionResponse;
    const text = data.choices?.[0]?.message?.content;
    if (!text) {
      throw new ProviderError(`${model.provider} (${model.model}) returned an empty response`, model.provider, true);
    }

    return {
      text,
      model: model.model,
      provider: model.provider,
      inputTokens: data.usage?.prompt_tokens,
      outputTokens: data.usage?.completion_tokens,
      latencyMs: Date.now() - started,
    };
  }
}
