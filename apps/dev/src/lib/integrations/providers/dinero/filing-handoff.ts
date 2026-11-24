import type { ReviewItem } from './review'

/**
 * The filing hand-off: what the owner needs in hand to file in Dinero themselves, after the final
 * approval of the books. It is text and figures only. Dinero's server has no tool for VAT filing
 * or year end (checked 23 Nov 2026), and VAT filing to SKAT is Dinero's own feature, so nothing in
 * here calls SKAT, Erhvervsstyrelsen or Dinero's filing, and nothing here says anything was filed.
 */

/** What the owner is told when the books are not approved, so no hand-off is made. */
export const FILING_NOT_APPROVED_MESSAGE =
	'The books for this period are not approved yet, so there is nothing to file. Press "Approve the books" first. No filing hand-off was made.'

/** What the owner is told when the log moved after the approval. */
export const FILING_FIGURES_CHANGED_MESSAGE =
	'The log for this period no longer matches what you approved. Look at it again and approve the books again. No filing hand-off was made.'

export const FILING_NOT_FILED_NOTICE =
	'Nothing has been filed. Maskin does not file anything. You file in Dinero with your own MitID.'

export interface FilingFigure {
	/** The VAT code on the lines, or null for lines with none. */
	vat_code: string | null
	/** Lines the flow booked under this code, counted once if reversed (a reversed item drops out). */
	lines: number
	/** Sum of the booked line amounts including VAT, as the flow booked them. */
	amount_incl_vat: number
}

export interface FilingHandoff {
	from: string
	to: string
	approved_by: string
	approved_at: string
	figures_hash: string
	figures: FilingFigure[]
	/** What the figures are, in a sentence, so nobody reads them as the VAT return. */
	figures_note: string
	steps: string[]
	year_end_steps: string[]
	notice: string
}

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * The figures the flow booked in the approved period, summed per VAT code. A booked item that was
 * reversed drops out, and so does its counter-posting, so a mistake the owner undid is not
 * counted. Drafts are not counted: they are not in the books.
 */
export function bookedFiguresByVatCode(items: ReviewItem[]): FilingFigure[] {
	const sums = new Map<string | null, FilingFigure>()
	for (const item of items) {
		if (!item.booked || item.reversed_by_event_id !== null || item.reverses_event_id !== null) {
			continue
		}
		for (const line of item.lines) {
			if (line.amount === null) continue
			const key = line.vat_code ?? null
			const row = sums.get(key) ?? { vat_code: key, lines: 0, amount_incl_vat: 0 }
			row.lines += 1
			row.amount_incl_vat = round2(row.amount_incl_vat + line.amount)
			sums.set(key, row)
		}
	}
	return [...sums.values()].sort((a, b) => (a.vat_code ?? '').localeCompare(b.vat_code ?? ''))
}

export function buildFilingHandoff(p: {
	from: string
	to: string
	items: ReviewItem[]
	approvedBy: string
	approvedAt: Date
	figuresHash: string
}): FilingHandoff {
	return {
		from: p.from,
		to: p.to,
		approved_by: p.approvedBy,
		approved_at: p.approvedAt.toISOString(),
		figures_hash: p.figuresHash,
		figures: bookedFiguresByVatCode(p.items),
		figures_note:
			'These are the lines the flow booked in this period, summed per VAT code, including VAT. They are not the VAT return. The amounts to report are the ones Dinero shows in its own VAT filing for the same period: compare the two before you file.',
		steps: [
			`Open Dinero and go to its own VAT filing (moms) for ${p.from} to ${p.to}.`,
			'Check that the period and the figures Dinero shows match your books and the list above.',
			'File it there. Dinero sends it to SKAT, and you confirm with your own MitID.',
		],
		year_end_steps: [
			'Only if the company is an ApS and this period ends its financial year:',
			"Open Dinero's year-end (annual report) for the year and go through it there.",
			'Dinero prepares the report. You approve and submit it yourself with your own MitID.',
		],
		notice: FILING_NOT_FILED_NOTICE,
	}
}
