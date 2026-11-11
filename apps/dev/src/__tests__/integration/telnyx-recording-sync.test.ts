import { randomUUID } from 'node:crypto'
import { events, files, relationships } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import {
	type TelnyxRecordingSyncConfig,
	type TelnyxRecordingSyncDeps,
	TelnyxRecordingSyncJob,
} from '../../jobs/telnyx-recording-sync'
import type { TelnyxRecording } from '../../lib/telnyx-recordings'
import { insertObject, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

// Lets one test make the last step of the save (the event) fail, after the file row and links went in.
const eventFailure = vi.hoisted(() => ({ on: false }))
vi.mock('../../lib/events/record-event', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../lib/events/record-event')>()
	return {
		...actual,
		recordEvent: (...args: Parameters<typeof actual.recordEvent>) => {
			if (eventFailure.on) throw new Error('event insert failed')
			return actual.recordEvent(...args)
		},
	}
})

function recording(overrides?: Partial<TelnyxRecording>): TelnyxRecording {
	return {
		id: randomUUID(),
		callSessionId: randomUUID(),
		from: '+4570000000',
		to: '+4551515484',
		status: 'completed',
		durationMillis: 24_000,
		startedAt: new Date().toISOString(),
		mp3Url: 'https://example.test/list-link.mp3',
		...overrides,
	}
}

async function setup(recs: TelnyxRecording[], depOverrides?: Partial<TelnyxRecordingSyncDeps>) {
	const actorId = getTestActorId()
	const ws = await insertWorkspace(db, actorId)
	const loop = await insertObject(db, ws.id, actorId, { title: 'SMB outbound' })
	const person = await insertObject(db, ws.id, actorId, {
		type: 'contact',
		title: 'Lars Orbe',
		metadata: { phone: '+4551515484', contact_name: 'Lars Orbe', company_name: 'Orbe ApS' },
	})
	await db.insert(relationships).values({
		sourceType: 'object',
		sourceId: loop.id,
		targetType: 'object',
		targetId: person.id,
		type: 'in_loop',
		createdBy: actorId,
	})
	const storage = {
		put: vi.fn(async () => {}),
		delete: vi.fn(async () => {}),
	}
	const deps = {
		readKey: vi.fn(async () => 'key'),
		listRecordings: vi.fn(async () => recs),
		getRecordingDownloadUrl: vi.fn(async (_k: string, id: string) => `https://example.test/${id}`),
		downloadRecording: vi.fn(async () => Buffer.from([1, 2, 3])),
		now: () => new Date(),
		...depOverrides,
	} as unknown as TelnyxRecordingSyncDeps
	const config: TelnyxRecordingSyncConfig = {
		workspaceId: ws.id,
		actorId,
		loopId: loop.id,
		keyName: 'Telnyx',
		backfillFrom: new Date(Date.now() - 24 * 60 * 60 * 1000),
	}
	const job = new TelnyxRecordingSyncJob(db, storage as never, config, deps)
	return { ws, loop, person, storage, deps, config, job }
}

const filesIn = (workspaceId: string) =>
	db.select().from(files).where(eq(files.workspaceId, workspaceId))

