import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Readable } from 'node:stream'
import type { Database } from '@maskin/db'
import type { StorageProvider } from '@maskin/storage'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
	FALLBACK_USD_PER_AUDIO_SECOND,
	FileTranscriptionError,
	MAX_TRANSCRIBE_AUDIO_SECONDS,
	TRANSCRIBE_CHUNK_SECONDS,
	formatTimedTranscript,
	transcribeStoredFile,
} from '../../services/file-transcription'
import { transcribeAudio } from '../../services/transcription'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))
vi.mock('../../services/transcription', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../services/transcription')>()),
	transcribeAudio: vi.fn(),
}))
vi.mock('../../lib/billing-usage-cache', () => ({ evictBillingUsage: vi.fn() }))

type Run = { stdout?: string; error?: NodeJS.ErrnoException }

/** Stands in for ffprobe and ffmpeg. `onRun` may write the files ffmpeg would. */
function fakeBinaries(onRun: (command: string, args: string[]) => Run | Promise<Run>) {
	vi.mocked(spawn).mockImplementation(((command: string, args: string[]) => {
		const child = new EventEmitter() as EventEmitter & {
			stdout: EventEmitter
			stderr: EventEmitter
			kill: () => void
		}
		child.stdout = new EventEmitter()
		child.stderr = new EventEmitter()
		child.kill = vi.fn()
		void (async () => {
			const run = await onRun(command, args)
			if (run.error) return child.emit('error', run.error)
			if (run.stdout) child.stdout.emit('data', Buffer.from(run.stdout))
			child.emit('close', 0, null)
		})()
		return child
	}) as unknown as typeof spawn)
}

const PROBE_OK = (seconds = 600) =>
	JSON.stringify({ streams: [{ codec_type: 'audio' }], format: { duration: String(seconds) } })

/** ffmpeg that writes `count` chunks; chunk N holds the bytes `chunk-N` so a call can be told apart. */
function ffmpegWithChunks(count: number, probe = PROBE_OK()) {
	const dirs: string[] = []
	fakeBinaries(async (command, args) => {
		if (command === 'ffprobe') return { stdout: probe }
		const dir = dirname(args[args.length - 1] as string)
		dirs.push(dir)
		for (let i = 0; i < count; i++) {
			await writeFile(`${dir}/chunk_${String(i).padStart(4, '0')}.wav`, `chunk-${i}`)
		}
		return {}
	})
	return dirs
}

function ok(text: string, costUsd: number | null = 0.001, audioSeconds: number | null = 180) {
	return { ok: true as const, text, model: 'test/voxtral', costUsd, audioSeconds }
}

const chunkOf = (audioBase64: string) => Buffer.from(audioBase64, 'base64').toString()

