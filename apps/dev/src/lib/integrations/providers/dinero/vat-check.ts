import type { VatReport, VatReportEntry, VatReportLine } from './vat-report'

/**
 * The VAT return check: what looks off in the figures of the VAT report, for the owner to look at
 * before filing in Dinero. It reads the report (buildVatReport) and adds no figures of its own:
 * every amount here is a line of that report. It is a draft for checking. Nothing here files,
 * calls Dinero's filing, SKAT or Erhvervsstyrelsen, or says anything was filed.
 */

export const VAT_CHECK_NOTICE =
	'A draft check, not the VAT return. The findings say what looks off: the owner decides in Dinero. This check files nothing.'

/**
 * VAT codes that are a purchase from abroad (reverse charge, or import). The report does not
 * calculate them, so their VAT is not in its totals. Taken from Dinero's VAT type names, not confirmed: the
 * check skill has the flow confirm each code against list_vat_types before it writes the note.
 */
const FOREIGN_CODES = new Set(['IEUV', 'IEUY', 'IVV', 'IVY'])

export type VatFindingKind = 'foreign_supplier' | 'odd_rate' | 'private_cost'

/** The kinds the check looks for, in the order the note lists what was checked. */
export const VAT_CHECK_KINDS: readonly VatFindingKind[] = [
	'foreign_supplier',
	'odd_rate',
	'private_cost',
]

export interface VatFinding {
	kind: VatFindingKind
	/** The rule ids of the accounting-rule-check skill this finding rests on. */
	rule_ids: string[]
	event_id: number
	voucher_date: string | null
	description: string | null
	account: number | null
	vat_code: string | null
	amount_incl_vat: number
	/** The VAT as the report calculates it, or null when the report does not calculate this code. */
	vat_amount: number | null
	net_amount: number | null
	/** VAT that may be wrongly claimed, in kroner, or null when it cannot be worked out here. */
	at_stake: number | null
	/** confirmed: read from the booked code. unconfirmed: a word in the line text, the owner decides. */
	confidence: 'confirmed' | 'unconfirmed'
	why: string
}

export interface VatCheck {
	from: string
	to: string
	/** Same hash as the report, so the note and the report are tied to the same figures. */
	figures_hash: string
	/** Sum of at_stake over the findings that have one. */
	total_at_stake: number
	/** Findings that have no at_stake, so the owner knows the total leaves them out. */
	not_calculated: number
	findings: VatFinding[]
	/** Kinds with no finding: what was checked and found clean. */
	clean_kinds: VatFindingKind[]
	/** False when the report has lines under codes it does not calculate. */
	report_complete: boolean
	notice: string
}

const round2 = (n: number) => Math.round(n * 100) / 100

/** A whole word or phrase from the list, in any case. \b does not know å, æ, ø or é, so this does. */
const words = (alternatives: string) =>
	new RegExp(`(?<![\\p{L}])(?:${alternatives})(?![\\p{L}])`, 'iu')

/** Words that mark a cost the rules treat as partly or wholly not deductible. Matched on the line text. */
const COST_WORDS: Array<{ re: RegExp; rule_ids: string[]; share: number; what: string }> = [
	{
		re: words(
			'dagligvarer?|grocer(?:y|ies)|supermarked|supermarket|netto|rema 1000|rema1000|føtex|fotex|irma|meny|lidl|aldi|bageri',
		),
		rule_ids: ['R28'],
		share: 1,
		what: 'food or a living cost for people, not for the business',
	},
	{
		re: words('restaurant|café|cafe|catering|frokost|middag|lunch|dinner'),
		rule_ids: ['R23'],
		share: 0.75,
		what: 'a restaurant bill, where only 25 percent of the VAT can be deducted',
	},
	{
		re: words('gave|gaver|gift|gifts|blomster|flowers|vin|wine|gavekort'),
		rule_ids: ['R26'],
		share: 1,
		what: 'a gift, where VAT cannot be deducted',
	},
	{
		re: words('biograf|cinema|koncert|concert|billet|billetter|ticket|tickets|forlystelse'),
		rule_ids: ['R25'],
		share: 1,
		what: 'entertainment, where VAT cannot be deducted',
	},
	{
		re: words('benzin|diesel|fuel|parkering|parking|bilvask|bilforsikring|autoværksted'),
		rule_ids: ['R27'],
		share: 1,
		what: 'a cost for a passenger car, where VAT cannot be deducted',
	},
]

