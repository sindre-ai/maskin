import { convertToWav, splitWavIntoChunks } from './audio-converter.js'

const WHISPER_URL = process.env.WHISPER_URL || 'http://127.0.0.1:8080'
const MAX_RETRIES = 2
const BASE_DELAY_MS = 1000
const CHUNK_TIMEOUT_MS = 10 * 60 * 1000 // 10 minutes per chunk
const CHUNK_DURATION_SECONDS = 5 * 60 // 5 minutes

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

/** Transcribe a single WAV buffer via whisper.cpp with retries. */
async function transcribeChunk(
	wavBuffer: Buffer,
	filename: string,
	options?: { language?: string },
): Promise<TranscriptionResult> {
	let lastError: Error | null = null

	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		if (attempt > 0) {
			await sleep(BASE_DELAY_MS * 2 ** (attempt - 1))
		}

		try {
			const form = new FormData()
			form.append('file', new Blob([new Uint8Array(wavBuffer)]), filename)
			form.append('response_format', 'verbose_json')
			if (options?.language) {
				form.append('language', options.language)
			}

			const res = await fetch(`${WHISPER_URL}/inference`, {
				method: 'POST',
				body: form,
				signal: AbortSignal.timeout(CHUNK_TIMEOUT_MS),
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
				throw lastError
			}
			lastError = err instanceof Error ? err : new Error(String(err))
			if (err instanceof TypeError && attempt < MAX_RETRIES) {
				continue
			}
			throw lastError
		}
	}

	throw lastError ?? new Error('Transcription failed after retries')
}

/**
 * Transcribe audio of any format and length.
 * Converts to WAV, splits into 30-min chunks if needed,
 * transcribes each chunk, and merges the results.
 */
export async function transcribe(
	audioBuffer: Buffer,
	filename: string,
	options?: { language?: string },
): Promise<TranscriptionResult> {
	const wavBuffer = await convertToWav(audioBuffer, filename)
	const wavFilename = filename.replace(/\.[^.]+$/, '.wav')

	const chunks = await splitWavIntoChunks(wavBuffer, CHUNK_DURATION_SECONDS)

	if (chunks.length === 1) {
		return transcribeChunk(chunks[0]!.buffer, wavFilename, options)
	}

	// Transcribe chunks sequentially to avoid overloading whisper
	const results: Array<{ result: TranscriptionResult; offsetSeconds: number }> = []
	for (const chunk of chunks) {
		const result = await transcribeChunk(chunk.buffer, wavFilename, options)
		results.push({ result, offsetSeconds: chunk.offsetSeconds })
	}

	// Merge results with adjusted timestamps
	const allSegments: TranscriptionSegment[] = []
	const textParts: string[] = []
	let language = 'unknown'

	for (const { result, offsetSeconds } of results) {
		if (language === 'unknown' && result.language !== 'unknown') {
			language = result.language
		}
		textParts.push(result.text)
		for (const seg of result.segments) {
			allSegments.push({
				start: seg.start + offsetSeconds,
				end: seg.end + offsetSeconds,
				text: seg.text,
			})
		}
	}

	return {
		text: textParts.join('\n'),
		language,
		segments: allSegments,
	}
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