describe('TelnyxRecordingSyncJob.tick', () => {
	it('saves a recording as a file linked to the person and the loop, with the erase flag', async () => {
		const rec = recording()
		const { ws, loop, person, storage, job } = await setup([rec])

		expect(await job.tick()).toBe(1)

		const [file] = await filesIn(ws.id)
		expect(file?.tags).toEqual(['erase-on-request'])
		expect(file?.description).toContain(`Telnyx recording ${rec.id}`)
		expect(file?.description).toContain('Lars Orbe')
		expect(storage.put).toHaveBeenCalledTimes(1)
		const links = await db
			.select()
			.from(relationships)
			.where(eq(relationships.targetId, file?.id as string))
		expect(links.map((l) => l.sourceId).sort()).toEqual([loop.id, person.id].sort())
		expect(links.every((l) => l.type === 'attached')).toBe(true)
		const created = await db
			.select()
			.from(events)
			.where(eq(events.entityId, file?.id as string))
		expect((created[0]?.data as { telnyxRecordingId?: string }).telnyxRecordingId).toBe(rec.id)
	})

	it('asks for a fresh download link for each recording', async () => {
		const rec = recording()
		const { deps, job } = await setup([rec])
		await job.tick()
		expect(deps.getRecordingDownloadUrl).toHaveBeenCalledWith('key', rec.id)
		expect(deps.downloadRecording).toHaveBeenCalledWith(`https://example.test/${rec.id}`)
	})

	it('creates no duplicates when it runs twice', async () => {
		const { ws, deps, job } = await setup([recording(), recording()])
		expect(await job.tick()).toBe(2)
		expect(await job.tick()).toBe(0)
		expect(await filesIn(ws.id)).toHaveLength(2)
		expect(deps.downloadRecording).toHaveBeenCalledTimes(2)
	})

	it('does not save an erased recording again, even after a restart', async () => {
		const rec = recording()
		const { ws, config, deps, storage, job } = await setup([rec])
		await job.tick()
		const [file] = await filesIn(ws.id)
		// Erase on request: the file row is deleted for good.
		await db.delete(files).where(eq(files.id, file?.id as string))

		// A restart forgets the in-memory mark, so this is a fresh job.
		const restarted = new TelnyxRecordingSyncJob(db, storage as never, config, deps)
		expect(await restarted.tick()).toBe(0)
		expect(await filesIn(ws.id)).toHaveLength(0)
		expect(deps.downloadRecording).toHaveBeenCalledTimes(1)
	})

	it('recognises a file the calling run saved by hand', async () => {
		const rec = recording()
		const { ws, person, deps, job } = await setup([rec])
		await db.insert(files).values({
			workspaceId: ws.id,
			name: 'b5-call-001.mp3',
			description: `Call, Telnyx recording ${rec.id}. Erase on request.`,
			mimeType: 'audio/mpeg',
			sizeBytes: 3,
			storageKey: `workspaces/${ws.id}/files/${randomUUID()}`,
			createdBy: person.createdBy,
		})
		expect(await job.tick()).toBe(0)
		expect(deps.downloadRecording).not.toHaveBeenCalled()
	})

	it('retries a recording whose download failed, and saves the others', async () => {
		const bad = recording()
		const good = recording()
		const download = vi
			.fn()
			.mockRejectedValueOnce(new Error('Telnyx answered 500'))
			.mockResolvedValue(Buffer.from([1, 2, 3]))
		const { ws, job } = await setup([bad, good], { downloadRecording: download })

		expect(await job.tick()).toBe(1)
		expect(await filesIn(ws.id)).toHaveLength(1)

		expect(await job.tick()).toBe(1)
		const saved = await filesIn(ws.id)
		expect(saved).toHaveLength(2)
		expect(saved.some((f) => f.description?.includes(bad.id))).toBe(true)
	})

	it('leaves nothing behind when the save fails half way, and saves it on a later run', async () => {
		const rec = recording()
		const { ws, storage, job } = await setup([rec])

		eventFailure.on = true
		try {
			expect(await job.tick()).toBe(0)
		} finally {
			eventFailure.on = false
		}
		// The file row and both links were inside the same transaction as the event.
		expect(await filesIn(ws.id)).toHaveLength(0)
		expect(
			await db.select().from(relationships).where(eq(relationships.type, 'attached')),
		).toHaveLength(0)
		expect(storage.delete).toHaveBeenCalledTimes(1)

		expect(await job.tick()).toBe(1)
		expect(await filesIn(ws.id)).toHaveLength(1)
	})

	it('links to the loop only when no person matches', async () => {
		const rec = recording({ to: '+4599999999' })
		const { ws, loop, job } = await setup([rec])
		expect(await job.tick()).toBe(1)
		const [file] = await filesIn(ws.id)
		expect(file?.description).toContain('no matching person found')
		const links = await db
			.select()
			.from(relationships)
			.where(eq(relationships.targetId, file?.id as string))
		expect(links.map((l) => l.sourceId)).toEqual([loop.id])
	})

	it('does nothing when the key cannot be had', async () => {
		const { ws, deps, job } = await setup([recording()], { readKey: vi.fn(async () => null) })
		expect(await job.tick()).toBe(0)
		expect(deps.listRecordings).not.toHaveBeenCalled()
		expect(await filesIn(ws.id)).toHaveLength(0)
	})
})
