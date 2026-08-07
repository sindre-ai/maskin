import { workspaceOverageUsage } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { PlanCapExceededError, canUseOverage, checkPlanCap } from '../../lib/llm-routing'
import { recordOverageIfCrossed } from '../../lib/overage-billing'
import type { WorkspaceSettings } from '../../lib/types'
import { insertSession, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

const OVERAGE_BLOCK_TOKENS = 32_000_000
const PERIOD_START_SEC = 1_700_000_000

function billingSettings(
	overrides: Partial<NonNullable<WorkspaceSettings['billing']>>,
): WorkspaceSettings {
	return {
		billing: {
			plan: 'pro',
			status: 'active',
			hard_cap_tokens: 1_000,
			period_start: PERIOD_START_SEC,
			stripe_customer_id: 'cus_test',
			...overrides,
		},
	} as WorkspaceSettings
}

describe('checkPlanCap / canUseOverage — soft cap matrix (Integration)', () => {
	let workspaceId: string
	let actorId: string

	beforeEach(async () => {
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		workspaceId = ws.id
	})

	async function seedOverCapUsage() {
		// hard_cap_tokens is 1000 in `billingSettings` — one session with 2000
		// input tokens is already past cap regardless of plan.
		await insertSession(db, workspaceId, actorId, actorId, {
			status: 'completed',
			config: { llm_route: 'maskin_plan' },
			inputTokens: 2000,
			outputTokens: 0,
			createdAt: new Date(PERIOD_START_SEC * 1000 + 1000),
		})
	}

	it('hard-blocks trial even when overage_enabled is set (no overage without a paid plan)', async () => {
		await seedOverCapUsage()
		const wsSettings = billingSettings({ plan: 'trial', overage_enabled: true })
		expect(canUseOverage('trial', wsSettings.billing)).toBe(false)
		await expect(checkPlanCap({ db, workspaceId, wsSettings })).rejects.toThrow(
			PlanCapExceededError,
		)
	})

	it('hard-blocks pro when overage_enabled is false (unchanged behavior)', async () => {
		await seedOverCapUsage()
		const wsSettings = billingSettings({ plan: 'pro', overage_enabled: false })
		expect(canUseOverage('pro', wsSettings.billing)).toBe(false)
		await expect(checkPlanCap({ db, workspaceId, wsSettings })).rejects.toThrow(
			PlanCapExceededError,
		)
	})

	it('lets pro through when overage_enabled is true and status is active', async () => {
		await seedOverCapUsage()
		const wsSettings = billingSettings({ plan: 'pro', overage_enabled: true, status: 'active' })
		expect(canUseOverage('pro', wsSettings.billing)).toBe(true)
		await expect(checkPlanCap({ db, workspaceId, wsSettings })).resolves.toBeUndefined()
	})

	it('hard-blocks pro when overage_enabled is true but status is past_due', async () => {
		await seedOverCapUsage()
		const wsSettings = billingSettings({ plan: 'pro', overage_enabled: true, status: 'past_due' })
		expect(canUseOverage('pro', wsSettings.billing)).toBe(false)
		await expect(checkPlanCap({ db, workspaceId, wsSettings })).rejects.toThrow(
			PlanCapExceededError,
		)
	})

	it('does not block when usage is under cap regardless of overage_enabled', async () => {
		// No sessions seeded — usage is 0, well under the 1000-token cap.
		const wsSettings = billingSettings({ plan: 'pro', overage_enabled: false })
		await expect(checkPlanCap({ db, workspaceId, wsSettings })).resolves.toBeUndefined()
	})
})

describe('workspace_overage_usage ledger (Integration)', () => {
	let workspaceId: string
	let actorId: string

	beforeEach(async () => {
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		workspaceId = ws.id
	})

	it('claims each block at most once under the unique (workspace, period, block) constraint', async () => {
		const values = {
			workspaceId,
			periodStart: PERIOD_START_SEC,
			blockIndex: 1,
			tokensAtBlock: OVERAGE_BLOCK_TOKENS,
		}
		const first = await db
			.insert(workspaceOverageUsage)
			.values(values)
			.onConflictDoNothing({
				target: [
					workspaceOverageUsage.workspaceId,
					workspaceOverageUsage.periodStart,
					workspaceOverageUsage.blockIndex,
				],
			})
			.returning({ id: workspaceOverageUsage.id })
		expect(first).toHaveLength(1)

		// A second claim attempt for the exact same block (simulating a
		// concurrent session completion, or a reconciler racing the original
		// report) must be a no-op, not a duplicate row or a thrown error.
		const second = await db
			.insert(workspaceOverageUsage)
			.values(values)
			.onConflictDoNothing({
				target: [
					workspaceOverageUsage.workspaceId,
					workspaceOverageUsage.periodStart,
					workspaceOverageUsage.blockIndex,
				],
			})
			.returning({ id: workspaceOverageUsage.id })
		expect(second).toHaveLength(0)

		const rows = await db
			.select()
			.from(workspaceOverageUsage)
			.where(
				and(
					eq(workspaceOverageUsage.workspaceId, workspaceId),
					eq(workspaceOverageUsage.periodStart, PERIOD_START_SEC),
					eq(workspaceOverageUsage.blockIndex, 1),
				),
			)
		expect(rows).toHaveLength(1)
	})

	it('recordOverageIfCrossed no-ops without Stripe env, leaving no claim rows', async () => {
		// Stripe isn't configured in the test environment (no STRIPE_SECRET_KEY),
		// so this exercises the "fail open" path: usage crossed a block boundary,
		// but the function must return without throwing and without a partial
		// claim row when readStripeEnv() throws.
		await insertSession(db, workspaceId, actorId, actorId, {
			status: 'completed',
			config: { llm_route: 'maskin_plan' },
			inputTokens: 1_000 + OVERAGE_BLOCK_TOKENS,
			outputTokens: 0,
			createdAt: new Date(PERIOD_START_SEC * 1000 + 1000),
		})
		const wsSettings = billingSettings({ plan: 'pro', overage_enabled: true, status: 'active' })

		await expect(
			recordOverageIfCrossed({
				db,
				workspaceId,
				sessionId: 'session-does-not-matter',
				actorId,
				wsSettings,
			}),
		).resolves.toBeUndefined()

		const rows = await db
			.select()
			.from(workspaceOverageUsage)
			.where(eq(workspaceOverageUsage.workspaceId, workspaceId))
		expect(rows).toHaveLength(0)
	})
})
