import type { Database } from '@maskin/db'
import { type AwaitingViesRow, awaitingVies } from '@maskin/db/schema'
import { and, isNull, lt, sql } from 'drizzle-orm'

export type { AwaitingViesRow }

/**
 * Rows written by Stripe's `checkout.session.completed` webhook when the
 * fresh `customers.retrieve(...tax_ids)` returns a `pending` VAT id — see
 * migration `0070_awaiting_vies.sql` for the full lifecycle.
 *
 * The VIES scheduler (`apps/dev/src/jobs/vies-scheduler.ts`) is the only
 * reader outside the webhook handler itself. It uses `findRemindable` +
 * `markReminderSent` on the T+2h reminder sweep and `findOlderThan` on the
 * T+24h timeout sweep. Both sweeps are gated behind `MASKIN_VAT_CHECKOUT`
 * at the scheduler layer so the accessors themselves never need to know
 * about the flag.
 */

/**
 * Rows older than `olderThan` that still have not fired their reminder.
 * The `reminder_sent_at IS NULL` filter uses the same predicate the T+24h
 * timeout sweep does not (`findOlderThan`), which is why they are two
 * separate methods rather than one filtered client-side. Excludes rows a
 * concurrent webhook is racing to delete only if `markReminderSent` runs
 * behind a `FOR UPDATE` lock — this method is the candidate set, not the
 * committed set.
 */
export async function findRemindable(db: Database, olderThan: Date): Promise<AwaitingViesRow[]> {
	return db
		.select()
		.from(awaitingVies)
		.where(and(lt(awaitingVies.createdAt, olderThan), isNull(awaitingVies.reminderSentAt)))
}

/**
 * Rows older than `cutoff`, regardless of `reminder_sent_at`. Fed straight
 * into `voidAwaitingRow(row, 'timeout')` by the T+24h sweep. Reminder-sent
 * state does not gate the timeout — a row that got its reminder still
 * times out if it stays open past T+24h.
 */
export async function findOlderThan(db: Database, cutoff: Date): Promise<AwaitingViesRow[]> {
	return db.select().from(awaitingVies).where(lt(awaitingVies.createdAt, cutoff))
}

/**
 * Transactional stamp of `reminder_sent_at`. Opens a transaction, takes
 * `SELECT ... FOR UPDATE` on the row, re-checks the row still exists AND
 * `reminder_sent_at IS NULL`, then updates the timestamp. Returns true iff
 * the update happened. Returns false when:
 *
 *   - a concurrent `customer.tax_id.updated` webhook has deleted the row
 *     between `findRemindable` and the lock (release or reject)
 *   - a prior tick already stamped `reminder_sent_at` (idempotent — two
 *     consecutive scheduler ticks with an old row must still fire exactly
 *     one reminder; see integration test 12).
 *
 * The email and PostHog capture are the caller's responsibility and MUST
 * only fire on `true` — a `false` return means either the row is gone or
 * the reminder is already sent, and firing again would double-send.
 */
export async function markReminderSent(db: Database, id: string): Promise<boolean> {
	return db.transaction(async (tx) => {
		// drizzle-orm/postgres-js's `.execute()` returns rows directly (no
		// `{ rows: [...] }` wrapper). Established cast pattern in this repo,
		// see `apps/dev/src/lib/claude-oauth-recovery.ts:158`.
		const locked = (await tx.execute(
			sql`SELECT id, reminder_sent_at FROM awaiting_vies WHERE id = ${id} FOR UPDATE`,
		)) as unknown as Array<{ id: string; reminder_sent_at: Date | null }>
		const row = locked[0]
		if (!row) return false
		if (row.reminder_sent_at !== null) return false

		await tx.execute(sql`UPDATE awaiting_vies SET reminder_sent_at = now() WHERE id = ${id}`)
		return true
	})
}
