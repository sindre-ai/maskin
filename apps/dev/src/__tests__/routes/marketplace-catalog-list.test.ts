import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { jsonGet } from '../helpers'
import { createTestApp } from '../setup'

const { default: marketplaceCatalogRoutes } = await import('../../routes/marketplace-catalog')

// ── Fixtures ────────────────────────────────────────────────────────────────
//
// The catalog list route runs, in order:
//   1. isWorkspaceMember  → SELECT from workspace_members
//   2. loadWorkspaceState → three parallel reads (integrations, human count,
//      installations); parallel calls consume the queue in the order Drizzle
//      dispatches them (see setup.ts). The mock is order-tolerant because
//      each queue entry is a full result set; we set them all in the order
//      the code awaits.
//   3. db.execute(CATALOG_UNION_SQL) — the UNION-ALL over the four kinds.
//      db.execute() returns `{ rows: [...] }` on node-postgres; the handler
//      accepts either shape.
//   4. loadWorkspaceState's db.execute() for installations returns { rows }.
//
// Route implementation calls select() in this dispatched order:
//   1. isWorkspaceMember (select rows returned)
//   2. integrations select
//   3. human count select
// db.execute is separate — mocked below.

function catalogRow(overrides: Partial<Record<string, unknown>> = {}) {
	return {
		item_kind: 'loop',
		catalog_id: randomUUID(),
		slug: 'customer-conversations',
		display_name: 'Customer Conversations',
		outcome_line: 'read + triage inbound conversations',
		description: 'Long description',
		team: 'customer',
		requires: { integrations: [] },
		recommendation: {},
		status: 'published',
		sort_weight: 0,
		install_count: 10,
		loop_definition: { steps_summary: '3 steps', ins: ['slack'], outs: ['inbox'], cadence: 'hourly' },
		skill_slugs: null,
		trigger_seeds: null,
		...overrides,
	}
}

function mockDbWithExecute(rawCatalogRows: unknown[], installationsRows: unknown[] = []) {
	const { app, db, mockResults } = createTestApp(marketplaceCatalogRoutes, '/api/marketplace')

	// Membership check, integrations connected, human count.
	mockResults.selectQueue = [
		[{ actorId: 'test-actor-id' }],           // isWorkspaceMember
		[{ provider: 'slack' }],                  // connected integrations
		[{ n: 2 }],                               // human count
	]

	// Two db.execute calls: (a) installations lookup, (b) the UNION-ALL.
	// Drizzle's Proxy in setup.ts doesn't stub `execute`; patch it inline.
	const executeQueue = [
		{ rows: installationsRows },
		{ rows: rawCatalogRows },
	]
	;(db as unknown as { execute: (q: unknown) => Promise<unknown> }).execute = async () => {
		return executeQueue.shift() ?? { rows: [] }
	}

	return { app, db, mockResults }
}

