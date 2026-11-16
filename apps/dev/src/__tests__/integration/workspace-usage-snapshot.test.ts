import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetPosthogEventBudgetForTesting } from '../../lib/analytics/event-budget'
import {
	__resetPosthogPrivacyForTesting,
	configurePosthogPrivacy,
} from '../../lib/analytics/posthog'
import { createApiError, formatZodError } from '../../lib/errors'
import type { WorkspaceSettings } from '../../lib/types'
import {
	WORKSPACE_USAGE_SNAPSHOT_EVENT,
	WorkspaceUsageSnapshotScheduler,
	readUsageSnapshot,
	readUsageSnapshots,
	sendUsageSnapshot,
} from '../../services/workspace-usage-snapshot'
import { insertActor, insertSession, insertWorkspace } from '../factories'
import { jsonGet } from '../helpers'
import { db, getTestActorId } from './global-setup'

const { default: billingRoutes } = await import('../../routes/billing')

type Env = { Variables: { db: Database; actorId: string; actorType: string } }

const DAY = '2026-11-16'
const PERIOD_START_SEC = Math.floor(Date.now() / 1000) - 5 * 24 * 3600
const IN_PERIOD = new Date(Date.now() - 3600_000)
const BEFORE_PERIOD = new Date((PERIOD_START_SEC - 3600) * 1000)

function billing(overrides: Record<string, unknown> = {}): WorkspaceSettings {
	return {
		billing: {
			plan: 'pro',
			status: 'active',
			hard_cap_usd_cents: 1000,
			period_start: PERIOD_START_SEC,
			...overrides,
		},
	} as WorkspaceSettings
}

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

