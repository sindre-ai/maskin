import { describe, expect, it } from 'vitest'
import {
	type DraftLogEvent,
	type ReviewItem,
	withPurchaseDraftDetails,
} from '../../../../lib/integrations/providers/dinero/review'
import {
	VAT_REPORT_CSV_HEADER,
	buildVatReport,
	vatReportCsv,
} from '../../../../lib/integrations/providers/dinero/vat-report'

// The made-up October 2026 month of an invented Danish sole trader (29 receipts, everything
// invented). Each row is the receipt as printed: number, date, supplier, total, VAT stated on it.
// The expected figures below are summed from these rows by hand, from the answer key, and not by
// the code under test.
const RECEIPTS: Array<[number, string, string, number, number]> = [
	[1, '2026-10-01', 'Studiehuset Odense', 4500.0, 0],
	[2, '2026-10-02', 'Leret ApS', 1875.0, 375.0],
	[3, '2026-10-03', 'Glasurhuset', 962.5, 192.5],
	[4, '2026-10-05', 'Elselskabet Nord', 1240.0, 248.0],
	[5, '2026-10-05', 'Webhotel Nord', 149.0, 29.8],
	[6, '2026-10-06', 'Pakkeposten', 312.5, 62.5],
	[7, '2026-10-09', 'Kontorlageret', 238.0, 47.6],
	[8, '2026-10-09', 'Mobildirekte', 199.0, 39.8],
	[9, '2026-10-12', 'Pakkeposten', 287.5, 57.5],
	[10, '2026-10-12', 'Værktøj Fyn', 1250.0, 200.0],
	[11, '2026-10-13', 'Leret ApS', 937.5, 187.5],
	[12, '2026-10-14', 'Fotostudie Syd', 1500.0, 300.0],
	[13, '2026-10-15', 'Forsikringsmægleren', 385.0, 0],
	[14, '2026-10-16', 'Pakkeposten', 301.25, 60.25],
	[15, '2026-10-16', 'Penselhuset', 90.0, 18.0],
	[16, '2026-10-19', 'Bogholderi-app ApS', 129.0, 25.8],
	[17, '2026-10-20', 'Brugsen Nørrebyen', 389.5, 77.9],
	[18, '2026-10-21', 'Ovnservice Fyn', 1625.0, 325.0],
	[19, '2026-10-22', 'Pakkeposten', 2987.5, 597.5],
	[20, '2026-10-23', 'Glasurhuset', 481.25, 96.25],
	[21, '2026-10-26', 'Klistermærker.dk', 412.5, 82.5],
	[22, '2026-10-27', 'Annonceplatformen', 750.0, 150.0],
	[23, '2026-10-27', 'Kontorlageret', 324.0, 64.8],
	[24, '2026-10-28', 'Leret ApS', 1250.0, 250.0],
	[25, '2026-10-29', 'Pakkeposten', 274.5, 54.9],
	[26, '2026-10-30', 'Lokal Tryk', 560.0, 112.0],
	[27, '2026-10-30', 'Skraldemanden', 225.0, 45.0],
	[28, '2026-10-31', 'Kontorlageret', 118.75, 23.75],
	[29, '2026-10-31', 'Bank Fyn', 49.0, 0],
]

// The answer key: bilag 10 (VAT does not add up), 17 (private) and 19 (odd amount) are flagged for
// the owner and stay drafts, so they are not in the books and not in the report.
const FLAGGED = new Set([10, 17, 19])

// What the answer key adds up to for the 26 booked bilag, summed by hand from the rows above.
const EXPECTED = {
	i25: { lines: 23, gross: 14242.25, vat: 2848.45, net: 11393.8 },
	none: { lines: 3, gross: 4934.0 },
}

const guid = (series: number, n: number) =>
	`00000000-0000-4000-${series}000-${String(n).padStart(12, '0')}`

