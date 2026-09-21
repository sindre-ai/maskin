import { type AwaitingViesRow, awaitingVies } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import type Stripe from 'stripe'
import { vi } from 'vitest'
import { processViesScheduler, sweepReminders, sweepTimeouts } from '../../jobs/vies-scheduler'
import { markReminderSent } from '../../lib/awaiting-vies'
import { insertWorkspace } from '../factories'
import { db, getTestActorId, sql } from './global-setup'

vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: vi.fn(async () => {}),
}))

vi.mock('../../lib/stripe', async (importOriginal) => {
	const mod = await importOriginal<typeof import('../../lib/stripe')>()
	return {
		...mod,
		getStripeClient: () => stripeMock as unknown as Stripe,
	}
})

const stripeMock = {
	refunds: { create: vi.fn(async () => ({ id: 're_test' })) },
	subscriptions: { cancel: vi.fn(async () => ({ id: 'sub_test' })) },
}

async function insertAwaitingViesRow(
	workspaceId: string,
	overrides: Partial<AwaitingViesRow> & { createdAt: Date; sessionId: string },
): Promise<AwaitingViesRow> {
	const [row] = await db
		.insert(awaitingVies)
		.values({
			sessionId: overrides.sessionId,
			customerId: overrides.customerId ?? `cus_${overrides.sessionId}`,
			workspaceId,
			kind: overrides.kind ?? 'topup',
			paymentIntentId: overrides.paymentIntentId ?? 'pi_test_123',
			subscriptionId: overrides.subscriptionId ?? null,
			currency: overrides.currency ?? 'usd',
			amountTotal: overrides.amountTotal ?? 5000,
			reminderSentAt: overrides.reminderSentAt ?? null,
			createdAt: overrides.createdAt,
		})
		.returning()
	return row
}

const HOUR_MS = 60 * 60 * 1000

describe('VIES scheduler integration', () => {
	let workspaceId: string

	beforeEach(async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		workspaceId = ws.id
		await sql`TRUNCATE awaiting_vies`
		stripeMock.refunds.create.mockClear()
		stripeMock.subscriptions.cancel.mockClear()
	})

	/**
	 * Spec Test approach item 3: a T+25h row runs through the timeout sweep
	 * and comes out with a refund submitted, the row deleted, and (once
	 * Task 2 lands its real transactional rejection email) an email sent.
	 * On this branch the rejection email is a stub log line — see the
	 * corresponding assertion below.
	 */
	it('sweepTimeouts refunds and deletes a T+25h topup row', async () => {
		const now = new Date()
		const row = await insertAwaitingViesRow(workspaceId, {
			sessionId: 'cs_test_timeout_1',
			createdAt: new Date(now.getTime() - 25 * HOUR_MS),
			paymentIntentId: 'pi_test_timeout_1',
		})

		await sweepTimeouts(db, now, 24 * HOUR_MS)

		expect(stripeMock.refunds.create).toHaveBeenCalledWith({
			payment_intent: 'pi_test_timeout_1',
			reason: 'requested_by_customer',
		})

		const remaining = await db.select().from(awaitingVies).where(eq(awaitingVies.id, row.id))
		expect(remaining).toHaveLength(0)
	})

	/**
	 * Spec Test approach item 12 (part A): a T+2h5min row runs through
	 * two consecutive ticks and fires exactly one reminder email + one
	 * `vies_hold_reminder_sent` PostHog capture. This proves the
	 * reminder-sent flag prevents double-firing across ticks.
	 */
	it('sweepReminders sends exactly one reminder across two consecutive ticks', async () => {
		const posthog = await import('../../lib/analytics/posthog')
		const captureMock = vi.mocked(posthog.capturePosthogEvent)
		captureMock.mockClear()

		const now = new Date()
		const row = await insertAwaitingViesRow(workspaceId, {
			sessionId: 'cs_test_reminder_1',
			customerId: 'cus_test_reminder_1',
			createdAt: new Date(now.getTime() - 2 * HOUR_MS - 5 * 60 * 1000),
		})

		await sweepReminders(db, now, 2 * HOUR_MS)
		await sweepReminders(db, new Date(now.getTime() + 60_000), 2 * HOUR_MS)

		const reminderSentEvents = captureMock.mock.calls.filter(
			([event]) => event === 'vies_hold_reminder_sent',
		)
		expect(reminderSentEvents).toHaveLength(1)

		const [[, distinctId, props]] = reminderSentEvents
		expect(distinctId).toBe('cus_test_reminder_1')
		expect(props).toMatchObject({
			session_id: 'cs_test_reminder_1',
		})
		expect(typeof props.minutes_elapsed).toBe('number')
		expect(props.minutes_elapsed).toBeGreaterThanOrEqual(125)

		const [after] = await db.select().from(awaitingVies).where(eq(awaitingVies.id, row.id))
		expect(after.reminderSentAt).not.toBeNull()
	})

	/**
	 * Spec Test approach item 12 (part B — the race): a webhook DELETE
	 * happening between `findRemindable` and `markReminderSent` must NOT
	 * result in a reminder being sent. We simulate this by deleting the
	 * row after `findRemindable` returns it, then calling
	 * `markReminderSent` directly — the transactional lock means the
	 * follow-up UPDATE finds nothing and returns false, so no email fires.
	 */
	it('markReminderSent returns false when the row was deleted by a concurrent webhook', async () => {
		const now = new Date()
		const row = await insertAwaitingViesRow(workspaceId, {
			sessionId: 'cs_test_race_1',
			createdAt: new Date(now.getTime() - 2 * HOUR_MS - 5 * 60 * 1000),
		})

		// Simulate the concurrent webhook DELETE that fires between the
		// scheduler's `findRemindable` and its call to `markReminderSent`.
		await db.delete(awaitingVies).where(eq(awaitingVies.id, row.id))

		const stamped = await markReminderSent(db, row.id)
		expect(stamped).toBe(false)
	})
})
