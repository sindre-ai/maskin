import { describe, expect, it } from 'vitest'
import {
	FILING_NOT_FILED_NOTICE,
	bookedFiguresByVatCode,
	buildFilingHandoff,
} from '../../../../lib/integrations/providers/dinero/filing-handoff'
import type { ReviewItem } from '../../../../lib/integrations/providers/dinero/review'

const item = (over: Partial<ReviewItem>): ReviewItem => ({
	event_id: 1,
	at: null,
	tool: 'CreateFinanceVoucher',
	outcome: 'success',
	booked: true,
	voucher_date: '2026-11-10',
	lines: [
		{ description: null, amount: 100, account: 1000, counter_account: null, vat_code: 'I25' },
	],
	result: null,
	reverses_event_id: null,
	reversed_by_event_id: null,
	can_reverse: false,
	cannot_reverse_because: null,
	...over,
})

describe('bookedFiguresByVatCode', () => {
	it('sums booked lines per VAT code', () => {
		const rows = bookedFiguresByVatCode([
			item({ event_id: 1 }),
			item({ event_id: 2, lines: [{ ...item({}).lines[0], amount: 50.5 } as never] }),
			item({
				event_id: 3,
				lines: [
					{ description: null, amount: 7, account: 1, counter_account: null, vat_code: null },
				],
			}),
		])
		expect(rows).toEqual([
			{ vat_code: null, lines: 1, amount_incl_vat: 7 },
			{ vat_code: 'I25', lines: 2, amount_incl_vat: 150.5 },
		])
	})

	it('leaves out drafts, failed calls, reversed items and their counter-postings', () => {
		const rows = bookedFiguresByVatCode([
			item({ event_id: 1, booked: false }),
			item({ event_id: 2, outcome: 'error', booked: false }),
			item({ event_id: 3, reversed_by_event_id: 4 }),
			item({ event_id: 4, reverses_event_id: 3 }),
		])
		expect(rows).toEqual([])
	})
})

describe('buildFilingHandoff', () => {
	it('carries who approved, the steps and a notice that nothing was filed', () => {
		const h = buildFilingHandoff({
			from: '2026-10-01',
			to: '2026-10-31',
			items: [item({})],
			approvedBy: 'owner-1',
			approvedAt: new Date('2026-11-01T10:00:00Z'),
			figuresHash: 'h'.repeat(64),
		})
		expect(h).toMatchObject({
			approved_by: 'owner-1',
			approved_at: '2026-11-01T10:00:00.000Z',
			notice: FILING_NOT_FILED_NOTICE,
		})
		expect(h.steps.join(' ')).toContain('2026-10-01 to 2026-10-31')
		// The only place "filed" appears is the denial.
		const text = JSON.stringify(h).toLowerCase().replace('nothing has been filed', '')
		expect(text).not.toMatch(/\b(was|has been|is|are) filed\b|\bfiled for you\b/)
	})
})
