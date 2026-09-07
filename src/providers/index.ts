import type { AIProvider } from "../types.js";
import { OpenAICompatibleProvider } from "./openaiCompatible.js";
import { AnthropicProvider } from "./anthropic.js";
import { OllamaProvider } from "./ollama.js";

const providerInstances: Record<string, AIProvider> = {
  openai_compatible: new OpenAICompatibleProvider(),
  anthropic: new AnthropicProvider(),
  ollama: new OllamaProvider(),
};

/**
 * To support a brand new provider type later:
 *   1. Implement AIProvider in a new file in this folder.
 *   2. Register an instance here under a new key.
 *   3. Use that key as the "provider" field for any model in config/models.json.
 *
 * Most new providers need none of this. Any provider that speaks the OpenAI
 * chat completions format, which is most of them, just gets a new entry in
 * config/models.json with "provider": "openai_compatible" and its own
 * baseUrl and apiKeyEnv. No code change at all.
 */
export function getProvider(kind: string): AIProvider {
  const provider = providerInstances[kind];
  if (!provider) {
    throw new Error(`Unknown provider kind "${kind}". Known kinds: ${Object.keys(providerInstances).join(", ")}`);
  }
  return provider;
}
