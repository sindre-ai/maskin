import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { beforeEach, describe, expect, it } from 'vitest'
import { USAGE_BREAKDOWN_MAX_ROWS } from '../../lib/billing-usage-breakdown'
import { createApiError, formatZodError } from '../../lib/errors'
import type { WorkspaceSettings } from '../../lib/types'
import {
	insertActor,
	insertObject,
	insertRelationship,
	insertSession,
	insertTrigger,
	insertWorkspace,
} from '../factories'
import { jsonGet } from '../helpers'
import { db, getTestActorId } from './global-setup'

const { default: billingRoutes } = await import('../../routes/billing')

type Env = { Variables: { db: Database; actorId: string; actorType: string } }

type Row = { id: string | null; name: string; usd_cents: number }
type Split = { rows: Row[]; other_usd_cents: number }
type Breakdown = {
	usd_cents_used: number
	by_model: Split
	by_agent: Split
	by_flow: Split
}

const PERIOD_START_SEC = 1_700_000_000
const IN_PERIOD = new Date(PERIOD_START_SEC * 1000 + 60_000)
const BEFORE_PERIOD = new Date(PERIOD_START_SEC * 1000 - 60_000)

const billingSettings = {
	billing: {
		plan: 'pro',
		status: 'active',
		hard_cap_usd_cents: 100_000,
		period_start: PERIOD_START_SEC,
		stripe_customer_id: 'cus_test',
	},
} as WorkspaceSettings

function makeApp(actorId: string) {
	const app = new OpenAPIHono<Env>({
		defaultHook: (result, c) => {
			if (!result.success) {
				return c.json(
					createApiError(
						'VALIDATION_ERROR',
						'Request validation failed',
						formatZodError(result.error),
					),
					400,
				)
			}
			return undefined
		},
	})
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('actorType', 'human')
		await next()
	})
	app.route('/api/billing', billingRoutes)
	return app
}

const sum = (split: Split) =>
	split.rows.reduce((a, r) => a + r.usd_cents, 0) + split.other_usd_cents

