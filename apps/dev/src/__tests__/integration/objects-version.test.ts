import { events, objects } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { buildCreateObjectBody, insertActor, insertObject, insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

const { default: objectsRoutes } = await import('../../routes/objects')

function createApp() {
	return createIntegrationApp({ path: '/api/objects', module: objectsRoutes })
}

describe('T2 — object versioning + 409 on stale PATCH', () => {
	let workspaceId: string

	beforeEach(async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		workspaceId = ws.id
	})

	describe('version column + trigger', () => {
		it('creates rows with version=1 and bumps to 2 on the first UPDATE', async () => {
			const created = await insertObject(db, workspaceId, getTestActorId())
			expect(created.version).toBe(1)

			await db
				.update(objects)
				.set({ title: 'Renamed via raw SQL' })
				.where(eq(objects.id, created.id))

			const [after] = await db.select().from(objects).where(eq(objects.id, created.id))
			expect(after.version).toBe(2)
			expect(after.title).toBe('Renamed via raw SQL')
		})

		it('bumps version regardless of whether SET explicitly assigns it', async () => {
			const created = await insertObject(db, workspaceId, getTestActorId())

			// A caller that tries to freeze version at some value has no effect —
			// the BEFORE UPDATE trigger overrides NEW.version to OLD.version + 1.
			await db.update(objects).set({ title: 'One', version: 99 }).where(eq(objects.id, created.id))

			const [after] = await db.select().from(objects).where(eq(objects.id, created.id))
			expect(after.version).toBe(2)
		})

		it('bumps version once per UPDATE across multiple write paths', async () => {
			const created = await insertObject(db, workspaceId, getTestActorId())

			await db.update(objects).set({ title: 'A' }).where(eq(objects.id, created.id))
			await db.update(objects).set({ status: 'in_progress' }).where(eq(objects.id, created.id))
			await db.update(objects).set({ driver: null }).where(eq(objects.id, created.id))

			const [after] = await db.select().from(objects).where(eq(objects.id, created.id))
			expect(after.version).toBe(4)
		})
	})

	describe('PATCH /api/objects/:id — matching version', () => {
		it('returns 200 and increments version on a fresh PATCH', async () => {
			const app = createApp()
			const create = await app.request(
				jsonRequest('POST', '/api/objects', buildCreateObjectBody(), {
					'x-workspace-id': workspaceId,
				}),
			)
			const created = await create.json()
			expect(created.version).toBe(1)

			const patch = await app.request(
				jsonRequest(
					'PATCH',
					`/api/objects/${created.id}`,
					{ title: 'Fresh title' },
					{ 'If-Match': String(created.version) },
				),
			)
			expect(patch.status).toBe(200)
			const updated = await patch.json()
			expect(updated.title).toBe('Fresh title')
			expect(updated.version).toBe(2)
		})

		it('accepts expected_version in the body when no If-Match header is present', async () => {
			const app = createApp()
			const created = await insertObject(db, workspaceId, getTestActorId())

			const patch = await app.request(
				jsonRequest('PATCH', `/api/objects/${created.id}`, {
					title: 'Body-version',
					expected_version: 1,
				}),
			)
			expect(patch.status).toBe(200)
			const updated = await patch.json()
			expect(updated.title).toBe('Body-version')
			expect(updated.version).toBe(2)
		})

		it('lets If-Match win over expected_version in the body when both are sent', async () => {
			const app = createApp()
			const created = await insertObject(db, workspaceId, getTestActorId())

			// If-Match matches (version=1). The body claims a stale version but the
			// header takes precedence in the handler, so the write succeeds.
			const patch = await app.request(
				jsonRequest(
					'PATCH',
					`/api/objects/${created.id}`,
					{ title: 'Header wins', expected_version: 99 },
					{ 'If-Match': '1' },
				),
			)
			expect(patch.status).toBe(200)
			const updated = await patch.json()
			expect(updated.title).toBe('Header wins')
			expect(updated.version).toBe(2)
		})

		it('accepts the RFC 7232 quoted ETag form for If-Match', async () => {
			const app = createApp()
			const created = await insertObject(db, workspaceId, getTestActorId())

			const patch = await app.request(
				jsonRequest(
					'PATCH',
					`/api/objects/${created.id}`,
					{ title: 'Quoted' },
					{ 'If-Match': '"1"' },
				),
			)
			expect(patch.status).toBe(200)
			const updated = await patch.json()
			expect(updated.version).toBe(2)
		})
	})

	describe('PATCH /api/objects/:id — stale version', () => {
		it('returns 409 with the current server state when If-Match is stale', async () => {
			const app = createApp()
			const created = await insertObject(db, workspaceId, getTestActorId(), {
				title: 'Original',
				status: 'todo',
			})

			// First writer bumps the row to version 2 with a different title.
			await app.request(
				jsonRequest(
					'PATCH',
					`/api/objects/${created.id}`,
					{ title: 'First writer wins' },
					{ 'If-Match': '1' },
				),
			)

			// Second writer arrives with the stale version and gets a 409 carrying
			// the row as it stands now — the "take theirs" preview T4 renders.
			const stale = await app.request(
				jsonRequest(
					'PATCH',
					`/api/objects/${created.id}`,
					{ title: 'Second writer loses' },
					{ 'If-Match': '1' },
				),
			)
			expect(stale.status).toBe(409)
			const body = await stale.json()
			expect(body.error.code).toBe('CONFLICT')
			expect(body.current.id).toBe(created.id)
			expect(body.current.version).toBe(2)
			expect(body.current.title).toBe('First writer wins')

			// The stale write did not overwrite the row.
			const [row] = await db.select().from(objects).where(eq(objects.id, created.id))
			expect(row.title).toBe('First writer wins')
			expect(row.version).toBe(2)
		})

		it('does not emit an event when the write is rejected', async () => {
			const app = createApp()
			const created = await insertObject(db, workspaceId, getTestActorId())
			await app.request(
				jsonRequest('PATCH', `/api/objects/${created.id}`, { title: 'First' }, { 'If-Match': '1' }),
			)
			const eventsBefore = await db.select().from(events).where(eq(events.entityId, created.id))

			const stale = await app.request(
				jsonRequest('PATCH', `/api/objects/${created.id}`, { title: 'Stale' }, { 'If-Match': '1' }),
			)
			expect(stale.status).toBe(409)

			const eventsAfter = await db.select().from(events).where(eq(events.entityId, created.id))
			// No new event row from the rejected write — audit log stays clean.
			expect(eventsAfter.length).toBe(eventsBefore.length)
		})
	})

	describe('concurrent PATCH', () => {
		it('serializes two same-version PATCHes into exactly one 200 and one 409', async () => {
			const app = createApp()
			const created = await insertObject(db, workspaceId, getTestActorId(), {
				title: 'Race target',
			})
			expect(created.version).toBe(1)

			const [a, b] = await Promise.all([
				app.request(
					jsonRequest(
						'PATCH',
						`/api/objects/${created.id}`,
						{ title: 'Writer A' },
						{ 'If-Match': '1' },
					),
				),
				app.request(
					jsonRequest(
						'PATCH',
						`/api/objects/${created.id}`,
						{ title: 'Writer B' },
						{ 'If-Match': '1' },
					),
				),
			])

			const statuses = [a.status, b.status].sort()
			expect(statuses).toEqual([200, 409])

			// The loser's response carries the current server state — whichever body
			// won gets echoed back on `current`.
			const loser = a.status === 409 ? a : b
			const winner = a.status === 200 ? a : b
			const loserBody = await loser.json()
			const winnerBody = await winner.json()
			expect(loserBody.current.version).toBe(2)
			expect(loserBody.current.title).toBe(winnerBody.title)

			// Row on disk reflects the winner and only the winner.
			const [row] = await db.select().from(objects).where(eq(objects.id, created.id))
			expect(row.version).toBe(2)
			expect(row.title).toBe(winnerBody.title)
		})
	})

	describe('backwards compatibility — missing version', () => {
		it('falls back to last-write-wins when no If-Match or expected_version is sent', async () => {
			const app = createApp()
			const created = await insertObject(db, workspaceId, getTestActorId())

			const patch = await app.request(
				jsonRequest('PATCH', `/api/objects/${created.id}`, { title: 'No guard' }),
			)
			expect(patch.status).toBe(200)
			const updated = await patch.json()
			expect(updated.title).toBe('No guard')
			// The trigger still bumps the version even on the deprecated path.
			expect(updated.version).toBe(2)
		})
	})

	describe('workspace isolation', () => {
		it('still returns 404 (not 409) when the row belongs to a different workspace', async () => {
			const app = createApp()
			const otherActor = await insertActor(db)
			const otherWorkspace = await insertWorkspace(db, otherActor.id)
			const created = await insertObject(db, otherWorkspace.id, otherActor.id)

			const patch = await app.request(
				jsonRequest(
					'PATCH',
					`/api/objects/${created.id}`,
					{ title: 'Cross-workspace' },
					{ 'If-Match': '1' },
				),
			)
			expect(patch.status).toBe(404)
		})
	})
})
