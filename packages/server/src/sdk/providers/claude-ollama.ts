/**
 * Claude + Ollama provider.
 *
 * Uses the Claude SDK agent loop (tools, permissions, session persistence)
 * but routes API calls to an Ollama instance via ANTHROPIC_BASE_URL.
 * Ollama 0.14+ natively speaks the Anthropic Messages API.
 */

import type { ModelInfo } from "@yep-anywhere/shared";
import { getLogger } from "../../logging/logger.js";
import { ClaudeProvider } from "./claude.js";
import type { AuthStatus } from "./types.js";

const DEFAULT_OLLAMA_URL = "http://localhost:11434";

/** Ollama /api/tags response shape */
interface OllamaTagsResponse {
  models: Array<{
    name: string;
    size: number;
    modified_at: string;
  }>;
}

/** Ollama /api/show response shape (subset we care about) */
interface OllamaShowResponse {
  parameters?: string;
  details?: {
    parent_model?: string;
    parameter_size?: string;
    quantization_level?: string;
  };
}

/** Parse num_ctx from Ollama parameters string */
function parseNumCtx(parameters: string): number | undefined {
  const match = parameters.match(/num_ctx\s+(\d+)/);
  const ctx = match?.[1];
  return ctx !== undefined ? Number.parseInt(ctx, 10) : undefined;
}

/** Fetch extended model details from /api/show. Returns empty object on failure. */
async function fetchOllamaModelDetails(
  ollamaUrl: string,
  modelName: string,
): Promise<
  Pick<
    ModelInfo,
    "contextWindow" | "parameterSize" | "parentModel" | "quantizationLevel"
  >
> {
  try {
    const response = await fetch(`${ollamaUrl}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelName }),
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return {};
    const data = (await response.json()) as OllamaShowResponse;
    const contextWindow = data.parameters
      ? parseNumCtx(data.parameters)
      : undefined;
    const parentModel =
      data.details?.parent_model && data.details.parent_model !== modelName
        ? data.details.parent_model
        : undefined;
    return {
      contextWindow,
      parameterSize: data.details?.parameter_size || undefined,
      parentModel,
      quantizationLevel: data.details?.quantization_level || undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Claude + Ollama provider.
 * Extends ClaudeProvider, overriding env injection and model discovery.
 */
export class ClaudeOllamaProvider extends ClaudeProvider {
  override readonly name = "claude-ollama" as const;
  override readonly displayName = "Claude + Ollama";

  /** Configurable Ollama URL. Defaults to OLLAMA_URL env or localhost:11434. */
  private static ollamaUrl = process.env.OLLAMA_URL || DEFAULT_OLLAMA_URL;

  /** Whether the URL was explicitly configured (skip detection ping). */
  private static urlExplicitlyConfigured = !!process.env.OLLAMA_URL;

  /** Custom system prompt override (undefined = use default minimal prompt). */
  private static customSystemPrompt: string | undefined;

  /** Whether to use the full Claude system prompt instead of the minimal/custom one. */
  private static useFullSystemPrompt = false;

  /**
   * Update the Ollama URL at runtime (called from settings route).
   */
  static setOllamaUrl(url: string | undefined): void {
    ClaudeOllamaProvider.ollamaUrl = url || DEFAULT_OLLAMA_URL;
    ClaudeOllamaProvider.urlExplicitlyConfigured =
      !!url && url !== DEFAULT_OLLAMA_URL;
  }

  /**
   * Get the current Ollama URL.
   */
  static getOllamaUrl(): string {
    return ClaudeOllamaProvider.ollamaUrl;
  }

  /**
   * Update the custom system prompt at runtime (called from settings route).
   */
  static setSystemPrompt(prompt: string | undefined): void {
    ClaudeOllamaProvider.customSystemPrompt = prompt;
  }

  /**
   * Toggle using the full Claude system prompt (called from settings route).
   */
  static setUseFullSystemPrompt(enabled: boolean): void {
    ClaudeOllamaProvider.useFullSystemPrompt = enabled;
  }

  /**
   * Check if Ollama is reachable by pinging its API.
   * If the user explicitly configured a URL, skip detection and assume available.
   */
  override async isInstalled(): Promise<boolean> {
    if (ClaudeOllamaProvider.urlExplicitlyConfigured) {
      return true;
    }
    try {
      const response = await fetch(
        `${ClaudeOllamaProvider.ollamaUrl}/api/tags`,
        { signal: AbortSignal.timeout(3000) },
      );
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * No authentication needed for Ollama.
   */
  override async isAuthenticated(): Promise<boolean> {
    return this.isInstalled();
  }

  override async getAuthStatus(): Promise<AuthStatus> {
    const installed = await this.isInstalled();
    return {
      installed,
      authenticated: installed,
      enabled: installed,
    };
  }

  /**
   * Fetch available models from Ollama's HTTP API.
   * Works over SSH tunnels (unlike `ollama list` CLI).
   */
  override async getAvailableModels(): Promise<ModelInfo[]> {
    const log = getLogger();
    try {
      const response = await fetch(
        `${ClaudeOllamaProvider.ollamaUrl}/api/tags`,
        { signal: AbortSignal.timeout(5000) },
      );
      if (!response.ok) {
        return [];
      }
      const data = (await response.json()) as OllamaTagsResponse;
      const baseModels = data.models ?? [];
      const details = await Promise.all(
        baseModels.map((m) =>
          fetchOllamaModelDetails(ClaudeOllamaProvider.ollamaUrl, m.name),
        ),
      );
      return baseModels.map((m, i) => ({
        id: m.name,
        name: m.name,
        size: m.size,
        ...details[i],
      }));
    } catch (error) {
      log.debug({ error }, "Failed to fetch Ollama models");
      return [];
    }
  }

  /**
   * Use a minimal system prompt that local models can actually follow.
   * The full claude_code preset is far too complex for most Ollama models
   * and causes them to get stuck in tool-calling loops.
   *
   * When useFullSystemPrompt is enabled (for large-context models like Qwen3),
   * delegates to the parent ClaudeProvider to use the full claude_code preset.
   */
  protected override getSystemPrompt(
    globalInstructions?: string,
  ):
    | string
    | { type: "preset"; preset: "claude_code"; append?: string }
    | undefined {
    if (ClaudeOllamaProvider.useFullSystemPrompt) {
      return super.getSystemPrompt(globalInstructions);
    }
    const base =
      ClaudeOllamaProvider.customSystemPrompt ||
      "You are a helpful coding assistant. You help users with software engineering tasks. You have access to tools for reading files, editing files, running shell commands, and searching code. Use tools when needed to answer questions or make changes. Be concise and direct.";
    return globalInstructions ? `${base}\n\n${globalInstructions}` : base;
  }

  /**
   * Inject ANTHROPIC_BASE_URL pointing at Ollama into the child process env.
   */
  protected override getEnv(): Record<string, string | undefined> {
    return {
      ...super.getEnv(),
      ANTHROPIC_BASE_URL: ClaudeOllamaProvider.ollamaUrl,
      ANTHROPIC_AUTH_TOKEN: "ollama",
    };
  }
}

/** Singleton instance */
export const claudeOllamaProvider = new ClaudeOllamaProvider();
