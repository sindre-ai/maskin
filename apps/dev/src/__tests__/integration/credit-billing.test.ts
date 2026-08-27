import { events, sessions, workspaceCreditLedger, workspaces } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { debitCreditForSession } from '../../lib/credit-billing'
import { isEnterpriseWorkspace } from '../../lib/enterprise'
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
		// The factory defaults `enterpriseGranted` to true (see factories.ts);
		// enterprise is exempt from the cap entirely, so every case below would
		// pass vacuously. These tests are about the cap matrix for an ordinary
		// metered workspace, so opt out of the grant explicitly.
		const ws = await insertWorkspace(db, actorId, { enterpriseGranted: false })
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
		await expect(checkPlanCap({ db, workspaceId, wsSettings, enterprise: false })).rejects.toThrow(
			PlanCapExceededError,
		)
	})

	it('hard-blocks pro when the balance is zero (unchanged behavior)', async () => {
		await seedOverCapUsage()
		const wsSettings = billingSettings({ plan: 'pro', credit_balance_cents: 0 })
		expect(canUseCreditBalance('pro', wsSettings.billing)).toBe(false)
		await expect(checkPlanCap({ db, workspaceId, wsSettings, enterprise: false })).rejects.toThrow(
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
		await expect(
			checkPlanCap({ db, workspaceId, wsSettings, enterprise: false }),
		).resolves.toBeUndefined()
	})

	it('hard-blocks pro when a positive balance is present but status is past_due', async () => {
		await seedOverCapUsage()
		const wsSettings = billingSettings({
			plan: 'pro',
			credit_balance_cents: 5_000,
			status: 'past_due',
		})
		expect(canUseCreditBalance('pro', wsSettings.billing)).toBe(false)
		await expect(checkPlanCap({ db, workspaceId, wsSettings, enterprise: false })).rejects.toThrow(
			PlanCapExceededError,
		)
	})

	it('does not block when usage is under cap regardless of balance', async () => {
		// No sessions seeded — usage is $0, well under the $10.00 cap.
		const wsSettings = billingSettings({ plan: 'pro', credit_balance_cents: 0 })
		await expect(
			checkPlanCap({ db, workspaceId, wsSettings, enterprise: false }),
		).resolves.toBeUndefined()
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
			// `checkPlanCap` no longer re-reads the workspace to answer "is this
			// enterprise" — it takes the answer from the caller, which already holds
			// the row (PR #1489). Derive it here the way `resolveLlmRoute` and the
			// session pre-flight do, so this still covers the allowlist resolution
			// and not just the branch it feeds.
			const enterprise = await isEnterpriseWorkspace(db, workspaceId)
			expect(enterprise).toBe(true)
			await expect(
				checkPlanCap({ db, workspaceId, wsSettings, enterprise }),
			).resolves.toBeUndefined()
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
			// `debitCreditForSession` exempts enterprise workspaces outright, and
			// the factory grants enterprise by default (see factories.ts) — leave it
			// on and nothing here is ever debited. These tests are about the metered
			// pro path, so the grant is off.
			enterpriseGranted: false,
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

	it('preserves settings keys the schema does not model when debiting', async () => {
		// Regression: the debit used the Zod-parsed copy of `settings` as the
		// write base. Zod strips unknown keys and workspaceSettingsSchema is not
		// a passthrough, so every debit silently dropped keys the schema doesn't
		// model — and a parse failure replaced the whole object. Only `billing`
		// may change here; everything else must survive byte-for-byte.
		const ws = await insertWorkspace(db, actorId, {
			enterpriseGranted: false,
			settings: {
				billing: {
					plan: 'pro',
					status: 'active',
					hard_cap_usd_cents: CAP_CENTS,
					period_start: PERIOD_START_SEC,
					stripe_customer_id: 'cus_test',
					credit_balance_cents: 10_000,
				},
				// Modelled by the schema.
				max_concurrent_sessions: 7,
				// NOT modelled by workspaceSettingsSchema — the exact class of key
				// that used to be dropped.
				an_unmodelled_future_key: { nested: ['keep', 'me'] },
			},
		})
		if (!ws) throw new Error('workspace insert failed')
		workspaceId = ws.id

		const session = await seedSessionWithCost('10.01')

		await debitCreditForSession({
			db,
			workspaceId,
			sessionId: session.id,
			actorId,
			wsSettings: wsSettingsFor(10_000),
		})

		const [after] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId))
		if (!after) throw new Error('workspace not found')
		const settings = after.settings as Record<string, unknown>

		// The debit landed...
		expect((settings.billing as { credit_balance_cents: number }).credit_balance_cents).toBe(9_999)
		// ...and nothing else was lost.
		expect(settings.an_unmodelled_future_key).toEqual({ nested: ['keep', 'me'] })
		expect(settings.max_concurrent_sessions).toBe(7)
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

	it('bills each of two sequential sessions only its own slice of the overage', async () => {
		// Regression test for the cumulative-overage double-charge.
		// `getWorkspacePlanUsdCentsUsage` returns usage for the whole period, so
		// naively debiting (used - cap) per session re-charges the running total
		// every time: session A took $10, then session B took the full $30
		// instead of its own $20 — $40 billed for $30 of real overage.
		await seedWorkspace(10_000)

		const sessionA = await seedSessionWithCost('20.00')
		await debitCreditForSession({
			db,
			workspaceId,
			sessionId: sessionA.id,
			actorId,
			wsSettings: wsSettingsFor(10_000),
		})

		// $20 used against a $10 cap = $10 over.
		const [afterA] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId))
		if (!afterA) throw new Error('workspace not found')
		expect((afterA.settings as WorkspaceSettings).billing?.credit_balance_cents).toBe(9_000)

		const sessionB = await seedSessionWithCost('20.00')
		await debitCreditForSession({
			db,
			workspaceId,
			sessionId: sessionB.id,
			actorId,
			// Balance as it now stands after A's debit.
			wsSettings: wsSettingsFor(9_000),
		})

		const [afterB] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId))
		if (!afterB) throw new Error('workspace not found')
		// $40 used, $10 cap => $30 total overage. A already accounted for $10,
		// so B owes its own $20 — NOT the full $30. Balance: 10000 - 3000.
		expect((afterB.settings as WorkspaceSettings).billing?.credit_balance_cents).toBe(7_000)

		const ledgerRows = await db
			.select()
			.from(workspaceCreditLedger)
			.where(eq(workspaceCreditLedger.workspaceId, workspaceId))
		expect(ledgerRows).toHaveLength(2)
		const totalDebited = ledgerRows.reduce((sum, row) => sum + -row.amountCents, 0)
		expect(totalDebited).toBe(3_000)
		const bySession = new Map(ledgerRows.map((r) => [r.sessionId, r]))
		expect(bySession.get(sessionA.id)?.amountCents).toBe(-1_000)
		expect(bySession.get(sessionB.id)?.amountCents).toBe(-2_000)
		// Each row records the slice it accounted for, so the sum equals the
		// period's real overage rather than the re-charged running total.
		expect(ledgerRows.reduce((sum, row) => sum + row.accountedOverageCents, 0)).toBe(3_000)
	})

	it('never bills more than the real overage when two sessions complete concurrently', async () => {
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

		// Both sessions' costs are already on the sessions table before either
		// debit runs, so cumulative usage is $40 either way — $30 over the $10
		// cap. The row lock serializes the two calls: whichever runs first
		// accounts for the whole $30, the second finds nothing left to bill and
		// writes no row. Exactly $30 is taken regardless of interleaving — the
		// old code billed $40 here.
		const ledgerRows = await db
			.select()
			.from(workspaceCreditLedger)
			.where(eq(workspaceCreditLedger.workspaceId, workspaceId))
		const totalDebited = ledgerRows.reduce((sum, row) => sum + -row.amountCents, 0)
		expect(totalDebited).toBe(3_000)
		expect(settings.billing?.credit_balance_cents).toBe(7_000)
	})

	it('does not re-bill written-off overage after a later top-up', async () => {
		// A session that outspends the balance has the excess forgiven. Because
		// the ledger records the accounted slice separately from the clamped
		// money taken, topping up must not resurrect those written-off cents.
		await seedWorkspace(500)
		const sessionA = await seedSessionWithCost('20.00')
		await debitCreditForSession({
			db,
			workspaceId,
			sessionId: sessionA.id,
			actorId,
			wsSettings: wsSettingsFor(500),
		})
		// Owed $10, only $5 available — $5 taken, $5 written off.
		const [afterA] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId))
		if (!afterA) throw new Error('workspace not found')
		expect((afterA.settings as WorkspaceSettings).billing?.credit_balance_cents).toBe(0)

		// Simulate a top-up, then run one more session.
		await db
			.update(workspaces)
			.set({
				settings: {
					...(afterA.settings as WorkspaceSettings),
					billing: {
						...(afterA.settings as WorkspaceSettings).billing,
						credit_balance_cents: 10_000,
					},
				},
			})
			.where(eq(workspaces.id, workspaceId))

		const sessionB = await seedSessionWithCost('5.00')
		await debitCreditForSession({
			db,
			workspaceId,
			sessionId: sessionB.id,
			actorId,
			wsSettings: wsSettingsFor(10_000),
		})

		const [afterB] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId))
		if (!afterB) throw new Error('workspace not found')
		// $25 used, $10 cap => $15 total overage; A accounted for $10, so B owes
		// its own $5 only. The $5 written off during A stays forgiven.
		expect((afterB.settings as WorkspaceSettings).billing?.credit_balance_cents).toBe(9_500)
	})
	it('bills each segment of a paused-then-resumed session, not just the first', async () => {
		// Regression (migration 0064): `debitCreditIfApplicable` runs on PAUSE as
		// well as on completion, but the ledger's idempotency key was
		// `session_id` alone — one row per session, ever. So a session that
		// paused over cap wrote its debit, and the completion after the resume
		// conflicted, returned no row, and exited before touching the balance:
		// everything spent after the resume was silently never charged.
		// Interactive sessions pause between turns, so this was the common path.
		await seedWorkspace(10_000)

		// Segment 1: $10.05 reported against the $10.00 cap = 5 cents over.
		const session = await seedSessionWithCost('10.05')
		await debitCreditForSession({
			db,
			workspaceId,
			sessionId: session.id,
			actorId,
			wsSettings: wsSettingsFor(10_000),
		})

		const [afterPause] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId))
		if (!afterPause) throw new Error('workspace not found')
		expect((afterPause.settings as WorkspaceSettings).billing?.credit_balance_cents).toBe(9_995)

		// The session resumes and spends more; its cumulative cost grows.
		await db.update(sessions).set({ totalCostUsd: '10.30' }).where(eq(sessions.id, session.id))

		await debitCreditForSession({
			db,
			workspaceId,
			sessionId: session.id,
			actorId,
			wsSettings: wsSettingsFor(9_995),
		})

		// 30 cents over cap in total, 5 already billed => 25 more, not 0.
		const [afterResume] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId))
		if (!afterResume) throw new Error('workspace not found')
		expect((afterResume.settings as WorkspaceSettings).billing?.credit_balance_cents).toBe(9_970)

		const ledgerRows = await db
			.select()
			.from(workspaceCreditLedger)
			.where(eq(workspaceCreditLedger.sessionId, session.id))
		expect(ledgerRows).toHaveLength(2)
	})

	it('still collapses a retry of the SAME segment after a resume', async () => {
		// The segmented key must not reopen the double-charge that the
		// per-session index originally closed: a completion re-firing at an
		// unchanged cumulative cost carries the same key and must be a no-op.
		await seedWorkspace(10_000)
		const session = await seedSessionWithCost('10.05')

		const debit = (balance: number) =>
			debitCreditForSession({
				db,
				workspaceId,
				sessionId: session.id,
				actorId,
				wsSettings: wsSettingsFor(balance),
			})

		await debit(10_000)
		await db.update(sessions).set({ totalCostUsd: '10.30' }).where(eq(sessions.id, session.id))
		await debit(9_995)
		// Same cumulative cost as the segment just billed — a pure retry.
		await debit(9_970)

		const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId))
		if (!ws) throw new Error('workspace not found')
		expect((ws.settings as WorkspaceSettings).billing?.credit_balance_cents).toBe(9_970)

		const ledgerRows = await db
			.select()
			.from(workspaceCreditLedger)
			.where(eq(workspaceCreditLedger.sessionId, session.id))
		expect(ledgerRows).toHaveLength(2)
	})
})
