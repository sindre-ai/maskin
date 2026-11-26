import { describe, expect, it } from 'vitest'
import {
	FILING_NOT_FILED_NOTICE,
	buildFilingHandoff,
} from '../../../../lib/integrations/providers/dinero/filing-handoff'
import type { ReviewItem } from '../../../../lib/integrations/providers/dinero/review'
import { buildVatReport } from '../../../../lib/integrations/providers/dinero/vat-report'

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
	receipt: null,
	result: null,
	reverses_event_id: null,
	reversed_by_event_id: null,
	can_reverse: false,
	cannot_reverse_because: null,
	...over,
})

describe('buildFilingHandoff', () => {
	it('carries who approved, the steps and a notice that nothing was filed', () => {
		const h = buildFilingHandoff({
			from: '2026-10-01',
			to: '2026-10-31',
			report: buildVatReport({
				from: '2026-10-01',
				to: '2026-10-31',
				items: [item({})],
				figuresHash: 'h'.repeat(64),
			}),
			approvedBy: 'owner-1',
			approvedAt: new Date('2026-11-01T10:00:00Z'),
			figuresHash: 'h'.repeat(64),
		})
		expect(h).toMatchObject({
			approved_by: 'owner-1',
			approved_at: '2026-11-01T10:00:00.000Z',
			notice: FILING_NOT_FILED_NOTICE,
		})
		// The figures are the VAT report's own lines: one set, not a second build.
		expect(h.figures).toMatchObject([
			{ vat_code: 'I25', lines: 1, amount_incl_vat: 100, vat_amount: 20, net_amount: 80 },
		])
		expect(h.steps.join(' ')).toContain('2026-10-01 to 2026-10-31')
		// The only place "filed" appears is the denial.
		const text = JSON.stringify(h).toLowerCase().replace('nothing has been filed', '')
		expect(text).not.toMatch(/\b(was|has been|is|are) filed\b|\bfiled for you\b/)
	})
})
