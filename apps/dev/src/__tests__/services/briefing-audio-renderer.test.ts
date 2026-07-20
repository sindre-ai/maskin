import { Readable } from 'node:stream'
import type { StorageProvider } from '@maskin/storage'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
	BRIEFING_AUDIO_FILE_NAME,
	BRIEFING_AUDIO_MIME_TYPE,
	BRIEFING_AUDIO_RELATIONSHIP_TYPE,
	briefingAudioStorageKey,
	renderBriefingAudio,
} from '../../services/briefing-audio-renderer'
import { createTestContext } from '../setup'

class InMemoryStorage implements StorageProvider {
	public puts: { key: string; bytes: Buffer }[] = []
	public deletes: string[] = []
	private objects = new Map<string, Buffer>()
	private putShouldFail = false

	failNextPut() {
		this.putShouldFail = true
	}

	async put(key: string, data: Buffer | Uint8Array | Readable): Promise<void> {
		if (this.putShouldFail) {
			this.putShouldFail = false
			throw new Error('simulated S3 put failure')
		}
		if (data instanceof Readable) throw new Error('Readable not exercised by this test')
		const buf = Buffer.from(data)
		this.puts.push({ key, bytes: buf })
		this.objects.set(key, buf)
	}
	async get(key: string): Promise<Buffer> {
		const v = this.objects.get(key)
		if (!v) throw new Error(`Missing key: ${key}`)
		return v
	}
	async list(prefix: string): Promise<string[]> {
		return [...this.objects.keys()].filter((k) => k.startsWith(prefix))
	}
	async listWithMetadata(prefix: string) {
		return [...this.objects.entries()]
			.filter(([k]) => k.startsWith(prefix))
			.map(([key, v]) => ({ key, size: v.byteLength }))
	}
	async delete(key: string): Promise<void> {
		this.deletes.push(key)
		this.objects.delete(key)
	}
	async exists(key: string): Promise<boolean> {
		return this.objects.has(key)
	}
	async ensureBucket(): Promise<void> {}
}

