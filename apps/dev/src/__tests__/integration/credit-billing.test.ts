import { events, workspaceCreditLedger, workspaces } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { debitCreditForSession } from '../../lib/credit-billing'
import { PlanCapExceededError, canUseCreditBalance, checkPlanCap } from '../../lib/llm-routing'
import type { WorkspaceSettings } from '../../lib/types'
import { insertSession, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

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

describe('checkPlanCap / canUseCreditBalance — soft cap matrix (Integration)', () => {
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
		// No sessions seeded — usage is 0, well under the 1000-token cap.
		const wsSettings = billingSettings({ plan: 'pro', credit_balance_cents: 0 })
		await expect(checkPlanCap({ db, workspaceId, wsSettings })).resolves.toBeUndefined()
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
					hard_cap_tokens: 1_000,
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

	async function seedOverCapSession(inputTokens: number) {
		const session = await insertSession(db, workspaceId, actorId, actorId, {
			status: 'completed',
			config: { llm_route: 'maskin_plan' },
			inputTokens,
			outputTokens: 0,
			createdAt: new Date(PERIOD_START_SEC * 1000 + 1000),
		})
		if (!session) throw new Error('session insert failed')
		return session
	}

	function wsSettingsFor(creditBalanceCents: number): WorkspaceSettings {
		return billingSettings({ plan: 'pro', credit_balance_cents: creditBalanceCents })
	}

	it('debits the balance for tokens over cap and writes a ledger row + audit event', async () => {
		await seedWorkspace(10_000)
		// 2000 tokens over the 1000 cap = 1000 overage tokens.
		// CREDIT_TOKENS_PER_USD_CENT = 16_000 -> ceil(1000/16_000) = 1 cent.
		const session = await seedOverCapSession(2_000)

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
		const session = await seedOverCapSession(2_000)

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
		// 32_000 tokens over cap -> ceil(32000/16000) = 2 cents owed, but balance is 1.
		const session = await seedOverCapSession(1_000 + 32_000)

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
		const sessionA = await seedOverCapSession(2_000)
		const sessionB = await seedOverCapSession(2_000)

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
		// Both sessions pushed usage to 4000 tokens total (3000 over the 1000
		// cap once both are counted), but each debit call computes its cost off
		// cumulative usage at the time it runs — the row lock guarantees both
		// debits land, not a specific total, so assert the ledger recorded two
		// distinct debits and the balance reflects their sum rather than a lost
		// update from one overwriting the other.
		const ledgerRows = await db
			.select()
			.from(workspaceCreditLedger)
			.where(eq(workspaceCreditLedger.workspaceId, workspaceId))
		expect(ledgerRows).toHaveLength(2)
		const totalDebited = ledgerRows.reduce((sum, row) => sum + -row.amountCents, 0)
		expect(settings.billing?.credit_balance_cents).toBe(10_000 - totalDebited)
	})
})
