// The Objects page must show the server's totals, not a count of whatever rows
// have loaded. These tests pin the three pieces that make that possible against
// real Postgres: GET /objects/facets, the group_by/group_value filter on the
// list, and the starred/working/attention_ids quick filters.

import { starState } from '@maskin/db/schema'
import { sql } from 'drizzle-orm'
import { insertObject, insertWorkspace } from '../factories'
import { jsonGet } from '../helpers'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

const { default: objectsRoutes } = await import('../../routes/objects')

function createApp() {
	return createIntegrationApp({ path: '/api/objects', module: objectsRoutes })
}

describe('Objects facets and group filtering', () => {
	let workspaceId: string
	let actorId: string

	beforeEach(async () => {
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		workspaceId = ws.id
	})

	const headers = () => ({ 'x-workspace-id': workspaceId })

	async function seed(type: string, status: string, count: number) {
		const rows = []
		for (let i = 0; i < count; i++) {
			rows.push(
				await insertObject(db, workspaceId, actorId, { type, status, title: `${type} ${i}` }),
			)
		}
		return rows
	}

	it('counts every row, not just the first page', async () => {
		await seed('bet', 'active', 7)
		await seed('bet', 'opportunity', 5)
		await seed('task', 'todo', 3)

		const res = await createApp().request(jsonGet('/api/objects/facets?type=bet', headers()))
		expect(res.status).toBe(200)
		const body = await res.json()

		expect(body.total).toBe(12)
		expect(body.by_status).toEqual({ active: 7, signal: 5 })
		// Type counts ignore the type filter, so the other tabs keep their numbers.
		expect(body.by_type).toEqual({ bet: 12, task: 3 })
		expect(
			Object.fromEntries(
				body.groups.map((g: { value: string; total: number }) => [g.value, g.total]),
			),
		).toEqual({
			active: 7,
			signal: 5,
		})
	})

	it('status facets ignore the status filter so every chip shows its own count', async () => {
		await seed('bet', 'active', 4)
		await seed('bet', 'opportunity', 2)

		const res = await createApp().request(
			jsonGet('/api/objects/facets?type=bet&status=active', headers()),
		)
		const body = await res.json()

		expect(body.total).toBe(4)
		expect(body.by_status).toEqual({ active: 4, signal: 2 })
	})

	it('returns one group’s complete rows through group_by and group_value', async () => {
		await seed('bet', 'active', 130)
		await seed('bet', 'opportunity', 3)

		const app = createApp()
		const page1 = await app.request(
			jsonGet(
				'/api/objects?type=bet&group_by=status&group_value=active&limit=100&offset=0',
				headers(),
			),
		)
		expect(page1.headers.get('X-Total-Count')).toBe('130')
		const first = await page1.json()
		expect(first).toHaveLength(100)

		const page2 = await app.request(
			jsonGet(
				'/api/objects?type=bet&group_by=status&group_value=active&limit=100&offset=100',
				headers(),
			),
		)
		const second = await page2.json()
		expect(second).toHaveLength(30)
		const ids = new Set([...first, ...second].map((o: { id: string }) => o.id))
		expect(ids.size).toBe(130)
		expect([...first, ...second].every((o: { status: string }) => o.status === 'active')).toBe(true)
	})

	it('groups rows with no value under the empty string', async () => {
		await insertObject(db, workspaceId, actorId, { type: 'bet', status: 'active', driver: null })
		await insertObject(db, workspaceId, actorId, { type: 'bet', status: 'active', driver: actorId })

		const app = createApp()
		const facets = await (
			await app.request(jsonGet('/api/objects/facets?group_by=driver', headers()))
		).json()
		expect(facets.groups).toEqual([
			{ value: actorId, total: 1 },
			{ value: '', total: 1 },
		])

		const none = await app.request(jsonGet('/api/objects?group_by=driver&group_value=', headers()))
		expect(await none.json()).toHaveLength(1)
	})

	it('buckets date groups by day in the requested timezone', async () => {
		const [row] = await seed('bet', 'active', 1)
		await db.execute(
			sql`UPDATE objects SET created_at = '2026-03-01T23:30:00Z' WHERE id = ${row?.id}`,
		)

		const app = createApp()
		const utc = await (
			await app.request(jsonGet('/api/objects/facets?group_by=createdAt&tz=UTC', headers()))
		).json()
		expect(utc.groups).toEqual([{ value: '2026-03-01', total: 1 }])

		const tokyo = await (
			await app.request(jsonGet('/api/objects/facets?group_by=createdAt&tz=Asia/Tokyo', headers()))
		).json()
		expect(tokyo.groups).toEqual([{ value: '2026-03-02', total: 1 }])

		const rows = await app.request(
			jsonGet('/api/objects?group_by=createdAt&group_value=2026-03-02&tz=Asia/Tokyo', headers()),
		)
		expect(await rows.json()).toHaveLength(1)
	})

	it('narrows by starred, working and attention_ids, and counts them', async () => {
		const [a, b, c] = await seed('bet', 'active', 3)
		await db.insert(starState).values({
			actorId,
			entityType: 'object',
			entityId: a?.id as string,
			workspaceId,
		})
		await db.execute(
			sql`UPDATE objects SET active_session_id = gen_random_uuid() WHERE id = ${b?.id}`,
		)

		const app = createApp()
		const starred = await (
			await app.request(jsonGet('/api/objects?starred=true', headers()))
		).json()
		expect(starred.map((o: { id: string }) => o.id)).toEqual([a?.id])

		const working = await (
			await app.request(jsonGet('/api/objects?working=true', headers()))
		).json()
		expect(working.map((o: { id: string }) => o.id)).toEqual([b?.id])

		const waiting = await (
			await app.request(jsonGet(`/api/objects?attention_ids=${c?.id}`, headers()))
		).json()
		expect(waiting.map((o: { id: string }) => o.id)).toEqual([c?.id])

		const nobody = await (
			await app.request(jsonGet('/api/objects?attention_ids=', headers()))
		).json()
		expect(nobody).toEqual([])

		const facets = await (
			await app.request(jsonGet(`/api/objects/facets?waiting_ids=${c?.id}`, headers()))
		).json()
		expect(facets).toMatchObject({ total: 3, starred: 1, working: 1, waiting: 1 })
	})

	it('anchors the Updated buckets on the viewer’s day start', async () => {
		const [today, yesterday, old] = await seed('bet', 'active', 3)
		await db.execute(
			sql`UPDATE objects SET updated_at = '2026-05-10T12:00:00Z' WHERE id = ${today?.id}`,
		)
		await db.execute(
			sql`UPDATE objects SET updated_at = '2026-05-09T12:00:00Z' WHERE id = ${yesterday?.id}`,
		)
		await db.execute(
			sql`UPDATE objects SET updated_at = '2026-04-01T12:00:00Z' WHERE id = ${old?.id}`,
		)

		const res = await createApp().request(
			jsonGet('/api/objects/facets?day_start=2026-05-10T00:00:00Z', headers()),
		)
		const body = await res.json()
		expect(body.updated).toEqual({ today: 1, yesterday: 1, week: 0, older: 1 })
	})
})