describe('GET /api/marketplace/catalog', () => {
	it('returns bands + team_grid + next_cursor with the spec §6.1 shape', async () => {
		const loopA = catalogRow({ slug: 'loop-a', display_name: 'Loop A', install_count: 20 })
		const loopB = catalogRow({ slug: 'loop-b', display_name: 'Loop B', install_count: 5 })
		const agent = catalogRow({
			item_kind: 'agent',
			slug: 'agent-a',
			display_name: 'Agent A',
			team: 'engineering',
			install_count: 15,
			loop_definition: null,
			skill_slugs: ['s1', 's2'],
			trigger_seeds: ['t1'],
		})
		const skill = catalogRow({
			item_kind: 'skill',
			slug: 'skill-a',
			display_name: 'Skill A',
			team: 'shared',
			install_count: 3,
			loop_definition: null,
		})
		const mcp = catalogRow({
			item_kind: 'mcp_server',
			slug: 'linear',
			display_name: 'Linear MCP',
			team: 'engineering',
			install_count: 30,
			loop_definition: null,
		})

		const { app } = mockDbWithExecute([loopA, loopB, agent, skill, mcp])

		const res = await app.request(
			jsonGet('/api/marketplace/catalog', { 'x-workspace-id': randomUUID() }),
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			bands: {
				recommended: unknown[]
				popular_loops: Array<{ slug: string }>
				top_agents: Array<{ slug: string }>
				most_installed_tools: Array<{ slug: string }>
			}
			team_grid: Array<{ slug: string; item_kind: string }>
			next_cursor: string | null
		}

		expect(body.bands.popular_loops.map((c) => c.slug)).toEqual(['loop-a', 'loop-b'])
		expect(body.bands.top_agents.map((c) => c.slug)).toEqual(['agent-a'])
		expect(body.bands.most_installed_tools.map((c) => c.slug)).toEqual(['linear'])
		// No recommendation bundles → recommended band empty.
		expect(body.bands.recommended).toEqual([])
		// team_grid unfiltered contains all five, ranked by sort_weight+install_count.
		expect(body.team_grid).toHaveLength(5)
		expect(body.team_grid[0].slug).toBe('linear') // 30 installs
		expect(body.next_cursor).toBeNull()
	})

	it('team filter applies "team = $1 OR team = \'shared\'" per §5.1', async () => {
		const customerLoop = catalogRow({ slug: 'c1', team: 'customer' })
		const engineeringLoop = catalogRow({ slug: 'e1', team: 'engineering' })
		const sharedLoop = catalogRow({ slug: 's1', team: 'shared' })
		const { app } = mockDbWithExecute([customerLoop, engineeringLoop, sharedLoop])

		const res = await app.request(
			jsonGet('/api/marketplace/catalog?team=customer', { 'x-workspace-id': randomUUID() }),
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as { team_grid: Array<{ slug: string }> }
		// customer + shared, NOT engineering.
		expect(body.team_grid.map((c) => c.slug).sort()).toEqual(['c1', 's1'])
	})

	it('item_kind filter narrows team_grid but leaves bands intact', async () => {
		const loop = catalogRow({ slug: 'l1', install_count: 5 })
		const agent = catalogRow({
			item_kind: 'agent',
			slug: 'a1',
			install_count: 10,
			loop_definition: null,
			skill_slugs: [],
			trigger_seeds: [],
		})
		const { app } = mockDbWithExecute([loop, agent])

		const res = await app.request(
			jsonGet('/api/marketplace/catalog?item_kind=agent', { 'x-workspace-id': randomUUID() }),
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			bands: { popular_loops: Array<{ slug: string }>; top_agents: Array<{ slug: string }> }
			team_grid: Array<{ slug: string; item_kind: string }>
		}
		expect(body.team_grid.map((c) => c.slug)).toEqual(['a1'])
		// Bands are computed off the full catalog, not the filtered grid.
		expect(body.bands.popular_loops.map((c) => c.slug)).toEqual(['l1'])
		expect(body.bands.top_agents.map((c) => c.slug)).toEqual(['a1'])
	})

	it('include_recommended=false suppresses the recommended band', async () => {
		const loop = catalogRow({
			slug: 'l1',
			recommendation: {
				rules: [{ when: { workspace_has_integration: ['slack'] }, why: 'you use slack' }],
			},
		})
		const { app } = mockDbWithExecute([loop])

		const res = await app.request(
			jsonGet('/api/marketplace/catalog?include_recommended=false', {
				'x-workspace-id': randomUUID(),
			}),
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as { bands: { recommended: unknown[] } }
		expect(body.bands.recommended).toEqual([])
	})

	it('populates installed_installation_id when the workspace has a live install', async () => {
		const catalogId = randomUUID()
		const installationId = randomUUID()
		const loop = catalogRow({ catalog_id: catalogId, slug: 'customer-conversations' })
		const installations = [
			{
				installation_id: installationId,
				item_kind: 'loop',
				catalog_slug: 'customer-conversations',
				display_name: 'Customer Conversations',
			},
		]
		const { app } = mockDbWithExecute([loop], installations)

		const res = await app.request(
			jsonGet('/api/marketplace/catalog', { 'x-workspace-id': randomUUID() }),
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			team_grid: Array<{ installed_installation_id?: string; slug: string }>
		}
		const card = body.team_grid.find((c) => c.slug === 'customer-conversations')
		expect(card?.installed_installation_id).toBe(installationId)
	})

	it('paginates team_grid via limit + cursor (base64 offset)', async () => {
		const rows = Array.from({ length: 5 }, (_, i) =>
			catalogRow({ slug: `l${i}`, install_count: 100 - i }),
		)
		const { app } = mockDbWithExecute(rows)

		const wsId = randomUUID()
		const res1 = await app.request(
			jsonGet('/api/marketplace/catalog?limit=2', { 'x-workspace-id': wsId }),
		)
		expect(res1.status).toBe(200)
		const body1 = (await res1.json()) as { team_grid: Array<{ slug: string }>; next_cursor: string | null }
		expect(body1.team_grid.map((c) => c.slug)).toEqual(['l0', 'l1'])
		expect(body1.next_cursor).toBeTruthy()

		const { app: app2 } = mockDbWithExecute(rows)
		const res2 = await app2.request(
			jsonGet(`/api/marketplace/catalog?limit=2&cursor=${encodeURIComponent(body1.next_cursor as string)}`, {
				'x-workspace-id': wsId,
			}),
		)
		expect(res2.status).toBe(200)
		const body2 = (await res2.json()) as { team_grid: Array<{ slug: string }>; next_cursor: string | null }
		expect(body2.team_grid.map((c) => c.slug)).toEqual(['l2', 'l3'])
		expect(body2.next_cursor).toBeTruthy()
	})

	it('renders WHY lines with placeholder resolution on matching cards', async () => {
		const loop = catalogRow({
			slug: 'closer',
			install_count: 1,
			recommendation: {
				score_boost: 100,
				rules: [
					{
						when: { workspace_has_integration: ['slack'] },
						why: 'you use {matched_integration} — this reads it',
					},
				],
			},
		})
		const { app } = mockDbWithExecute([loop])

		const res = await app.request(
			jsonGet('/api/marketplace/catalog', { 'x-workspace-id': randomUUID() }),
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			bands: { recommended: Array<{ slug: string; why_line?: string }> }
			team_grid: Array<{ slug: string; why_line?: string }>
		}
		const rec = body.bands.recommended.find((c) => c.slug === 'closer')
		expect(rec?.why_line).toBe('you use slack — this reads it')
		expect(body.team_grid[0]?.why_line).toBe('you use slack — this reads it')
	})

	it('returns 400 when X-Workspace-Id header is missing', async () => {
		const { app } = createTestApp(marketplaceCatalogRoutes, '/api/marketplace')
		const res = await app.request(jsonGet('/api/marketplace/catalog'))
		expect(res.status).toBe(400)
	})

	it('returns 403 when the actor is not a member of the workspace', async () => {
		const { app, mockResults } = createTestApp(marketplaceCatalogRoutes, '/api/marketplace')
		mockResults.selectQueue = [[]] // isWorkspaceMember → no row → not a member
		const res = await app.request(
			jsonGet('/api/marketplace/catalog', { 'x-workspace-id': randomUUID() }),
		)
		expect(res.status).toBe(403)
	})
})

describe('GET /api/marketplace/items/{item_kind}/{catalog_id}', () => {
	it('returns the full card + description + rendered requires_status', async () => {
		const catalogId = randomUUID()
		const loop = catalogRow({
			catalog_id: catalogId,
			slug: 'customer-conversations',
			requires: { integrations: ['slack', 'github'], mcp_installations: ['linear'] },
		})
		// Route calls loadWorkspaceState (execute #1 = installations) then a
		// second execute for the detail row. Wire two executes in order.
		const { app, mockResults, db } = createTestApp(marketplaceCatalogRoutes, '/api/marketplace')
		mockResults.selectQueue = [
			[{ actorId: 'test-actor-id' }], // isWorkspaceMember
			[{ provider: 'slack' }],          // integrations
			[{ n: 1 }],                       // human count
		]
		const executeQueue: unknown[] = [
			{ rows: [] },       // installations
			{ rows: [loop] },   // detail row
		]
		;(db as unknown as { execute: (q: unknown) => Promise<unknown> }).execute = async () => {
			return executeQueue.shift() ?? { rows: [] }
		}

		const res = await app.request(
			jsonGet(`/api/marketplace/items/loop/${catalogId}`, { 'x-workspace-id': randomUUID() }),
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			slug: string
			description: string
			requires_status: {
				integrations: Array<{ slug: string; connected: boolean }>
				mcp_installations: Array<{ slug: string; installed: boolean }>
			}
		}
		expect(body.slug).toBe('customer-conversations')
		expect(body.description).toBe('Long description')
		expect(body.requires_status.integrations).toEqual([
			{ slug: 'slack', connected: true },
			{ slug: 'github', connected: false },
		])
		expect(body.requires_status.mcp_installations).toEqual([
			{ slug: 'linear', installed: false },
		])
	})

	it('returns 404 when the item is missing', async () => {
		const { app, mockResults, db } = createTestApp(marketplaceCatalogRoutes, '/api/marketplace')
		mockResults.selectQueue = [
			[{ actorId: 'test-actor-id' }],
			[],
			[{ n: 0 }],
		]
		const executeQueue: unknown[] = [{ rows: [] }, { rows: [] }]
		;(db as unknown as { execute: (q: unknown) => Promise<unknown> }).execute = async () => {
			return executeQueue.shift() ?? { rows: [] }
		}

		const res = await app.request(
			jsonGet(`/api/marketplace/items/loop/${randomUUID()}`, { 'x-workspace-id': randomUUID() }),
		)
		expect(res.status).toBe(404)
	})

	it('returns 400 on an unknown item_kind (Zod enum validation)', async () => {
		const { app } = createTestApp(marketplaceCatalogRoutes, '/api/marketplace')
		const res = await app.request(
			jsonGet(`/api/marketplace/items/widget/${randomUUID()}`, {
				'x-workspace-id': randomUUID(),
			}),
		)
		expect(res.status).toBe(400)
	})
})
