import { actors } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { insertActor } from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { createIntegrationApp, db } from './global-setup'

const { default: actorsRoutes } = await import('../../routes/actors')

function createApp() {
	return createIntegrationApp({ path: '/api/actors', module: actorsRoutes })
}

describe('Actors Integration — avatar_url', () => {
	it('persists a valid URL through PATCH, returns it on GET, and preserves it across unrelated updates', async () => {
		const app = createApp()
		const actor = await insertActor(db, { type: 'agent', name: 'Avatar Agent' })

		// Baseline: column exists and reads back as null before any update.
		const beforeRes = await app.request(jsonGet(`/api/actors/${actor.id}`))
		expect(beforeRes.status).toBe(200)
		expect((await beforeRes.json()).avatar_url).toBeNull()

		// PATCH persists the URL and echoes it back.
		const url = 'https://example.com/avatars/agent.png'
		const patchRes = await app.request(
			jsonRequest('PATCH', `/api/actors/${actor.id}`, { avatar_url: url }),
		)
		expect(patchRes.status).toBe(200)
		expect((await patchRes.json()).avatar_url).toBe(url)

		// GET reflects the persisted value.
		const afterRes = await app.request(jsonGet(`/api/actors/${actor.id}`))
		expect((await afterRes.json()).avatar_url).toBe(url)

		// Unrelated PATCH (name-only) leaves avatar_url intact — the DoD's
		// preserve-on-omit constraint is enforced by the `!== undefined` guard
		// in the update handler.
		const renameRes = await app.request(
			jsonRequest('PATCH', `/api/actors/${actor.id}`, { name: 'Renamed Agent' }),
		)
		expect(renameRes.status).toBe(200)
		expect((await renameRes.json()).avatar_url).toBe(url)

		// Explicit null clears the column.
		const clearRes = await app.request(
			jsonRequest('PATCH', `/api/actors/${actor.id}`, { avatar_url: null }),
		)
		expect(clearRes.status).toBe(200)
		expect((await clearRes.json()).avatar_url).toBeNull()

		// DB-level confirmation — Drizzle can select the column and Postgres
		// stores null as expected once cleared.
		const [row] = await db
			.select({ avatarUrl: actors.avatarUrl })
			.from(actors)
			.where(eq(actors.id, actor.id))
		expect(row.avatarUrl).toBeNull()
	})

	it('rejects a non-URL avatar_url with 400', async () => {
		const app = createApp()
		const actor = await insertActor(db, { type: 'agent', name: 'Reject Me' })

		const res = await app.request(
			jsonRequest('PATCH', `/api/actors/${actor.id}`, { avatar_url: 'not-a-url' }),
		)
		expect(res.status).toBe(400)

		// And the row is untouched.
		const [row] = await db
			.select({ avatarUrl: actors.avatarUrl })
			.from(actors)
			.where(eq(actors.id, actor.id))
		expect(row.avatarUrl).toBeNull()
	})
})
