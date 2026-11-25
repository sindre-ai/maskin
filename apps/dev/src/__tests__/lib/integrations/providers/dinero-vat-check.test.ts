import { describe, expect, it } from 'vitest'
import type { ReviewItem } from '../../../../lib/integrations/providers/dinero/review'
import {
	VAT_CHECK_KINDS,
	VAT_CHECK_NOTICE,
	buildVatCheck,
} from '../../../../lib/integrations/providers/dinero/vat-check'
import { buildVatReport } from '../../../../lib/integrations/providers/dinero/vat-report'

// An invented October 2026 month of an invented Danish sole trader. Each row is one booked line:
// event id, date, text as booked, total including VAT, VAT code. The expected figures below are
// worked out by hand from these rows, not by the code under test.
const BOOKED: Array<[number, string, string, number, string | null]> = [
	[11, '2026-10-02', 'Leret ApS bilag 2', 1875, 'I25'],
	[12, '2026-10-05', 'Elselskabet Nord bilag 4', 1240, 'I25'],
	[13, '2026-10-12', 'Brugsen Nørrebyen dagligvarer bilag 17', 389.5, 'I25'],
	[14, '2026-10-14', 'Restaurant Smagen frokost med kunde bilag 20', 625, 'I25'],
	[15, '2026-10-15', 'Bogholderi-app ApS bilag 16', 129, 'I25'],
	[16, '2026-10-20', 'Cloud Hosting GmbH abonnement bilag 21', 1000, 'IEUY'],
	[17, '2026-10-22', 'Konsulent Oslo bilag 22', 800, 'U12'],
	[18, '2026-10-27', 'Annonceplatformen bilag 23', 750, 'I25'],
	[19, '2026-10-31', 'Bank Fyn gebyr bilag 29', 49, 'UDEN'],
	[20, '2026-10-31', 'Salgsfaktura 1001 bilag 30', -2500, 'U25'],
]

function items(): ReviewItem[] {
	return BOOKED.map(([event_id, date, description, amount, vat_code]) => ({
		event_id,
		at: null,
		tool: 'BookVoucher',
		outcome: 'success',
		booked: true,
		voucher_date: date,
		lines: [{ description, amount, account: 2000, counter_account: null, vat_code }],
		receipt: null,
		result: null,
		reverses_event_id: null,
		reversed_by_event_id: null,
		can_reverse: false,
		cannot_reverse_because: null,
	}))
}

const report = buildVatReport({
	from: '2026-10-01',
	to: '2026-10-31',
	items: items(),
	figuresHash: 'f'.repeat(64),
})
const check = buildVatCheck(report)

describe('VAT return check on the made-up month', () => {
	it('finds the private cost, restaurant, foreign supplier and odd rate, and nothing else', () => {
		expect(check.findings.map((f) => [f.event_id, f.kind])).toEqual([
			[14, 'private_cost'],
			[13, 'private_cost'],
			[16, 'foreign_supplier'],
			[17, 'odd_rate'],
		])
	})

	it('shows both amounts for the private costs, and ranks them by kroner at stake', () => {
		const [restaurant, groceries] = check.findings
		// 625 incl. VAT: VAT 125, net 500. A restaurant bill keeps 25 percent of its VAT, so 93.75 is at stake.
		expect(restaurant).toMatchObject({
			amount_incl_vat: 625,
			vat_amount: 125,
			net_amount: 500,
			at_stake: 93.75,
			rule_ids: ['R23'],
			confidence: 'unconfirmed',
		})
		// 389.5 incl. VAT: VAT 77.9, net 311.6. Groceries are not business costs, all 77.9 is at stake.
		expect(groceries).toMatchObject({
			amount_incl_vat: 389.5,
			vat_amount: 77.9,
			net_amount: 311.6,
			at_stake: 77.9,
			rule_ids: ['R28'],
		})
		expect(check.total_at_stake).toBe(171.65)
	})

	it('puts the foreign supplier and the odd rate after the ranked ones, not in kroner', () => {
		const [foreign, odd] = check.findings.slice(2)
		expect(foreign).toMatchObject({
			vat_code: 'IEUY',
			amount_incl_vat: 1000,
			vat_amount: null,
			net_amount: null,
			at_stake: null,
			confidence: 'confirmed',
		})
		expect(foreign?.rule_ids).toContain('R10')
		expect(odd).toMatchObject({ vat_code: 'U12', amount_incl_vat: 800, at_stake: null })
		expect(check.not_calculated).toBe(2)
		expect(check.report_complete).toBe(false)
	})

	it('names what was found clean, and is tied to the report figures', () => {
		expect(check.clean_kinds).toEqual([])
		expect(check.figures_hash).toBe(report.figures_hash)
		expect([check.from, check.to]).toEqual(['2026-10-01', '2026-10-31'])
	})

	it('adds no figure of its own: every finding amount is a line of the report', () => {
		for (const f of check.findings) {
			const entry = report.lines.flatMap((l) => l.entries).find((e) => e.event_id === f.event_id)
			expect(entry).toBeDefined()
			expect(f.amount_incl_vat).toBe(entry?.amount_incl_vat)
			expect(f.vat_amount).toBe(entry?.vat_amount)
			expect(f.net_amount).toBe(entry?.net_amount)
		}
	})

	it('never says anything was filed', () => {
		const all = JSON.stringify(check)
		expect(all.toLowerCase()).not.toMatch(/\b(was|has been|is|are) filed\b/)
		expect(VAT_CHECK_NOTICE).toContain('Nothing was filed')
	})
})

describe('VAT return check edge cases', () => {
	const only = (rows: typeof BOOKED) => {
		const r = buildVatReport({
			from: '2026-10-01',
			to: '2026-10-31',
			items: items().filter((i) => rows.some((x) => x[0] === i.event_id)),
			figuresHash: 'a'.repeat(64),
		})
		return buildVatCheck(r)
	}

	it('is clean, with every kind listed as checked, when nothing looks off', () => {
		const c = only(BOOKED.filter((r) => [11, 12, 15, 18, 19, 20].includes(r[0])))
		expect(c.findings).toEqual([])
		expect(c.total_at_stake).toBe(0)
		expect(c.clean_kinds).toEqual([...VAT_CHECK_KINDS])
		expect(c.report_complete).toBe(true)
	})

	it('is clean on an empty period', () => {
		const c = buildVatCheck(
			buildVatReport({ from: '2026-10-01', to: '2026-10-31', items: [], figuresHash: 'b' }),
		)
		expect(c.findings).toEqual([])
		expect(c.clean_kinds).toEqual([...VAT_CHECK_KINDS])
	})

	it('does not call a sale or a no-VAT line a private cost, whatever its text says', () => {
		const sale = buildVatCheck(
			buildVatReport({
				from: '2026-10-01',
				to: '2026-10-31',
				items: items().map((i) => ({
					...i,
					lines: i.lines.map((l) => ({
						...l,
						description: 'Restaurant gaveæske',
						vat_code: i.event_id === 20 ? 'U25' : 'UDEN',
					})),
				})),
				figuresHash: 'c',
			}),
		)
		expect(sale.findings).toEqual([])
	})
})
