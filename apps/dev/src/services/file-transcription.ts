import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { Database } from '@maskin/db'
import { workspaceAiUsage } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { evictBillingUsage } from '../lib/billing-usage-cache'
import { logger } from '../lib/logger'
import {
	type TranscribeResult,
	type TranscriptSegment,
	readTranscriptionModel,
	transcribeAudio,
} from './transcription'

// Transcribes an uploaded audio or video file for the `transcribe_file` MCP tool.
//
// OpenRouter's upstream speech providers time out after about 60 seconds per
// request, so the file is never sent whole: ffmpeg decodes it to 16 kHz mono WAV
// (the one format the Voxtral models document) in fixed-length chunks, each chunk
// goes through the same `transcribeAudio` call chat dictation uses, and the text
// is joined in order. The spend OpenRouter reports for each chunk is recorded in
// `workspace_ai_usage`, which plan usage reads (see `getWorkspacePlanUsdCentsUsage`).

/** Longest audio a single call will transcribe. Bounds the request time and the response size. */
export const MAX_TRANSCRIBE_AUDIO_SECONDS = 60 * 60
/** One chunk is the size dictation already sends: ~5.8 MB of WAV, well inside the provider's limits. */
export const TRANSCRIBE_CHUNK_SECONDS = 180
const CHUNK_CONCURRENCY = 3
const MAX_CHUNKS = Math.ceil(MAX_TRANSCRIBE_AUDIO_SECONDS / TRANSCRIBE_CHUNK_SECONDS)
const FFMPEG_TIMEOUT_MS = 10 * 60_000
const FFPROBE_TIMEOUT_MS = 60_000
const RETRY_DELAY_MS = 800

/**
 * Used only when OpenRouter does not report `usage.cost`: above the dearest
 * transcription model it lists ($0.000075 per second), so a missing figure
 * errs toward counting the spend rather than losing it.
 */
export const FALLBACK_USD_PER_AUDIO_SECOND = 0.0001

/** 16 kHz, mono, 16-bit PCM. */
const WAV_HEADER_BYTES = 44
const WAV_BYTES_PER_SECOND = 16_000 * 2

export type FileTranscriptionFailure =
	| 'not_transcribable'
	| 'too_long'
	| 'tooling_unavailable'
	| 'not_configured'
	| 'busy'
	| 'provider_refused'
	| 'provider_error'
	| 'timeout'
	| 'storage_error'

export class FileTranscriptionError extends Error {
	constructor(
		readonly code: FileTranscriptionFailure,
		message: string,
	) {
		super(message)
		this.name = 'FileTranscriptionError'
	}
}

export interface FileTranscriptionResult {
	/**
	 * The transcript. With timed segments it is one line per speaker turn,
	 * `[mm:ss] Speaker: text`; without them it is the plain text joined in order.
	 */
	text: string
	/** True when `text` carries timestamps and speaker labels. */
	timed: boolean
	/** Seconds of audio transcribed. */
	audioSeconds: number
	chunks: number
	model: string
}

interface ProcessResult {
	stdout: string
}

/** Runs a binary with an argument array (never a shell) and a hard timeout. */
function run(command: string, args: string[], timeoutMs: number): Promise<ProcessResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
		let stdout = ''
		let stderr = ''
		child.stdout.on('data', (chunk: Buffer) => {
			if (stdout.length < 100_000) stdout += chunk.toString('utf8')
		})
		child.stderr.on('data', (chunk: Buffer) => {
			if (stderr.length < 4_000) stderr += chunk.toString('utf8')
		})
		const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
		child.on('error', (err) => {
			clearTimeout(timer)
			reject(err)
		})
		child.on('close', (code, signal) => {
			clearTimeout(timer)
			if (code === 0) return resolve({ stdout })
			const reason = signal ? `killed by ${signal} (timed out)` : `exit code ${code}`
			reject(new Error(`${command} failed: ${reason}: ${stderr.trim()}`))
		})
	})
}

