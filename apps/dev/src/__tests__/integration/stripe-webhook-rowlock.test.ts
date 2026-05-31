import { workspaces } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

/**
 * Mirrors the transaction shape used by `applyEvent` in
 * `apps/dev/src/routes/stripe-webhook.ts`: BEGIN → SELECT … FOR UPDATE →
 * mutate settings.billing → UPDATE → COMMIT. The route-level unit test in
 * `__tests__/routes/stripe-webhook.test.ts` pins the merge logic against a
 * mock DB; this integration test pins the lock semantics against a real
 * Postgres so concurrent webhook deliveries on the same workspace serialize
 * instead of losing each other's writes.
 */
async function applyBillingPatchInTx(
	workspaceId: string,
	patch: Record<string, unknown>,
	opts: { holdLockMs?: number } = {},
): Promise<{ selectAt: number; updateAt: number }> {
	let selectAt = 0
	let updateAt = 0
	await db.transaction(async (tx) => {
		const [row] = await tx
			.select({ id: workspaces.id, settings: workspaces.settings })
			.from(workspaces)
			.where(eq(workspaces.id, workspaceId))
			.for('update')
			.limit(1)
		selectAt = Date.now()
		if (!row) throw new Error(`workspace ${workspaceId} not found`)

		if (opts.holdLockMs) {
			await new Promise((r) => setTimeout(r, opts.holdLockMs))
		}

		const settings = (row.settings ?? {}) as Record<string, unknown>
		const billing = (settings.billing ?? {}) as Record<string, unknown>
		const merged = { ...settings, billing: { ...billing, ...patch } }
		await tx
			.update(workspaces)
			.set({ settings: merged, updatedAt: new Date() })
			.where(eq(workspaces.id, workspaceId))
		updateAt = Date.now()
	})
	return { selectAt, updateAt }
}

describe('Stripe webhook row-lock Integration', () => {
	it('serializes concurrent applyEvent transactions and preserves both writers fields', async () => {
		const ws = await insertWorkspace(db, getTestActorId(), {
			settings: { billing: { plan: 'trial', status: 'incomplete' } },
		})

		// Tx A writes the subscription slice and holds the lock long enough that
		// B's SELECT FOR UPDATE attempts to acquire while A still owns it.
		// Without `.for('update')` in a transaction, B would read A's pre-commit
		// snapshot and clobber A's plan / hard_cap_tokens on UPDATE.
		const patchA = {
			plan: 'pro',
			hard_cap_tokens: 96_000_000,
			period_start: 1_700_000_000,
		}
		const patchB = {
			stripe_customer_id: 'cus_42',
			stripe_subscription_id: 'sub_42',
			status: 'active',
		}

		const holdLockMs = 200
		const headStartMs = 100
		const txA = applyBillingPatchInTx(ws.id, patchA, { holdLockMs })
		// Give A enough time to BEGIN + SELECT FOR UPDATE before B fires. The lock
		// is what we want to test — racing the BEGINs themselves is not the gap.
		await new Promise((r) => setTimeout(r, headStartMs))
		const txB = applyBillingPatchInTx(ws.id, patchB)

		const [a, b] = await Promise.all([txA, txB])

		// Serialization proof: B's SELECT (and therefore the whole critical
		// section) only proceeds after A's UPDATE has committed. Without the
		// row lock, B.selectAt would land near A.selectAt instead of after
		// A.updateAt.
		expect(b.selectAt).toBeGreaterThanOrEqual(a.updateAt)
		expect(b.selectAt - a.selectAt).toBeGreaterThanOrEqual(holdLockMs)

		const [final] = await db
			.select({ settings: workspaces.settings })
			.from(workspaces)
			.where(eq(workspaces.id, ws.id))
		const finalBilling = (final?.settings as { billing?: Record<string, unknown> })?.billing
		expect(finalBilling).toMatchObject({
			plan: 'pro',
			hard_cap_tokens: 96_000_000,
			period_start: 1_700_000_000,
			stripe_customer_id: 'cus_42',
			stripe_subscription_id: 'sub_42',
			status: 'active',
		})
	})
})
