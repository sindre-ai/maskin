import { readings } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import {
	PAID_MEASURE,
	type StripePaymentSyncConfig,
	type StripePaymentSyncDeps,
	StripePaymentSyncJob,
	UNMATCHED_MEASURE,
} from '../../jobs/stripe-payment-sync'
import { logger } from '../../lib/logger'
import type { StripePayment } from '../../lib/stripe-payments'
import { insertObject, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

function payment(overrides?: Partial<StripePayment>): StripePayment {
	return {
		id: `in_${Math.random().toString(36).slice(2)}`,
		kind: 'invoice',
		email: 'anna@byg.dk',
		amount: 49000,
		currency: 'dkk',
		paidAt: new Date('2026-11-12T10:00:00Z'),
		...overrides,
	}
}

async function setup(payments: StripePayment[], depOverrides?: Partial<StripePaymentSyncDeps>) {
	const actorId = getTestActorId()
	const ws = await insertWorkspace(db, actorId)
	const loop = await insertObject(db, ws.id, actorId, { type: 'loop', title: 'SMB sales pilot' })
	const anna = await insertObject(db, ws.id, actorId, {
		type: 'contact',
		title: 'Anna',
		metadata: { email: 'anna@byg.dk' },
	})
	const deps = {
		readKey: vi.fn(async () => 'key'),
		checkKeyAccess: vi.fn(async () => null),
		listPaidInvoices: vi.fn(async () => payments),
		listCompletedCheckouts: vi.fn(async () => []),
		now: () => new Date('2026-11-13T00:00:00Z'),
		...depOverrides,
	} as unknown as StripePaymentSyncDeps
	const config: StripePaymentSyncConfig = {
		workspaceId: ws.id,
		actorId,
		loopId: loop.id,
		keyName: 'Stripe',
		backfillFrom: new Date('2026-11-01T00:00:00Z'),
	}
	const job = new StripePaymentSyncJob(db, config, deps)
	return { ws, loop, anna, deps, config, job, actorId }
}

const rowsIn = (workspaceId: string, measure: string) =>
	db
		.select()
		.from(readings)
		.where(and(eq(readings.workspaceId, workspaceId), eq(readings.measure, measure)))

describe('StripePaymentSyncJob.tick', () => {
	it('writes a stripe.paid reading on the person whose email matches', async () => {
		const p = payment({ id: 'in_match' })
		const { ws, anna, job } = await setup([p])

		expect(await job.tick()).toBe(1)

		const rows = await rowsIn(ws.id, PAID_MEASURE)
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({
			subjectId: anna.id,
			value: 49000,
			source: 'stripe',
			sourceRef: 'in_match',
			detail: { currency: 'dkk', kind: 'invoice' },
		})
		expect(rows[0]?.readAt.toISOString()).toBe('2026-11-12T10:00:00.000Z')
		expect(await rowsIn(ws.id, UNMATCHED_MEASURE)).toHaveLength(0)
	})

	it('matches the same address whatever its case or padding', async () => {
		const { ws, anna, job } = await setup([payment({ email: '  Anna@Byg.DK ' })])
		expect(await job.tick()).toBe(1)
		expect((await rowsIn(ws.id, PAID_MEASURE))[0]?.subjectId).toBe(anna.id)
	})

	it('writes no payment reading when nobody has that email, and counts it on the loop', async () => {
		const p = payment({ id: 'in_nobody', email: 'stranger@elsewhere.dk' })
		const { ws, loop, job } = await setup([p])

		expect(await job.tick()).toBe(0)

		expect(await rowsIn(ws.id, PAID_MEASURE)).toHaveLength(0)
		const unmatched = await rowsIn(ws.id, UNMATCHED_MEASURE)
		expect(unmatched).toHaveLength(1)
		expect(unmatched[0]).toMatchObject({
			subjectId: loop.id,
			value: 1,
			sourceRef: 'in_nobody',
			detail: { reason: 'no_person', amount: 49000, currency: 'dkk' },
		})
		// The count never holds the address itself.
		expect(JSON.stringify(unmatched[0]?.detail)).not.toContain('stranger')
	})

	it('does not match on the domain alone', async () => {
		// Same domain as Anna, a different person: byg.dk must not win Anna's lead.
		const { ws, job } = await setup([payment({ id: 'in_domain', email: 'someone.else@byg.dk' })])

		expect(await job.tick()).toBe(0)

		expect(await rowsIn(ws.id, PAID_MEASURE)).toHaveLength(0)
		expect((await rowsIn(ws.id, UNMATCHED_MEASURE))[0]?.detail).toMatchObject({
			reason: 'no_person',
		})
	})

	it('does not let a shared mail domain win every lead', async () => {
		const actorId = getTestActorId()
		const { ws, job } = await setup([payment({ id: 'in_gmail', email: 'buyer@gmail.com' })])
		await insertObject(db, ws.id, actorId, {
			type: 'contact',
			title: 'Other gmail user',
			metadata: { email: 'other@gmail.com' },
		})
		expect(await job.tick()).toBe(0)
		expect(await rowsIn(ws.id, PAID_MEASURE)).toHaveLength(0)
	})

	it('counts a payment with no email, and one whose email two people share, as unmatched', async () => {
		const { ws, job, actorId } = await setup([
			payment({ id: 'in_noemail', email: null }),
			payment({ id: 'in_shared', email: 'twin@byg.dk' }),
		])
		for (const title of ['Twin one', 'Twin two']) {
			await insertObject(db, ws.id, actorId, {
				type: 'contact',
				title,
				metadata: { email: 'twin@byg.dk' },
			})
		}

		expect(await job.tick()).toBe(0)

		const reasons = new Map(
			(await rowsIn(ws.id, UNMATCHED_MEASURE)).map((r) => [
				r.sourceRef,
				(r.detail as { reason: string }).reason,
			]),
		)
		expect(reasons.get('in_noemail')).toBe('no_email')
		expect(reasons.get('in_shared')).toBe('several_people')
		expect(await rowsIn(ws.id, PAID_MEASURE)).toHaveLength(0)
	})

	it('ignores a person in another workspace', async () => {
		const actorId = getTestActorId()
		const other = await insertWorkspace(db, actorId)
		await insertObject(db, other.id, actorId, {
			type: 'contact',
			title: 'Elsewhere',
			metadata: { email: 'far@away.dk' },
		})
		const { ws, job } = await setup([payment({ id: 'in_far', email: 'far@away.dk' })])
		expect(await job.tick()).toBe(0)
		expect(await rowsIn(ws.id, PAID_MEASURE)).toHaveLength(0)
		expect(await rowsIn(other.id, PAID_MEASURE)).toHaveLength(0)
	})

	it('adds no second reading when it runs twice on the same payments', async () => {
		const { ws, job } = await setup([
			payment({ id: 'in_a' }),
			payment({ id: 'in_b', email: 'stranger@elsewhere.dk' }),
		])
		expect(await job.tick()).toBe(1)
		expect(await job.tick()).toBe(0)

		expect(await rowsIn(ws.id, PAID_MEASURE)).toHaveLength(1)
		expect(await rowsIn(ws.id, UNMATCHED_MEASURE)).toHaveLength(1)
	})

	it('adds no second reading when a fresh job reads the same payments again', async () => {
		const p = payment({ id: 'in_restart' })
		const first = await setup([p])
		expect(await first.job.tick()).toBe(1)
		// A restart forgets the watermark and rescans from the start date.
		const second = new StripePaymentSyncJob(db, first.config, first.deps)
		expect(await second.tick()).toBe(0)
		expect(await rowsIn(first.ws.id, PAID_MEASURE)).toHaveLength(1)
	})

	it('reads from the start date on the first run and from the overlap after a clean one', async () => {
		const { deps, job } = await setup([])
		await job.tick()
		await job.tick()
		const calls = vi.mocked(deps.listPaidInvoices).mock.calls
		expect(calls[0]?.[1]).toEqual(new Date('2026-11-01T00:00:00Z'))
		// now is 13 Nov 00:00, so the next window starts a day earlier.
		expect(calls[1]?.[1]).toEqual(new Date('2026-11-12T00:00:00Z'))
	})

	it('stops at the first step, and says so once, when the key cannot read invoices', async () => {
		const errors = vi.spyOn(logger, 'error').mockImplementation(() => {})
		try {
			const { ws, deps, job } = await setup([payment()], {
				checkKeyAccess: vi.fn(
					async () => 'The Stripe key cannot read invoices (Stripe answered 403).',
				),
			})

			expect(await job.tick()).toBe(0)
			expect(await job.tick()).toBe(0)

			expect(deps.listPaidInvoices).not.toHaveBeenCalled()
			expect(await rowsIn(ws.id, PAID_MEASURE)).toHaveLength(0)
			const stops = errors.mock.calls.filter(([m]) => String(m).includes('payment sync stopped'))
			expect(stops).toHaveLength(1)
			expect(String(stops[0]?.[0])).toContain('cannot read invoices')
		} finally {
			errors.mockRestore()
		}
	})

	it('stops when there is no key, and does not throw', async () => {
		const errors = vi.spyOn(logger, 'error').mockImplementation(() => {})
		try {
			const { deps, job } = await setup([payment()], { readKey: vi.fn(async () => null) })
			expect(await job.tick()).toBe(0)
			expect(deps.checkKeyAccess).not.toHaveBeenCalled()
			expect(String(errors.mock.calls[0]?.[0])).toContain('No active Keychain key')
		} finally {
			errors.mockRestore()
		}
	})

	it('never throws when Stripe fails, and retries from the same point next time', async () => {
		const errors = vi.spyOn(logger, 'error').mockImplementation(() => {})
		try {
			const list = vi
				.fn()
				.mockRejectedValueOnce(new Error('Stripe answered 500'))
				.mockResolvedValueOnce([payment({ id: 'in_late' })])
			const { ws, job } = await setup([], { listPaidInvoices: list })

			await expect(job.tick()).resolves.toBe(0)
			expect(await job.tick()).toBe(1)
			expect(await rowsIn(ws.id, PAID_MEASURE)).toHaveLength(1)
			expect(list.mock.calls[1]?.[1]).toEqual(list.mock.calls[0]?.[1])
		} finally {
			errors.mockRestore()
		}
	})

	it('records a checkout the same way as an invoice', async () => {
		const { ws, anna, job } = await setup([], {
			listCompletedCheckouts: vi.fn(async () => [
				payment({ id: 'cs_1', kind: 'checkout', amount: 9900, currency: 'eur' }),
			]),
		})
		expect(await job.tick()).toBe(1)
		expect((await rowsIn(ws.id, PAID_MEASURE))[0]).toMatchObject({
			subjectId: anna.id,
			value: 9900,
			sourceRef: 'cs_1',
			detail: { currency: 'eur', kind: 'checkout' },
		})
	})
})
