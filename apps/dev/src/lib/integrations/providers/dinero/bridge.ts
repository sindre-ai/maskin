/**
 * The Dinero tools Dinero's own MCP server does not have. Dinero's public API (https://api.dinero.dk,
 * scope dineropublicapi:write) has them, so the gateway answers these calls itself with the same
 * sign-in token it uses for the hosted server, and adds the tools to the list the agent sees.
 *
 * Two groups (checked against the OpenAPI spec, 24 Nov 2026):
 *
 * - Booking tools (emailing a sales invoice, chasing a late one) reach the customer or the
 *   customer's books, so they sit behind the owner's booking switch with BookVoucher
 *   (./allowed-tools.ts). Each carries the version stamp (timestamp) of the document the agent
 *   looked at, so Dinero refuses it if the document changed since (dineroCallRefusal in
 *   ./action-log.ts checks it is there).
 * - Draft tools, open without the switch: list_posted_entries only reads, update_purchase_voucher_draft
 *   edits a purchase voucher draft (Dinero refuses a booked one), and delete_finance_voucher_draft
 *   removes a finance voucher draft. Dinero's delete of a booked finance voucher books an offset
 *   entry instead, so the bridge reads the voucher first and sends the delete only when its status
 *   is Draft, with the timestamp it just read. Anything else is refused and nothing is deleted.
 */

export const DINERO_API_URL = 'https://api.dinero.dk'

const API_TIMEOUT_MS = 30_000
const RESULT_LIMIT = 4000
/** A list of posted entries is the answer itself, so it gets more room than a confirmation. */
const ENTRIES_LIMIT = 200_000

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface BridgeTool {
	name: string
	description: string
	inputSchema: Record<string, unknown>
}

const organizationId = {
	type: 'string',
	description: 'The organization id (guid) from list_organizations.',
}
const invoiceGuid = {
	type: 'string',
	description: 'The guid of the booked sales invoice (from list_vouchers or get_invoice).',
}
const timestamp = {
	type: 'string',
	description:
		'The timestamp of the version you looked at, from get_invoice. Dinero refuses the call if it changed since.',
}
const mail = {
	receiver: {
		type: 'string',
		description: 'Email address to send to. Leave out to use the contact on the invoice.',
	},
	subject: { type: 'string', description: 'Subject line. Leave out for Dinero’s default.' },
	message: { type: 'string', description: 'Message text. Leave out for Dinero’s default.' },
	sender: { type: 'string', description: 'Sender address. Leave out for the company default.' },
	ccToSender: { type: 'boolean', description: 'Send a copy to the sender.' },
	addVoucherAsPdfAttachment: { type: 'boolean', description: 'Attach the document as a PDF.' },
}

export const DINERO_BRIDGE_BOOKING_TOOLS: readonly BridgeTool[] = [
	{
		name: 'send_invoice_email',
		description:
			'Emails a booked sales invoice to the customer from Dinero, with a link to a public copy. The invoice must be booked. This sends a real email to a customer and cannot be taken back.',
		inputSchema: {
			type: 'object',
			properties: { organizationId, invoiceGuid, timestamp, ...mail },
			required: ['organizationId', 'invoiceGuid', 'timestamp'],
		},
	},
	{
		name: 'add_invoice_reminder',
		description:
			'Adds a reminder (rykker) draft to an overdue sales invoice. Dinero only allows it when the invoice is overdue, and again after 10 days. It has no effect until book_invoice_reminder books it. Fee flags default to false.',
		inputSchema: {
			type: 'object',
			properties: {
				organizationId,
				invoiceGuid,
				timestamp,
				date: { type: 'string', description: 'Reminder date, YYYY-MM-DD.' },
				title: { type: 'string' },
				description: { type: 'string' },
				withFee: { type: 'boolean' },
				withInterestFee: { type: 'boolean' },
				withCompensationFee: { type: 'boolean' },
				withDebtCollectionWarning: { type: 'boolean' },
			},
			required: ['organizationId', 'invoiceGuid', 'timestamp', 'date'],
		},
	},
	{
		name: 'book_invoice_reminder',
		description:
			'Books a reminder draft made with add_invoice_reminder. Only a booked reminder can be sent. Booked reminders cannot be deleted through this server.',
		inputSchema: {
			type: 'object',
			properties: {
				organizationId,
				invoiceGuid,
				reminderId: { type: 'string', description: 'The id add_invoice_reminder returned.' },
				timestamp: {
					type: 'string',
					description: 'The reminder’s own timestamp, from add_invoice_reminder.',
				},
			},
			required: ['organizationId', 'invoiceGuid', 'reminderId', 'timestamp'],
		},
	},
	{
		name: 'send_invoice_reminder_email',
		description:
			'Emails the latest booked reminder on a sales invoice to the customer. This sends a real email to a customer and cannot be taken back.',
		inputSchema: {
			type: 'object',
			properties: { organizationId, invoiceGuid, timestamp, ...mail },
			required: ['organizationId', 'invoiceGuid', 'timestamp'],
		},
	},
]