function month(): { items: ReviewItem[]; events: DraftLogEvent[] } {
	const items: ReviewItem[] = []
	const events: DraftLogEvent[] = []
	const base = (event_id: number, tool: string, booked: boolean, date: string): ReviewItem => ({
		event_id,
		at: null,
		tool,
		outcome: 'success',
		booked,
		voucher_date: date,
		lines: [],
		receipt: null,
		result: null,
		reverses_event_id: null,
		reversed_by_event_id: null,
		can_reverse: false,
		cannot_reverse_because: null,
	})
	for (const [n, date, supplier, total, moms] of RECEIPTS) {
		const id = n * 10
		const file = guid(9, n)
		const voucher = guid(8, n)
		events.push({
			id,
			data: {
				tool: 'upload_file',
				outcome: 'success',
				arguments: { fileName: `bilag-${n}.pdf` },
				result: `Uploaded. fileGuid ${file}`,
			},
		})
		events.push({
			id: id + 1,
			data: {
				tool: 'CreatePurchaseVoucher',
				outcome: 'success',
				arguments: {
					voucherDate: date,
					fileGuid: file,
					externalReference: `Bilag ${n}`,
					lines: [
						{
							amount: total,
							accountNumber: 2000,
							description: `${supplier} bilag ${n}`,
							vatCode: moms > 0 ? 'I25' : 'UDEN',
						},
					],
				},
				result: `Purchase voucher draft created: ${voucher}`,
			},
		})
		items.push(base(id + 1, 'CreatePurchaseVoucher', false, date))
		if (FLAGGED.has(n)) continue
		events.push({
			id: id + 2,
			data: {
				tool: 'BookVoucher',
				outcome: 'success',
				arguments: { voucherGuid: voucher, timestamp: '2026-10-31T10:00:00Z' },
				result: 'Booked',
			},
		})
		items.push(base(id + 2, 'BookVoucher', true, date))
	}
	return { items, events }
}

describe('VAT report on the made-up month', () => {
	const { items, events } = month()
	const joined = withPurchaseDraftDetails(items, events)
	const report = buildVatReport({
		from: '2026-10-01',
		to: '2026-10-31',
		items: joined,
		figuresHash: 'f'.repeat(64),
	})

	it('matches the answer key per VAT code', () => {
		const i25 = report.lines.find((l) => l.vat_code === 'I25')
		const none = report.lines.find((l) => l.vat_code === 'UDEN')
		expect(i25).toMatchObject({
			direction: 'input',
			lines: EXPECTED.i25.lines,
			amount_incl_vat: EXPECTED.i25.gross,
			vat_amount: EXPECTED.i25.vat,
			net_amount: EXPECTED.i25.net,
		})
		expect(none).toMatchObject({
			direction: 'none',
			lines: EXPECTED.none.lines,
			amount_incl_vat: EXPECTED.none.gross,
			vat_amount: 0,
		})
		expect(report.totals).toMatchObject({
			input_vat: EXPECTED.i25.vat,
			output_vat: 0,
			complete: true,
			uncalculated_lines: 0,
		})
	})

	it('leaves the three flagged receipts out, because they are drafts', () => {
		const numbers = report.lines.flatMap((l) => l.entries.map((e) => e.description))
		expect(numbers).toHaveLength(26)
		for (const n of FLAGGED) {
			expect(numbers.some((d) => d?.endsWith(`bilag ${n}`))).toBe(false)
		}
	})

	it('puts a receipt behind every line: the file, and the log entry that booked it', () => {
		for (const l of report.lines) {
			for (const e of l.entries) {
				expect(e.event_id).toBeGreaterThan(0)
				expect(e.receipt?.file_name).toMatch(/^bilag-\d+\.pdf$/)
				expect(e.receipt?.reference).toMatch(/^Bilag \d+$/)
				expect(e.voucher_date).toMatch(/^2026-10-\d\d$/)
			}
		}
	})

	it('writes a spreadsheet whose totals equal the report', () => {
		const csv = vatReportCsv(report)
		expect(csv.startsWith('﻿')).toBe(true)
		const rows = csv
			.slice(1)
			.split('\r\n')
			.filter((r) => r.length > 0)
			.map((r) => r.split(';'))
		expect(rows[0]).toEqual([...VAT_REPORT_CSV_HEADER])
		const num = (v: string | undefined) => Number((v ?? '').replace(',', '.'))
		for (const l of report.lines) {
			const lineRows = rows.filter((r) => r[0] === 'Line' && r[1] === (l.vat_code ?? ''))
			const total = rows.find((r) => r[0] === 'Total' && r[1] === (l.vat_code ?? ''))
			expect(lineRows).toHaveLength(l.lines)
			const sum = (col: number) =>
				Math.round(lineRows.reduce((acc, r) => acc + num(r[col]), 0) * 100) / 100
			expect(sum(7)).toBe(num(total?.[7]))
			expect(sum(8)).toBe(num(total?.[8]))
			expect(num(total?.[7])).toBe(l.amount_incl_vat)
			expect(num(total?.[8])).toBe(l.vat_amount ?? 0)
		}
		// Nothing in the file says it was filed, and it says it is a draft.
		expect(csv).toContain('Draft VAT report 2026-10-01 to 2026-10-31')
		expect(csv.toLowerCase()).not.toMatch(/\b(was|has been|is|are) filed\b/)
	})
})

