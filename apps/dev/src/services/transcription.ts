import { readFallbackConfig } from '../lib/llm-routing'
import { logger } from '../lib/logger'

// One-shot speech-to-text for chat dictation, via OpenRouter's
// /v1/audio/transcriptions endpoint. Billed to the operator's OpenRouter
// account (MASKIN_FALLBACK_OPENROUTER_KEY), the same one `callLlm` uses.

/** Voxtral Small and Mini are priced within ~15% of each other; Small is the more accurate. */
export const DEFAULT_TRANSCRIPTION_MODEL = 'mistralai/voxtral-small-transcribe-3-0'

const TIMEOUT_MS = 60_000

export type TranscribeResult =
	| { ok: true; text: string; model: string }
	| { ok: false; reason: 'not_configured' | 'upstream_error' | 'exception'; status?: number }

export function readTranscriptionModel(env: NodeJS.ProcessEnv = process.env): string {
	return env.MASKIN_TRANSCRIPTION_MODEL?.trim() || DEFAULT_TRANSCRIPTION_MODEL
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
	const body: Record<string, unknown> = {
		model,
		input_audio: { data: input.audioBase64, format: 'wav' },
	}
	if (input.language) body.language = input.language

	try {
		const response = await fetch(`${fallback.baseUrl}/v1/audio/transcriptions`, {
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
		const data = (await response.json()) as { text?: unknown }
		const text = typeof data.text === 'string' ? data.text.trim() : ''
		return { ok: true, text, model }
	} catch (err) {
		logger.error('transcription: request failed', {
			err: err instanceof Error ? err.message : String(err),
			model,
		})
		return { ok: false, reason: 'exception' }
	}
}