const voucherGuid = {
	type: 'string',
	description: 'The guid of the voucher draft (from list_vouchers or get_purchase_voucher).',
}

export const DINERO_BRIDGE_DRAFT_TOOLS: readonly BridgeTool[] = [
	{
		name: 'list_posted_entries',
		description:
			'Lists the posted entries (bookings) of one organization for a date range, so a trial balance can be built for any period. Read only. The range cannot cross an accounting year. Large ranges are slow: ask for one month or one quarter at a time.',
		inputSchema: {
			type: 'object',
			properties: {
				organizationId,
				fromDate: { type: 'string', description: 'First day, YYYY-MM-DD.' },
				toDate: { type: 'string', description: 'Last day, YYYY-MM-DD.' },
				includePrimo: {
					type: 'boolean',
					description: 'Include the opening balance entries. Default true.',
				},
			},
			required: ['organizationId', 'fromDate', 'toDate'],
		},
	},
	{
		name: 'update_purchase_voucher_draft',
		description:
			'Replaces the contents of a purchase voucher draft. Dinero refuses a booked voucher. Send the whole voucher, as get_purchase_voucher shows it, with your changes: lines you leave out are removed. Does not book.',
		inputSchema: {
			type: 'object',
			properties: {
				organizationId,
				voucherGuid,
				timestamp: {
					type: 'string',
					description:
						'The timestamp of the version you looked at, from get_purchase_voucher. Dinero refuses the call if it changed since.',
				},
				voucherDate: { type: 'string', description: 'Date of the voucher, YYYY-MM-DD.' },
				purchaseType: { type: 'string', description: 'cash or credit.' },
				contactGuid: { type: 'string', description: 'The supplier contact guid.' },
				lines: {
					type: 'array',
					description:
						'The voucher lines. Each has amount (number, required) and optionally accountNumber, description and vatCode.',
					items: {
						type: 'object',
						properties: {
							amount: { type: 'number' },
							accountNumber: { type: 'integer' },
							description: { type: 'string' },
							vatCode: { type: 'string' },
						},
						required: ['amount'],
					},
				},
				paymentDate: { type: 'string', description: 'Payment deadline, YYYY-MM-DD. Credit only.' },
				fileGuid: { type: 'string', description: 'The receipt file guid from upload_file.' },
				depositAccountNumber: { type: 'integer', description: 'Cash purchases only.' },
				regionKey: { type: 'string', description: 'EU, DK or World. Cash purchases only.' },
				currencyKey: { type: 'string', description: 'Credit purchases only. Default DKK.' },
				externalReference: { type: 'string', description: 'Up to 128 characters.' },
			},
			required: [
				'organizationId',
				'voucherGuid',
				'timestamp',
				'voucherDate',
				'purchaseType',
				'contactGuid',
				'lines',
			],
		},
	},
	{
		name: 'delete_finance_voucher_draft',
		description:
			'Deletes a finance voucher (manual voucher) that is still a draft. Refused, with nothing deleted, when the voucher is booked or being edited: a booked voucher is corrected with a counter-posting instead.',
		inputSchema: {
			type: 'object',
			properties: { organizationId, voucherGuid },
			required: ['organizationId', 'voucherGuid'],
		},
	},
]

export const DINERO_BRIDGE_TOOLS: readonly BridgeTool[] = [
	...DINERO_BRIDGE_BOOKING_TOOLS,
	...DINERO_BRIDGE_DRAFT_TOOLS,
]

export const DINERO_BRIDGE_BOOKING_TOOL_NAMES: readonly string[] = DINERO_BRIDGE_BOOKING_TOOLS.map(
	(t) => t.name,
)
export const DINERO_BRIDGE_DRAFT_TOOL_NAMES: readonly string[] = DINERO_BRIDGE_DRAFT_TOOLS.map(
	(t) => t.name,
)

export const DINERO_BRIDGE_TOOL_NAMES: readonly string[] = DINERO_BRIDGE_TOOLS.map((t) => t.name)

export function isDineroBridgeTool(name: string): boolean {
	return DINERO_BRIDGE_TOOL_NAMES.includes(name)
}

export interface BridgeResult {
	isError: boolean
	text: string
}

type Args = Record<string, unknown>

function text(args: Args, key: string): string | undefined {
	const v = args[key]
	return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined
}

function flag(args: Args, key: string): boolean | undefined {
	return typeof args[key] === 'boolean' ? (args[key] as boolean) : undefined
}