describe('VAT report rules', () => {
	const line = (amount: number, vat_code: string | null, description = 'x') => ({
		description,
		amount,
		account: 7000,
		counter_account: null,
		vat_code,
	})
	const item = (over: Partial<ReviewItem>): ReviewItem => ({
		event_id: 1,
		at: null,
		tool: 'CreateFinanceVoucher',
		outcome: 'success',
		booked: true,
		voucher_date: '2026-10-05',
		lines: [line(125, 'I25')],
		receipt: null,
		result: null,
		reverses_event_id: null,
		reversed_by_event_id: null,
		can_reverse: false,
		cannot_reverse_because: null,
		...over,
	})
	const report = (items: ReviewItem[]) =>
		buildVatReport({ from: '2026-10-01', to: '2026-10-31', items, figuresHash: 'h' })

	it('counts only booked items that are not reversed and not counter-postings', () => {
		const r = report([
			item({ event_id: 1, booked: false }),
			item({ event_id: 2, outcome: 'error', booked: false }),
			item({ event_id: 3, reversed_by_event_id: 4 }),
			item({ event_id: 4, reverses_event_id: 3 }),
			item({ event_id: 5 }),
		])
		expect(r.lines).toHaveLength(1)
		expect(r.lines[0]).toMatchObject({ lines: 1, amount_incl_vat: 125, vat_amount: 25 })
	})

	it('splits input and output VAT, and calculates a line with no code as no VAT', () => {
		const r = report([
			item({ event_id: 1, lines: [line(125, 'I25'), line(-250, 'U25'), line(10, null)] }),
		])
		expect(r.totals).toMatchObject({ input_vat: 25, output_vat: -50, complete: true })
		expect(r.lines.find((l) => l.vat_code === null)).toMatchObject({
			direction: 'none',
			vat_amount: 0,
		})
	})

	it('does not guess VAT for a code it does not calculate, and says so', () => {
		const r = report([item({ lines: [line(100, 'IEUV')] })])
		expect(r.totals).toMatchObject({ complete: false, uncalculated_lines: 1, input_vat: 0 })
		expect(r.lines[0]).toMatchObject({ direction: 'unknown', vat_amount: null, net_amount: null })
		expect(vatReportCsv(r)).toContain('1 lines use a VAT code this report does not calculate')
	})

	it('shows an empty period as no lines', () => {
		const r = report([])
		expect(r.lines).toEqual([])
		expect(r.totals).toMatchObject({ input_vat: 0, output_vat: 0, complete: true })
	})

	it('stops a supplier text from running as a spreadsheet formula', () => {
		const r = report([item({ lines: [line(125, 'I25', '=HYPERLINK("http://x")')] })])
		const csv = vatReportCsv(r)
		expect(csv).not.toMatch(/;=HYPERLINK/)
		expect(csv).toContain(`"'=HYPERLINK(""http://x"")"`)
	})

	it('uses the latest edit of a purchase draft when it is booked', () => {
		const voucher = '00000000-0000-4000-8000-000000000001'
		const booked = item({ event_id: 30, tool: 'BookVoucher', lines: [] })
		const joined = withPurchaseDraftDetails(
			[booked],
			[
				{
					id: 10,
					data: {
						tool: 'CreatePurchaseVoucher',
						outcome: 'success',
						arguments: { voucherDate: '2026-10-05', lines: [{ amount: 100, vatCode: 'I25' }] },
						result: `draft ${voucher}`,
					},
				},
				{
					id: 20,
					data: {
						tool: 'update_purchase_voucher_draft',
						outcome: 'success',
						arguments: {
							voucherGuid: voucher,
							voucherDate: '2026-10-06',
							lines: [{ amount: 250, vatCode: 'I25' }],
						},
						result: 'ok',
					},
				},
				{
					id: 30,
					data: { tool: 'BookVoucher', outcome: 'success', arguments: { voucherGuid: voucher } },
				},
			],
		)
		expect(joined[0]?.lines).toMatchObject([{ amount: 250, vat_code: 'I25' }])
		expect(joined[0]?.voucher_date).toBe('2026-10-06')
	})

	it('keeps a booked voucher it cannot find a draft for as it was, never inventing lines', () => {
		const booked = item({ event_id: 30, tool: 'BookVoucher', lines: [] })
		const joined = withPurchaseDraftDetails(
			[booked],
			[{ id: 30, data: { tool: 'BookVoucher', outcome: 'success', arguments: {} } }],
		)
		expect(joined[0]).toEqual(booked)
	})
})
