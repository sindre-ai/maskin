import type { ReviewItem, ReviewReceipt } from './review'

/**
 * The VAT report: the one set of figures the owner checks and the filing hand-off hands over. It is
 * built from the booked, not reversed entries of the review log, grouped by VAT code, with the
 * entry and receipt behind every line. It is a draft for the owner's own check. Dinero files VAT
 * itself, so nothing here calls Dinero's filing, SKAT or Erhvervsstyrelsen, and nothing here says
 * anything was filed.
 */

export const VAT_REPORT_NOTICE =
	'A draft for checking, not the VAT return. The amounts to report are the ones Dinero shows in its own VAT filing for the same period: compare the two before you file. Nothing has been filed.'

/** The VAT codes this report calculates, as a share of the amount including VAT. */
const RATE_BY_CODE: Record<string, { direction: 'input' | 'output'; rate: number }> = {
	I25: { direction: 'input', rate: 0.25 },
	U25: { direction: 'output', rate: 0.25 },
}

/** Codes that carry no VAT. A line with no code at all is counted here too. */
const NO_VAT_CODES = new Set(['', 'UDEN', 'INGEN'])

const round2 = (n: number) => Math.round(n * 100) / 100

export type VatDirection = 'input' | 'output' | 'none' | 'unknown'

export interface VatReportEntry {
	/** The log entry that booked the line. The review screen shows it and what Dinero answered. */
	event_id: number
	voucher_date: string | null
	description: string | null
	account: number | null
	amount_incl_vat: number
	vat_amount: number | null
	net_amount: number | null
	receipt: ReviewReceipt | null
}

export interface VatReportLine {
	/** The VAT code on the lines, or null for lines with none. */
	vat_code: string | null
	direction: VatDirection
	/** The VAT as a share of the amount including VAT, or null when this code is not calculated. */
	rate: number | null
	lines: number
	amount_incl_vat: number
	vat_amount: number | null
	net_amount: number | null
	entries: VatReportEntry[]
}

export interface VatReport {
	from: string
	to: string
	lines: VatReportLine[]
	totals: {
		/** VAT on lines under input codes (purchases), as booked. */
		input_vat: number
		/** VAT on lines under output codes (sales), as booked. */
		output_vat: number
		/** False when a code this report does not calculate is on a line: check those in Dinero. */
		complete: boolean
		/** Lines under codes this report does not calculate. */
		uncalculated_lines: number
	}
	figures_hash: string
	notice: string
}

function classify(code: string | null): {
	direction: VatDirection
	rate: number | null
} {
	const key = (code ?? '').trim().toUpperCase()
	const known = RATE_BY_CODE[key]
	if (known) return known
	if (NO_VAT_CODES.has(key)) return { direction: 'none', rate: 0 }
	return { direction: 'unknown', rate: null }
}

/**
 * The lines the flow booked in the period, summed per VAT code. A booked item that was reversed
 * drops out, and so does its counter-posting, so a mistake the owner undid is not counted. Drafts
 * are not counted: they are not in the books. Amounts are as the flow booked them, including VAT.
 */
