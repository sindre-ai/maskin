import { logger } from '../lib/logger'

// Shared OpenAI-compatible chat-completions client. All server-side LLM calls
// route through here (bet-strategist draft, agent-builder pipeline) so env
// resolution and error handling stay consistent.
//
// Uses the workspace-level fallback provider (currently OpenRouter). Callers
// pass per-request temperature / token budgets — the helper only owns
// transport and env resolution, not prompt shape.

export interface FallbackConfig {
	apiKey: string
	baseUrl: string
	model: string
}

/**
 * Reads MASKIN_FALLBACK_* env vars once per call. Returns null when the
 * OpenRouter key is unset — callers must handle that (usually by surfacing an
 * "LLM not configured" error to the requester).
 */
export function readFallbackConfig(): FallbackConfig | null {
	const apiKey = process.env.MASKIN_FALLBACK_OPENROUTER_KEY?.trim()
	if (!apiKey) return null
	const baseUrl = process.env.MASKIN_FALLBACK_BASE_URL?.trim() ?? 'https://openrouter.ai/api'
	const model =
		process.env.MASKIN_FALLBACK_SMALL_MODEL?.trim() ??
		process.env.MASKIN_FALLBACK_MODEL?.trim() ??
		'deepseek/deepseek-v4-flash'
	return { apiKey, baseUrl, model }
}

export interface LlmCallInput {
	system: string
	user: string
	temperature: number
	maxTokens: number
	timeoutMs?: number
	/** Ask the provider for a JSON object response (adds `response_format`). */
	jsonMode?: boolean
	/** Optional model override — defaults to the fallback config's model. */
	model?: string
	/** Log-prefix so failures can be traced back to the caller. */
	callerTag?: string
}

export type LlmCallResult =
	| { ok: true; content: string }
	| {
			ok: false
			reason: 'no_api_key' | 'http_error' | 'network_error' | 'empty_content'
			status?: number
			message?: string
	  }

const DEFAULT_TIMEOUT_MS = 30_000

export async function callLlm(input: LlmCallInput): Promise<LlmCallResult> {
	const config = readFallbackConfig()
	const tag = input.callerTag ?? 'llm-call'
	if (!config) {
		logger.warn(`${tag}: MASKIN_FALLBACK_OPENROUTER_KEY not set`)
		return { ok: false, reason: 'no_api_key' }
	}

	const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
	const model = input.model ?? config.model

	try {
		const response = await fetch(`${config.baseUrl}/v1/chat/completions`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${config.apiKey}`,
			},
			body: JSON.stringify({
				model,
				messages: [
					{ role: 'system', content: input.system },
					{ role: 'user', content: input.user },
				],
				max_tokens: input.maxTokens,
				temperature: input.temperature,
				...(input.jsonMode ? { response_format: { type: 'json_object' } } : {}),
			}),
			signal: AbortSignal.timeout(timeoutMs),
		})

		if (!response.ok) {
			logger.warn(`${tag}: LLM API error`, { status: response.status })
			return { ok: false, reason: 'http_error', status: response.status }
		}

		const data = (await response.json()) as {
			choices?: Array<{ message?: { content?: string } }>
		}
		const content = data.choices?.[0]?.message?.content?.trim() ?? ''
		if (content.length === 0) {
			return { ok: false, reason: 'empty_content' }
		}
		return { ok: true, content }
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		logger.error(`${tag}: LLM call failed`, { err: message })
		return { ok: false, reason: 'network_error', message }
	}
}
