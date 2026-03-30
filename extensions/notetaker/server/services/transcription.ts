import { convertToWav } from './audio-converter.js'

const WHISPER_URL = process.env.WHISPER_URL || 'http://127.0.0.1:8080'
const MAX_RETRIES = 2
const BASE_DELAY_MS = 1000
const TRANSCRIPTION_TIMEOUT_MS = 10 * 60 * 1000 // 10 minutes

export interface TranscriptionSegment {
	start: number
	end: number
	text: string
}

export interface TranscriptionResult {
	text: string
	language: string
	segments: TranscriptionSegment[]
}

function isRetryable(status: number): boolean {
	return status >= 500
}

async function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function transcribe(
	audioBuffer: Buffer,
	filename: string,
	options?: { language?: string },
): Promise<TranscriptionResult> {
	// Convert to WAV if needed — whisper.cpp only accepts WAV
	const wavBuffer = await convertToWav(audioBuffer, filename)
	const wavFilename = filename.replace(/\.[^.]+$/, '.wav')

	let lastError: Error | null = null

	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		if (attempt > 0) {
			await sleep(BASE_DELAY_MS * 2 ** (attempt - 1))
		}

		try {
			const form = new FormData()
			form.append('file', new Blob([new Uint8Array(wavBuffer)]), wavFilename)
			form.append('response_format', 'verbose_json')
			if (options?.language) {
				form.append('language', options.language)
			}

			const res = await fetch(`${WHISPER_URL}/inference`, {
				method: 'POST',
				body: form,
				signal: AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS),
			})

			if (!res.ok) {
				lastError = new Error(`Transcription failed: ${res.status}`)
				if (isRetryable(res.status) && attempt < MAX_RETRIES) {
					continue
				}
				throw lastError
			}

			const json = await res.json()
			return {
				text: json.text ?? '',
				language: json.language ?? 'unknown',
				segments: json.segments ?? [],
			}
		} catch (err) {
			if (lastError && lastError === err) {
				// Non-retryable HTTP error — already set above, rethrow
				throw lastError
			}
			lastError = err instanceof Error ? err : new Error(String(err))
			// Retry on connection errors (TypeError = network failure)
			if (err instanceof TypeError && attempt < MAX_RETRIES) {
				continue
			}
			throw lastError
		}
	}

	throw lastError ?? new Error('Transcription failed after retries')
}

export async function checkWhisperHealth(): Promise<boolean> {
	try {
		const res = await fetch(WHISPER_URL, {
			signal: AbortSignal.timeout(3000),
		})
		return res.ok
	} catch {
		return false
	}
}
