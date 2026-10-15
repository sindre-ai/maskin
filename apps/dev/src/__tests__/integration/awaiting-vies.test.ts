import { awaitingVies } from '@maskin/db/schema'
import { and, eq, sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

// Integration tests for the VAT-bet Task 1 migration (0070_awaiting_vies.sql).
// The migration harness (global-setup.ts) drops + recreates public and
// replays every .sql file in order, so this suite verifies the migration
// actually applied — not just that a mocked schema object exists.
//
// The invariants under test are the ones downstream tasks depend on:
//   • UNIQUE(session_id) — Task 2's held-branch UPSERT relies on this to
//     survive Stripe webhook replays.
//   • CHECK on kind — Task 2 branches on 'topup' vs 'subscription' shape.
//   • Nullable reminder_sent_at — Task 3's markReminderSent flips this from
//     NULL to now() under SELECT FOR UPDATE.
//   • NO `status` column — row lifecycle carries state (Architect fold-in).

describe('awaiting_vies migration (Integration)', () => {
	async function insertRow(
		workspaceId: string,
		overrides: Partial<typeof awaitingVies.$inferInsert> = {},
	): Promise<typeof awaitingVies.$inferSelect> {
		const base = {
			workspaceId,
			sessionId: `cs_test_${crypto.randomUUID()}`,
			customerId: `cus_test_${Math.random().toString(36).slice(2, 8)}`,
			kind: 'topup' as const,
			paymentIntentId: 'pi_test',
			subscriptionId: null,
			currency: 'dkk',
			amountTotal: 34_900,
		}
		const [row] = await db
			.insert(awaitingVies)
			.values({ ...base, ...overrides })
			.returning()
		if (!row) throw new Error('insert returned no row')
		return row
	}

	it('accepts a well-formed topup row and reads it back', async () => {
		const ws = await insertWorkspace(db, getTestActorId(), { enterpriseGranted: false })
		const row = await insertRow(ws.id)
		expect(row.id).toBeDefined()
		expect(row.kind).toBe('topup')
		expect(row.reminderSentAt).toBeNull()
		expect(row.currency).toBe('dkk')
		expect(row.amountTotal).toBe(34_900)
	})

	it('accepts kind="subscription" and rejects any other value (CHECK constraint)', async () => {
		const ws = await insertWorkspace(db, getTestActorId(), { enterpriseGranted: false })
		const sub = await insertRow(ws.id, {
			kind: 'subscription',
			subscriptionId: 'sub_test_1',
			paymentIntentId: null,
		})
		expect(sub.kind).toBe('subscription')

		// Drizzle wraps postgres errors as "Failed query: …" with the real
		// SQLSTATE + constraint name on the .cause chain — assert against the
		// underlying cause rather than the wrapping message so a Drizzle
		// message-shape rotation doesn't silently break the test.
		let caught: unknown
		try {
			await insertRow(ws.id, { kind: 'partial_refund' } as never)
		} catch (err) {
			caught = err
		}
		expect(caught).toBeDefined()
		const cause = (caught as { cause?: { constraint_name?: string; code?: string } }).cause
		expect(cause?.constraint_name).toBe('awaiting_vies_kind_check')
		expect(cause?.code).toBe('23514') // check_violation
	})

	it('UNIQUE(session_id) blocks a webhook replay double-insert (Task 2 dedup key)', async () => {
		const ws = await insertWorkspace(db, getTestActorId(), { enterpriseGranted: false })
		const sessionId = `cs_replay_${crypto.randomUUID()}`
		await insertRow(ws.id, { sessionId })
		let caught: unknown
		try {
			await insertRow(ws.id, { sessionId })
		} catch (err) {
			caught = err
		}
		expect(caught).toBeDefined()
		const cause = (caught as { cause?: { code?: string; constraint_name?: string } }).cause
		expect(cause?.code).toBe('23505') // unique_violation
		expect(cause?.constraint_name).toBe('awaiting_vies_session_id_key')
	})

	it('allows deletion — row lifecycle is the state (Architect invariant)', async () => {
		const ws = await insertWorkspace(db, getTestActorId(), { enterpriseGranted: false })
		const row = await insertRow(ws.id)
		const deleted = await db
			.delete(awaitingVies)
			.where(eq(awaitingVies.id, row.id))
			.returning({ id: awaitingVies.id })
		expect(deleted).toHaveLength(1)
		const gone = await db.select().from(awaitingVies).where(eq(awaitingVies.id, row.id))
		expect(gone).toHaveLength(0)
	})

	it('reminder_sent_at is nullable and independently updatable (Task 3 marker semantics)', async () => {
		const ws = await insertWorkspace(db, getTestActorId(), { enterpriseGranted: false })
		const row = await insertRow(ws.id)
		expect(row.reminderSentAt).toBeNull()

		const now = new Date()
		await db.update(awaitingVies).set({ reminderSentAt: now }).where(eq(awaitingVies.id, row.id))

		const [again] = await db
			.select()
			.from(awaitingVies)
			.where(and(eq(awaitingVies.id, row.id)))
		expect(again?.reminderSentAt).not.toBeNull()
	})

	it('the migration ships NO status column (row existence IS the held state)', async () => {
		const cols = await db.execute<{ column_name: string }>(sql`
			SELECT column_name FROM information_schema.columns
			WHERE table_name = 'awaiting_vies' AND table_schema = 'public'
		`)
		const names = new Set(cols.map((r) => r.column_name))
		expect(names.has('status')).toBe(false)
		// And it DOES ship the load-bearing columns.
		for (const col of [
			'id',
			'session_id',
			'customer_id',
			'kind',
			'payment_intent_id',
			'subscription_id',
			'currency',
			'amount_total',
			'created_at',
			'reminder_sent_at',
			'workspace_id',
		]) {
			expect(names.has(col)).toBe(true)
		}
	})
})