function finding(
	line: VatReportLine,
	entry: VatReportEntry,
	extra: Pick<VatFinding, 'kind' | 'rule_ids' | 'at_stake' | 'confidence' | 'why'>,
): VatFinding {
	return {
		event_id: entry.event_id,
		voucher_date: entry.voucher_date,
		description: entry.description,
		account: entry.account,
		vat_code: line.vat_code,
		amount_incl_vat: entry.amount_incl_vat,
		vat_amount: entry.vat_amount,
		net_amount: entry.net_amount,
		...extra,
	}
}

/**
 * Checks the figures of one VAT report. Foreign suppliers and odd rates are read from the booked
 * VAT code. Private costs are read from the words on the line, so they are marked unconfirmed and only
 * counted where input VAT was claimed (code I25). Findings are ranked by kroner at stake, biggest
 * first, with the ones that cannot be put in kroner after them.
 */
export function buildVatCheck(report: VatReport): VatCheck {
	const findings: VatFinding[] = []
	for (const line of report.lines) {
		const code = (line.vat_code ?? '').trim().toUpperCase()
		for (const entry of line.entries) {
			if (FOREIGN_CODES.has(code)) {
				findings.push(
					finding(line, entry, {
						kind: 'foreign_supplier',
						rule_ids: ['R10', 'R11', 'R13', 'R16'],
						at_stake: null,
						confidence: 'confirmed',
						why: `Booked under ${code}, a purchase from abroad. The report does not calculate the Danish VAT on it, so it is not in the totals: check the reverse charge in Dinero.`,
					}),
				)
			} else if (line.direction === 'unknown') {
				findings.push(
					finding(line, entry, {
						kind: 'odd_rate',
						rule_ids: ['R2', 'R8'],
						at_stake: null,
						confidence: 'confirmed',
						why: `Booked under ${code || 'a code the report does not know'}, which is not 25 percent VAT or no VAT. The report does not calculate it, so check the rate in Dinero.`,
					}),
				)
			}
			if (line.direction === 'input' && entry.vat_amount !== null) {
				const text = entry.description ?? ''
				const hit = COST_WORDS.find((w) => w.re.test(text))
				if (hit) {
					findings.push(
						finding(line, entry, {
							kind: 'private_cost',
							rule_ids: hit.rule_ids,
							at_stake: round2(entry.vat_amount * hit.share),
							confidence: 'unconfirmed',
							why: `The text looks like ${hit.what}. Input VAT of ${entry.vat_amount.toFixed(2)} kr was claimed on it.`,
						}),
					)
				}
			}
		}
	}
	findings.sort((a, b) => {
		if (a.at_stake === null && b.at_stake === null) return a.event_id - b.event_id
		if (a.at_stake === null) return 1
		if (b.at_stake === null) return -1
		return b.at_stake - a.at_stake || a.event_id - b.event_id
	})
	const found = new Set(findings.map((f) => f.kind))
	return {
		from: report.from,
		to: report.to,
		figures_hash: report.figures_hash,
		total_at_stake: round2(findings.reduce((sum, f) => sum + (f.at_stake ?? 0), 0)),
		not_calculated: findings.filter((f) => f.at_stake === null).length,
		findings,
		clean_kinds: VAT_CHECK_KINDS.filter((k) => !found.has(k)),
		report_complete: report.totals.complete,
		notice: VAT_CHECK_NOTICE,
	}
}
