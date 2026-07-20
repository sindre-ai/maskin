import { Readable } from 'node:stream'
import { files, relationships } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import {
	BRIEFING_AUDIO_MIME_TYPE,
	BRIEFING_AUDIO_RELATIONSHIP_TYPE,
	briefingAudioStorageKey,
	renderBriefingAudio,
} from '../../services/briefing-audio-renderer'
import { insertActor, insertObject, insertWorkspace } from '../factories'
import { db } from './global-setup'

class InMemoryStorage implements StorageProvider {
	public objects = new Map<string, Buffer>()
	async put(key: string, data: Buffer | Uint8Array | Readable): Promise<void> {
		if (data instanceof Readable) throw new Error('Readable not exercised')
		this.objects.set(key, Buffer.from(data))
	}
	async get(key: string): Promise<Buffer> {
		const v = this.objects.get(key)
		if (!v) throw new Error(`Missing ${key}`)
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
		this.objects.delete(key)
	}
	async exists(key: string): Promise<boolean> {
		return this.objects.has(key)
	}
	async ensureBucket(): Promise<void> {}
}

describe('renderBriefingAudio (integration)', () => {
	it('inserts a files row + attached relationship linking the briefing to the audio file', async () => {
		const actor = await insertActor(db)
		const workspace = await insertWorkspace(db, actor.id)
		const briefing = await insertObject(db, workspace.id, actor.id, {
			type: 'knowledge',
			status: 'validated',
			title: 'Daily Briefing 07-20',
			content:
				'Today: T1 audio pipeline shipped. Sebk needs to review the fleet-status Objects page.',
			metadata: { kind: 'briefing' },
		})

		const storage = new InMemoryStorage()
		const fetchTts = vi.fn().mockResolvedValue(Buffer.from('FAKE-MP3-BYTES-OK'))

		const result = await renderBriefingAudio(
			{ db, storage, getApiKey: () => 'sk-test', fetchTts },
			{ workspaceId: workspace.id, briefingId: briefing.id, actorId: actor.id },
		)

		expect(result.status).toBe('rendered')
		if (result.status !== 'rendered') return
		expect(fetchTts).toHaveBeenCalledOnce()

		// The file row landed with the audio metadata and the deterministic S3 key.
		const [fileRow] = await db.select().from(files).where(eq(files.id, result.fileId))
		expect(fileRow).toBeDefined()
		expect(fileRow.mimeType).toBe(BRIEFING_AUDIO_MIME_TYPE)
		expect(fileRow.storageKey).toBe(briefingAudioStorageKey(workspace.id, briefing.id))
		expect(fileRow.sizeBytes).toBe(Buffer.from('FAKE-MP3-BYTES-OK').byteLength)

		// The attachment relationship links the briefing object to the file.
		const rels = await db
			.select()
			.from(relationships)
			.where(
				and(
					eq(relationships.sourceId, briefing.id),
					eq(relationships.targetId, result.fileId),
					eq(relationships.type, BRIEFING_AUDIO_RELATIONSHIP_TYPE),
				),
			)
		expect(rels).toHaveLength(1)
		expect(rels[0].sourceType).toBe('object')
		expect(rels[0].targetType).toBe('file')

		// The S3 side got the bytes at the same key.
		expect(storage.objects.has(fileRow.storageKey)).toBe(true)
	})

	it('is idempotent — a second call short-circuits without re-uploading', async () => {
		const actor = await insertActor(db)
		const workspace = await insertWorkspace(db, actor.id)
		const briefing = await insertObject(db, workspace.id, actor.id, {
			type: 'knowledge',
			status: 'validated',
			title: 'Daily Briefing 07-21',
			content: 'Small briefing body.',
			metadata: { kind: 'briefing' },
		})

		const storage = new InMemoryStorage()
		const fetchTts = vi.fn().mockResolvedValue(Buffer.from('MP3'))

		const first = await renderBriefingAudio(
			{ db, storage, getApiKey: () => 'sk-test', fetchTts },
			{ workspaceId: workspace.id, briefingId: briefing.id, actorId: actor.id },
		)
		if (first.status !== 'rendered') throw new Error('expected first render')

		const second = await renderBriefingAudio(
			{ db, storage, getApiKey: () => 'sk-test', fetchTts },
			{ workspaceId: workspace.id, briefingId: briefing.id, actorId: actor.id },
		)

		expect(second).toEqual({ status: 'already_attached', fileId: first.fileId })
		expect(fetchTts).toHaveBeenCalledOnce() // still 1 call across both invocations
	})
})
