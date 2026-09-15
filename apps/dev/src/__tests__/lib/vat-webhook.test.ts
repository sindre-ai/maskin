/**
 * Unit tests for the VAT-correct-checkout state machine (spec Delta 2 + 2a + Delta 5).
 *
 * Covers Task 2's acceptance criteria at the helper level. End-to-end
 * integration coverage against a live Stripe test-mode workspace (spec Test
 * approach items 1, 2, 4, 5, 11) belongs to Task 4's rollout verification —
 * see the task body's out-of-scope block.
 */

import type Stripe from 'stripe'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: vi.fn(async () => {}),
}))

vi.mock('../../lib/vat-notifications', () => ({
	sendAwaitingViesEmail: vi.fn(async () => {}),
	sendRejectionEmail: vi.fn(async () => {}),
	sendRejectionEmailForSession: vi.fn(async () => {}),
	sendReleaseEmail: vi.fn(async () => {}),
	notifySebkOnSlack: vi.fn(async () => {}),
}))

import type { Database } from '@maskin/db'
import { capturePosthogEvent } from '../../lib/analytics/posthog'
import {
	notifySebkOnSlack,
	sendAwaitingViesEmail,
	sendRejectionEmail,
	sendRejectionEmailForSession,
	sendReleaseEmail,
} from '../../lib/vat-notifications'
import { applyVatEventIfHandled } from '../../lib/vat-webhook'

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111'
const CUSTOMER_ID = 'cus_test_vat'

function withFlag(on: boolean, run: () => Promise<void> | void) {
	const prior = process.env.MASKIN_VAT_CHECKOUT
	process.env.MASKIN_VAT_CHECKOUT = on ? 'true' : 'false'
	return Promise.resolve(run()).finally(() => {
		if (prior === undefined) process.env.MASKIN_VAT_CHECKOUT = undefined
		else process.env.MASKIN_VAT_CHECKOUT = prior
	})
}

function fakeStripe(overrides: Partial<Stripe> = {}): Stripe {
	return {
		customers: {
			retrieve: vi.fn(async () => ({ tax_ids: { data: [] } })),
		},
		subscriptions: {
			retrieve: vi.fn(async () => ({ latest_invoice: null })),
			cancel: vi.fn(async () => ({})),
		},
		refunds: {
			create: vi.fn(async () => ({})),
		},
		charges: {
			retrieve: vi.fn(async () => ({
				id: 'ch_1',
				customer: CUSTOMER_ID,
				invoice: { id: 'in_1' },
			})),
		},
		...overrides,
	} as unknown as Stripe
}

interface FakeDb {
	insertedRows: unknown[]
	deletedIds: string[]
	selectRows: unknown[]
	transactions: number
}

function fakeDb(selectRows: unknown[] = []): { db: Database; state: FakeDb } {
	const state: FakeDb = { insertedRows: [], deletedIds: [], selectRows, transactions: 0 }
	const db = {
		insert: () => ({
			values: (row: unknown) => ({
				onConflictDoNothing: () => {
					state.insertedRows.push(row)
					return Promise.resolve([{ id: 'row-1' }])
				},
			}),
		}),
		delete: () => ({
			where: () => {
				state.deletedIds.push('deleted')
				return Promise.resolve()
			},
		}),
		select: () => ({
			from: () => ({
				where: () => Promise.resolve(state.selectRows),
			}),
		}),
		transaction: async (cb: (tx: unknown) => Promise<void>) => {
			state.transactions += 1
			await cb(db)
		},
	} as unknown as Database
	return { db, state }
}

function completedSession(
	overrides: Partial<Stripe.Checkout.Session> = {},
): Stripe.Checkout.Session {
	return {
		id: 'cs_test_1',
		mode: 'payment',
		customer: CUSTOMER_ID,
		payment_intent: 'pi_1',
		subscription: null,
		amount_total: 5000,
		currency: 'usd',
		customer_details: { email: 'buyer@example.com' } as Stripe.Checkout.Session.CustomerDetails,
		customer_email: null,
		...overrides,
	} as Stripe.Checkout.Session
}

