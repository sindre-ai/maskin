import type { Database } from '@maskin/db'
import { objects } from '@maskin/db/schema'
import { and, desc, eq, ne } from 'drizzle-orm'
import { hashFigures } from '../../../owner-approval'
import { figuresOf, isIsoDate, readReviewLog } from './review'
import { buildVatCheck } from './vat-check'
import { buildVatReport } from './vat-report'

/**
 * get_vat_report: the one Dinero tool our gateway answers from our own books, not from Dinero.
 * The VAT report routes are for a signed-in owner, so the flow's Bookkeeper reads the same report
 * and its check through this tool when it writes the VAT check note. It reads the review log and
 * writes nothing. It returns the report lines without the receipts, plus the check.
 */

export const DINERO_VAT_REPORT_TOOL_NAME = 'get_vat_report'

export const DINERO_APP_TOOLS = [
	{
		name: DINERO_VAT_REPORT_TOOL_NAME,
		description:
			'Reads the draft VAT report for a period and its check: the booked lines of the flow summed per VAT code, and the findings (foreign suppliers, odd rates, private costs) ranked by kroner at stake. Read only. It is a draft for checking, not the VAT return, and it files nothing: the amounts to report are the ones Dinero shows in its own VAT filing.',
		inputSchema: {
			type: 'object',
			properties: {
				from: { type: 'string', description: 'First day of the period, YYYY-MM-DD.' },
				to: { type: 'string', description: 'Last day of the period, YYYY-MM-DD.' },
			},
			required: ['from', 'to'],
		},
	},
] as const

export const DINERO_APP_TOOL_NAMES: readonly string[] = DINERO_APP_TOOLS.map((t) => t.name)

export function isDineroAppTool(name: string): boolean {
	return DINERO_APP_TOOL_NAMES.includes(name)
}

export async function answerDineroAppTool(
	db: Database,
	p: { workspaceId: string; integrationId: string },
	tool: string,
	args: unknown,
): Promise<{ isError: boolean; text: string }> {
	if (tool !== DINERO_VAT_REPORT_TOOL_NAME) {
		return { isError: true, text: `${tool} is not a tool of this server. Nothing was done.` }
	}
	const a = args && typeof args === 'object' ? (args as Record<string, unknown>) : {}
	const from = typeof a.from === 'string' ? a.from.trim() : ''
	const to = typeof a.to === 'string' ? a.to.trim() : ''
	if (!isIsoDate(from) || !isIsoDate(to)) {
		return { isError: true, text: 'Give from and to as dates like 2026-11-30.' }
	}
	if (from > to) return { isError: true, text: 'from is after to.' }
	const items = await readReviewLog(db, { ...p, from, to })
	const report = buildVatReport({ from, to, items, figuresHash: hashFigures(figuresOf(items)) })
	const check = buildVatCheck(report)
	// The receipts stay on the review screen: the check names the log entry behind every finding.
	const lines = report.lines.map(({ entries, ...line }) => ({ ...line, entries: entries.length }))
	return {
		isError: false,
		text: JSON.stringify({ report: { ...report, lines }, check }),
	}
}

/** The title the flow gives the check note of a period. The review screen finds the note by it. */
export function vatCheckNoteTitle(from: string, to: string): string {
	return `VAT check ${from} to ${to}`
}

/** The latest check note of a period, or null. A deprecated note is not the latest. */
export async function findVatCheckNote(
	db: Database,
	p: { workspaceId: string; from: string; to: string },
): Promise<{ id: string; title: string; created_at: string | null } | null> {
	const [row] = await db
		.select({ id: objects.id, title: objects.title, createdAt: objects.createdAt })
		.from(objects)
		.where(
			and(
				eq(objects.workspaceId, p.workspaceId),
				eq(objects.type, 'knowledge'),
				eq(objects.title, vatCheckNoteTitle(p.from, p.to)),
				ne(objects.status, 'deprecated'),
			),
		)
		.orderBy(desc(objects.createdAt))
		.limit(1)
	return row
		? { id: row.id, title: row.title ?? '', created_at: row.createdAt?.toISOString() ?? null }
		: null
}
