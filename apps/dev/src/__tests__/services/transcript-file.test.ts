import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { recordEvent } from '../../lib/events/record-event'
import {
	TRANSCRIPT_PREVIEW_CHARS,
	saveTranscriptFile,
	transcriptFileName,
	transcriptPreview,
} from '../../services/transcript-file'
import { buildFile } from '../factories'
import { createMockStorageProvider, createTestContext } from '../setup'

vi.mock('../../lib/events/record-event', () => ({ recordEvent: vi.fn() }))

const workspaceId = randomUUID()

function params(overrides: Record<string, unknown> = {}) {
	const { db, mockResults, calls } = createTestContext()
	const storage = createMockStorageProvider()
	mockResults.insert = [buildFile({ workspaceId })]
	return {
		mockResults,
		calls,
		storage,
		args: {
			db,
			storage,
			workspaceId,
			actorId: 'actor-1',
			sessionId: 'session-1',
			sourceName: 'standup.mp4',
			text: 'Good morning everyone.',
			...overrides,
		},
	}
}

describe('transcriptFileName', () => {
	it('swaps the recording extension for "transcript.txt"', () => {
		expect(transcriptFileName('standup.mp4')).toBe('standup transcript.txt')
	})

	it('keeps a name that has no extension', () => {
		expect(transcriptFileName('voice memo')).toBe('voice memo transcript.txt')
	})

	it('only drops the last extension', () => {
		expect(transcriptFileName('2026-02-09 20-42-10.v2.mov')).toBe(
			'2026-02-09 20-42-10.v2 transcript.txt',
		)
	})

	it('stays within the file name limit', () => {
		expect(transcriptFileName(`${'a'.repeat(500)}.mp3`).length).toBeLessThanOrEqual(200)
	})
})

describe('transcriptPreview', () => {
	it('returns a short transcript whole', () => {
		expect(transcriptPreview('Hi there.')).toBe('Hi there.')
	})

	it('cuts a long transcript on a word boundary and marks the cut', () => {
		const preview = transcriptPreview('word '.repeat(5000))
		expect(preview.length).toBeLessThanOrEqual(TRANSCRIPT_PREVIEW_CHARS + 1)
		expect(preview.endsWith('word…')).toBe(true)
	})
})

describe('saveTranscriptFile', () => {
	beforeEach(() => {
		vi.mocked(recordEvent).mockReset()
		vi.mocked(recordEvent).mockResolvedValue(undefined as never)
	})

	it('writes a text/plain file row, its bytes and a created event', async () => {
		const { args, storage, calls } = params()

		const saved = await saveTranscriptFile(args as never)

		expect(saved).toMatchObject({ name: 'standup transcript.txt' })
		expect(saved?.url).toContain(`/${workspaceId}/files/${saved?.fileId}`)
		expect(calls.inserts[0]).toMatchObject({
			id: saved?.fileId,
			workspaceId,
			name: 'standup transcript.txt',
			mimeType: 'text/plain',
			tags: ['transcript'],
			sizeBytes: Buffer.byteLength('Good morning everyone.'),
			createdBy: 'actor-1',
		})
		expect(storage.put).toHaveBeenCalledWith(
			expect.stringContaining(saved?.fileId as string),
			Buffer.from('Good morning everyone.'),
		)
		expect(recordEvent).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				action: 'created',
				entityType: 'file',
				entityId: saved?.fileId,
				provenance: { sessionId: 'session-1', entityKind: 'file' },
			}),
		)
	})

	it('saves a transcript of any length, with no size threshold', async () => {
		const { args, storage } = params({ text: 'a' })

		expect(await saveTranscriptFile(args as never)).not.toBeNull()
		expect(storage.put).toHaveBeenCalledTimes(1)
	})

	it('returns null, without an audit event, when the bytes cannot be stored', async () => {
		const { args, storage } = params()
		vi.mocked(storage.put).mockRejectedValue(new Error('s3 down'))

		const saved = await saveTranscriptFile(args as never)

		expect(saved).toBeNull()
		expect(recordEvent).not.toHaveBeenCalled()
	})

	it('returns null when the row cannot be inserted', async () => {
		const { args, storage, mockResults } = params()
		mockResults.insertError = new Error('db down')

		expect(await saveTranscriptFile(args as never)).toBeNull()
		expect(storage.put).not.toHaveBeenCalled()
	})

	it('still returns the saved file when the audit event fails', async () => {
		const { args } = params()
		vi.mocked(recordEvent).mockRejectedValue(new Error('events down'))

		expect(await saveTranscriptFile(args as never)).not.toBeNull()
	})
})
