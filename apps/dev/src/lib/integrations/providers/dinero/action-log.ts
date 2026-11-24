import { createHash } from 'node:crypto'
import type { Database } from '@maskin/db'
import { toolCallSucceeded } from '../../../analytics/receipt-events'
import { recordEvent } from '../../../events/record-event'
import { logger } from '../../../logger'
import { parseSseData } from '../../mcp-gateway'
import { DINERO_BRIDGE_TOOL_NAMES } from './bridge'

/** The event action every logged Dinero call is written under. */
export const DINERO_ACTION_EVENT = 'dinero_action'

/**
 * The tools that change something in Dinero. Each call to one is logged, with its arguments and
 * Dinero's answer. Reads are not: they change nothing, and a period run makes hundreds of them.
 */
export const DINERO_LOGGED_TOOLS: ReadonlySet<string> = new Set([
	'CreatePurchaseVoucher',
	'CreateFinanceVoucher',
	'upload_file',
	'BookVoucher',
	'add_purchase_payment',
	'add_invoice_payment',
	...DINERO_BRIDGE_TOOL_NAMES,
])

/** The tools that book, pay, email or chase: they act on one version of a voucher. */
const VERSIONED_TOOLS: ReadonlySet<string> = new Set([
	'BookVoucher',
	'add_purchase_payment',
	'add_invoice_payment',
	...DINERO_BRIDGE_TOOL_NAMES,
])

const RESULT_LIMIT = 4000

/** A text argument longer than this is a file (upload_file takes the receipt as one string). */
const ARGUMENT_TEXT_LIMIT = 1000

/**
 * The arguments as the log keeps them. A long text argument is the file itself (a receipt, up to
 * a few MB), so it is replaced by its size and a short fingerprint, and the other arguments (the
 * file name, the voucher figures) stay as they are.
 */
export function loggedArguments(args: unknown): unknown {
	if (typeof args === 'string' && args.length > ARGUMENT_TEXT_LIMIT) {
		return {
			omitted: 'file content',
			length: args.length,
			sha256: createHash('sha256').update(args).digest('hex').slice(0, 16),
		}
	}
	if (Array.isArray(args)) return args.map(loggedArguments)
	if (args && typeof args === 'object') {
		return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, loggedArguments(v)]))
	}
	return args
}

/** Every value stored under a key that has "book" in it, at any depth of the arguments. */
function bookValues(value: unknown, out: unknown[] = []): unknown[] {
	if (Array.isArray(value)) {
		for (const item of value) bookValues(item, out)
	} else if (value && typeof value === 'object') {
		for (const [key, inner] of Object.entries(value)) {
			if (/book/i.test(key)) out.push(inner)
			bookValues(inner, out)
		}
	}
	return out
}

/**
 * A call the list cannot judge, because it depends on the arguments. A booking or payment must
 * carry the version stamp (timestamp) of the voucher the agent looked at, so Dinero refuses it
 * if the voucher changed since. BookVoucher makes the stamp optional; here it is not.
 *
 * CreateFinanceVoucher books in the same call when its book argument is set, so a name on the list
 * is not enough. With the owner's booking switch off it is let through only with book set to
 * false, and every book-like value anywhere in the arguments must be false: a missing book, a true,
 * a string, or a shape that is not understood is refused, so it fails closed. With the switch on
 * it is let through as it is.
 */
export function dineroCallRefusal(tool: string, args: unknown, booking = false): string | null {
	if (tool === 'CreateFinanceVoucher') {
		if (booking) return null
		const top = (args as { book?: unknown } | null | undefined)?.book
		if (top === false && bookValues(args).every((v) => v === false)) return null
		return `${tool} saves a draft only while booking is switched off, and booking is off. Call it again with book set to false and no other book setting. Nothing was sent to Dinero.`
	}
	if (!VERSIONED_TOOLS.has(tool)) return null
	const stamp = (args as { timestamp?: unknown } | null | undefined)?.timestamp
	if (typeof stamp === 'string' && stamp.trim().length > 0) return null
	return `${tool} needs the timestamp of the voucher version you looked at (from get_purchase_voucher or get_invoice). Read the voucher again, then call ${tool} with that timestamp. Nothing was sent to Dinero.`
}

/** The text of the answer to one tools/call, or null when it cannot be read. */
export function toolAnswerText(responseText: string, requestId: unknown): string | null {
	let messages: unknown[]
	try {
		messages = responseText.trimStart().startsWith('{')
			? [JSON.parse(responseText)]
			: parseSseData(responseText)
	} catch {
		return null
	}
	const answer = messages.find(
		(m): m is { id?: unknown; result?: { content?: unknown } } =>
			!!m && typeof m === 'object' && (m as { id?: unknown }).id === requestId,
	)
	const content = answer?.result?.content
	if (!Array.isArray(content)) return null
	const text = content
		.map((part) => (part && typeof part === 'object' ? (part as { text?: unknown }).text : null))
		.filter((t): t is string => typeof t === 'string')
		.join('\n')
	return text.length > 0 ? text.slice(0, RESULT_LIMIT) : null
}

/**
 * Writes one event for a Dinero call that changed something, when Dinero has answered: what
 * (tool and arguments), when (the event time), the outcome and Dinero's answer. Arguments and
 * answer are the owner's own bookkeeping and stay in the workspace. The reason for a line is
 * the description the agent puts on it, which Dinero keeps too. Runs on a clone of the answer, so
 * it never delays or alters what the agent receives. Best-effort: never throws.
 */
export async function recordDineroAction(p: {
	db: Database
	upstream: Response
	requestId: unknown
	tool: string
	args: unknown
	booking: boolean
	integrationId: string
	workspaceId: string
	actorId: string
	sessionId: string | undefined
}): Promise<void> {
	try {
		const text = await p.upstream.clone().text()
		const ok = p.upstream.ok && toolCallSucceeded(text, p.requestId)
		await recordEvent(p.db, {
			workspaceId: p.workspaceId,
			actorId: p.actorId,
			action: DINERO_ACTION_EVENT,
			entityType: 'integration',
			entityId: p.integrationId,
			data: {
				tool: p.tool,
				arguments: loggedArguments(p.args) ?? null,
				outcome: ok ? 'success' : 'error',
				result: toolAnswerText(text, p.requestId),
				booking_switch: p.booking,
				session_id: p.sessionId ?? null,
			},
		})
	} catch (err) {
		logger.warn('Could not log a Dinero action', {
			workspaceId: p.workspaceId,
			error: err instanceof Error ? err.name : 'unknown',
		})
	}
}