function mailBody(args: Args): Record<string, unknown> {
	return {
		Timestamp: text(args, 'timestamp'),
		Sender: text(args, 'sender'),
		CcToSender: flag(args, 'ccToSender'),
		Receiver: text(args, 'receiver'),
		Subject: text(args, 'subject'),
		Message: text(args, 'message'),
		AddVoucherAsPdfAttachment: flag(args, 'addVoucherAsPdfAttachment'),
	}
}

interface ApiCall {
	method: 'GET' | 'POST' | 'PUT' | 'DELETE'
	path: string
	query?: Record<string, string>
	body?: Record<string, unknown>
	/** How much of the answer is kept. Default RESULT_LIMIT. */
	limit?: number
	/** A read made first. Its answer decides whether the call goes ahead, and may fill in its body. */
	preflight?: {
		path: string
		decide: (answer: unknown) => { body: Record<string, unknown> } | { refusal: string }
	}
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function uuidArg(args: Args, key: string): string | null {
	const v = text(args, key)
	return v && GUID.test(v) ? v : null
}

function voucherLines(args: Args): Record<string, unknown>[] | string {
	const lines = args.lines
	if (!Array.isArray(lines) || lines.length === 0) return 'lines must list at least one line.'
	const out: Record<string, unknown>[] = []
	for (const line of lines) {
		const l = line && typeof line === 'object' ? (line as Args) : {}
		if (typeof l.amount !== 'number' || !Number.isFinite(l.amount))
			return 'Every line needs an amount that is a number.'
		out.push({
			Amount: l.amount,
			AccountNumber: typeof l.accountNumber === 'number' ? l.accountNumber : undefined,
			Description: text(l, 'description'),
			VatCode: text(l, 'vatCode'),
		})
	}
	return out
}

/** The Dinero API request for one bridge tool, or a plain-words reason it cannot be made. */
function buildCall(tool: string, args: Args): ApiCall | string {
	const org = text(args, 'organizationId')
	if (!org || !GUID.test(org))
		return 'organizationId must be the organization guid from list_organizations.'

	if (tool === 'list_posted_entries') {
		const from = text(args, 'fromDate')
		const to = text(args, 'toDate')
		if (!from || !to || !ISO_DATE.test(from) || !ISO_DATE.test(to))
			return 'fromDate and toDate must be YYYY-MM-DD.'
		const query: Record<string, string> = { fromDate: from, toDate: to }
		const primo = flag(args, 'includePrimo')
		if (primo !== undefined) query.includePrimo = String(primo)
		return { method: 'GET', path: `/v1/${org}/entries`, query, limit: ENTRIES_LIMIT }
	}

	if (tool === 'update_purchase_voucher_draft') {
		const voucher = uuidArg(args, 'voucherGuid')
		if (!voucher) return 'voucherGuid must be the guid of a purchase voucher draft.'
		const date = text(args, 'voucherDate')
		if (!date || !ISO_DATE.test(date)) return 'voucherDate must be YYYY-MM-DD.'
		const type = text(args, 'purchaseType')
		if (type !== 'cash' && type !== 'credit') return 'purchaseType must be cash or credit.'
		const contact = uuidArg(args, 'contactGuid')
		if (!contact) return 'contactGuid must be the guid of the supplier contact.'
		const lines = voucherLines(args)
		if (typeof lines === 'string') return lines
		const paymentDate = text(args, 'paymentDate')
		if (paymentDate && !ISO_DATE.test(paymentDate)) return 'paymentDate must be YYYY-MM-DD.'
		return {
			method: 'PUT',
			// The v1.1 route; Dinero answers a booked voucher with an error, it never edits one.
			path: `/v1.1/${org}/vouchers/purchase/${voucher}`,
			body: {
				Timestamp: text(args, 'timestamp'),
				VoucherDate: date,
				PurchaseType: type,
				ContactGuid: contact,
				Lines: lines,
				PaymentDate: paymentDate,
				FileGuid: text(args, 'fileGuid'),
				DepositAccountNumber:
					typeof args.depositAccountNumber === 'number' ? args.depositAccountNumber : undefined,
				RegionKey: text(args, 'regionKey'),
				CurrencyKey: text(args, 'currencyKey'),
				ExternalReference: text(args, 'externalReference'),
			},
		}
	}

	if (tool === 'delete_finance_voucher_draft') {
		const voucher = uuidArg(args, 'voucherGuid')
		if (!voucher) return 'voucherGuid must be the guid of a finance voucher draft.'
		const path = `/v1/${org}/vouchers/manuel/${voucher}`
		return {
			method: 'DELETE',
			path,
			preflight: {
				path,
				decide: (answer) => {
					const a = answer && typeof answer === 'object' ? (answer as Args) : {}
					const stamp = typeof a.Timestamp === 'string' ? a.Timestamp.trim() : ''
					if (a.Status !== 'Draft' || stamp.length === 0) {
						return {
							refusal: `The voucher is not a draft (status: ${typeof a.Status === 'string' ? a.Status : 'unknown'}). Dinero would book an offset entry instead of deleting it, so nothing was deleted. Correct a booked voucher with a counter-posting.`,
						}
					}
					return { body: { Timestamp: stamp } }
				},
			},
		}
	}

	const invoice = text(args, 'invoiceGuid')
	if (!invoice || !GUID.test(invoice)) return 'invoiceGuid must be the guid of a sales invoice.'
	const base = `/v1/${org}/invoices/${invoice}`
	switch (tool) {
		case 'send_invoice_email':
			return { method: 'POST', path: `${base}/email`, body: mailBody(args) }
		case 'send_invoice_reminder_email':
			return { method: 'POST', path: `${base}/reminders/email`, body: mailBody(args) }
		case 'add_invoice_reminder': {
			const date = text(args, 'date')
			if (!date || !ISO_DATE.test(date)) return 'date must be YYYY-MM-DD.'
			return {
				method: 'POST',
				path: `${base}/reminders`,
				body: {
					Timestamp: text(args, 'timestamp'),
					Date: date,
					Title: text(args, 'title'),
					Description: text(args, 'description'),
					WithDebtCollectionWarning: flag(args, 'withDebtCollectionWarning') ?? false,
					WithFee: flag(args, 'withFee') ?? false,
					WithInterestFee: flag(args, 'withInterestFee') ?? false,
					WithCompensationFee: flag(args, 'withCompensationFee') ?? false,
				},
			}
		}
		case 'book_invoice_reminder': {
			const id = text(args, 'reminderId')
			if (!id || !/^[A-Za-z0-9-]+$/.test(id))
				return 'reminderId must be the id add_invoice_reminder returned.'
			return {
				method: 'POST',
				path: `${base}/reminders/${id}/book`,
				body: { Timestamp: text(args, 'timestamp') },
			}
		}
		default:
			return `${tool} is not a Dinero bridge tool.`
	}
}

const UNREACHABLE = {
	isError: true,
	text: 'Dinero could not be reached. Read the document again before you retry: the call may or may not have gone through.',
}

/**
 * Makes one bridge call against Dinero's public API. Never throws: a refusal, an unreachable
 * Dinero or an error answer comes back as an error result the agent can read. The answer's text
 * is Dinero's own, cut to a size that fits a tool result.
 */
export async function callDineroBridge(
	tool: string,
	args: unknown,
	authorization: string,
	fetchImpl: typeof fetch = fetch,
): Promise<BridgeResult> {
	const call = buildCall(tool, args && typeof args === 'object' ? (args as Args) : {})
	if (typeof call === 'string')
		return { isError: true, text: `${call} Nothing was sent to Dinero.` }

	const send = (method: string, path: string, query?: Record<string, string>, body?: unknown) => {
		const qs = query ? `?${new URLSearchParams(query).toString()}` : ''
		return fetchImpl(`${DINERO_API_URL}${path}${qs}`, {
			method,
			headers: {
				Authorization: authorization,
				...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
			redirect: 'manual',
			signal: AbortSignal.timeout(API_TIMEOUT_MS),
		})
	}

	let body = call.body
	if (call.preflight) {
		let read: Response
		try {
			read = await send('GET', call.preflight.path)
		} catch {
			return { isError: true, text: `${UNREACHABLE.text} Nothing was deleted.` }
		}
		const readText = await read.text().catch(() => '')
		if (!read.ok) {
			return {
				isError: true,
				text: `Dinero could not show the voucher (HTTP ${read.status}), so nothing was changed: ${readText.slice(0, RESULT_LIMIT)}`,
			}
		}
		let parsed: unknown
		try {
			parsed = JSON.parse(readText)
		} catch {
			parsed = null
		}
		const verdict = call.preflight.decide(parsed)
		if ('refusal' in verdict) return { isError: true, text: verdict.refusal }
		body = verdict.body
	}

	let res: Response
	try {
		res = await send(call.method, call.path, call.query, body)
	} catch {
		return UNREACHABLE
	}
	const limit = call.limit ?? RESULT_LIMIT
	const full = await res.text().catch(() => '')
	const cut = call.limit !== undefined && full.length > limit
	const answer = full.slice(0, limit)
	if (res.ok) {
		if (cut) {
			return {
				isError: false,
				text: `${answer}\n\n[Cut at ${limit} characters: the answer is longer. Ask for a shorter date range.]`,
			}
		}
		return { isError: false, text: answer || `Dinero accepted ${tool} (HTTP ${res.status}).` }
	}
	return { isError: true, text: `Dinero refused ${tool} (HTTP ${res.status}): ${answer}` }
}
