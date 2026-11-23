import type { Database } from '@maskin/db'
import { events } from '@maskin/db/schema'
import { and, asc, eq, gte, lt } from 'drizzle-orm'
import { toolCallSucceeded } from '../../../analytics/receipt-events'
import { OWNER_APPROVAL_DINERO_BOOKS, findOwnerApprovals } from '../../../owner-approval'
import { DINERO_ACTION_EVENT, toolAnswerText } from './action-log'
import { DINERO_MCP_URL } from './config'

/** A call to Dinero's own server by our code, as the owner, outside the flow's tool list. */
const CALL_TIMEOUT_MS = 60_000
const LOG_LIMIT = 2000
const DAY_MS = 86_400_000

/** What the flow is told when the owner has approved the books and the period is closed. */
export const DINERO_LOCKED_MESSAGE =
	'The owner has approved the books for a period that includes today, so nothing more can be changed in Dinero by the flow. Reading still works. Nothing was sent to Dinero.'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function isIsoDate(value: string): boolean {
	return DATE_RE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
}

/** What the owner approves: the period, one Dinero connection. Read back by the lock. */
export function approvalSubject(integrationId: string, from: string, to: string): string {
	return `dinero:${integrationId}:${from}:${to}`
}

function parseSubject(subject: string): { integrationId: string; from: string; to: string } | null {
	const m = /^dinero:([0-9a-f-]{36}):(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})$/.exec(subject)
	return m ? { integrationId: m[1] as string, from: m[2] as string, to: m[3] as string } : null
}

type Json = Record<string, unknown>
const asObj = (v: unknown): Json | null =>
	v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null

export interface ReviewLine {
	description: string | null
	amount: number | null
	account: number | null
	counter_account: number | null
	vat_code: string | null
}

export interface ReviewItem {
	event_id: number
	at: string | null
	tool: string
	outcome: string
	/** True when this call booked something in Dinero (a booked voucher). */
	booked: boolean
	voucher_date: string | null
	lines: ReviewLine[]
	result: string | null
	reverses_event_id: number | null
	reversed_by_event_id: number | null
	can_reverse: boolean
	/** Why a booked item cannot be reversed with one click, in plain words. */
	cannot_reverse_because: string | null
}

type LogEvent = {
	id: number
	actorId: string
	createdAt: Date | null
	data: unknown
}

function linesOf(args: Json | null): ReviewLine[] {
	const raw = Array.isArray(args?.lines) ? (args?.lines as unknown[]) : []
	return raw.flatMap((l) => {
		const o = asObj(l)
		if (!o) return []
		const num = (v: unknown) => (typeof v === 'number' ? v : null)
		return [
			{
				description: typeof o.description === 'string' ? o.description : null,
				amount: num(o.amount) ?? num(o.amountInclVat),
				account: num(o.accountNumber),
				counter_account: num(o.balancingAccountNumber),
				vat_code:
					typeof o.accountVatCode === 'string'
						? o.accountVatCode
						: typeof o.vatCode === 'string'
							? o.vatCode
							: null,
			},
		]
	})
}

/** Whether a logged call booked something: a finance voucher with book true, or BookVoucher. */
export function bookedByCall(tool: string, args: Json | null, outcome: unknown): boolean {
	if (outcome !== 'success') return false
	if (tool === 'BookVoucher') return true
	return tool === 'CreateFinanceVoucher' && args?.book === true
}

/**
 * The call that undoes a booked finance voucher: the same lines with the sign turned, booked in
 * one call, on the voucher's own date. Dinero cannot delete a booked voucher, so this is the
 * counter-posting. The idempotency key makes a second click return the first counter-posting
 * instead of making another. A booked purchase voucher (BookVoucher) has none here: it needs a
 * credit note and a second booking call, which this step does not make.
 */
export function counterPostingArguments(
	tool: string,
	args: Json | null,
	eventId: number,
): { ok: true; args: Json } | { ok: false; reason: string } {
	if (tool === 'BookVoucher') {
		return {
			ok: false,
			reason:
				'A booked purchase voucher is reversed in Dinero with a credit note. Do it there, then it shows here on the next look.',
		}
	}
	if (tool !== 'CreateFinanceVoucher' || !args) {
		return { ok: false, reason: 'This kind of action has no one-click reversal.' }
	}
	const lines = Array.isArray(args.lines) ? (args.lines as unknown[]) : []
	const date = typeof args.date === 'string' ? args.date : null
	const org = args.organizationId
	if (lines.length === 0 || !date || typeof org !== 'number') {
		return { ok: false, reason: 'The log does not hold enough to reverse this one.' }
	}
	const turned: Json[] = []
	for (const l of lines) {
		const o = asObj(l)
		if (!o || typeof o.amount !== 'number') {
			return { ok: false, reason: 'The log does not hold enough to reverse this one.' }
		}
		turned.push({ ...o, amount: -o.amount })
	}
	return {
		ok: true,
		args: {
			organizationId: org,
			date,
			book: true,
			idempotencyKey: `maskin-reverse-${eventId}`,
			externalReference: `Reversal of log entry ${eventId}`,
			lines: turned,
		},
	}
}