describe('transcribeStoredFile', () => {
	const insertValues = vi.fn()
	const db = { insert: vi.fn(() => ({ values: insertValues })) } as unknown as Database
	const storage = {
		getStream: vi.fn(async () => Readable.from(Buffer.from('media bytes'))),
	} as unknown as StorageProvider
	const input = {
		db,
		storage,
		workspaceId: 'ws-1',
		actorId: 'actor-1',
		file: { id: 'file-1', storageKey: 'workspaces/ws-1/files/file-1' },
	}

	beforeEach(() => {
		vi.mocked(spawn).mockReset()
		vi.mocked(transcribeAudio).mockReset()
		insertValues.mockReset().mockResolvedValue(undefined)
		vi.mocked(db.insert).mockClear()
		vi.mocked(storage.getStream).mockClear()
	})

	it('joins the chunk texts in order and records one usage row with the cost OpenRouter reported', async () => {
		ffmpegWithChunks(3)
		vi.mocked(transcribeAudio).mockImplementation(async ({ audioBase64 }) => {
			const chunk = chunkOf(audioBase64)
			// The later chunks answer first, so order has to come from position, not arrival.
			if (chunk === 'chunk-0') await new Promise((r) => setTimeout(r, 30))
			return ok({ 'chunk-0': 'one', 'chunk-1': 'two', 'chunk-2': 'three' }[chunk] as string)
		})

		const result = await transcribeStoredFile(input)

		expect(result.text).toBe('one two three')
		expect(result.chunks).toBe(3)
		expect(result.audioSeconds).toBe(540)
		expect(insertValues).toHaveBeenCalledTimes(1)
		expect(insertValues).toHaveBeenCalledWith({
			workspaceId: 'ws-1',
			actorId: 'actor-1',
			kind: 'transcription',
			model: expect.any(String),
			costUsd: '0.003000',
			audioSeconds: '540.00',
			fileId: 'file-1',
		})
	})

	it('asks for diarized output and writes speaker turns with timestamps offset per chunk', async () => {
		ffmpegWithChunks(2)
		vi.mocked(transcribeAudio).mockImplementation(async ({ audioBase64 }) => {
			const first = chunkOf(audioBase64) === 'chunk-0'
			return {
				...ok(first ? 'Hi. Hello.' : 'Bye.'),
				segments: first
					? [
							{ start: 0, end: 2, text: 'Hi.', speaker: 'speaker_0' },
							{ start: 2, end: 4, text: 'Hello.', speaker: 'speaker_1' },
						]
					: [{ start: 5, end: 6, text: 'Bye.', speaker: 'speaker_0' }],
			}
		})

		const result = await transcribeStoredFile(input)

		expect(vi.mocked(transcribeAudio).mock.calls[0]?.[0]).toMatchObject({ detail: 'speakers' })
		expect(result.timed).toBe(true)
		expect(result.text).toContain(
			'[00:00] Speaker 1: Hi.\n[00:02] Speaker 2: Hello.\n[03:05] Speaker 1: Bye.',
		)
		expect(result.text).toContain('assigned separately')
	})

	it('keeps timestamps, without speakers, when the model refuses only speaker labels', async () => {
		ffmpegWithChunks(2)
		vi.mocked(transcribeAudio).mockImplementation(async ({ detail }) =>
			detail === 'speakers'
				? { ok: false as const, reason: 'upstream_error' as const, status: 400 }
				: {
						...ok('Hi.'),
						segments: [{ start: 2, end: 3, text: 'Hi.', speaker: null }],
					},
		)

		const result = await transcribeStoredFile(input)

		expect(result.timed).toBe(true)
		expect(result.text).toBe('[00:02] Hi.\n[03:02] Hi.')
	})

	it('falls back to plain text when the model refuses timestamps too', async () => {
		ffmpegWithChunks(3)
		vi.mocked(transcribeAudio).mockImplementation(async ({ detail }) =>
			detail ? { ok: false as const, reason: 'upstream_error' as const, status: 400 } : ok('plain'),
		)

		const result = await transcribeStoredFile(input)

		expect(result.text).toBe('plain plain plain')
		expect(result.timed).toBe(false)
	})

	it('drops chunks with no speech instead of leaving gaps in the text', async () => {
		ffmpegWithChunks(3)
		vi.mocked(transcribeAudio).mockImplementation(async ({ audioBase64 }) =>
			ok(chunkOf(audioBase64) === 'chunk-1' ? '' : 'speech'),
		)

		const result = await transcribeStoredFile(input)

		expect(result.text).toBe('speech speech')
	})

	it('still records the spend of the chunks that succeeded when a later one fails', async () => {
		ffmpegWithChunks(3)
		vi.mocked(transcribeAudio).mockImplementation(async ({ audioBase64 }) =>
			chunkOf(audioBase64) === 'chunk-1'
				? { ok: false, reason: 'upstream_error', status: 401 }
				: ok('fine'),
		)

		await expect(transcribeStoredFile(input)).rejects.toMatchObject({ code: 'provider_refused' })

		expect(insertValues).toHaveBeenCalledTimes(1)
		expect(insertValues).toHaveBeenCalledWith(
			expect.objectContaining({ costUsd: '0.002000', audioSeconds: '360.00' }),
		)
	})

	it('retries a rate-limited chunk once and bills only the request that succeeded', async () => {
		ffmpegWithChunks(1)
		vi.mocked(transcribeAudio)
			.mockResolvedValueOnce({ ok: false, reason: 'upstream_error', status: 429 })
			.mockResolvedValueOnce(ok('after the retry'))

		const result = await transcribeStoredFile(input)

		expect(result.text).toBe('after the retry')
		expect(transcribeAudio).toHaveBeenCalledTimes(2)
		expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ costUsd: '0.001000' }))
	})

	it('gives up after the retry and reports the provider as busy', async () => {
		ffmpegWithChunks(1)
		vi.mocked(transcribeAudio).mockResolvedValue({
			ok: false,
			reason: 'upstream_error',
			status: 429,
		})

		await expect(transcribeStoredFile(input)).rejects.toMatchObject({ code: 'busy' })

		expect(transcribeAudio).toHaveBeenCalledTimes(2)
		// Nothing succeeded, so nothing was charged and no row is written.
		expect(insertValues).not.toHaveBeenCalled()
	})

	it('counts a chunk at the fallback rate when OpenRouter reports no cost', async () => {
		ffmpegWithChunks(1)
		vi.mocked(transcribeAudio).mockResolvedValue(ok('hello', null, 10))

		await transcribeStoredFile(input)

		const cost = (10 * FALLBACK_USD_PER_AUDIO_SECOND).toFixed(6)
		expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ costUsd: cost }))
	})

	it('measures a chunk from its size when OpenRouter reports no seconds', async () => {
		ffmpegWithChunks(1)
		vi.mocked(transcribeAudio).mockResolvedValue(ok('hello', 0.001, null))

		const result = await transcribeStoredFile(input)

		// The fake chunk is 7 bytes, under a WAV header, so it measures as zero seconds.
		expect(result.audioSeconds).toBe(0)
	})

	it('still returns the transcript when the usage row cannot be written', async () => {
		ffmpegWithChunks(1)
		vi.mocked(transcribeAudio).mockResolvedValue(ok('paid for'))
		insertValues.mockRejectedValue(new Error('db down'))

		const result = await transcribeStoredFile(input)

		expect(result.text).toBe('paid for')
	})

	it('refuses a file with no audio track and charges nothing', async () => {
		fakeBinaries(async () => ({
			stdout: JSON.stringify({ streams: [], format: { duration: '5' } }),
		}))

		await expect(transcribeStoredFile(input)).rejects.toMatchObject({ code: 'not_transcribable' })

		expect(transcribeAudio).not.toHaveBeenCalled()
		expect(insertValues).not.toHaveBeenCalled()
	})

	it('refuses audio over the limit before extracting any of it', async () => {
		const over = MAX_TRANSCRIBE_AUDIO_SECONDS + 1
		const dirs = ffmpegWithChunks(1, PROBE_OK(over))

		await expect(transcribeStoredFile(input)).rejects.toMatchObject({ code: 'too_long' })

		expect(dirs).toHaveLength(0)
		expect(transcribeAudio).not.toHaveBeenCalled()
	})

	it('refuses a file whose length is unknown but which decodes to more chunks than the limit allows', async () => {
		const limit = Math.ceil(MAX_TRANSCRIBE_AUDIO_SECONDS / TRANSCRIBE_CHUNK_SECONDS)
		ffmpegWithChunks(limit + 1, JSON.stringify({ streams: [{ codec_type: 'audio' }], format: {} }))

		await expect(transcribeStoredFile(input)).rejects.toMatchObject({ code: 'too_long' })

		expect(transcribeAudio).not.toHaveBeenCalled()
	})

	it('says so when ffmpeg is not installed', async () => {
		fakeBinaries(async () => ({
			error: Object.assign(new Error('spawn ffprobe'), { code: 'ENOENT' }),
		}))

		const err = await transcribeStoredFile(input).catch((e) => e)

		expect(err).toBeInstanceOf(FileTranscriptionError)
		expect(err.code).toBe('tooling_unavailable')
		expect(err.message).toMatch(/ffmpeg is not installed/)
	})

	it('reports an unreadable storage object as a storage error', async () => {
		vi.mocked(storage.getStream).mockRejectedValueOnce(new Error('NoSuchKey'))

		await expect(transcribeStoredFile(input)).rejects.toMatchObject({ code: 'storage_error' })

		expect(spawn).not.toHaveBeenCalled()
	})

	it('removes its temp directory whether the call succeeds or fails', async () => {
		const dirs = ffmpegWithChunks(1)
		vi.mocked(transcribeAudio).mockResolvedValueOnce(ok('done'))
		await transcribeStoredFile(input)

		vi.mocked(transcribeAudio).mockResolvedValueOnce({
			ok: false,
			reason: 'upstream_error',
			status: 401,
		})
		await transcribeStoredFile(input).catch(() => {})

		expect(dirs).toHaveLength(2)
		for (const dir of dirs) expect(existsSync(dirname(dir))).toBe(false)
	})

	it('runs the binaries with an argument array and never a path built from the file name', async () => {
		ffmpegWithChunks(1)
		vi.mocked(transcribeAudio).mockResolvedValue(ok('x'))

		await transcribeStoredFile({ ...input, file: { ...input.file, id: '; rm -rf /' } })

		for (const call of vi.mocked(spawn).mock.calls) {
			expect(Array.isArray(call[1])).toBe(true)
			expect(call[2]).not.toHaveProperty('shell')
			expect(JSON.stringify(call[1])).not.toContain('rm -rf')
		}
	})
})

describe('formatTimedTranscript', () => {
	it('merges consecutive segments by one speaker and uses h:mm:ss past an hour', () => {
		const text = formatTimedTranscript([
			{
				offsetSeconds: 3600,
				segments: [
					{ start: 1, end: 2, text: 'One.', speaker: 'speaker_0' },
					{ start: 2, end: 3, text: 'Two.', speaker: 'speaker_0' },
				],
			},
		])

		expect(text).toBe('[1:00:01] Speaker 1: One. Two.')
	})

	it('gives every segment its own timestamp when the model labelled no speakers', () => {
		expect(
			formatTimedTranscript([
				{
					offsetSeconds: 0,
					segments: [
						{ start: 65, end: 66, text: 'Hi.', speaker: null },
						{ start: 70, end: 72, text: 'Hello.', speaker: null },
					],
				},
			]),
		).toBe('[01:05] Hi.\n[01:10] Hello.')
	})
})
