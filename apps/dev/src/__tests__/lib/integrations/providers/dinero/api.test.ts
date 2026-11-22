import { describe, expect, it } from 'vitest'
import {
	DINERO_OPERATIONS,
	type DineroOperation,
	buildRequest,
	trimContacts,
	trimEntries,
	trimVoucher,
} from '../../../../../lib/integrations/providers/dinero/api'

const GUID = '11111111-2222-4333-8444-555555555555'

const ALL: DineroOperation[] = [
	{ op: 'list_organizations' },
	{ op: 'list_purchase_accounts' },
	{ op: 'list_vat_types' },
	{ op: 'list_contacts', page: 0, pageSize: 50 },
	{ op: 'list_entries', fromDate: '2026-01-01', toDate: '2026-01-31' },
	{ op: 'get_purchase_voucher', guid: GUID },
	{ op: 'upload_file', form: new FormData() },
	{ op: 'create_purchase_voucher_draft', body: {} },
]

describe('Dinero operations', () => {
	it('lists every operation once, so a new one cannot be added unseen', () => {
		expect(ALL.map((o) => o.op).sort()).toEqual([...DINERO_OPERATIONS].sort())
	})

	it('cannot book, change or delete: only GET, and POST for the file upload and the draft', () => {
		for (const operation of ALL) {
			const req = buildRequest(42, operation)
			expect(['GET', 'POST']).toContain(req.method)
			expect(req.url.startsWith('https://api.dinero.dk/')).toBe(true)
			// Booking is its own call in Dinero's API and is never built here.
			expect(req.url).not.toMatch(/\/book(\/|\?|$)/i)
			if (req.method === 'POST') {
				expect(['upload_file', 'create_purchase_voucher_draft']).toContain(operation.op)
			}
		}
	})

	it('saves the voucher through the draft endpoint', () => {
		const req = buildRequest(42, { op: 'create_purchase_voucher_draft', body: { a: 1 } })
		expect(req.url).toBe('https://api.dinero.dk/v1.2/42/vouchers/purchase')
		expect(req.body).toBe('{"a":1}')
	})
})

describe('trimmers', () => {
	it('marks a draft voucher, and anything else as not a draft', () => {
		expect(trimVoucher({ Guid: GUID, Status: 'Draft' })?.is_draft).toBe(true)
		expect(trimVoucher({ Guid: GUID, Status: 'Paid' })?.is_draft).toBe(false)
		expect(trimVoucher({ Guid: GUID })?.is_draft).toBe(false)
		expect(trimVoucher('nope')).toBeNull()
	})

	it('pages contacts and entries and says when there is more', () => {
		const contacts = trimContacts(
			{
				Collection: [{ ContactGuid: GUID, Name: 'A', IsCreditor: true }],
				Pagination: { Result: 3 },
			},
			0,
			1,
		)
		expect(contacts?.has_more).toBe(true)
		expect(contacts?.items[0]).toMatchObject({ contact_guid: GUID, name: 'A', is_creditor: true })

		const rows = Array.from({ length: 250 }, (_, i) => ({ VoucherNumber: i, Amount: 1 }))
		const first = trimEntries(rows, 0)
		expect(first?.items).toHaveLength(200)
		expect(first?.next_skip).toBe(200)
		expect(trimEntries(rows, 200)?.has_more).toBe(false)
	})
})
