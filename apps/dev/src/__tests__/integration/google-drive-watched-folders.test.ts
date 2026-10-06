import { integrations } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { insertActor, insertTrigger, insertWorkspace } from '../factories'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

const { default: driveRoutes } = await import('../../routes/integrations-google-drive')

// Folder watches list and stop against real Postgres. The stop endpoint is one
// UPDATE that rewrites config.drive.watchedFolders with jsonb_agg inside a
// correlated subquery, the exact shape known-pitfalls.md warns mocked-DB tests
// cannot check, so the semantics are pinned here: the matching entry goes, its
// siblings and the rest of config.drive stay, and another workspace's row is
// never touched.

const BASE = '/api/integrations/google-drive/watched-folders'

function app() {
	return createIntegrationApp({ path: '/api/integrations/google-drive', module: driveRoutes })
}

const headers = (workspaceId: string) => ({ 'X-Workspace-Id': workspaceId })

let counter = 0

async function insertDriveRow(
	workspaceId: string,
	watchedFolders: unknown,
	overrides: { status?: 'active' | 'error' | 'revoked'; externalId?: string } = {},
) {
	counter += 1
	const [row] = await db
		.insert(integrations)
		.values({
			workspaceId,
			provider: 'google-drive',
			status: overrides.status ?? 'active',
			externalId: overrides.externalId ?? `human${counter}@acme.test`,
			credentials: 'not-a-real-credential',
			config: {
				system_actor_id: 'keep-me',
				drive: { peopleId: 'p-1', channelId: 'chan-1', watchedFolders },
			},
			createdBy: getTestActorId(),
		})
		.returning()
	return row
}

async function storedConfig(id: string) {
	const [row] = await db.select().from(integrations).where(eq(integrations.id, id))
	return row?.config as {
		system_actor_id?: string
		drive?: { peopleId?: string; channelId?: string; watchedFolders?: { folderId: string }[] }
	}
}

const watch = (folderId: string, extra: Record<string, unknown> = {}) => ({
	folderId,
	name: `Folder ${folderId}`,
	addedAt: '2026-10-01T09:00:00.000Z',
	...extra,
})