describe('renderBriefingAudio', () => {
	const workspaceId = '11111111-1111-1111-1111-111111111111'
	const briefingId = '22222222-2222-2222-2222-222222222222'
	const actorId = '33333333-3333-3333-3333-333333333333'
	let storage: InMemoryStorage
	let fetchTts: ReturnType<typeof vi.fn>

	beforeEach(() => {
		storage = new InMemoryStorage()
		fetchTts = vi.fn().mockResolvedValue(Buffer.from('MP3-BYTES'))
	})

	it('renders, uploads, and attaches the audio file to the briefing', async () => {
		const { db, mockResults, calls } = createTestContext()
		mockResults.selectQueue = [
			[], // existing attached-file check → none
			[{ content: 'Today: Sebk shipped audio.', workspaceId }], // briefing lookup
		]
		mockResults.insert = []

		const result = await renderBriefingAudio(
			{ db, storage, getApiKey: () => 'sk-test', fetchTts },
			{ workspaceId, briefingId, actorId },
		)

		expect(result.status).toBe('rendered')
		if (result.status !== 'rendered') throw new Error('narrow')
		expect(fetchTts).toHaveBeenCalledOnce()
		expect(fetchTts.mock.calls[0][0].text).toBe('Today: Sebk shipped audio.')
		expect(fetchTts.mock.calls[0][0].apiKey).toBe('sk-test')
		// Bytes uploaded to the deterministic per-briefing key.
		expect(storage.puts).toHaveLength(1)
		expect(storage.puts[0].key).toBe(briefingAudioStorageKey(workspaceId, briefingId))
		// Three inserts: files row, relationships row, audit event.
		expect(calls.inserts).toHaveLength(3)
		const [fileRow, relRow, eventRow] = calls.inserts as Array<Record<string, unknown>>
		expect(fileRow.name).toBe(BRIEFING_AUDIO_FILE_NAME)
		expect(fileRow.mimeType).toBe(BRIEFING_AUDIO_MIME_TYPE)
		expect(fileRow.sizeBytes).toBe(Buffer.from('MP3-BYTES').byteLength)
		expect(fileRow.storageKey).toBe(briefingAudioStorageKey(workspaceId, briefingId))
		expect(fileRow.createdBy).toBe(actorId)
		expect(relRow.sourceType).toBe('object')
		expect(relRow.sourceId).toBe(briefingId)
		expect(relRow.targetType).toBe('file')
		expect(relRow.targetId).toBe(result.fileId)
		expect(relRow.type).toBe(BRIEFING_AUDIO_RELATIONSHIP_TYPE)
		expect(eventRow.entityType).toBe('file')
		expect(eventRow.entityId).toBe(result.fileId)
	})

	it('short-circuits if the briefing already has an attached audio file', async () => {
		const { db, mockResults } = createTestContext()
		mockResults.selectQueue = [
			[{ targetId: 'existing-file-id' }], // existing attached-file check
		]

		const result = await renderBriefingAudio(
			{ db, storage, getApiKey: () => 'sk-test', fetchTts },
			{ workspaceId, briefingId, actorId },
		)

		expect(result).toEqual({ status: 'already_attached', fileId: 'existing-file-id' })
		expect(fetchTts).not.toHaveBeenCalled()
		expect(storage.puts).toHaveLength(0)
	})

	it('throws a clear error when OPENAI_API_KEY is missing', async () => {
		const { db, mockResults } = createTestContext()
		mockResults.selectQueue = [
			[], // no existing attachment
			[{ content: 'Some briefing text', workspaceId }],
		]

		await expect(
			renderBriefingAudio(
				{ db, storage, getApiKey: () => undefined, fetchTts },
				{ workspaceId, briefingId, actorId },
			),
		).rejects.toThrow(/OPENAI_API_KEY/)
		expect(fetchTts).not.toHaveBeenCalled()
		expect(storage.puts).toHaveLength(0)
	})

	it('skips when the briefing has no content', async () => {
		const { db, mockResults } = createTestContext()
		mockResults.selectQueue = [[], [{ content: '  ', workspaceId }]]

		const result = await renderBriefingAudio(
			{ db, storage, getApiKey: () => 'sk-test', fetchTts },
			{ workspaceId, briefingId, actorId },
		)

		expect(result).toEqual({ status: 'skipped', reason: 'empty_content' })
		expect(fetchTts).not.toHaveBeenCalled()
	})

	it('skips when the briefing object is not found', async () => {
		const { db, mockResults } = createTestContext()
		mockResults.selectQueue = [[], []]

		const result = await renderBriefingAudio(
			{ db, storage, getApiKey: () => 'sk-test', fetchTts },
			{ workspaceId, briefingId, actorId },
		)

		expect(result).toEqual({ status: 'skipped', reason: 'briefing_not_found' })
	})

	it('rolls back the S3 object when the DB insert fails', async () => {
		const { db, mockResults } = createTestContext()
		mockResults.selectQueue = [[], [{ content: 'Briefing content', workspaceId }]]
		mockResults.insertError = new Error('files insert exploded')

		await expect(
			renderBriefingAudio(
				{ db, storage, getApiKey: () => 'sk-test', fetchTts },
				{ workspaceId, briefingId, actorId },
			),
		).rejects.toThrow('files insert exploded')

		// S3 put ran, then the compensating delete cleaned the orphan.
		expect(storage.puts).toHaveLength(1)
		expect(storage.deletes).toEqual([briefingAudioStorageKey(workspaceId, briefingId)])
	})

	it('truncates briefing content that would exceed the TTS input cap', async () => {
		const bigText = 'x'.repeat(5000)
		const { db, mockResults } = createTestContext()
		mockResults.selectQueue = [[], [{ content: bigText, workspaceId }]]
		mockResults.insert = []

		await renderBriefingAudio(
			{ db, storage, getApiKey: () => 'sk-test', fetchTts },
			{ workspaceId, briefingId, actorId },
		)

		expect(fetchTts).toHaveBeenCalledOnce()
		expect(fetchTts.mock.calls[0][0].text.length).toBe(4096)
	})
})
