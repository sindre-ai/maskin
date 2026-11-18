import { describe, expect, it } from 'vitest'
import {
	StripeApiError,
	checkStripeKeyAccess,
	listCompletedCheckouts,
	listPaidInvoices,
} from '../../lib/stripe-payments'

// Bodies shaped like Stripe's own list responses, trimmed to the fields the job reads.
const invoiceList = {
	object: 'list',
	has_more: false,
	data: [
		{
			id: 'in_1',
			object: 'invoice',
			status: 'paid',
			amount_paid: 49000,
			currency: 'dkk',
			customer_email: 'Anna@Byg.dk',
			created: 1_762_900_000,
			status_transitions: { paid_at: 1_762_900_100 },
		},
		{ id: 'in_free', status: 'paid', amount_paid: 0, currency: 'dkk', customer_email: 'x@y.dk' },
	],
}
const checkoutList = {
	object: 'list',
	has_more: false,
	data: [
		{
			id: 'cs_1',
			status: 'complete',
			payment_status: 'paid',
			amount_total: 9900,
			currency: 'eur',
			invoice: null,
			customer_details: { email: 'lars@orbe.dk' },
			created: 1_762_950_000,
		},
		{
			id: 'cs_with_invoice',
			status: 'complete',
			payment_status: 'paid',
			amount_total: 49000,
			currency: 'dkk',
			invoice: 'in_1',
			customer_details: { email: 'anna@byg.dk' },
			created: 1_762_900_000,
		},
		{
			id: 'cs_unpaid',
			status: 'complete',
			payment_status: 'unpaid',
			amount_total: 100,
			currency: 'eur',
			invoice: null,
			customer_details: { email: 'a@b.dk' },
			created: 1_762_900_000,
		},
	],
}

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('listPaidInvoices', () => {
	it('keeps paid invoices with money, in minor units, with the paid time', async () => {
		const calls: URL[] = []
		const fetchFn = (async (url: URL, init: RequestInit) => {
			calls.push(url)
			expect((init.headers as Record<string, string>).Authorization).toBe('Bearer k')
			return json(invoiceList)
		}) as unknown as typeof fetch

		const since = new Date('2025-11-01T00:00:00Z')
		const out = await listPaidInvoices('k', since, fetchFn)

		expect(out).toEqual([
			{
				id: 'in_1',
				kind: 'invoice',
				email: 'Anna@Byg.dk',
				amount: 49000,
				currency: 'dkk',
				paidAt: new Date(1_762_900_100 * 1000),
			},
		])
		expect(calls[0]?.pathname).toBe('/v1/invoices')
		expect(calls[0]?.searchParams.get('status')).toBe('paid')
		expect(calls[0]?.searchParams.get('created[gte]')).toBe(
			String((since.getTime() - 45 * 24 * 60 * 60 * 1000) / 1000),
		)
	})

	it('reads an invoice created before the window but paid inside it', async () => {
		const since = new Date('2026-11-12T00:00:00Z')
		const createdAt = Date.parse('2026-10-20T00:00:00Z') / 1000
		const fetchFn = (async (url: URL) => {
			// Stripe filters on created, so honour created[gte] like the real API does.
			const from = Number(url.searchParams.get('created[gte]'))
			const base = { status: 'paid', amount_paid: 5000, currency: 'dkk', customer_email: 'a@b.dk' }
			const rows = [
				{
					...base,
					id: 'in_paid_late',
					created: createdAt,
					status_transitions: { paid_at: Date.parse('2026-11-12T08:00:00Z') / 1000 },
				},
				{
					...base,
					id: 'in_paid_early',
					created: createdAt,
					status_transitions: { paid_at: Date.parse('2026-10-25T08:00:00Z') / 1000 },
				},
			].filter((r) => r.created >= from)
			return json({ has_more: false, data: rows })
		}) as unknown as typeof fetch

		const out = await listPaidInvoices('k', since, fetchFn)

		expect(out.map((p) => p.id)).toEqual(['in_paid_late'])
	})

	it('follows starting_after until Stripe says there is no more', async () => {
		const afters: Array<string | null> = []
		const fetchFn = (async (url: URL) => {
			const after = url.searchParams.get('starting_after')
			afters.push(after)
			const base = { status: 'paid', amount_paid: 100, currency: 'dkk', customer_email: 'a@b.dk' }
			return after
				? json({ has_more: false, data: [{ ...base, id: 'in_2' }] })
				: json({ has_more: true, data: [{ ...base, id: 'in_1' }] })
		}) as unknown as typeof fetch

		const out = await listPaidInvoices('k', new Date(0), fetchFn)

		expect(out.map((p) => p.id)).toEqual(['in_1', 'in_2'])
		expect(afters).toEqual([null, 'in_1'])
	})

	it('throws on a failed page instead of returning a partial list', async () => {
		const fetchFn = (async () =>
			json(
				{ error: { type: 'api_error', message: 'Something went wrong.' } },
				500,
			)) as unknown as typeof fetch
		await expect(listPaidInvoices('k', new Date(0), fetchFn)).rejects.toMatchObject({
			status: 500,
			code: 'api_error',
		})
	})
})

describe('listCompletedCheckouts', () => {
	it('keeps paid sessions and leaves out one that made an invoice, so a payment counts once', async () => {
		const fetchFn = (async () => json(checkoutList)) as unknown as typeof fetch
		const out = await listCompletedCheckouts('k', new Date(0), fetchFn)
		expect(out).toEqual([
			{
				id: 'cs_1',
				kind: 'checkout',
				email: 'lars@orbe.dk',
				amount: 9900,
				currency: 'eur',
				paidAt: new Date(1_762_950_000 * 1000),
			},
		])
	})
})

describe('checkStripeKeyAccess', () => {
	it('is null when both listings answer', async () => {
		const fetchFn = (async () => json({ data: [], has_more: false })) as unknown as typeof fetch
		expect(await checkStripeKeyAccess('k', fetchFn)).toBeNull()
	})

	it('says which listing the key cannot read', async () => {
		const fetchFn = (async (url: URL) =>
			url.pathname === '/v1/invoices'
				? json(
						{
							error: {
								type: 'invalid_request_error',
								code: 'secret_key_required',
								message: 'The provided key does not have the required permissions.',
							},
						},
						403,
					)
				: json({ data: [] })) as unknown as typeof fetch
		const reason = await checkStripeKeyAccess('k', fetchFn)
		expect(reason).toContain('cannot read invoices')
		expect(reason).toContain('403')
	})

	it('does not throw when Stripe cannot be reached', async () => {
		const fetchFn = (async () => {
			throw new Error('socket hang up')
		}) as unknown as typeof fetch
		expect(await checkStripeKeyAccess('k', fetchFn)).toContain('could not be reached')
	})
})

describe('StripeApiError', () => {
	it('carries the status and code', () => {
		const err = new StripeApiError(401, 'api_key_invalid', 'nope')
		expect([err.status, err.code, err.name]).toEqual([401, 'api_key_invalid', 'StripeApiError'])
	})
})
