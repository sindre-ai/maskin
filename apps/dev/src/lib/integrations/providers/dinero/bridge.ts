/**
 * The Dinero tools Dinero's own MCP server does not have: emailing a sales invoice and chasing a
 * late one. Dinero's public API (https://api.dinero.dk, scope dineropublicapi:write) has them, so
 * the gateway answers these calls itself with the same sign-in token it uses for the hosted
 * server, and adds the tools to the list the agent sees.
 *
 * All four reach the customer or the customer's books, so they sit behind the owner's booking
 * switch with BookVoucher (./allowed-tools.ts). Each one carries the version stamp (timestamp)
 * of the document the agent looked at, so Dinero refuses it if the document changed since
 * (dineroCallRefusal in ./action-log.ts checks it is there).
 */

export const DINERO_API_URL = 'https://api.dinero.dk'

const API_TIMEOUT_MS = 30_000
const RESULT_LIMIT = 4000

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

export const DINERO_BRIDGE_TOOLS: readonly BridgeTool[] = [
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
	path: string
	body: Record<string, unknown>
}

/** The Dinero API request for one bridge tool, or a plain-words reason it cannot be made. */
function buildCall(tool: string, args: Args): ApiCall | string {
	const org = text(args, 'organizationId')
	const invoice = text(args, 'invoiceGuid')
	if (!org || !GUID.test(org))
		return 'organizationId must be the organization guid from list_organizations.'
	if (!invoice || !GUID.test(invoice)) return 'invoiceGuid must be the guid of a sales invoice.'
	const base = `/v1/${org}/invoices/${invoice}`
	switch (tool) {
		case 'send_invoice_email':
			return { path: `${base}/email`, body: mailBody(args) }
		case 'send_invoice_reminder_email':
			return { path: `${base}/reminders/email`, body: mailBody(args) }
		case 'add_invoice_reminder': {
			const date = text(args, 'date')
			if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return 'date must be YYYY-MM-DD.'
			return {
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
			return { path: `${base}/reminders/${id}/book`, body: { Timestamp: text(args, 'timestamp') } }
		}
		default:
			return `${tool} is not a Dinero bridge tool.`
	}
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
	let res: Response
	try {
		res = await fetchImpl(`${DINERO_API_URL}${call.path}`, {
			method: 'POST',
			headers: { Authorization: authorization, 'Content-Type': 'application/json' },
			body: JSON.stringify(call.body),
			redirect: 'manual',
			signal: AbortSignal.timeout(API_TIMEOUT_MS),
		})
	} catch {
		return {
			isError: true,
			text: 'Dinero could not be reached. Read the document again before you retry: the call may or may not have gone through.',
		}
	}
	const answer = (await res.text().catch(() => '')).slice(0, RESULT_LIMIT)
	if (res.ok) {
		return { isError: false, text: answer || `Dinero accepted ${tool} (HTTP ${res.status}).` }
	}
	return { isError: true, text: `Dinero refused ${tool} (HTTP ${res.status}): ${answer}` }
}