describe('GET /api/integrations/google-drive/watched-folders (integration)', () => {
	let workspaceId: string
	let otherWorkspaceId: string

	beforeEach(async () => {
		const actor = await insertActor(db)
		workspaceId = (await insertWorkspace(db, actor.id)).id
		otherWorkspaceId = (await insertWorkspace(db, actor.id)).id
	})

	it('returns [] for a workspace with no Drive row', async () => {
		const res = await app().request(BASE, { headers: headers(workspaceId) })
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
	})

	it('returns [] when a Drive row has no watches yet', async () => {
		await insertDriveRow(workspaceId, [])
		const res = await app().request(BASE, { headers: headers(workspaceId) })
		expect(await res.json()).toEqual([])
	})

	it('lists every entry across the workspace rows with the account it lives on', async () => {
		const priya = await insertDriveRow(
			workspaceId,
			[
				watch('f-recordings', {
					path: 'Meet Recordings',
					lastFiredAt: '2026-10-05T10:00:00.000Z',
				}),
				watch('f-briefs'),
			],
			{ externalId: 'priya@acme.test' },
		)
		const kai = await insertDriveRow(
			workspaceId,
			[watch('f-investors', { lastFiredAt: 1_759_650_000_000 })],
			{
				externalId: 'kai@acme.test',
			},
		)

		const res = await app().request(BASE, { headers: headers(workspaceId) })
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, unknown>[]
		expect(body.map((w) => w.folderId).sort()).toEqual(['f-briefs', 'f-investors', 'f-recordings'])

		const recordings = body.find((w) => w.folderId === 'f-recordings')
		expect(recordings).toMatchObject({
			name: 'Folder f-recordings',
			path: 'Meet Recordings',
			addedAt: '2026-10-01T09:00:00.000Z',
			lastFiredAt: '2026-10-05T10:00:00.000Z',
			integrationId: priya.id,
			account: 'priya@acme.test',
			triggers: [],
		})
		// Optional fields are null, never invented.
		const briefs = body.find((w) => w.folderId === 'f-briefs')
		expect(briefs).toMatchObject({ path: null, lastFiredAt: null })
		// An epoch-ms lastFiredAt is normalised to ISO.
		const investors = body.find((w) => w.folderId === 'f-investors')
		expect(investors).toMatchObject({
			integrationId: kai.id,
			account: 'kai@acme.test',
			lastFiredAt: new Date(1_759_650_000_000).toISOString(),
		})
	})

	it('skips entries that do not parse and rows that are revoked', async () => {
		await insertDriveRow(workspaceId, [watch('f-good'), { name: 'no id' }, 'garbage', null])
		await insertDriveRow(workspaceId, [watch('f-revoked')], { status: 'revoked' })
		await insertDriveRow(workspaceId, [watch('f-errored')], { status: 'error' })

		const res = await app().request(BASE, { headers: headers(workspaceId) })
		const ids = ((await res.json()) as { folderId: string }[]).map((w) => w.folderId).sort()
		expect(ids).toEqual(['f-errored', 'f-good'])
	})

	it('names the triggers that reference a folder, and only those', async () => {
		const actor = await insertActor(db)
		await insertDriveRow(workspaceId, [watch('f-recordings'), watch('f-briefs'), watch('f-lonely')])
		await insertTrigger(db, workspaceId, actor.id, actor.id, {
			name: 'Post-call recap',
			config: {
				entity_type: 'google_drive.file',
				action: 'created',
				filter: { folderId: 'f-recordings' },
			},
		})
		// Any-of array filter still references the folder.
		await insertTrigger(db, workspaceId, actor.id, actor.id, {
			name: 'Brief intake',
			config: {
				entity_type: 'google_drive.file',
				filter: { folderId: ['f-briefs', 'f-elsewhere'] },
			},
		})
		// Disabled, wrong entity type and other-workspace triggers do not count.
		await insertTrigger(db, workspaceId, actor.id, actor.id, {
			name: 'Switched off',
			enabled: false,
			config: { entity_type: 'google_drive.file', filter: { folderId: 'f-lonely' } },
		})
		await insertTrigger(db, workspaceId, actor.id, actor.id, {
			name: 'Not a Drive trigger',
			config: { entity_type: 'task', filter: { folderId: 'f-lonely' } },
		})
		await insertTrigger(db, otherWorkspaceId, actor.id, actor.id, {
			name: 'Other workspace',
			config: { entity_type: 'google_drive.file', filter: { folderId: 'f-lonely' } },
		})

		const res = await app().request(BASE, { headers: headers(workspaceId) })
		const body = (await res.json()) as { folderId: string; triggers: { name: string }[] }[]
		const namesFor = (id: string) =>
			body.find((w) => w.folderId === id)?.triggers.map((t) => t.name)
		expect(namesFor('f-recordings')).toEqual(['Post-call recap'])
		expect(namesFor('f-briefs')).toEqual(['Brief intake'])
		expect(namesFor('f-lonely')).toEqual([])
	})

	it("never returns another workspace's watches", async () => {
		await insertDriveRow(otherWorkspaceId, [watch('f-theirs')])
		const res = await app().request(BASE, { headers: headers(workspaceId) })
		expect(await res.json()).toEqual([])
	})

	it('400s without a valid X-Workspace-Id', async () => {
		const res = await app().request(BASE, { headers: { 'X-Workspace-Id': 'not-a-uuid' } })
		expect(res.status).toBe(400)
	})
})