export function buildVatReport(p: {
	from: string
	to: string
	items: ReviewItem[]
	figuresHash: string
}): VatReport {
	const groups = new Map<string | null, VatReportLine>()
	for (const item of p.items) {
		if (!item.booked || item.reversed_by_event_id !== null || item.reverses_event_id !== null) {
			continue
		}
		for (const line of item.lines) {
			if (line.amount === null) continue
			const code = line.vat_code?.trim() ? line.vat_code.trim() : null
			const { direction, rate } = classify(code)
			const group = groups.get(code) ?? {
				vat_code: code,
				direction,
				rate,
				lines: 0,
				amount_incl_vat: 0,
				vat_amount: rate === null ? null : 0,
				net_amount: rate === null ? null : 0,
				entries: [],
			}
			// VAT is the share of the amount that includes it: 25 percent on net is a fifth of gross.
			const vat = rate === null ? null : round2((line.amount * rate) / (1 + rate))
			group.lines += 1
			group.amount_incl_vat = round2(group.amount_incl_vat + line.amount)
			if (vat !== null && group.vat_amount !== null && group.net_amount !== null) {
				group.vat_amount = round2(group.vat_amount + vat)
				group.net_amount = round2(group.net_amount + (line.amount - vat))
			}
			group.entries.push({
				event_id: item.event_id,
				voucher_date: item.voucher_date,
				description: line.description,
				account: line.account,
				amount_incl_vat: line.amount,
				vat_amount: vat,
				net_amount: vat === null ? null : round2(line.amount - vat),
				receipt: item.receipt,
			})
			groups.set(code, group)
		}
	}
	const lines = [...groups.values()].sort((a, b) =>
		(a.vat_code ?? '').localeCompare(b.vat_code ?? ''),
	)
	const sumVat = (direction: VatDirection) =>
		round2(
			lines
				.filter((l) => l.direction === direction)
				.reduce((sum, l) => sum + (l.vat_amount ?? 0), 0),
		)
	return {
		from: p.from,
		to: p.to,
		lines,
		totals: {
			input_vat: sumVat('input'),
			output_vat: sumVat('output'),
			complete: lines.every((l) => l.direction !== 'unknown'),
			uncalculated_lines: lines
				.filter((l) => l.direction === 'unknown')
				.reduce((sum, l) => sum + l.lines, 0),
		},
		figures_hash: p.figuresHash,
		notice: VAT_REPORT_NOTICE,
	}
}

/** The spreadsheet file, one row per line plus a total row per VAT code, for Excel in Danish. */
export const VAT_REPORT_CSV_HEADER = [
	'Row',
	'VAT code',
	'Direction',
	'Date',
	'Log entry',
	'Description',
	'Account',
	'Amount incl. VAT',
	'VAT',
	'Net',
	'Receipt file',
	'Receipt reference',
] as const

/** A cell that a spreadsheet would run as a formula starts with one of these. */
const FORMULA_START = /^[=+\-@\t\r]/

function cell(value: string | number | null): string {
	if (value === null) return ''
	if (typeof value === 'number') return value.toFixed(2).replace('.', ',')
	const safe = FORMULA_START.test(value) ? `'${value}` : value
	return /[;"\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

export function vatReportCsv(report: VatReport): string {
	const rows: Array<Array<string | number | null>> = [[...VAT_REPORT_CSV_HEADER]]
	for (const l of report.lines) {
		for (const e of l.entries) {
			rows.push([
				'Line',
				l.vat_code,
				l.direction,
				e.voucher_date,
				String(e.event_id),
				e.description,
				e.account === null ? null : String(e.account),
				e.amount_incl_vat,
				e.vat_amount,
				e.net_amount,
				e.receipt?.file_name ?? e.receipt?.file_guid ?? null,
				e.receipt?.reference ?? null,
			])
		}
		rows.push([
			'Total',
			l.vat_code,
			l.direction,
			null,
			null,
			`${l.lines} ${l.lines === 1 ? 'line' : 'lines'}`,
			null,
			l.amount_incl_vat,
			l.vat_amount,
			l.net_amount,
			null,
			null,
		])
	}
	const note = [
		`Draft VAT report ${report.from} to ${report.to}. ${report.notice}`,
		...(report.totals.complete
			? []
			: [
					`${report.totals.uncalculated_lines} lines use a VAT code this report does not calculate. Their VAT is left empty: check them in Dinero.`,
				]),
	]
	// BOM so Excel reads UTF-8, semicolons and decimal commas as a Danish Excel expects.
	return `﻿${[...rows, [], ...note.map((n) => [n])]
		.map((r) => r.map(cell).join(';'))
		.join('\r\n')}\r\n`
}