function isMissingBinary(err: unknown): boolean {
	return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

const TOOLING_MESSAGE =
	'Audio extraction is not available on this server (ffmpeg is not installed). Ask the operator to install ffmpeg.'

/**
 * Reads the first audio stream and the container duration. A file with no audio
 * stream (a silent screen recording, an image renamed .mp4) is not transcribable;
 * a missing duration is allowed (some webm files omit it) and left to the
 * chunk-count limit.
 */
async function probe(inputPath: string): Promise<{ durationSeconds: number | null }> {
	let stdout: string
	try {
		;({ stdout } = await run(
			'ffprobe',
			[
				'-v',
				'error',
				'-select_streams',
				'a:0',
				'-show_entries',
				'stream=codec_type:format=duration',
				'-of',
				'json',
				inputPath,
			],
			FFPROBE_TIMEOUT_MS,
		))
	} catch (err) {
		if (isMissingBinary(err))
			throw new FileTranscriptionError('tooling_unavailable', TOOLING_MESSAGE)
		logger.warn('file-transcription: ffprobe could not read the file', {
			err: err instanceof Error ? err.message : String(err),
		})
		throw new FileTranscriptionError(
			'not_transcribable',
			'This file could not be read as audio or video. Supported: common audio and video formats such as mp3, m4a, wav, ogg, flac, webm, mp4 and mov.',
		)
	}
	let parsed: { streams?: unknown[]; format?: { duration?: string } }
	try {
		parsed = JSON.parse(stdout)
	} catch {
		parsed = {}
	}
	if (!Array.isArray(parsed.streams) || parsed.streams.length === 0) {
		throw new FileTranscriptionError(
			'not_transcribable',
			'This file has no audio track to transcribe.',
		)
	}
	const duration = Number(parsed.format?.duration)
	return { durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : null }
}

function tooLong(audioSeconds: number | null): FileTranscriptionError {
	const limit = MAX_TRANSCRIBE_AUDIO_SECONDS / 60
	const length = audioSeconds === null ? '' : ` (${Math.ceil(audioSeconds / 60)} minutes)`
	return new FileTranscriptionError(
		'too_long',
		`This file is too long to transcribe in one call${length}. The limit is ${limit} minutes of audio: cut it into shorter files and transcribe each.`,
	)
}

/** Decodes the first audio track to numbered 16 kHz mono WAV chunks and returns their paths in order. */
async function extractChunks(inputPath: string, dir: string): Promise<string[]> {
	try {
		await run(
			'ffmpeg',
			[
				'-v',
				'error',
				'-nostdin',
				'-i',
				inputPath,
				// One second past the limit, so a file over it is seen as over it.
				'-t',
				String(MAX_TRANSCRIBE_AUDIO_SECONDS + 1),
				'-map',
				'0:a:0',
				'-vn',
				'-ac',
				'1',
				'-ar',
				'16000',
				'-c:a',
				'pcm_s16le',
				'-f',
				'segment',
				'-segment_time',
				String(TRANSCRIBE_CHUNK_SECONDS),
				'-reset_timestamps',
				'1',
				join(dir, 'chunk_%04d.wav'),
			],
			FFMPEG_TIMEOUT_MS,
		)
	} catch (err) {
		if (isMissingBinary(err))
			throw new FileTranscriptionError('tooling_unavailable', TOOLING_MESSAGE)
		logger.warn('file-transcription: ffmpeg failed', {
			err: err instanceof Error ? err.message : String(err),
		})
		throw new FileTranscriptionError(
			'not_transcribable',
			'The audio in this file could not be decoded. It may be corrupt or use an unsupported codec.',
		)
	}
	return (await readdir(dir))
		.filter((name) => /^chunk_\d{4}\.wav$/.test(name))
		.sort()
		.map((name) => join(dir, name))
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

function failureFor(result: Extract<TranscribeResult, { ok: false }>): FileTranscriptionError {
	if (result.reason === 'not_configured') {
		return new FileTranscriptionError(
			'not_configured',
			'Transcription is not configured on this server.',
		)
	}
	if (result.reason === 'exception') {
		return new FileTranscriptionError('timeout', 'Transcription timed out. Try again.')
	}
	if (result.status === 429) {
		return new FileTranscriptionError('busy', 'Transcription is busy. Try again shortly.')
	}
	if (result.status === 401 || result.status === 402) {
		return new FileTranscriptionError(
			'provider_refused',
			'Transcription is not available on this server (speech provider account or key problem).',
		)
	}
	return new FileTranscriptionError(
		'provider_error',
		'Transcription failed (speech provider error).',
	)
}

function isRetryable(result: Extract<TranscribeResult, { ok: false }>): boolean {
	if (result.reason === 'exception') return true
	return (
		result.reason === 'upstream_error' && (result.status === 429 || (result.status ?? 0) >= 500)
	)
}

function formatClock(totalSeconds: number): string {
	const s = Math.floor(totalSeconds)
	const h = Math.floor(s / 3600)
	const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0')
	const ss = String(s % 60).padStart(2, '0')
	return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

/** `speaker_0` -> `Speaker 1`; labels the provider already made readable are kept. */
function speakerName(label: string): string {
	const match = /^speaker[_ -]?(\d+)$/i.exec(label)
	return match ? `Speaker ${Number(match[1]) + 1}` : label
}

/**
 * One line per speaker turn: consecutive segments by the same speaker are merged.
 * `chunkOffsets` are each chunk's start in the whole recording, because every
 * chunk's own times begin at zero.
 */
export function formatTimedTranscript(
	chunks: { offsetSeconds: number; segments: TranscriptSegment[] }[],
): string {
	const lines: { start: number; speaker: string | null; text: string }[] = []
	for (const chunk of chunks) {
		for (const seg of chunk.segments) {
			const last = lines[lines.length - 1]
			// Only a named speaker's consecutive segments are one turn; without labels every
			// segment keeps its own timestamp.
			if (last && seg.speaker !== null && last.speaker === seg.speaker) last.text += ` ${seg.text}`
			else
				lines.push({ start: chunk.offsetSeconds + seg.start, speaker: seg.speaker, text: seg.text })
		}
	}
	return lines
		.map((l) => {
			const who = l.speaker === null ? '' : `${speakerName(l.speaker)}: `
			return `[${formatClock(l.start)}] ${who}${l.text}`
		})
		.join('\n')
}

/** Seconds of audio in one of our own chunks, from its size. */
function wavSeconds(sizeBytes: number): number {
	return Math.max(0, sizeBytes - WAV_HEADER_BYTES) / WAV_BYTES_PER_SECOND
}

/** Runs `fn` over `items` with at most `limit` in flight; stops starting new items after a failure. */
async function mapPool<T, R>(
	items: T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length)
	let next = 0
	let failed = false
	const worker = async () => {
		while (!failed) {
			const index = next++
			if (index >= items.length) return
			try {
				results[index] = await fn(items[index] as T, index)
			} catch (err) {
				failed = true
				throw err
			}
		}
	}
	const settled = await Promise.allSettled(
		Array.from({ length: Math.min(limit, items.length) }, worker),
	)
	const rejected = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected')
	if (rejected) throw rejected.reason
	return results
}

export interface TranscribeStoredFileInput {
	db: Database
	storage: StorageProvider
	workspaceId: string
	actorId: string
	file: { id: string; storageKey: string }
	language?: string
}

/**
 * Transcribes one stored file. Throws `FileTranscriptionError` for every failure
 * a caller can act on. The spend of every chunk that succeeded is recorded even
 * when a later chunk fails: OpenRouter already charged it.
 */
export async function transcribeStoredFile(
	input: TranscribeStoredFileInput,
): Promise<FileTranscriptionResult> {
	const dir = await mkdtemp(join(tmpdir(), 'maskin-transcribe-'))
	const model = readTranscriptionModel()
	let costUsd = 0
	let audioSeconds = 0
	try {
		const inputPath = join(dir, 'input')
		try {
			await pipeline(
				await input.storage.getStream(input.file.storageKey),
				createWriteStream(inputPath),
			)
		} catch (err) {
			logger.error('file-transcription: could not read the file from storage', {
				fileId: input.file.id,
				err: err instanceof Error ? err.message : String(err),
			})
			throw new FileTranscriptionError('storage_error', 'The file could not be read from storage.')
		}

		const { durationSeconds } = await probe(inputPath)
		if (durationSeconds !== null && durationSeconds > MAX_TRANSCRIBE_AUDIO_SECONDS) {
			throw tooLong(durationSeconds)
		}

		const chunkDir = join(dir, 'chunks')
		await mkdir(chunkDir)
		const chunks = await extractChunks(inputPath, chunkDir)
		if (chunks.length === 0) {
			throw new FileTranscriptionError('not_transcribable', 'This file has no audio to transcribe.')
		}
		if (chunks.length > MAX_CHUNKS) throw tooLong(durationSeconds)

		// Speakers and timestamps are requested first. A model that refuses (a 400) is
		// stepped down to timestamps only, then to plain text, rather than failing the file.
		let detail: 'speakers' | 'timestamps' | undefined = 'speakers'
		const parts = await mapPool(chunks, CHUNK_CONCURRENCY, async (chunkPath, index) => {
			const bytes = await readFile(chunkPath)
			const audioBase64 = bytes.toString('base64')
			for (let attempt = 1; ; attempt++) {
				// Chunks run concurrently, so what THIS request asked for decides the step
				// down: another chunk may already have lowered the shared level.
				const asked = detail
				const result = await transcribeAudio({
					audioBase64,
					language: input.language,
					detail: asked,
				})
				if (!result.ok && asked && result.reason === 'upstream_error' && result.status === 400) {
					const next = asked === 'speakers' ? 'timestamps' : undefined
					logger.warn('file-transcription: the model refused the request, stepping down', {
						fileId: input.file.id,
						model,
						from: asked,
						to: next ?? 'plain text',
					})
					if (detail === asked) detail = next
					attempt--
					continue
				}
				if (result.ok) {
					const seconds = result.audioSeconds ?? wavSeconds(bytes.byteLength)
					if (result.costUsd === null) {
						logger.warn('file-transcription: provider reported no cost, using the fallback rate', {
							fileId: input.file.id,
							model: result.model,
						})
					}
					costUsd += result.costUsd ?? seconds * FALLBACK_USD_PER_AUDIO_SECOND
					audioSeconds += seconds
					return {
						text: result.text,
						segments: result.segments ?? [],
						offsetSeconds: index * TRANSCRIBE_CHUNK_SECONDS,
					}
				}
				if (attempt >= 2 || !isRetryable(result)) throw failureFor(result)
				await sleep(RETRY_DELAY_MS)
			}
		})

		const timed = parts.some((p) => p.segments.length > 0)
		const plain = parts
			.map((p) => p.text)
			.filter((t) => t.length > 0)
			.join(' ')
		let text = plain
		if (timed) {
			text = formatTimedTranscript(parts)
			if (chunks.length > 1 && parts.some((p) => p.segments.some((s) => s.speaker !== null))) {
				text = `Note: speaker numbers were assigned separately for each ${TRANSCRIBE_CHUNK_SECONDS / 60}-minute section, so "Speaker 1" in one section may not be the same person in another.\n\n${text}`
			}
		}

		return {
			text,
			timed,
			audioSeconds,
			chunks: chunks.length,
			model,
		}
	} finally {
		await rm(dir, { recursive: true, force: true }).catch((err) => {
			logger.warn('file-transcription: could not remove the temp directory', {
				dir,
				err: err instanceof Error ? err.message : String(err),
			})
		})
		await recordTranscriptionUsage(input, { model, costUsd, audioSeconds })
	}
}

/**
 * One `workspace_ai_usage` row for the call. Never throws: the transcript is
 * already paid for, so a failed write is logged loudly (with the figures, so the
 * spend can be recovered from the log) rather than turned into a failed call.
 */
async function recordTranscriptionUsage(
	input: TranscribeStoredFileInput,
	usage: { model: string; costUsd: number; audioSeconds: number },
): Promise<void> {
	if (usage.costUsd <= 0 && usage.audioSeconds <= 0) return
	try {
		await input.db.insert(workspaceAiUsage).values({
			workspaceId: input.workspaceId,
			actorId: input.actorId,
			kind: 'transcription',
			model: usage.model,
			costUsd: usage.costUsd.toFixed(6),
			audioSeconds: usage.audioSeconds.toFixed(2),
			fileId: input.file.id,
		})
		evictBillingUsage(input.workspaceId)
	} catch (err) {
		logger.error('transcription_usage_record_failed', {
			workspaceId: input.workspaceId,
			actorId: input.actorId,
			fileId: input.file.id,
			model: usage.model,
			costUsd: usage.costUsd,
			audioSeconds: usage.audioSeconds,
			err: err instanceof Error ? err.message : String(err),
		})
	}
}
