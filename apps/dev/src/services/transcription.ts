import { readFallbackConfig } from '../lib/llm-routing'
import { logger } from '../lib/logger'

// One-shot speech-to-text for chat dictation, via OpenRouter's
// /v1/audio/transcriptions endpoint. Billed to the operator's OpenRouter
// account (MASKIN_FALLBACK_OPENROUTER_KEY), the same one `callLlm` uses.

/** Voxtral Small and Mini are priced within ~15% of each other; Small is the more accurate. */
export const DEFAULT_TRANSCRIPTION_MODEL = 'mistralai/voxtral-small-transcribe-3-0'

const TIMEOUT_MS = 60_000

export type TranscribeResult =
	| {
			ok: true
			text: string
			model: string
			/** What OpenRouter charged for this request (`usage.cost`); null when it did not say. */
			costUsd: number | null
			/** Seconds of audio OpenRouter measured (`usage.seconds`); null when it did not say. */
			audioSeconds: number | null
	  }
	| { ok: false; reason: 'not_configured' | 'upstream_error' | 'exception'; status?: number }

/** A finite, non-negative number, else null: `usage` is the provider's, so it is checked. */
function readUsageNumber(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

export function readTranscriptionModel(env: NodeJS.ProcessEnv = process.env): string {
	return env.MASKIN_TRANSCRIPTION_MODEL?.trim() || DEFAULT_TRANSCRIPTION_MODEL
}

/**
 * Speech goes to MASKIN_TRANSCRIPTION_BASE_URL when set, otherwise the shared
 * OpenRouter base. Point it at https://eu.openrouter.ai/api to keep audio in
 * OpenRouter's EU in-region routing (Business/Enterprise plan; fails closed
 * rather than leaving the region) without moving the rest of the LLM traffic.
 */
export function readTranscriptionBaseUrl(
	fallbackBaseUrl: string,
	env: NodeJS.ProcessEnv = process.env,
): string {
	return (env.MASKIN_TRANSCRIPTION_BASE_URL?.trim() || fallbackBaseUrl).replace(/\/+$/, '')
}

export async function transcribeAudio(input: {
	/** Base64 of a WAV file — the only input format OpenRouter documents for these models. */
	audioBase64: string
	/** BCP-47 / ISO-639-1 hint; omitted lets the model detect the language. */
	language?: string
}): Promise<TranscribeResult> {
	const fallback = readFallbackConfig()
	if (!fallback.apiKey) {
		logger.warn('transcription: MASKIN_FALLBACK_OPENROUTER_KEY not set')
		return { ok: false, reason: 'not_configured' }
	}

	const model = readTranscriptionModel()
	const baseUrl = readTranscriptionBaseUrl(fallback.baseUrl ?? 'https://openrouter.ai/api')
	const body: Record<string, unknown> = {
		model,
		input_audio: { data: input.audioBase64, format: 'wav' },
	}
	if (input.language) body.language = input.language

	try {
		const response = await fetch(`${baseUrl}/v1/audio/transcriptions`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${fallback.apiKey}`,
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(TIMEOUT_MS),
		})
		if (!response.ok) {
			logger.warn('transcription: upstream error', {
				status: response.status,
				model,
				body: (await response.text().catch(() => '')).slice(0, 500),
			})
			return { ok: false, reason: 'upstream_error', status: response.status }
		}
		const data = (await response.json()) as {
			text?: unknown
			usage?: { cost?: unknown; seconds?: unknown } | null
		}
		const text = typeof data.text === 'string' ? data.text.trim() : ''
		return {
			ok: true,
			text,
			model,
			costUsd: readUsageNumber(data.usage?.cost),
			audioSeconds: readUsageNumber(data.usage?.seconds),
		}
	} catch (err) {
		logger.error('transcription: request failed', {
			err: err instanceof Error ? err.message : String(err),
			model,
		})
		return { ok: false, reason: 'exception' }
	}
}
