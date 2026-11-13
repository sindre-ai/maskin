import { events } from '@maskin/db/schema'
import { beforeEach, describe, expect, it } from 'vitest'
import { insertActor, insertObject, insertTrigger, insertWorkspace } from '../factories'
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
		const { rows } = await list('?q=SWEEP')
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

describe('GET /api/triggers — q matches everything except the prompt', () => {
	const app = createIntegrationApp({ path: '/api/triggers', module: triggersRoutes })
	let headers: Record<string, string>
	let workspaceId: string
	let rune: string
	let coach: string
	const ids: Record<string, string> = {}

	async function ids_(query: string) {
		const res = await app.request(jsonGet(`/api/triggers${query}`, headers))
		expect(res.status).toBe(200)
		return ((await res.json()) as Array<{ id: string }>).map((r) => r.id).sort()
	}

	beforeEach(async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		workspaceId = ws.id
		headers = { 'x-workspace-id': ws.id }
		rune = (await insertActor(db, { type: 'agent', name: 'Rune Værk' })).id
		coach = (await insertActor(db, { type: 'agent', name: 'Workspace Coach' })).id
		const seed = [
			[
				'hourly',
				'Calling run',
				rune,
				'cron',
				{ expression: '0 * * * *' },
				'Ring the secret-word list',
			],
			[
				'once',
				'Call Hans',
				rune,
				'reminder',
				{ scheduled_at: '2030-11-10T09:00:00.000Z' },
				'Phone Hans',
			],
			[
				'event',
				'On new insight',
				coach,
				'event',
				{ entity_type: 'insight', action: 'created' },
				'Triage it',
			],
		] as const
		for (const [key, name, agent, type, config, actionPrompt] of seed) {
			const row = await insertTrigger(db, ws.id, getTestActorId(), agent, {
				name,
				type,
				config,
				actionPrompt,
			})
			ids[key] = row.id
		}
	})

	it('finds a trigger by agent name, agent id and kind', async () => {
		expect(await ids_('?q=rune')).toEqual([ids.hourly, ids.once].sort())
		expect(await ids_(`?q=${coach}`)).toEqual([ids.event])
		expect(await ids_('?q=recurring')).toEqual([ids.hourly])
		expect(await ids_('?q=one-time')).toEqual([ids.once])
		expect(await ids_('?q=event')).toEqual([ids.event])
	})

	it('finds a trigger by status and by schedule', async () => {
		expect(await ids_('?q=enabled')).toHaveLength(3)
		expect(await ids_('?q=disabled')).toEqual([])
		expect(await ids_(`?q=${encodeURIComponent('0 * * * *')}`)).toEqual([ids.hourly])
		expect(await ids_('?q=2030-11-10')).toEqual([ids.once])
	})

	it('requires every word to match', async () => {
		expect(await ids_('?q=rune%20recurring')).toEqual([ids.hourly])
		expect(await ids_('?q=rune%20insight')).toEqual([])
	})

	it('finds a trigger by the name of a loop it is a step of', async () => {
		await insertObject(db, workspaceId, getTestActorId(), {
			type: 'loop',
			title: 'Cold calling',
			status: 'live',
			metadata: { trigger_ids: [ids.hourly] },
		})
		expect(await ids_('?q=cold%20calling')).toEqual([ids.hourly])
	})

	it('does not match the prompt', async () => {
		expect(await ids_('?q=secret-word')).toEqual([])
	})

	it('adds lastRunAt only when asked, and null when the trigger never fired', async () => {
		await db.insert(events).values({
			workspaceId,
			actorId: rune,
			action: 'trigger_fired',
			entityType: 'trigger',
			entityId: ids.hourly,
			createdAt: new Date('2026-11-10T08:00:00.000Z'),
		})
		const plain = await app.request(jsonGet('/api/triggers', headers))
		expect(((await plain.json()) as Array<Record<string, unknown>>)[0]).not.toHaveProperty(
			'lastRunAt',
		)
		const res = await app.request(jsonGet('/api/triggers?include_last_run=true', headers))
		const rows = (await res.json()) as Array<{ id: string; lastRunAt: string | null }>
		expect(rows.find((r) => r.id === ids.hourly)?.lastRunAt).toBe('2026-11-10T08:00:00.000Z')
		expect(rows.find((r) => r.id === ids.once)?.lastRunAt).toBeNull()
	})
})

describe('GET /api/triggers/:id', () => {
	const app = createIntegrationApp({ path: '/api/triggers', module: triggersRoutes })

	it('returns the full trigger with its prompt and last run', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const headers = { 'x-workspace-id': ws.id }
		const agent = (await insertActor(db, { type: 'agent', name: 'Rune Værk' })).id
		const row = await insertTrigger(db, ws.id, getTestActorId(), agent, {
			name: 'Calling run',
			actionPrompt: 'Ring the list',
		})
		await db.insert(events).values({
			workspaceId: ws.id,
			actorId: agent,
			action: 'trigger_fired',
			entityType: 'trigger',
			entityId: row.id,
			createdAt: new Date('2026-11-10T08:00:00.000Z'),
		})

		const res = await app.request(jsonGet(`/api/triggers/${row.id}`, headers))
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({
			id: row.id,
			name: 'Calling run',
			actionPrompt: 'Ring the list',
			lastRunAt: '2026-11-10T08:00:00.000Z',
		})
	})

	it('is 404 for an unknown id and for a trigger in another workspace', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const other = await insertWorkspace(db, getTestActorId())
		const agent = (await insertActor(db, { type: 'agent', name: 'Agent' })).id
		const row = await insertTrigger(db, other.id, getTestActorId(), agent)
		const headers = { 'x-workspace-id': ws.id }

		const elsewhere = await app.request(jsonGet(`/api/triggers/${row.id}`, headers))
		expect(elsewhere.status).toBe(404)
		const missing = await app.request(
			jsonGet('/api/triggers/00000000-0000-4000-8000-000000000000', headers),
		)
		expect(missing.status).toBe(404)
	})
})