describe('GET /api/billing/usage/breakdown (Integration)', () => {
	let workspaceId: string
	let actorId: string
	let app: ReturnType<typeof makeApp>

	beforeEach(async () => {
		actorId = getTestActorId()
		// The factory grants enterprise by default, which is not metered at all.
		const ws = await insertWorkspace(db, actorId, {
			enterpriseGranted: false,
			settings: billingSettings,
		})
		workspaceId = ws.id
		app = makeApp(actorId)
	})

	function seedSession(overrides: Record<string, unknown> = {}, forWorkspace = workspaceId) {
		return insertSession(db, forWorkspace, (overrides.actorId as string) ?? actorId, actorId, {
			status: 'completed',
			config: { llm_route: 'maskin_plan' },
			totalCostUsd: '0.50',
			createdAt: IN_PERIOD,
			...overrides,
		})
	}

	async function breakdown(): Promise<Breakdown> {
		const res = await app.request(
			jsonGet('/api/billing/usage/breakdown', { 'x-workspace-id': workspaceId }),
		)
		expect(res.status).toBe(200)
		return (await res.json()) as Breakdown
	}

	async function usageTotal(): Promise<number> {
		const res = await app.request(jsonGet('/api/billing/usage', { 'x-workspace-id': workspaceId }))
		expect(res.status).toBe(200)
		return ((await res.json()) as { usd_cents_used: number }).usd_cents_used
	}

	it('returns zero and empty splits for a period with no usage', async () => {
		// Spend before the period and on another route must not count either.
		await seedSession({ createdAt: BEFORE_PERIOD })
		await seedSession({ config: { llm_route: 'claude_oauth' } })

		const body = await breakdown()

		expect(body).toEqual({
			usd_cents_used: 0,
			by_model: { rows: [], other_usd_cents: 0 },
			by_agent: { rows: [], other_usd_cents: 0 },
			by_flow: { rows: [], other_usd_cents: 0 },
		})
		expect(await usageTotal()).toBe(0)
	})

	it('returns 404 for a workspace that does not exist', async () => {
		const res = await app.request(
			jsonGet('/api/billing/usage/breakdown', {
				'x-workspace-id': '00000000-0000-4000-8000-000000000000',
			}),
		)
		expect(res.status).toBe(404)
	})

	it('adds every split up to usd_cents_used, and usd_cents_used matches the usage read', async () => {
		const other = await insertActor(db, { type: 'agent', name: 'Zed' })
		// Sub-cent figures: rounding each group up on its own would overshoot the total.
		await seedSession({ totalCostUsd: '0.0033', modelName: 'model/a' })
		await seedSession({ totalCostUsd: '0.0033', modelName: 'model/b', actorId: other.id })
		await seedSession({ totalCostUsd: '0.0033', modelName: 'model/c' })
		await seedSession({ totalCostUsd: '1.2345', modelName: 'model/a', actorId: other.id })
		// Token-rate fallback for a session that never reported a cost.
		await seedSession({ totalCostUsd: null, inputTokens: 300_000, outputTokens: 100_000 })
		// Another workspace's spend never leaks in.
		const otherWs = await insertWorkspace(db, actorId, { enterpriseGranted: false })
		await seedSession({ totalCostUsd: '99.00' }, otherWs.id)

		const body = await breakdown()

		expect(body.usd_cents_used).toBe(await usageTotal())
		expect(body.usd_cents_used).toBeGreaterThan(0)
		expect(sum(body.by_model)).toBe(body.usd_cents_used)
		expect(sum(body.by_agent)).toBe(body.usd_cents_used)
		expect(sum(body.by_flow)).toBe(body.usd_cents_used)
		expect(body.by_agent.rows.map((r) => r.name)).toContain('Zed')
		// The session with no model name is shown, not dropped.
		expect(body.by_model.rows.some((r) => r.id === null && r.name === 'Unknown model')).toBe(true)
		// Sorted by spend, biggest first.
		const cents = body.by_model.rows.map((r) => r.usd_cents)
		expect(cents).toEqual([...cents].sort((a, b) => b - a))
	})

	it('puts a session in the flow that lists its trigger, else the flow its source item is in', async () => {
		const agent = await insertActor(db, { type: 'agent', name: 'Worker' })
		const trigger = await insertTrigger(db, workspaceId, actorId, agent.id)
		const viaTrigger = await insertObject(db, workspaceId, actorId, {
			type: 'loop',
			status: 'active',
			title: 'Outbound',
			metadata: { trigger_ids: [trigger.id] },
		})
		const viaEdge = await insertObject(db, workspaceId, actorId, {
			type: 'loop',
			status: 'active',
			title: 'Support',
		})
		const item = await insertObject(db, workspaceId, actorId, { type: 'task', title: 'Ticket' })
		await insertRelationship(db, actorId, {
			sourceType: 'object',
			sourceId: viaEdge.id,
			targetType: 'object',
			targetId: item.id,
			type: 'in_loop',
		})

		await seedSession({ totalCostUsd: '3.00', triggerId: trigger.id })
		// Trigger wins over the item's flow when both could apply.
		await seedSession({
			totalCostUsd: '1.00',
			triggerId: trigger.id,
			initiatedFromObjectId: item.id,
		})
		await seedSession({ totalCostUsd: '2.00', initiatedFromObjectId: item.id })
		await seedSession({ totalCostUsd: '0.50' })

		const { by_flow } = await breakdown()

		expect(by_flow.rows).toEqual([
			{ id: viaTrigger.id, name: 'Outbound', usd_cents: 400 },
			{ id: viaEdge.id, name: 'Support', usd_cents: 200 },
			{ id: null, name: 'No flow', usd_cents: 50 },
		])
		expect(by_flow.other_usd_cents).toBe(0)
	})

	it('counts a session once when its item sits in two flows', async () => {
		const first = await insertObject(db, workspaceId, actorId, { type: 'loop', title: 'A' })
		const second = await insertObject(db, workspaceId, actorId, { type: 'loop', title: 'B' })
		const item = await insertObject(db, workspaceId, actorId, { type: 'task' })
		for (const loop of [first, second]) {
			await insertRelationship(db, actorId, {
				sourceType: 'object',
				sourceId: loop.id,
				targetType: 'object',
				targetId: item.id,
				type: 'in_loop',
			})
		}
		await seedSession({ totalCostUsd: '1.00', initiatedFromObjectId: item.id })

		const body = await breakdown()

		expect(body.by_flow.rows).toHaveLength(1)
		expect(sum(body.by_flow)).toBe(body.usd_cents_used)
	})

	it('caps each split at the top rows and folds the rest into other', async () => {
		const extra = 3
		for (let i = 0; i < USAGE_BREAKDOWN_MAX_ROWS + extra; i++) {
			// model-00 is the cheapest, so it and its neighbours land in other.
			await seedSession({
				modelName: `model/m${String(i).padStart(2, '0')}`,
				totalCostUsd: String(1 + i),
			})
		}

		const body = await breakdown()

		expect(body.by_model.rows).toHaveLength(USAGE_BREAKDOWN_MAX_ROWS)
		expect(body.by_model.rows[0]?.id).toBe(`model/m${USAGE_BREAKDOWN_MAX_ROWS + extra - 1}`)
		// The three cheapest models: $1 + $2 + $3.
		expect(body.by_model.other_usd_cents).toBe(600)
		expect(sum(body.by_model)).toBe(body.usd_cents_used)
	})

	it('reports nothing for an enterprise workspace, as the usage read does', async () => {
		const ws = await insertWorkspace(db, actorId, { enterpriseGranted: true })
		await seedSession({ totalCostUsd: '5.00' }, ws.id)
		workspaceId = ws.id

		const body = await breakdown()

		expect(body.usd_cents_used).toBe(0)
		expect(body.by_model).toEqual({ rows: [], other_usd_cents: 0 })
		expect(await usageTotal()).toBe(0)
	})
})
