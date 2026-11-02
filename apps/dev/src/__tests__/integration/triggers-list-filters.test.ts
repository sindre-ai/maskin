import { beforeEach, describe, expect, it } from 'vitest'
import { insertActor, insertTrigger, insertWorkspace } from '../factories'
import { jsonGet } from '../helpers'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

const { default: triggersRoutes } = await import('../../routes/triggers')

type Row = { id: string; name: string; createdAt: string }

describe('GET /api/triggers — filters', () => {
	const app = createIntegrationApp({ path: '/api/triggers', module: triggersRoutes })
	let headers: Record<string, string>
	let agentA: string
	let agentB: string
	const names: Record<string, string> = {}

	async function list(query: string) {
		const res = await app.request(jsonGet(`/api/triggers${query}`, headers))
		expect(res.status).toBe(200)
		return {
			rows: (await res.json()) as Row[],
			total: Number(res.headers.get('x-total-count')),
		}
	}

	beforeEach(async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		headers = { 'x-workspace-id': ws.id }
		agentA = (await insertActor(db, { type: 'agent', name: 'Agent A' })).id
		agentB = (await insertActor(db, { type: 'agent', name: 'Agent B' })).id
		const seed = [
			['a-on', 'PR merge sweep', agentA, true],
			['a-off', 'Held PR sweep', agentA, false],
			['b-on', 'Daily heartbeat', agentB, true],
			['b-off', 'Weekly 100%_done review', agentB, false],
		] as const
		for (const [key, name, agent, enabled] of seed) {
			const row = await insertTrigger(db, ws.id, getTestActorId(), agent, { name, enabled })
			names[key] = row.id
		}
	})

	it('filters by target agent', async () => {
		const { rows, total } = await list(`?target_actor_id=${agentA}`)
		expect(rows.map((r) => r.id).sort()).toEqual([names['a-on'], names['a-off']].sort())
		expect(total).toBe(2)
	})

	it('filters by enabled and disabled', async () => {
		const on = await list('?enabled=true')
		expect(on.rows.map((r) => r.id).sort()).toEqual([names['a-on'], names['b-on']].sort())
		const off = await list('?enabled=false')
		expect(off.rows.map((r) => r.id).sort()).toEqual([names['a-off'], names['b-off']].sort())
	})

	it('filters by name, ignoring case', async () => {
		const { rows } = await list('?q=pr%20SWEEP')
		expect(rows.map((r) => r.id).sort()).toEqual([names['a-on'], names['a-off']].sort())
	})

	it('treats % and _ in q as plain characters', async () => {
		const literal = await list(`?q=${encodeURIComponent('100%_done')}`)
		expect(literal.rows.map((r) => r.id)).toEqual([names['b-off']])
		const wildcard = await list(`?q=${encodeURIComponent('%')}`)
		expect(wildcard.rows.map((r) => r.id)).toEqual([names['b-off']])
	})

	it('combines filters with AND', async () => {
		const { rows, total } = await list(`?target_actor_id=${agentA}&enabled=true&q=sweep`)
		expect(rows.map((r) => r.id)).toEqual([names['a-on']])
		expect(total).toBe(1)
	})

	it('returns nothing when the filters share no row', async () => {
		const { rows } = await list(`?target_actor_id=${agentB}&q=sweep`)
		expect(rows).toEqual([])
	})

	it('applies filters to a page, X-Total-Count and the cursor walk', async () => {
		const snapshot = encodeURIComponent(new Date(Date.now() + 60_000).toISOString())
		const base = `?target_actor_id=${agentA}&limit=1&order=asc&snapshot_at=${snapshot}`
		const first = await list(base)
		expect(first.rows).toHaveLength(1)
		// The total counts every match, not the page.
		expect(first.total).toBe(2)
		const last = first.rows[0]
		const second = await list(
			`${base}&cursor_created_at=${encodeURIComponent(last.createdAt)}&cursor_id=${last.id}`,
		)
		expect(second.rows).toHaveLength(1)
		expect([first.rows[0].id, second.rows[0].id].sort()).toEqual(
			[names['a-on'], names['a-off']].sort(),
		)
		const third = await list(
			`${base}&cursor_created_at=${encodeURIComponent(second.rows[0].createdAt)}&cursor_id=${second.rows[0].id}`,
		)
		expect(third.rows).toEqual([])
	})

	it('rejects a malformed filter value', async () => {
		for (const query of ['?target_actor_id=nope', '?enabled=maybe']) {
			const res = await app.request(jsonGet(`/api/triggers${query}`, headers))
			expect(res.status).toBe(400)
		}
	})
})
