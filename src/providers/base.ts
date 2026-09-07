const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Distinguishes failures worth retrying against another model (timeouts,
 * 429s, 5xxs) from failures that will happen again no matter which model
 * you pick next (missing API key, bad request shape).
 */
export class ProviderError extends Error {
  public readonly provider: string;
  public readonly retryable: boolean;

  constructor(message: string, provider: string, retryable: boolean) {
    super(message);
    this.name = "ProviderError";
    this.provider = provider;
    this.retryable = retryable;
  }
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new ProviderError(`Request to ${url} timed out after ${timeoutMs}ms`, "unknown", true);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function resolveApiKey(envVarName: string | undefined, providerLabel: string): string {
  if (!envVarName) {
    throw new ProviderError(
      `No "apiKeyEnv" configured for provider "${providerLabel}" in config/models.json`,
      providerLabel,
      false
    );
  }
  const key = process.env[envVarName];
  if (!key || key.trim().length === 0) {
    throw new ProviderError(
      `Missing environment variable "${envVarName}" for provider "${providerLabel}". Set it in your .env file (see .env.example).`,
      providerLabel,
      false
    );
  }
  return key;
}

export async function safeReadText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 500);
  } catch {
    return "<no response body>";
  }
}
