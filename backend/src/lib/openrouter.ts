import { env } from "../config/env";
import { AppError } from "../middleware/errorHandler";
import { logger } from "../middleware/logger";

/**
 * One way to call OpenRouter's chat API.
 *
 * Models get retired: OpenRouter answers 404 for a model it no longer offers
 * (openai/gpt-3.5-turbo, anthropic/claude-3.5-sonnet and others went this
 * way), and every AI feature then failed with a bare "Internal Server Error".
 * So callers pass the model(s) they prefer, and when one is gone we move on to
 * the next, ending with current general-purpose models. Any other failure
 * becomes a clear, non-secret message instead of a 500.
 */
export const FALLBACK_MODELS = ["openai/gpt-4o-mini", "openai/gpt-4.1-mini"] as const;

export interface ChatResult {
  data: any;
  /** The model that actually answered. */
  model: string;
}

export function candidateModels(preferred: Array<string | undefined | null>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of [...preferred, ...FALLBACK_MODELS]) {
    const id = (m ?? "").trim();
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

export async function openrouterChat(
  preferred: Array<string | undefined | null>,
  body: Record<string, unknown>
): Promise<ChatResult> {
  const models = candidateModels(preferred);
  const unavailable: string[] = [];

  for (const model of models) {
    let response: Response;
    try {
      response = await fetch(`${env.OPENROUTER_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": env.FRONTEND_URL || "",
          "X-Title": "DevUp Ecosystem",
        },
        body: JSON.stringify({ ...body, model }),
      });
    } catch (err) {
      logger.warn(`OpenRouter unreachable: ${(err as Error).message}`);
      throw new AppError(502, "Could not reach the AI provider. Please try again shortly.", "AI_UNREACHABLE");
    }

    if (response.ok) {
      if (unavailable.length) logger.warn(`OpenRouter: ${unavailable.join(", ")} unavailable; answered by ${model}`);
      return { data: await response.json(), model };
    }

    // The provider's message helps diagnosis (it never contains our key);
    // keep it in the log only.
    const detail = (await response.text().catch(() => "")).slice(0, 200);

    if (response.status === 404) {
      unavailable.push(model);
      logger.warn(`OpenRouter: model ${model} unavailable (404) ${detail}`);
      continue;
    }
    logger.warn(`OpenRouter error ${response.status} for ${model}: ${detail}`);
    if (response.status === 401 || response.status === 403) {
      throw new AppError(502, "The AI provider rejected DevUp's API key. Check OPENROUTER_API_KEY.", "AI_KEY_REJECTED");
    }
    if (response.status === 402) {
      throw new AppError(502, "The AI provider account is out of credits.", "AI_NO_CREDITS");
    }
    if (response.status === 429) {
      throw new AppError(429, "The AI provider is rate-limiting requests. Try again in a minute.", "AI_RATE_LIMITED");
    }
    throw new AppError(502, `The AI provider returned an error (${response.status}). Please try again.`, "AI_PROVIDER_ERROR");
  }

  throw new AppError(
    502,
    `None of the configured AI models are available (${unavailable.join(", ")}).`,
    "AI_MODEL_UNAVAILABLE"
  );
}
