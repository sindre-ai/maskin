import { randomUUID } from 'node:crypto'
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

	// Regression guard for the T1 review's "SHOULD 1" finding: the exactly-once
	// check must discriminate audio from non-audio attachments so a diagram or
	// transcript already attached to the briefing does not silently prevent the
	// audio render.
	it('renders even when the briefing already has a non-audio attached file', async () => {
		const actor = await insertActor(db)
		const workspace = await insertWorkspace(db, actor.id)
		const briefing = await insertObject(db, workspace.id, actor.id, {
			type: 'knowledge',
			status: 'validated',
			title: 'Daily Briefing with diagram',
			content: 'Briefing body with a diagram attached.',
			metadata: { kind: 'briefing' },
		})

		// Seed a non-audio attached file — a PNG diagram of the same shape another
		// agent might attach to a briefing in the future.
		const diagramFileId = randomUUID()
		await db.insert(files).values({
			id: diagramFileId,
			workspaceId: workspace.id,
			name: 'briefing-diagram.png',
			description: 'Reference diagram',
			mimeType: 'image/png',
			sizeBytes: 42,
			storageKey: `workspaces/${workspace.id}/files/${diagramFileId}`,
			createdBy: actor.id,
		})
		await db.insert(relationships).values({
			sourceType: 'object',
			sourceId: briefing.id,
			targetType: 'file',
			targetId: diagramFileId,
			type: BRIEFING_AUDIO_RELATIONSHIP_TYPE,
			createdBy: actor.id,
		})

		const storage = new InMemoryStorage()
		const fetchTts = vi.fn().mockResolvedValue(Buffer.from('MP3-BODY'))

		const result = await renderBriefingAudio(
			{ db, storage, getApiKey: () => 'sk-test', fetchTts },
			{ workspaceId: workspace.id, briefingId: briefing.id, actorId: actor.id },
		)

		expect(result.status).toBe('rendered')
		if (result.status !== 'rendered') return
		expect(fetchTts).toHaveBeenCalledOnce()

		// The audio file landed alongside the diagram — both attachments coexist.
		const attached = await db
			.select({ id: files.id, mimeType: files.mimeType })
			.from(relationships)
			.innerJoin(files, eq(files.id, relationships.targetId))
			.where(
				and(
					eq(relationships.sourceType, 'object'),
					eq(relationships.sourceId, briefing.id),
					eq(relationships.targetType, 'file'),
					eq(relationships.type, BRIEFING_AUDIO_RELATIONSHIP_TYPE),
				),
			)
		const mimeTypes = attached.map((r) => r.mimeType).sort()
		expect(mimeTypes).toEqual(['audio/mpeg', 'image/png'])
	})

	// Regression guard for the T1 review's "SHOULD 2" finding: two overlapping
	// renders on the same briefing must not double-attach audio. The DB row-lock
	// closes the race window at commit time — TTS may still run twice (the
	// second caller has already paid for the API call before the first commits),
	// but only one audio attachment survives.
	it('two overlapping renders leave exactly one audio attachment (TTS may run twice)', async () => {
		const actor = await insertActor(db)
		const workspace = await insertWorkspace(db, actor.id)
		const briefing = await insertObject(db, workspace.id, actor.id, {
			type: 'knowledge',
			status: 'validated',
			title: 'Daily Briefing race test',
			content: 'Concurrency test briefing body.',
			metadata: { kind: 'briefing' },
		})

		const storage = new InMemoryStorage()

		// A controllable TTS mock: each call takes a deferred slot so the test
		// can gate both invocations past the fast-path idempotency check before
		// either commits. Different bytes per call so the tie-breaking on the
		// files row is observable — the winning fileId's bytes are what land
		// in S3 under the deterministic per-briefing key.
		const ttsGates: Array<{
			resolve: (bytes: Buffer) => void
		}> = []
		const fetchTts = vi.fn().mockImplementation(() => {
			return new Promise<Buffer>((resolve) => {
				ttsGates.push({ resolve })
			})
		})

		const p1 = renderBriefingAudio(
			{ db, storage, getApiKey: () => 'sk-test', fetchTts },
			{ workspaceId: workspace.id, briefingId: briefing.id, actorId: actor.id },
		)
		const p2 = renderBriefingAudio(
			{ db, storage, getApiKey: () => 'sk-test', fetchTts },
			{ workspaceId: workspace.id, briefingId: briefing.id, actorId: actor.id },
		)

		// Spin until both callers have parked on their TTS promise. That
		// guarantees both cleared the fast-path idempotency check — the race
		// window the T1 review flagged.
		while (ttsGates.length < 2) await new Promise((r) => setImmediate(r))

		// Release TTS for both. Order after the gate is up to the microtask
		// queue; the row-lock is what decides the winner, not our sequencing.
		ttsGates[0].resolve(Buffer.from('MP3-A'))
		ttsGates[1].resolve(Buffer.from('MP3-B'))

		const [r1, r2] = await Promise.all([p1, p2])

		expect(fetchTts).toHaveBeenCalledTimes(2)

		// Exactly one of the two callers commits `rendered`; the other lost the
		// row-lock race and returned `already_attached`.
		const outcomes = [r1.status, r2.status].sort()
		expect(outcomes).toEqual(['already_attached', 'rendered'])
		const winner = r1.status === 'rendered' ? r1 : r2
		const loser = r1.status === 'already_attached' ? r1 : r2
		if (winner.status !== 'rendered' || loser.status !== 'already_attached') {
			throw new Error('unreachable')
		}
		// Loser resolves against the winner's fileId, not its own aborted upload.
		expect(loser.fileId).toBe(winner.fileId)

		// Exactly one audio attachment survives on the briefing.
		const audioAttachments = await db
			.select({ id: files.id })
			.from(relationships)
			.innerJoin(files, eq(files.id, relationships.targetId))
			.where(
				and(
					eq(relationships.sourceType, 'object'),
					eq(relationships.sourceId, briefing.id),
					eq(relationships.targetType, 'file'),
					eq(relationships.type, BRIEFING_AUDIO_RELATIONSHIP_TYPE),
					eq(files.mimeType, BRIEFING_AUDIO_MIME_TYPE),
				),
			)
		expect(audioAttachments).toHaveLength(1)
		expect(audioAttachments[0].id).toBe(winner.fileId)

		// Both callers wrote to the same deterministic per-briefing S3 key. The
		// loser skips its cleanup delete precisely so the shared object stays
		// on disk for the winning row to point at. Assert the object survived
		// and the frontend can still fetch bytes for the winning fileId.
		expect(await storage.exists(briefingAudioStorageKey(workspace.id, briefing.id))).toBe(true)
	})
})