describe('workspace_usage_snapshot (Integration)', () => {
	let humanId: string
	let agentId: string
	let fetchMock: ReturnType<typeof vi.fn>

	beforeEach(async () => {
		humanId = getTestActorId()
		agentId = (await insertActor(db, { type: 'agent' })).id
		__resetPosthogEventBudgetForTesting()
		fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response)
		vi.stubGlobal('fetch', fetchMock)
		vi.stubEnv('POSTHOG_API_KEY', 'phc_test')
		configurePosthogPrivacy(db)
	})

	afterEach(() => {
		__resetPosthogPrivacyForTesting()
		vi.unstubAllGlobals()
		vi.unstubAllEnvs()
	})

	// The factory grants enterprise by default, which is not metered at all.
	async function workspace(settings: WorkspaceSettings = billing()) {
		const ws = await insertWorkspace(db, humanId, { enterpriseGranted: false, settings })
		return ws.id
	}

	function seedSession(workspaceId: string, overrides: Record<string, unknown> = {}) {
		return insertSession(db, workspaceId, agentId, humanId, {
			status: 'completed',
			config: { llm_route: 'maskin_plan' },
			totalCostUsd: '2.50',
			inputTokens: 1_000,
			outputTokens: 400,
			createdAt: IN_PERIOD,
			...overrides,
		})
	}

	// What reached PostHog for one workspace.
	function sentFor(workspaceId: string) {
		return fetchMock.mock.calls
			.map(([, init]) => JSON.parse((init as RequestInit).body as string))
			.filter(
				(body) =>
					body.event === WORKSPACE_USAGE_SNAPSHOT_EVENT &&
					body.properties.workspace_id === workspaceId,
			)
	}

	async function claims(workspaceId: string) {
		return db
			.select()
			.from(events)
			.where(
				and(eq(events.workspaceId, workspaceId), eq(events.action, WORKSPACE_USAGE_SNAPSHOT_EVENT)),
			)
	}

	it('sends the percent and tokens the usage page shows for the same workspace', async () => {
		const workspaceId = await workspace()
		await seedSession(workspaceId)
		await seedSession(workspaceId, { totalCostUsd: '1.00', inputTokens: 600, outputTokens: 100 })
		// Spend before the period does not count, here or on the usage page.
		await seedSession(workspaceId, { createdAt: BEFORE_PERIOD, totalCostUsd: '9.00' })

		expect(await sendUsageSnapshot(db, workspaceId, DAY)).toBe(true)

		const [body] = sentFor(workspaceId)
		const res = await makeApp(humanId).request(
			jsonGet('/api/billing/usage', { 'x-workspace-id': workspaceId }),
		)
		const usage = (await res.json()) as {
			usd_cents_used: number
			hard_cap_usd_cents: number
			period_start: number
		}
		expect(usage.usd_cents_used).toBe(350)
		expect(body.distinct_id).toBe(workspaceId)
		expect(body.properties).toMatchObject({
			workspace_id: workspaceId,
			plan: 'pro',
			period_start: usage.period_start,
			usd_cents_used: usage.usd_cents_used,
			plan_limit_usd_cents: usage.hard_cap_usd_cents,
			usage_percent: 35,
			input_tokens: 1_600,
			output_tokens: 500,
			session_count: 2,
		})
		expect(await claims(workspaceId)).toHaveLength(1)
	})

	it('reads 0 percent for a trace of use against a large plan', async () => {
		const workspaceId = await workspace(billing({ hard_cap_usd_cents: 100_000 }))
		await seedSession(workspaceId, { totalCostUsd: '0.01' })

		const snapshot = await readUsageSnapshot(db, workspaceId)

		expect(snapshot).toMatchObject({ usd_cents_used: 1, usage_percent: 0 })
	})

	it('caps the percent at 100 over the limit, as the app does, and keeps the dollars', async () => {
		const workspaceId = await workspace()
		await seedSession(workspaceId, { totalCostUsd: '15.00' })

		const snapshot = await readUsageSnapshot(db, workspaceId)

		expect(snapshot).toMatchObject({ usd_cents_used: 1500, plan_limit_usd_cents: 1000 })
		expect(snapshot?.usage_percent).toBe(100)
	})

	it('sends nothing for a workspace with no plan usage in its period', async () => {
		const workspaceId = await workspace()
		await seedSession(workspaceId, { createdAt: BEFORE_PERIOD })
		await seedSession(workspaceId, { config: { llm_route: 'claude_oauth' } })

		expect(await sendUsageSnapshot(db, workspaceId, DAY)).toBe(false)

		expect(sentFor(workspaceId)).toHaveLength(0)
		expect(await claims(workspaceId)).toHaveLength(0)
	})

	it('sends nothing for an enterprise workspace, which is not metered', async () => {
		const ws = await insertWorkspace(db, humanId, { enterpriseGranted: true, settings: {} })
		await seedSession(ws.id)

		expect(await sendUsageSnapshot(db, ws.id, DAY)).toBe(false)
		expect(sentFor(ws.id)).toHaveLength(0)
	})

	it('sends nothing for a workspace that switched share usage off', async () => {
		const workspaceId = await workspace({
			...billing(),
			privacy: { share_usage: false },
		} as WorkspaceSettings)
		await seedSession(workspaceId)

		await sendUsageSnapshot(db, workspaceId, DAY)

		expect(sentFor(workspaceId)).toHaveLength(0)
		// Skipped on purpose, so a retry would skip again: the day stays claimed.
		expect(await claims(workspaceId)).toHaveLength(1)
	})

	it('gives the day back when PostHog refuses the send, so the next try sends it', async () => {
		const workspaceId = await workspace()
		await seedSession(workspaceId)
		fetchMock.mockResolvedValueOnce({ ok: false, status: 500 } as Response)

		expect(await sendUsageSnapshot(db, workspaceId, DAY)).toBe(false)
		expect(await claims(workspaceId)).toHaveLength(0)

		expect(await sendUsageSnapshot(db, workspaceId, DAY)).toBe(true)
		expect(await claims(workspaceId)).toHaveLength(1)
		expect(sentFor(workspaceId)).toHaveLength(2)
	})

	it('the daily job retries a failed send on its next tick, then stops', async () => {
		const workspaceId = await workspace()
		await seedSession(workspaceId)
		const scheduler = new WorkspaceUsageSnapshotScheduler(db)
		const now = new Date('2026-11-18T10:00:00Z')
		fetchMock.mockRejectedValueOnce(new Error('network down'))

		expect(await scheduler.tick(now)).toBe(0)
		expect(await scheduler.tick(now)).toBe(1)
		expect(await scheduler.tick(now)).toBe(0)

		expect(sentFor(workspaceId)).toHaveLength(2)
		expect(await claims(workspaceId)).toHaveLength(1)
	})

	it('reads many workspaces at once, each over its own period, as the usage page does', async () => {
		const longPeriod = await workspace(billing({ period_start: PERIOD_START_SEC - 20 * 24 * 3600 }))
		const shortPeriod = await workspace(billing({ hard_cap_usd_cents: 500 }))
		for (const id of [longPeriod, shortPeriod]) {
			await seedSession(id)
			// 10 days back: inside the long period only.
			await seedSession(id, { createdAt: new Date(Date.now() - 10 * 24 * 3600_000) })
		}

		const snapshots = await readUsageSnapshots(db, [longPeriod, shortPeriod])

		for (const id of [longPeriod, shortPeriod]) {
			const res = await makeApp(humanId).request(
				jsonGet('/api/billing/usage', { 'x-workspace-id': id }),
			)
			const usage = (await res.json()) as { usd_cents_used: number; hard_cap_usd_cents: number }
			expect(snapshots.get(id)).toMatchObject({
				usd_cents_used: usage.usd_cents_used,
				plan_limit_usd_cents: usage.hard_cap_usd_cents,
			})
		}
		expect(snapshots.get(longPeriod)).toMatchObject({ usd_cents_used: 500, session_count: 2 })
		expect(snapshots.get(shortPeriod)).toMatchObject({ usd_cents_used: 250, session_count: 1 })
	})

	it('sends one snapshot per workspace per day, however often it is asked', async () => {
		const workspaceId = await workspace()
		await seedSession(workspaceId)

		expect(await sendUsageSnapshot(db, workspaceId, DAY)).toBe(true)
		expect(await sendUsageSnapshot(db, workspaceId, DAY)).toBe(false)
		const [first, second] = await Promise.all([
			sendUsageSnapshot(db, workspaceId, '2026-11-17'),
			sendUsageSnapshot(db, workspaceId, '2026-11-17'),
		])

		expect([first, second].filter(Boolean)).toHaveLength(1)
		expect(sentFor(workspaceId)).toHaveLength(2)
		expect(await claims(workspaceId)).toHaveLength(2)
	})

	it('the daily job finds an active workspace once, and a restarted job does not resend it', async () => {
		const workspaceId = await workspace()
		await seedSession(workspaceId)
		const now = new Date('2026-11-18T10:00:00Z')

		await new WorkspaceUsageSnapshotScheduler(db).tick(now)
		await new WorkspaceUsageSnapshotScheduler(db).tick(now)

		expect(sentFor(workspaceId)).toHaveLength(1)
	})
})