function toItem(e: LogEvent, reversedBy: Map<number, number>): ReviewItem {
	const d = asObj(e.data) ?? {}
	const tool = typeof d.tool === 'string' ? d.tool : 'unknown'
	const args = asObj(d.arguments)
	const booked = bookedByCall(tool, args, d.outcome)
	const reverses = typeof d.reverses_event_id === 'number' ? d.reverses_event_id : null
	const reversedById = reversedBy.get(e.id) ?? null
	let canReverse = false
	let why: string | null = null
	if (booked && reverses === null && reversedById === null) {
		const plan = counterPostingArguments(tool, args, e.id)
		canReverse = plan.ok
		why = plan.ok ? null : plan.reason
	}
	return {
		event_id: e.id,
		at: e.createdAt ? e.createdAt.toISOString() : null,
		tool,
		outcome: typeof d.outcome === 'string' ? d.outcome : 'error',
		booked,
		voucher_date: typeof args?.date === 'string' ? args.date : null,
		lines: linesOf(args),
		result: typeof d.result === 'string' ? d.result : null,
		reverses_event_id: reverses,
		reversed_by_event_id: reversedById,
		can_reverse: canReverse,
		cannot_reverse_because: why,
	}
}

/** The log of one Dinero connection for the days from..to (UTC, both included), oldest first. */
export async function readReviewLog(
	db: Database,
	p: { workspaceId: string; integrationId: string; from: string; to: string },
): Promise<ReviewItem[]> {
	const start = new Date(`${p.from}T00:00:00Z`)
	const end = new Date(Date.parse(`${p.to}T00:00:00Z`) + DAY_MS)
	const rows = await db
		.select({
			id: events.id,
			actorId: events.actorId,
			createdAt: events.createdAt,
			data: events.data,
		})
		.from(events)
		.where(
			and(
				eq(events.workspaceId, p.workspaceId),
				eq(events.entityId, p.integrationId),
				eq(events.action, DINERO_ACTION_EVENT),
				gte(events.createdAt, start),
				lt(events.createdAt, end),
			),
		)
		.orderBy(asc(events.id))
		.limit(LOG_LIMIT)
	// A reversal counts only when Dinero answered with success.
	const reversedBy = new Map<number, number>()
	for (const r of rows) {
		const d = asObj(r.data)
		if (typeof d?.reverses_event_id === 'number' && d.outcome === 'success') {
			reversedBy.set(d.reverses_event_id, r.id)
		}
	}
	return rows.map((r) => toItem(r, reversedBy))
}

/**
 * The figures an approval is a hash of: every item of the period with what was booked, and whether
 * it was reversed. Not the times or Dinero's free text, so a harmless re-read gives the same hash.
 */
export function figuresOf(items: ReviewItem[]): unknown {
	return items.map((i) => ({
		id: i.event_id,
		tool: i.tool,
		outcome: i.outcome,
		booked: i.booked,
		date: i.voucher_date,
		lines: i.lines,
		reverses: i.reverses_event_id,
		reversed_by: i.reversed_by_event_id,
	}))
}

/**
 * The approval of this period if the owner has given one that covers it exactly, else null.
 */
export async function findPeriodApproval(
	db: Database,
	p: { workspaceId: string; integrationId: string; from: string; to: string },
) {
	const subject = approvalSubject(p.integrationId, p.from, p.to)
	const all = await findOwnerApprovals(db, p.workspaceId, OWNER_APPROVAL_DINERO_BOOKS)
	return all.find((a) => a.subject === subject) ?? null
}

/**
 * True while the current day lies inside a period the owner has approved for this connection.
 * The flow is then refused every Dinero write: the books of that period are closed on our side.
 */
export async function isDineroPeriodLocked(
	db: Database,
	p: { workspaceId: string; integrationId: string; now?: Date },
): Promise<boolean> {
	const today = (p.now ?? new Date()).toISOString().slice(0, 10)
	const all = await findOwnerApprovals(db, p.workspaceId, OWNER_APPROVAL_DINERO_BOOKS)
	return all.some((a) => {
		const s = parseSubject(a.subject)
		return !!s && s.integrationId === p.integrationId && s.from <= today && today <= s.to
	})
}

/**
 * One tools/call on Dinero's own server with the owner's token: initialize, then call. This is
 * our code acting for the owner, not the flow, so the flow's tool list does not apply. Never
 * throws for a refusal by Dinero: it returns ok false with Dinero's words.
 */
export async function callDineroAsOwner(
	token: string,
	tool: string,
	args: Json,
	fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; text: string | null }> {
	const base: Record<string, string> = {
		authorization: `Bearer ${token}`,
		'content-type': 'application/json',
		accept: 'application/json, text/event-stream',
	}
	const post = (headers: Record<string, string>, body: unknown) =>
		fetchImpl(DINERO_MCP_URL, {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
			redirect: 'manual',
			signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
		})
	const init = await post(base, {
		jsonrpc: '2.0',
		id: 1,
		method: 'initialize',
		params: {
			protocolVersion: '2025-03-26',
			capabilities: {},
			clientInfo: { name: 'maskin-review', version: '1' },
		},
	})
	if (!init.ok) return { ok: false, text: `Dinero answered ${init.status} when connecting.` }
	await init.text()
	const session = init.headers.get('mcp-session-id')
	const headers = session ? { ...base, 'mcp-session-id': session } : base
	await post(headers, { jsonrpc: '2.0', method: 'notifications/initialized' }).then((r) => r.text())
	const res = await post(headers, {
		jsonrpc: '2.0',
		id: 2,
		method: 'tools/call',
		params: { name: tool, arguments: args },
	})
	const text = await res.text()
	return {
		ok: res.ok && toolCallSucceeded(text, 2),
		text: toolAnswerText(text, 2) ?? (res.ok ? null : `Dinero answered ${res.status}.`),
	}
}
