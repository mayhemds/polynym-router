import type { AIProvider, AIRequest, AIResponse, ModelConfig } from "../types.js";
import { fetchWithTimeout, safeReadText, ProviderError } from "./base.js";

interface OllamaChatResponse {
  message?: { content?: string };
  prompt_eval_count?: number;
  eval_count?: number;
}

const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";
const OLLAMA_TIMEOUT_MS = 120_000;

export class OllamaProvider implements AIProvider {
  async generate(request: AIRequest, model: ModelConfig): Promise<AIResponse> {
    const baseUrl = (model.baseUrl ?? DEFAULT_OLLAMA_BASE_URL).replace(/\/$/, "");
    const started = Date.now();

    const messages: Array<{ role: string; content: string }> = [];
    if (request.system) {
      messages.push({ role: "system", content: request.system });
    }
    messages.push({ role: "user", content: request.prompt });

    const response = await fetchWithTimeout(
      `${baseUrl}/api/chat`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: model.model, messages, stream: false }),
      },
      OLLAMA_TIMEOUT_MS
    );

    if (!response.ok) {
      const bodyText = await safeReadText(response);
      throw new ProviderError(
        `ollama (${model.model}) request failed with status ${response.status}: ${bodyText}`,
        "ollama",
        response.status >= 500
      );
    }

    const data = (await response.json()) as OllamaChatResponse;
    const text = data.message?.content;
    if (!text) {
      throw new ProviderError(
        `ollama (${model.model}) returned an empty response. Is the model pulled locally? Try: ollama pull ${model.model}`,
        "ollama",
        false
      );
    }

    return {
      text,
      model: model.model,
      provider: "ollama",
      inputTokens: data.prompt_eval_count,
      outputTokens: data.eval_count,
      latencyMs: Date.now() - started,
    };
  }
}