describe('DELETE /api/integrations/google-drive/watched-folders/:folderId (integration)', () => {
	let workspaceId: string
	let otherWorkspaceId: string

	beforeEach(async () => {
		const actor = await insertActor(db)
		workspaceId = (await insertWorkspace(db, actor.id)).id
		otherWorkspaceId = (await insertWorkspace(db, actor.id)).id
	})

	const stop = (ws: string, folderId: string) =>
		app().request(`${BASE}/${folderId}`, { method: 'DELETE', headers: headers(ws) })

	it('removes the entry, keeps its siblings and the rest of config, and the list drops it', async () => {
		const row = await insertDriveRow(workspaceId, [
			watch('f-one'),
			watch('f-two'),
			watch('f-three'),
		])

		const res = await stop(workspaceId, 'f-two')
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ ok: true, folderId: 'f-two' })

		const config = await storedConfig(row.id)
		expect(config.drive?.watchedFolders?.map((w) => w.folderId)).toEqual(['f-one', 'f-three'])
		expect(config.drive?.peopleId).toBe('p-1')
		expect(config.drive?.channelId).toBe('chan-1')
		expect(config.system_actor_id).toBe('keep-me')

		const list = await app().request(BASE, { headers: headers(workspaceId) })
		const ids = ((await list.json()) as { folderId: string }[]).map((w) => w.folderId)
		expect(ids).toEqual(['f-one', 'f-three'])
	})

	it('leaves an empty array, not null, when the last watch is stopped', async () => {
		const row = await insertDriveRow(workspaceId, [watch('f-only')])
		expect((await stop(workspaceId, 'f-only')).status).toBe(200)
		expect((await storedConfig(row.id)).drive?.watchedFolders).toEqual([])
		const list = await app().request(BASE, { headers: headers(workspaceId) })
		expect(await list.json()).toEqual([])
	})

	it('stopping an unknown folder id is a clean 404 and changes nothing', async () => {
		const row = await insertDriveRow(workspaceId, [watch('f-one')])
		const res = await stop(workspaceId, 'f-does-not-exist')
		expect(res.status).toBe(404)
		expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND')
		expect((await storedConfig(row.id)).drive?.watchedFolders).toHaveLength(1)
	})

	it('a folder id from another workspace is a 404 and that workspace keeps its watch', async () => {
		const theirs = await insertDriveRow(otherWorkspaceId, [watch('f-theirs')])
		const res = await stop(workspaceId, 'f-theirs')
		expect(res.status).toBe(404)
		expect((await storedConfig(theirs.id)).drive?.watchedFolders).toHaveLength(1)

		// And the owner can still stop it from its own workspace.
		expect((await stop(otherWorkspaceId, 'f-theirs')).status).toBe(200)
		expect((await storedConfig(theirs.id)).drive?.watchedFolders).toEqual([])
	})

	it('a row with no watchedFolders key is a 404, not an error', async () => {
		counter += 1
		await db.insert(integrations).values({
			workspaceId,
			provider: 'google-drive',
			status: 'active',
			externalId: `bare${counter}@acme.test`,
			credentials: 'x',
			config: { drive: { peopleId: 'p-1' } },
			createdBy: getTestActorId(),
		})
		expect((await stop(workspaceId, 'f-any')).status).toBe(404)
	})

	it('removes the folder from every Drive row in the workspace that holds it', async () => {
		const a = await insertDriveRow(workspaceId, [watch('f-shared'), watch('f-a-only')])
		const b = await insertDriveRow(workspaceId, [watch('f-shared')])
		expect((await stop(workspaceId, 'f-shared')).status).toBe(200)
		expect((await storedConfig(a.id)).drive?.watchedFolders?.map((w) => w.folderId)).toEqual([
			'f-a-only',
		])
		expect((await storedConfig(b.id)).drive?.watchedFolders).toEqual([])
	})

	it('rejects a folder id with characters Drive never issues', async () => {
		await insertDriveRow(workspaceId, [watch('f-one')])
		const res = await stop(workspaceId, 'a%27%20OR%201=1')
		expect(res.status).toBe(400)
	})
})