function event<T>(type: string, obj: T): Stripe.Event {
	return { id: 'evt_1', type, data: { object: obj } } as unknown as Stripe.Event
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe('applyVatEventIfHandled — flag gating (spec Delta 2 rollout)', () => {
	it('returns handled=false for checkout.session.completed when MASKIN_VAT_CHECKOUT is off', async () => {
		await withFlag(false, async () => {
			const { db } = fakeDb()
			const stripe = fakeStripe()
			const out = await applyVatEventIfHandled(
				db,
				WORKSPACE_ID,
				event('checkout.session.completed', completedSession()),
				stripe,
			)
			expect(out).toEqual({ handled: false })
		})
	})

	it('returns handled=false for customer.tax_id.updated when flag is off', async () => {
		await withFlag(false, async () => {
			const { db } = fakeDb()
			const out = await applyVatEventIfHandled(
				db,
				WORKSPACE_ID,
				event('customer.tax_id.updated', {
					customer: CUSTOMER_ID,
					verification: { status: 'verified' },
				}),
				fakeStripe(),
			)
			expect(out).toEqual({ handled: false })
		})
	})

	it('always handles charge.dispute.created regardless of the flag (Delta 5)', async () => {
		await withFlag(false, async () => {
			const { db } = fakeDb()
			const out = await applyVatEventIfHandled(
				db,
				WORKSPACE_ID,
				event('charge.dispute.created', {
					id: 'dp_1',
					charge: 'ch_1',
					amount: 5000,
					currency: 'usd',
					reason: 'fraudulent',
					status: 'needs_response',
				}),
				fakeStripe(),
			)
			expect(out).toEqual({ handled: true })
			expect(notifySebkOnSlack).toHaveBeenCalledOnce()
			expect(capturePosthogEvent).toHaveBeenCalledWith(
				'stripe_dispute_created',
				CUSTOMER_ID,
				expect.objectContaining({ dispute_id: 'dp_1', reason: 'fraudulent' }),
			)
		})
	})
})

describe('checkout.session.completed guard (spec Delta 2 three-way branch)', () => {
	it('pending → UPSERT awaiting_vies, send email, PostHog with awaiting_vies=true, handled=true', async () => {
		await withFlag(true, async () => {
			const { db, state } = fakeDb()
			const stripe = fakeStripe({
				customers: {
					retrieve: vi.fn(async () => ({
						tax_ids: {
							data: [{ verification: { status: 'pending' } }],
						},
					})),
				},
			} as unknown as Partial<Stripe>)

			const out = await applyVatEventIfHandled(
				db,
				WORKSPACE_ID,
				event('checkout.session.completed', completedSession()),
				stripe,
			)

			expect(out).toEqual({ handled: true })
			expect(state.insertedRows).toHaveLength(1)
			expect(state.insertedRows[0]).toMatchObject({
				sessionId: 'cs_test_1',
				customerId: CUSTOMER_ID,
				kind: 'topup',
				paymentIntentId: 'pi_1',
				currency: 'usd',
				amountTotal: 5000,
				workspaceId: WORKSPACE_ID,
			})
			expect(sendAwaitingViesEmail).toHaveBeenCalledOnce()
			expect(capturePosthogEvent).toHaveBeenCalledWith(
				'checkout_session_completed',
				CUSTOMER_ID,
				expect.objectContaining({ awaiting_vies: true }),
			)
		})
	})

	it('unverified → voidSessionDirect + rejection email + stripe_tax_id_rejected + handled=true', async () => {
		await withFlag(true, async () => {
			const { db, state } = fakeDb()
			const refundCreate = vi.fn(async () => ({}))
			const stripe = fakeStripe({
				customers: {
					retrieve: vi.fn(async () => ({
						tax_ids: {
							data: [{ verification: { status: 'unverified' } }],
						},
					})),
				},
				refunds: { create: refundCreate },
			} as unknown as Partial<Stripe>)

			const out = await applyVatEventIfHandled(
				db,
				WORKSPACE_ID,
				event('checkout.session.completed', completedSession()),
				stripe,
			)

			expect(out).toEqual({ handled: true })
			expect(refundCreate).toHaveBeenCalledWith(
				expect.objectContaining({ payment_intent: 'pi_1', reason: 'requested_by_customer' }),
			)
			expect(sendRejectionEmailForSession).toHaveBeenCalledOnce()
			expect(capturePosthogEvent).toHaveBeenCalledWith(
				'stripe_tax_id_rejected',
				CUSTOMER_ID,
				expect.objectContaining({ session_id: 'cs_test_1', reason: 'unverified' }),
			)
			expect(state.insertedRows).toHaveLength(0) // no row on inline-rejected path
		})
	})

	it('empty tax_ids or all verified → PostHog awaiting_vies=false + handled=false (fall through to fulfil)', async () => {
		await withFlag(true, async () => {
			const { db } = fakeDb()
			const stripe = fakeStripe({
				customers: {
					retrieve: vi.fn(async () => ({ tax_ids: { data: [] } })),
				},
			} as unknown as Partial<Stripe>)

			const out = await applyVatEventIfHandled(
				db,
				WORKSPACE_ID,
				event('checkout.session.completed', completedSession()),
				stripe,
			)

			expect(out).toEqual({ handled: false })
			expect(capturePosthogEvent).toHaveBeenCalledWith(
				'checkout_session_completed',
				CUSTOMER_ID,
				expect.objectContaining({ awaiting_vies: false }),
			)
		})
	})

	it('ordering-race guard: `updated(verified)` before `session.completed` → completed reads fresh state and fulfils, no row written (spec Test 11)', async () => {
		await withFlag(true, async () => {
			const { db, state } = fakeDb()
			const stripe = fakeStripe({
				customers: {
					retrieve: vi.fn(async () => ({
						tax_ids: {
							data: [{ verification: { status: 'verified' } }],
						},
					})),
				},
			} as unknown as Partial<Stripe>)

			const out = await applyVatEventIfHandled(
				db,
				WORKSPACE_ID,
				event('checkout.session.completed', completedSession()),
				stripe,
			)

			expect(out).toEqual({ handled: false })
			expect(state.insertedRows).toHaveLength(0)
		})
	})

	it('subscription mode with pending tax_id fresh-reads the PI off latest_invoice before UPSERT (CTO fix #3)', async () => {
		await withFlag(true, async () => {
			const { db, state } = fakeDb()
			const stripe = fakeStripe({
				customers: {
					retrieve: vi.fn(async () => ({
						tax_ids: { data: [{ verification: { status: 'pending' } }] },
					})),
				},
				subscriptions: {
					retrieve: vi.fn(async () => ({
						latest_invoice: { payment_intent: 'pi_sub_first_invoice' },
					})),
					cancel: vi.fn(),
				},
			} as unknown as Partial<Stripe>)

			await applyVatEventIfHandled(
				db,
				WORKSPACE_ID,
				event(
					'checkout.session.completed',
					completedSession({
						mode: 'subscription',
						payment_intent: null,
						subscription: 'sub_test',
					}),
				),
				stripe,
			)

			expect(state.insertedRows).toHaveLength(1)
			expect(state.insertedRows[0]).toMatchObject({
				kind: 'subscription',
				paymentIntentId: 'pi_sub_first_invoice',
				subscriptionId: 'sub_test',
			})
		})
	})
})

describe('customer.tax_id.updated (spec Delta 2 handleTaxIdVerification)', () => {
	it('no matching row → no-op (fast-VIES / not-our-customer)', async () => {
		await withFlag(true, async () => {
			const { db } = fakeDb([])
			const out = await applyVatEventIfHandled(
				db,
				WORKSPACE_ID,
				event('customer.tax_id.updated', {
					customer: CUSTOMER_ID,
					verification: { status: 'verified' },
				}),
				fakeStripe(),
			)
			expect(out).toEqual({ handled: true })
			expect(sendReleaseEmail).not.toHaveBeenCalled()
			expect(sendRejectionEmail).not.toHaveBeenCalled()
			expect(capturePosthogEvent).not.toHaveBeenCalled()
		})
	})

	it('verified with an open row → release email + delete row + stripe_tax_id_verified', async () => {
		await withFlag(true, async () => {
			const heldRow = {
				id: 'row-1',
				sessionId: 'cs_test_1',
				customerId: CUSTOMER_ID,
				kind: 'topup',
				paymentIntentId: 'pi_1',
				subscriptionId: null,
				currency: 'usd',
				amountTotal: 5000,
				reminderSentAt: null,
				workspaceId: null,
				createdAt: new Date(),
			}
			const { db, state } = fakeDb([heldRow])
			const out = await applyVatEventIfHandled(
				db,
				WORKSPACE_ID,
				event('customer.tax_id.updated', {
					customer: CUSTOMER_ID,
					verification: { status: 'verified' },
				}),
				fakeStripe(),
			)
			expect(out).toEqual({ handled: true })
			expect(sendReleaseEmail).toHaveBeenCalledOnce()
			expect(state.deletedIds).toHaveLength(1)
			expect(capturePosthogEvent).toHaveBeenCalledWith(
				'stripe_tax_id_verified',
				CUSTOMER_ID,
				expect.objectContaining({ session_id: 'cs_test_1' }),
			)
		})
	})

	it('unverified with an open row → refund PI + rejection email + delete row + stripe_tax_id_rejected', async () => {
		await withFlag(true, async () => {
			const heldRow = {
				id: 'row-1',
				sessionId: 'cs_test_1',
				customerId: CUSTOMER_ID,
				kind: 'topup',
				paymentIntentId: 'pi_1',
				subscriptionId: null,
				currency: 'usd',
				amountTotal: 5000,
				reminderSentAt: null,
				workspaceId: null,
				createdAt: new Date(),
			}
			const { db, state } = fakeDb([heldRow])
			const refundCreate = vi.fn(async () => ({}))
			const stripe = fakeStripe({
				refunds: { create: refundCreate },
			} as unknown as Partial<Stripe>)
			const out = await applyVatEventIfHandled(
				db,
				WORKSPACE_ID,
				event('customer.tax_id.updated', {
					customer: CUSTOMER_ID,
					verification: { status: 'unverified' },
				}),
				stripe,
			)
			expect(out).toEqual({ handled: true })
			expect(refundCreate).toHaveBeenCalledWith(
				expect.objectContaining({ payment_intent: 'pi_1', reason: 'requested_by_customer' }),
			)
			expect(sendRejectionEmail).toHaveBeenCalledOnce()
			expect(state.deletedIds).toHaveLength(1)
			expect(capturePosthogEvent).toHaveBeenCalledWith(
				'stripe_tax_id_rejected',
				CUSTOMER_ID,
				expect.objectContaining({ session_id: 'cs_test_1', reason: 'unverified' }),
			)
		})
	})

	it('subscription void: cancels the subscription and refunds the stored PI', async () => {
		await withFlag(true, async () => {
			const heldRow = {
				id: 'row-1',
				sessionId: 'cs_sub_1',
				customerId: CUSTOMER_ID,
				kind: 'subscription',
				paymentIntentId: 'pi_sub_1',
				subscriptionId: 'sub_1',
				currency: 'usd',
				amountTotal: 4900,
				reminderSentAt: null,
				workspaceId: null,
				createdAt: new Date(),
			}
			const { db } = fakeDb([heldRow])
			const cancel = vi.fn(async () => ({}))
			const refundCreate = vi.fn(async () => ({}))
			const stripe = fakeStripe({
				subscriptions: { retrieve: vi.fn(), cancel },
				refunds: { create: refundCreate },
			} as unknown as Partial<Stripe>)
			await applyVatEventIfHandled(
				db,
				WORKSPACE_ID,
				event('customer.tax_id.updated', {
					customer: CUSTOMER_ID,
					verification: { status: 'unverified' },
				}),
				stripe,
			)
			expect(cancel).toHaveBeenCalledWith('sub_1', { invoice_now: false, prorate: false })
			expect(refundCreate).toHaveBeenCalledWith(
				expect.objectContaining({ payment_intent: 'pi_sub_1' }),
			)
		})
	})

	it('unavailable/pending status on an open row → leave row open, no email, no PostHog', async () => {
		await withFlag(true, async () => {
			const heldRow = {
				id: 'row-1',
				sessionId: 'cs_test_1',
				customerId: CUSTOMER_ID,
				kind: 'topup',
				paymentIntentId: 'pi_1',
				subscriptionId: null,
				currency: 'usd',
				amountTotal: 5000,
				reminderSentAt: null,
				workspaceId: null,
				createdAt: new Date(),
			}
			const { db, state } = fakeDb([heldRow])
			await applyVatEventIfHandled(
				db,
				WORKSPACE_ID,
				event('customer.tax_id.updated', {
					customer: CUSTOMER_ID,
					verification: { status: 'unavailable' },
				}),
				fakeStripe(),
			)
			expect(state.deletedIds).toHaveLength(0)
			expect(sendReleaseEmail).not.toHaveBeenCalled()
			expect(sendRejectionEmail).not.toHaveBeenCalled()
			expect(capturePosthogEvent).not.toHaveBeenCalled()
		})
	})
})

describe('customer.tax_id.created / .deleted (spec Delta 2)', () => {
	it('created is handled and logs only (no state change)', async () => {
		await withFlag(true, async () => {
			const { db, state } = fakeDb()
			const out = await applyVatEventIfHandled(
				db,
				WORKSPACE_ID,
				event('customer.tax_id.created', {
					customer: CUSTOMER_ID,
					value: 'DE111111111',
					verification: { status: 'pending' },
				}),
				fakeStripe(),
			)
			expect(out).toEqual({ handled: true })
			expect(state.insertedRows).toHaveLength(0)
			expect(state.deletedIds).toHaveLength(0)
		})
	})

	it('deleted is handled and is a no-op', async () => {
		await withFlag(true, async () => {
			const { db, state } = fakeDb()
			const out = await applyVatEventIfHandled(
				db,
				WORKSPACE_ID,
				event('customer.tax_id.deleted', { customer: CUSTOMER_ID }),
				fakeStripe(),
			)
			expect(out).toEqual({ handled: true })
			expect(state.insertedRows).toHaveLength(0)
			expect(state.deletedIds).toHaveLength(0)
		})
	})
})

describe('charge.dispute.created (spec Delta 5 log-and-alert)', () => {
	it('logs, PostHogs, Slack-DMs Sebk, and never mutates state', async () => {
		await withFlag(false, async () => {
			const { db, state } = fakeDb()
			const chargeRetrieve = vi.fn(async () => ({
				id: 'ch_1',
				customer: CUSTOMER_ID,
				invoice: { id: 'in_1' },
			}))
			const stripe = fakeStripe({
				charges: { retrieve: chargeRetrieve },
			} as unknown as Partial<Stripe>)

			const out = await applyVatEventIfHandled(
				db,
				WORKSPACE_ID,
				event('charge.dispute.created', {
					id: 'dp_1',
					charge: 'ch_1',
					amount: 12300,
					currency: 'eur',
					reason: 'general',
					status: 'needs_response',
				}),
				stripe,
			)

			expect(out).toEqual({ handled: true })
			expect(chargeRetrieve).toHaveBeenCalledWith(
				'ch_1',
				expect.objectContaining({ expand: expect.arrayContaining(['invoice']) }),
			)
			expect(notifySebkOnSlack).toHaveBeenCalledOnce()
			const [msg] = vi.mocked(notifySebkOnSlack).mock.calls[0]
			expect(msg).toMatch(/Stripe dispute opened/)
			expect(msg).toMatch(/123\.00 EUR/)
			expect(msg).toMatch(/dp_1/)
			expect(capturePosthogEvent).toHaveBeenCalledWith(
				'stripe_dispute_created',
				CUSTOMER_ID,
				expect.objectContaining({
					dispute_id: 'dp_1',
					invoice_id: 'in_1',
					amount: 12300,
					currency: 'eur',
					reason: 'general',
				}),
			)
			expect(state.insertedRows).toHaveLength(0)
			expect(state.deletedIds).toHaveLength(0)
		})
	})

	it('falls back to dispute id as distinct_id when the charge retrieval fails', async () => {
		await withFlag(false, async () => {
			const { db } = fakeDb()
			const stripe = fakeStripe({
				charges: {
					retrieve: vi.fn(async () => {
						throw new Error('stripe boom')
					}),
				},
			} as unknown as Partial<Stripe>)

			await applyVatEventIfHandled(
				db,
				WORKSPACE_ID,
				event('charge.dispute.created', {
					id: 'dp_1',
					charge: 'ch_1',
					amount: 5000,
					currency: 'usd',
					reason: 'fraudulent',
					status: 'needs_response',
				}),
				stripe,
			)

			expect(capturePosthogEvent).toHaveBeenCalledWith(
				'stripe_dispute_created',
				'dp_1',
				expect.any(Object),
			)
			expect(notifySebkOnSlack).toHaveBeenCalledOnce()
		})
	})
})
