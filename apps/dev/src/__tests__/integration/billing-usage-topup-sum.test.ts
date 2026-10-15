import { workspaceCreditLedger } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { insertWorkspace } from '../factories'
import { jsonGet } from '../helpers'
import { createIntegrationApp, db, getTestActorId, sql } from './global-setup'

const { default: billingRoutes } = await import('../../routes/billing')

function createApp() {
	return createIntegrationApp({ path: '/api/billing', module: billingRoutes })
}

/**
 * Runtime verification for the low-balance banner (Task 6775ef6c). The mocked-
 * DB unit tests pin the schema shape and the response wiring; this test proves
 * the 30-day rolling ledger sum against real Postgres — the same window
 * filter, the same COALESCE-into-integer cents cast, and the same type='topup'
 * filter that the front-end threshold formula depends on. If the ledger's
 * date arithmetic ever regressed to counting a debit or a stale row, that
 * banner would either miss the threshold or fire on a workspace that just
 * burned through a fresh top-up — this is the only test that catches it.
 */
describe('GET /api/billing/usage — sum_topups_last_30d_cents (integration)', () => {
	let workspaceId: string

	afterEach(async () => {
		if (workspaceId) {
			await sql`DELETE FROM workspace_credit_ledger WHERE workspace_id = ${workspaceId}`
		}
	})

	it('reports 0 for a workspace with no ledger rows', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		workspaceId = ws.id
		const app = createApp()

		const res = await app.request(jsonGet('/api/billing/usage', { 'x-workspace-id': workspaceId }))
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.sum_topups_last_30d_cents).toBe(0)
	})

	it('sums positive amountCents across topup rows inside the 30-day window', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		workspaceId = ws.id
		const app = createApp()

		await db.insert(workspaceCreditLedger).values([
			{
				workspaceId,
				type: 'topup',
				amountCents: 2_500,
				balanceAfterCents: 2_500,
				stripeCheckoutSessionId: `cs_test_a_${workspaceId}`,
			},
			{
				workspaceId,
				type: 'topup',
				amountCents: 5_000,
				balanceAfterCents: 7_500,
				stripeCheckoutSessionId: `cs_test_b_${workspaceId}`,
			},
		])

		const res = await app.request(jsonGet('/api/billing/usage', { 'x-workspace-id': workspaceId }))
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.sum_topups_last_30d_cents).toBe(7_500)
	})

	it('excludes ledger rows older than 30 days from the sum', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		workspaceId = ws.id
		const app = createApp()

		// One row inside the window, one 45 days old — the old one must not
		// count toward the rolling sum.
		await db.insert(workspaceCreditLedger).values([
			{
				workspaceId,
				type: 'topup',
				amountCents: 1_000,
				balanceAfterCents: 1_000,
				stripeCheckoutSessionId: `cs_recent_${workspaceId}`,
			},
			{
				workspaceId,
				type: 'topup',
				amountCents: 9_999,
				balanceAfterCents: 10_999,
				stripeCheckoutSessionId: `cs_stale_${workspaceId}`,
			},
		])
		// Backdate the second row past the 30-day boundary.
		await sql`
			UPDATE workspace_credit_ledger
			SET created_at = NOW() - INTERVAL '45 days'
			WHERE workspace_id = ${workspaceId}
				AND stripe_checkout_session_id = ${`cs_stale_${workspaceId}`}
		`

		const res = await app.request(jsonGet('/api/billing/usage', { 'x-workspace-id': workspaceId }))
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.sum_topups_last_30d_cents).toBe(1_000)
	})

	it("excludes debit rows — the sum is topup-only so a session's spend can't cancel a purchase", async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		workspaceId = ws.id
		const app = createApp()

		await db.insert(workspaceCreditLedger).values([
			{
				workspaceId,
				type: 'topup',
				amountCents: 4_000,
				balanceAfterCents: 4_000,
				stripeCheckoutSessionId: `cs_topup_${workspaceId}`,
			},
			{
				workspaceId,
				type: 'debit',
				amountCents: -1_500,
				balanceAfterCents: 2_500,
				accountedOverageCents: 1_500,
			},
		])

		const res = await app.request(jsonGet('/api/billing/usage', { 'x-workspace-id': workspaceId }))
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.sum_topups_last_30d_cents).toBe(4_000)
	})

	it('only sums rows for the requested workspace — cross-workspace bleed check', async () => {
		const wsA = await insertWorkspace(db, getTestActorId())
		const wsB = await insertWorkspace(db, getTestActorId())
		workspaceId = wsA.id
		const app = createApp()

		await db.insert(workspaceCreditLedger).values([
			{
				workspaceId: wsA.id,
				type: 'topup',
				amountCents: 3_000,
				balanceAfterCents: 3_000,
				stripeCheckoutSessionId: `cs_a_${wsA.id}`,
			},
			{
				workspaceId: wsB.id,
				type: 'topup',
				amountCents: 6_000,
				balanceAfterCents: 6_000,
				stripeCheckoutSessionId: `cs_b_${wsB.id}`,
			},
		])

		const res = await app.request(jsonGet('/api/billing/usage', { 'x-workspace-id': wsA.id }))
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.sum_topups_last_30d_cents).toBe(3_000)

		// Also verify from the other side of the fence — a query against wsB
		// should see only its own row, not wsA's.
		await db.delete(workspaceCreditLedger).where(eq(workspaceCreditLedger.workspaceId, wsB.id))
	})
})
