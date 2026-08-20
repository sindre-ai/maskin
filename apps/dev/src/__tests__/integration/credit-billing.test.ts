import { events, workspaceCreditLedger, workspaces } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { debitCreditForSession } from '../../lib/credit-billing'
import { PlanCapExceededError, canUseCreditBalance, checkPlanCap } from '../../lib/llm-routing'
import type { WorkspaceSettings } from '../../lib/types'
import { insertSession, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

const PERIOD_START_SEC = 1_700_000_000
// $10.00 included per period — usage and cap are tracked in USD cents (not
// token counts) since different agents can run different model tiers with
// different $/token ratios; see lib/llm-routing.ts.
const CAP_CENTS = 1_000

function billingSettings(
	overrides: Partial<NonNullable<WorkspaceSettings['billing']>>,
): WorkspaceSettings {
	return {
		billing: {
			plan: 'pro',
			status: 'active',
			hard_cap_usd_cents: CAP_CENTS,
			period_start: PERIOD_START_SEC,
			stripe_customer_id: 'cus_test',
			...overrides,
		},
	} as WorkspaceSettings
}

describe('checkPlanCap / canUseCreditBalance — soft cap matrix (Integration)', () => {
	let workspaceId: string
	let actorId: string

	beforeEach(async () => {
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		workspaceId = ws.id
	})

	async function seedOverCapUsage() {
		// The cap is $10.00 (CAP_CENTS); a session that reported $20.00 of its
		// own cost is already well past cap regardless of plan.
		await insertSession(db, workspaceId, actorId, actorId, {
			status: 'completed',
			config: { llm_route: 'maskin_plan' },
			totalCostUsd: '20.00',
			inputTokens: 0,
			outputTokens: 0,
			createdAt: new Date(PERIOD_START_SEC * 1000 + 1000),
		})
	}

	it('hard-blocks trial even with a balance (no credit spending without a paid plan)', async () => {
		await seedOverCapUsage()
		const wsSettings = billingSettings({ plan: 'trial', credit_balance_cents: 5_000 })
		expect(canUseCreditBalance('trial', wsSettings.billing)).toBe(false)
		await expect(checkPlanCap({ db, workspaceId, wsSettings })).rejects.toThrow(
			PlanCapExceededError,
		)
	})

	it('hard-blocks pro when the balance is zero (unchanged behavior)', async () => {
		await seedOverCapUsage()
		const wsSettings = billingSettings({ plan: 'pro', credit_balance_cents: 0 })
		expect(canUseCreditBalance('pro', wsSettings.billing)).toBe(false)
		await expect(checkPlanCap({ db, workspaceId, wsSettings })).rejects.toThrow(
			PlanCapExceededError,
		)
	})

	it('lets pro through when a positive balance is present and status is active', async () => {
		await seedOverCapUsage()
		const wsSettings = billingSettings({
			plan: 'pro',
			credit_balance_cents: 5_000,
			status: 'active',
		})
		expect(canUseCreditBalance('pro', wsSettings.billing)).toBe(true)
		await expect(checkPlanCap({ db, workspaceId, wsSettings })).resolves.toBeUndefined()
	})

	it('hard-blocks pro when a positive balance is present but status is past_due', async () => {
		await seedOverCapUsage()
		const wsSettings = billingSettings({
			plan: 'pro',
			credit_balance_cents: 5_000,
			status: 'past_due',
		})
		expect(canUseCreditBalance('pro', wsSettings.billing)).toBe(false)
		await expect(checkPlanCap({ db, workspaceId, wsSettings })).rejects.toThrow(
			PlanCapExceededError,
		)
	})

	it('does not block when usage is under cap regardless of balance', async () => {
		// No sessions seeded — usage is $0, well under the $10.00 cap.
		const wsSettings = billingSettings({ plan: 'pro', credit_balance_cents: 0 })
		await expect(checkPlanCap({ db, workspaceId, wsSettings })).resolves.toBeUndefined()
	})

	describe('enterprise allowlist bypass', () => {
		const ORIGINAL_ENV = process.env.MASKIN_ENTERPRISE_ACTOR_IDS

		afterEach(() => {
			if (ORIGINAL_ENV === undefined) {
				// biome-ignore lint/performance/noDelete: assigning undefined coerces to the string "undefined" in Node.js
				delete process.env.MASKIN_ENTERPRISE_ACTOR_IDS
			} else {
				process.env.MASKIN_ENTERPRISE_ACTOR_IDS = ORIGINAL_ENV
			}
		})

		it('never blocks a workspace bill-owned by an allowlisted actor, even far over cap on trial', async () => {
			await seedOverCapUsage()
			process.env.MASKIN_ENTERPRISE_ACTOR_IDS = actorId
			const wsSettings = billingSettings({ plan: 'trial', credit_balance_cents: 0 })
			await expect(checkPlanCap({ db, workspaceId, wsSettings })).resolves.toBeUndefined()
		})
	})
})

describe('debitCreditForSession (Integration)', () => {
	let workspaceId: string
	let actorId: string

	beforeEach(async () => {
		actorId = getTestActorId()
	})

	async function seedWorkspace(creditBalanceCents: number) {
		const ws = await insertWorkspace(db, actorId, {
			settings: {
				billing: {
					plan: 'pro',
					status: 'active',
					hard_cap_usd_cents: CAP_CENTS,
					period_start: PERIOD_START_SEC,
					stripe_customer_id: 'cus_test',
					credit_balance_cents: creditBalanceCents,
				},
			},
		})
		if (!ws) throw new Error('workspace insert failed')
		workspaceId = ws.id
		return ws
	}

	/** `totalCostUsdDollars` is the session's own reported cost, e.g. "10.01" for $10.01. */
	async function seedSessionWithCost(totalCostUsdDollars: string) {
		const session = await insertSession(db, workspaceId, actorId, actorId, {
			status: 'completed',
			config: { llm_route: 'maskin_plan' },
			totalCostUsd: totalCostUsdDollars,
			inputTokens: 0,
			outputTokens: 0,
			createdAt: new Date(PERIOD_START_SEC * 1000 + 1000),
		})
		if (!session) throw new Error('session insert failed')
		return session
	}

	function wsSettingsFor(creditBalanceCents: number): WorkspaceSettings {
		return billingSettings({ plan: 'pro', credit_balance_cents: creditBalanceCents })
	}

	it('debits the balance for cost over cap and writes a ledger row + audit event', async () => {
		await seedWorkspace(10_000)
		// $10.01 reported cost against a $10.00 cap = 1 cent over.
		const session = await seedSessionWithCost('10.01')

		await debitCreditForSession({
			db,
			workspaceId,
			sessionId: session.id,
			actorId,
			wsSettings: wsSettingsFor(10_000),
		})

		const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId))
		if (!ws) throw new Error('workspace not found')
		const settings = ws.settings as WorkspaceSettings
		expect(settings.billing?.credit_balance_cents).toBe(9_999)

		const ledgerRows = await db
			.select()
			.from(workspaceCreditLedger)
			.where(eq(workspaceCreditLedger.sessionId, session.id))
		expect(ledgerRows).toHaveLength(1)
		const [ledgerRow] = ledgerRows
		if (!ledgerRow) throw new Error('ledger row not found')
		expect(ledgerRow.type).toBe('debit')
		expect(ledgerRow.amountCents).toBe(-1)
		expect(ledgerRow.balanceAfterCents).toBe(9_999)

		const eventRows = await db.select().from(events).where(eq(events.entityId, session.id))
		expect(eventRows.some((e) => e.action === 'session_credit_debited')).toBe(true)
	})

	it('is idempotent per session — a re-fired completion does not double-debit', async () => {
		await seedWorkspace(10_000)
		const session = await seedSessionWithCost('10.01')

		const debit = () =>
			debitCreditForSession({
				db,
				workspaceId,
				sessionId: session.id,
				actorId,
				wsSettings: wsSettingsFor(10_000),
			})

		await debit()
		await debit()

		const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId))
		if (!ws) throw new Error('workspace not found')
		const settings = ws.settings as WorkspaceSettings
		// Only the first call's debit should have applied.
		expect(settings.billing?.credit_balance_cents).toBe(9_999)

		const ledgerRows = await db
			.select()
			.from(workspaceCreditLedger)
			.where(eq(workspaceCreditLedger.sessionId, session.id))
		expect(ledgerRows).toHaveLength(1)
	})

	it('clamps the debit at the available balance instead of going negative', async () => {
		// A tiny positive balance so canUseCreditBalance's gate still lets the
		// session through (a $0 balance is blocked earlier, by checkPlanCap) —
		// but the balance is smaller than what this session actually owes.
		await seedWorkspace(1)
		// $10.02 reported cost against a $10.00 cap = 2 cents owed, but balance is 1.
		const session = await seedSessionWithCost('10.02')

		await debitCreditForSession({
			db,
			workspaceId,
			sessionId: session.id,
			actorId,
			wsSettings: wsSettingsFor(1),
		})

		const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId))
		if (!ws) throw new Error('workspace not found')
		const settings = ws.settings as WorkspaceSettings
		expect(settings.billing?.credit_balance_cents).toBe(0)

		const ledgerRows = await db
			.select()
			.from(workspaceCreditLedger)
			.where(eq(workspaceCreditLedger.sessionId, session.id))
		const [ledgerRow] = ledgerRows
		if (!ledgerRow) throw new Error('ledger row not found')
		expect(ledgerRow.amountCents).toBe(-1)
		expect(ledgerRow.balanceAfterCents).toBe(0)
	})

	it('applies concurrent debits from two different sessions without losing an update', async () => {
		await seedWorkspace(10_000)
		const sessionA = await seedSessionWithCost('20.00')
		const sessionB = await seedSessionWithCost('20.00')

		await Promise.all([
			debitCreditForSession({
				db,
				workspaceId,
				sessionId: sessionA.id,
				actorId,
				wsSettings: wsSettingsFor(10_000),
			}),
			debitCreditForSession({
				db,
				workspaceId,
				sessionId: sessionB.id,
				actorId,
				wsSettings: wsSettingsFor(10_000),
			}),
		])

		const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId))
		if (!ws) throw new Error('workspace not found')
		const settings = ws.settings as WorkspaceSettings
		// Both sessions pushed usage to $40 total ($30 over the $10 cap once both
		// are counted), but each debit call computes its cost off cumulative
		// usage at the time it runs — the row lock guarantees both debits land,
		// not a specific total, so assert the ledger recorded two distinct
		// debits and the balance reflects their sum rather than a lost update
		// from one overwriting the other.
		const ledgerRows = await db
			.select()
			.from(workspaceCreditLedger)
			.where(eq(workspaceCreditLedger.workspaceId, workspaceId))
		expect(ledgerRows).toHaveLength(2)
		const totalDebited = ledgerRows.reduce((sum, row) => sum + -row.amountCents, 0)
		expect(settings.billing?.credit_balance_cents).toBe(10_000 - totalDebited)
	})
})
