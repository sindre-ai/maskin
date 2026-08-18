import { readFallbackConfig } from '../lib/llm-routing'
import { logger } from '../lib/logger'

// Shared helper for one-shot LLM calls made from backend services (e.g. the
// public bet-strategist draft endpoint). Wraps
// the OpenAI-shape chat completions endpoint the workspace already uses via
// MASKIN_FALLBACK_OPENROUTER_KEY / MASKIN_FALLBACK_BASE_URL / MASKIN_FALLBACK_SMALL_MODEL.
// Keeping this in one place ensures both callers pick up the same env var
// naming, timeout defaults, and error taxonomy.

export interface LlmCallInput {
	system: string
	user: string
	temperature?: number
	maxTokens?: number
	timeoutMs?: number
	/** When true, requests `response_format: { type: 'json_object' }`. */
	jsonMode?: boolean
	/** Optional model override; defaults to the fallback config's small model. */
	model?: string
}

export type LlmCallResult =
	| { ok: true; content: string }
	| { ok: false; reason: 'no_api_key' | 'http_error' | 'exception'; status?: number }

export class LlmCallError extends Error {
	constructor(
		readonly reason: 'no_api_key' | 'http_error' | 'exception',
		message: string,
		readonly status?: number,
	) {
		super(message)
		this.name = 'LlmCallError'
	}
}

const DEFAULT_TIMEOUT_MS = 30_000
// One retry for transient failures (request timeout, connection reset, 5xx).
// Non-retryable failures (missing key, 4xx) return immediately — a retry
// can't fix a bad request. Kept to a single retry so a stage's worst-case
// latency stays bounded (timeoutMs * 2 + RETRY_DELAY_MS) rather than
// compounding indefinitely.
const MAX_ATTEMPTS = 2
const RETRY_DELAY_MS = 400

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

function isRetryable(reason: 'http_error' | 'exception', status?: number): boolean {
	return reason === 'exception' || (status !== undefined && status >= 500)
}

export async function callLlm(input: LlmCallInput): Promise<LlmCallResult> {
	const fallback = readFallbackConfig()
	if (!fallback.apiKey) {
		logger.warn('llm-call: MASKIN_FALLBACK_OPENROUTER_KEY not set')
		return { ok: false, reason: 'no_api_key' }
	}

	const baseUrl = fallback.baseUrl ?? 'https://openrouter.ai/api'
	const model = input.model?.trim() || fallback.smallModel || fallback.model
	const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS

	const body: Record<string, unknown> = {
		model,
		messages: [
			{ role: 'system', content: input.system },
			{ role: 'user', content: input.user },
		],
		max_tokens: input.maxTokens ?? 800,
		temperature: input.temperature ?? 0.7,
	}
	if (input.jsonMode) body.response_format = { type: 'json_object' }

	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		try {
			const response = await fetch(`${baseUrl}/v1/chat/completions`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${fallback.apiKey}`,
				},
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(timeoutMs),
			})

			if (!response.ok) {
				logger.warn('llm-call: LLM API error', { status: response.status, attempt })
				if (attempt < MAX_ATTEMPTS && isRetryable('http_error', response.status)) {
					await sleep(RETRY_DELAY_MS)
					continue
				}
				return { ok: false, reason: 'http_error', status: response.status }
			}

			const data = (await response.json()) as {
				choices?: Array<{ message?: { content?: string } }>
			}
			const content = data.choices?.[0]?.message?.content?.trim() ?? ''
			// An empty completion is never a useful answer to any caller. Some
			// models emit visible chain-of-thought reasoning that shares the
			// same completion-token budget as the answer — how much they
			// "think" before answering varies per call, and can occasionally
			// consume the whole budget before any content is written. Retry
			// once rather than handing the caller a guaranteed-unparseable
			// empty string.
			if (!content && attempt < MAX_ATTEMPTS) {
				logger.warn('llm-call: empty completion content, retrying', { attempt })
				await sleep(RETRY_DELAY_MS)
				continue
			}
			return { ok: true, content }
		} catch (err) {
			logger.error('llm-call: request failed', {
				err: err instanceof Error ? err.message : String(err),
				attempt,
			})
			if (attempt < MAX_ATTEMPTS && isRetryable('exception')) {
				await sleep(RETRY_DELAY_MS)
				continue
			}
			return { ok: false, reason: 'exception' }
		}
	}
	// Unreachable — the loop always returns on its final attempt.
	return { ok: false, reason: 'exception' }
}
