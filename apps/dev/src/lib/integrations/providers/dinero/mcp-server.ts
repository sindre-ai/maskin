import type { Database } from '@maskin/db'
import { files } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { trackIntegrationToolCalled } from '../../../analytics/integration-events'
import { flowSlugOfSession, trackReceiptDraftBooked } from '../../../analytics/receipt-events'
import { logger } from '../../../logger'
import { IntegrationAuthRevokedError } from '../../errors'
import { getCredential } from '../../lookup'
import { TokenManager } from '../../oauth/token-manager'
import { readContextFor } from '../../read-context'
import {
	DINERO_API_URL,
	DINERO_GUID_RE,
	type DineroOperation,
	buildRequest,
	trimAccounts,
	trimContacts,
	trimEntries,
	trimOrganization,
	trimVatTypes,
	trimVoucher,
} from './api'
import { DINERO_PROVIDER } from './config'

/**
 * In-process MCP server for Dinero, served over Streamable HTTP at
 * `/api/integrations/dinero/mcp`. Sibling of the Deepdots surface.
 *
 * Six read tools and one write tool, and the write tool only saves a draft purchase voucher
 * that Dinero keeps out of the books until someone books it in Dinero. Nothing here books,
 * changes or deletes: api.ts has no such operation to call. tool-kinds.ts lists the reads;
 * anything not listed is a write, so an agent held to Read cannot save a draft.
 *
 * The three Dinero values and the one-hour token are resolved here, on the server:
 * getCredential first (access check plus one audit row, attributed to the calling agent), then
 * TokenManager, which asks Dinero for a new token when the old one is near its end. They never
 * reach the session, and the agent never sees them.
 *
 * Every call fires integration_tool_called with ids and an outcome only. No arguments, no rows,
 * no error text.
 */
export { DINERO_PROVIDER }
export const DINERO_FETCH_TIMEOUT_MS = 20_000
/** Dinero refuses a file over 6 MB. */
export const DINERO_FILE_MAX_BYTES = 6 * 1024 * 1024

export interface DineroMcpContext {
	db: Database
	workspaceId: string
	/** The authenticated caller; credential reads are attributed to it. */
	actorId: string
	/** The Maskin session making the call (X-Maskin-Session-Id), for the tool-call event only. */
	sessionId?: string | null
	/** The workspace's active Dinero integration, null when none is connected. */
	integrationId: string | null
	/** For a receipt file named by id. */
	storage?: StorageProvider
	/** Overridable in tests. */
	getAuth?: (
		db: Database,
		input: { workspaceId: string; integrationId: string; actorId: string; outboundTarget: string },
	) => Promise<{ token: string; organizationId: number }>
	fetchImpl?: typeof fetch
	/** Overridable in tests. */
	trackToolCalled?: typeof trackIntegrationToolCalled
	/** Counts one saved draft as receipt_draft_booked. Overridable in tests. */
	countDraft?: (ctx: DineroMcpContext) => Promise<void>
}

async function defaultAuth(
	db: Database,
	input: { workspaceId: string; integrationId: string; actorId: string; outboundTarget: string },
): Promise<{ token: string; organizationId: number }> {
	// Gate and audit first. TokenManager then decrypts and renews on its own path.
	const credential = await getCredential(
		db,
		input.workspaceId,
		input.integrationId,
		readContextFor(input.actorId, input.outboundTarget),
	)
	// Only the company id is taken from the stored value, never the keys.
	const organizationId = Number(
		(JSON.parse(credential.value) as { organizationId?: unknown }).organizationId,
	)
	if (!Number.isInteger(organizationId) || organizationId <= 0) {
		throw new IntegrationAuthRevokedError(input.integrationId, 'No stored Dinero company')
	}
	// Imported lazily, as Deepdots does: the registry imports provider modules.
	const { getProvider } = await import('../../registry')
	const token = await new TokenManager().getValidToken(
		db,
		input.integrationId,
		getProvider(DINERO_PROVIDER),
	)
	return { token, organizationId }
}

/**
 * One receipt_draft_booked per draft Dinero confirmed as a draft: counts and ids only. The vendor
 * MCP the gateway counts for is not this tool, so the count is made here. Best-effort: a failure
 * to count never changes what the agent is told.
 */
async function countSavedDraft(ctx: DineroMcpContext): Promise<void> {
	try {
		const flowSlug = await flowSlugOfSession(ctx.db, {
			workspaceId: ctx.workspaceId,
			actorId: ctx.actorId,
			sessionId: ctx.sessionId ?? undefined,
		})
		await trackReceiptDraftBooked({
			flowSlug,
			connector: DINERO_PROVIDER,
			workspaceId: ctx.workspaceId,
			actorId: ctx.actorId,
		})
	} catch (err) {
		logger.warn('Could not count a Dinero draft', {
			workspaceId: ctx.workspaceId,
			error: err instanceof Error ? err.name : 'unknown',
		})
	}
}

function textResult(payload: unknown, isError = false) {
	return {
		...(isError ? { isError: true as const } : {}),
		content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
	}
}

type ToolResult = ReturnType<typeof textResult>

// A failure carries its code out so the event can report it without reading the message.
type Outcome = { result: ToolResult; errorCode: string | null }

function failure(code: string, message: string): Outcome {
	return { result: textResult({ error: { code, message } }, true), errorCode: code }
}

function success(payload: unknown): Outcome {
	return { result: textResult(payload), errorCode: null }
}

const NEEDS_ATTENTION_MESSAGE =
	'The Dinero connection needs attention: the saved keys no longer work. Ask a person to reconnect Dinero under Settings, Integrations. This is not an outage, so do not retry.'

/** Every Dinero failure, mapped to a code and a message that says what to do. */
function failureForStatus(status: number): Outcome {
	if (status === 401) return failure('NEEDS_ATTENTION', NEEDS_ATTENTION_MESSAGE)
	if (status === 403) {
		return failure(
			'NOT_ALLOWED',
			'Dinero refused this for the connected company. The company needs a Pro or Total plan for the API, and the keys must belong to it. Ask a person to check the plan in Dinero.',
		)
	}
	if (status === 404) return failure('NOT_FOUND', 'Dinero has nothing with that id.')
	if (status === 429) {
		return failure(
			'RATE_LIMITED',
			'Dinero allows 60 requests a minute for this connection. Wait a minute, then try again.',
		)
	}
	if (status >= 500) {
		return failure('TEMPORARILY_UNAVAILABLE', 'Dinero is busy or down right now. Try again later.')
	}
	return failure('REQUEST_FAILED', `Dinero answered with an unexpected status (${status}).`)
}

const MAX_REASON_LENGTH = 300

/**
 * Dinero's own words for a refused request (400 or 422): its message and the messages of its
 * validation errors. Those describe the request we sent, never the books. Nothing else in the
 * body is read, so nothing else can reach the agent.
 */
async function refusalReason(res: Response): Promise<string | null> {
	try {
		const text = (await res.text()).slice(0, 4000)
		let parts: string[] = []
		try {
			const body = JSON.parse(text) as unknown
			if (typeof body === 'string') parts = [body]
			else if (body && typeof body === 'object') {
				const { message, validationErrors } = body as {
					message?: unknown
					validationErrors?: unknown
				}
				if (typeof message === 'string') parts.push(message)
				if (Array.isArray(validationErrors)) {
					for (const v of validationErrors.slice(0, 5)) {
						const { propertyName, message: m } = (v ?? {}) as {
							propertyName?: unknown
							message?: unknown
						}
						if (typeof m === 'string') {
							parts.push(typeof propertyName === 'string' ? `${propertyName}: ${m}` : m)
						}
					}
				}
			}
		} catch {
			parts = [text]
		}
		const reason = parts.join(' ').replace(/\s+/g, ' ').trim()
		return reason ? reason.slice(0, MAX_REASON_LENGTH) : null
	} catch {
		return null
	}
}

/** A receipt in the workspace's file store: PDF, PNG or JPEG, read from its first bytes. */
const SIGNATURES: Array<{ type: string; bytes: number[] }> = [
	{ type: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46] },
	{ type: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
	{ type: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
]

export function sniffReceiptType(bytes: Uint8Array): string | null {
	for (const { type, bytes: sig } of SIGNATURES) {
		if (bytes.length >= sig.length && sig.every((b, i) => bytes[i] === b)) return type
	}
	return null
}

async function loadReceipt(
	ctx: DineroMcpContext,
	fileId: string,
): Promise<{ ok: true; form: FormData } | { ok: false; outcome: Outcome }> {
	const [file] = await ctx.db
		.select()
		.from(files)
		.where(and(eq(files.id, fileId), eq(files.workspaceId, ctx.workspaceId)))
		.limit(1)
	if (!file) {
		return {
			ok: false,
			outcome: failure('INVALID_INPUT', 'file_id is not a file in this workspace.'),
		}
	}
	if (file.sizeBytes > DINERO_FILE_MAX_BYTES) {
		return {
			ok: false,
			outcome: failure('INVALID_INPUT', "The receipt is over Dinero's 6 MB limit."),
		}
	}
	if (!ctx.storage) {
		return {
			ok: false,
			outcome: failure(
				'UNAVAILABLE',
				'File storage is not available, so the receipt cannot be read.',
			),
		}
	}
	const bytes = await ctx.storage.get(file.storageKey)
	if (bytes.length > DINERO_FILE_MAX_BYTES) {
		return {
			ok: false,
			outcome: failure('INVALID_INPUT', "The receipt is over Dinero's 6 MB limit."),
		}
	}
	const type = sniffReceiptType(bytes)
	if (!type) {
		return {
			ok: false,
			outcome: failure(
				'INVALID_INPUT',
				'The receipt is not a PDF, PNG or JPEG. Dinero takes only those.',
			),
		}
	}
	const form = new FormData()
	form.append('file', new Blob([new Uint8Array(bytes)], { type }), file.name)
	return { ok: true, form }
}

type Auth = { token: string; organizationId: number }

async function authFor(ctx: DineroMcpContext, tool: string): Promise<Auth | Outcome> {
	if (!ctx.integrationId) {
		return failure('NOT_CONNECTED', 'Dinero is not connected in this workspace.')
	}
	try {
		return await (ctx.getAuth ?? defaultAuth)(ctx.db, {
			workspaceId: ctx.workspaceId,
			integrationId: ctx.integrationId,
			actorId: ctx.actorId,
			outboundTarget: new URL(DINERO_API_URL).host,
		})
	} catch (err) {
		// The error name and nothing else: the message of a sign-in failure could carry a key.
		logger.warn('Dinero MCP could not get a token', {
			workspaceId: ctx.workspaceId,
			integrationId: ctx.integrationId,
			tool,
			error: err instanceof Error ? err.name : 'unknown',
		})
		if (err instanceof IntegrationAuthRevokedError) {
			return failure('NEEDS_ATTENTION', NEEDS_ATTENTION_MESSAGE)
		}
		return failure(
			'TOKEN_UNAVAILABLE',
			'Could not get a valid Dinero token for this workspace. This may be temporary; if it keeps happening the connection needs attention.',
		)
	}
}

const isOutcome = (v: Auth | Outcome): v is Outcome => 'errorCode' in v

/** One Dinero call. Returns the parsed JSON body, or the failure to hand back. */
async function call(
	ctx: DineroMcpContext,
	auth: Auth,
	tool: string,
	operation: DineroOperation,
): Promise<{ ok: true; body: unknown } | { ok: false; outcome: Outcome }> {
	const req = buildRequest(auth.organizationId, operation)
	let res: Response
	try {
		res = await (ctx.fetchImpl ?? fetch)(req.url, {
			method: req.method,
			headers: {
				Authorization: `Bearer ${auth.token}`,
				Accept: 'application/json',
				...(req.json ? { 'Content-Type': 'application/json' } : {}),
			},
			body: req.body,
			signal: AbortSignal.timeout(DINERO_FETCH_TIMEOUT_MS),
		})
	} catch (err) {
		logger.warn('Dinero MCP request failed', {
			workspaceId: ctx.workspaceId,
			tool,
			error: err instanceof Error ? err.name : 'unknown',
		})
		return {
			ok: false,
			outcome: failure('REQUEST_FAILED', 'The request to Dinero did not complete.'),
		}
	}
	logger.info('Dinero MCP call', { workspaceId: ctx.workspaceId, tool, httpStatus: res.status })
	if (!res.ok) {
		const outcome = failureForStatus(res.status)
		if (res.status !== 400 && res.status !== 422) return { ok: false, outcome }
		const reason = await refusalReason(res)
		return {
			ok: false,
			outcome: failure(
				'INVALID_INPUT',
				reason
					? `Dinero refused the request (${res.status}): ${reason}`
					: `Dinero refused the request (${res.status}).`,
			),
		}
	}
	try {
		return { ok: true, body: await res.json() }
	} catch {
		return {
			ok: false,
			outcome: failure('UNEXPECTED_RESPONSE', 'Dinero answered with something that is not JSON.'),
		}
	}
}

const unexpected = () =>
	failure('UNEXPECTED_RESPONSE', 'Dinero answered with something this tool does not recognise.')

const dateField = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
	.describe('A date as YYYY-MM-DD.')

const lineField = z.object({
	description: z.string().trim().min(1).max(500).describe('What was bought.'),
	amount: z.number().positive().describe('The amount paid for this line, in the voucher currency.'),
	account_number: z
		.number()
		.int()
		.optional()
		.describe(
			'The purchase account to book on, from dinero_list_purchase_accounts. Leave out to let Dinero use its default for the VAT code.',
		),
	vat_code: z
		.string()
		.max(40)
		.optional()
		.describe('A VAT code from dinero_list_vat_types. Leave out to use the account default.'),
})

const draftInput = {
	purchase_type: z
		.enum(['cash', 'credit'])
		.describe('cash: paid at once (for example a card receipt). credit: an invoice to pay later.'),
	voucher_date: dateField.describe('The date on the receipt, as YYYY-MM-DD.'),
	lines: z.array(lineField).min(1).max(50),
	file_id: z
		.string()
		.uuid()
		.optional()
		.describe(
			'The id of the receipt file in this workspace (PDF, PNG or JPEG, up to 6 MB). It is uploaded to Dinero and attached to the draft.',
		),
	contact_guid: z
		.string()
		.regex(DINERO_GUID_RE)
		.optional()
		.describe('The supplier, from dinero_list_contacts. Credit purchases only.'),
	payment_date: dateField.optional().describe('The payment deadline. Credit purchases only.'),
	currency_key: z
		.string()
		.max(10)
		.optional()
		.describe('A currency code such as EUR. Credit purchases only; DKK when left out.'),
	deposit_account_number: z
		.number()
		.int()
		.optional()
		.describe('The account the money left, such as the bank or cash account. Cash purchases only.'),
	region_key: z
		.enum(['DK', 'EU', 'World'])
		.optional()
		.describe('Where the seller is. Cash purchases only.'),
	external_reference: z
		.string()
		.max(128)
		.optional()
		.describe('Your own id for this receipt, kept on the draft in Dinero.'),
}

type DraftInput = {
	purchase_type: 'cash' | 'credit'
	voucher_date: string
	lines: Array<{ description: string; amount: number; account_number?: number; vat_code?: string }>
	file_id?: string
	contact_guid?: string
	payment_date?: string
	currency_key?: string
	deposit_account_number?: number
	region_key?: 'DK' | 'EU' | 'World'
	external_reference?: string
}

/** Fields that mean something for only one purchase type, so the other type refuses them. */
function wrongTypeFields(input: DraftInput): string[] {
	const creditOnly = ['contact_guid', 'payment_date', 'currency_key'] as const
	const cashOnly = ['deposit_account_number', 'region_key'] as const
	const wrong: readonly string[] = input.purchase_type === 'cash' ? creditOnly : cashOnly
	return wrong.filter((k) => input[k as keyof DraftInput] !== undefined)
}

/** Every field any read tool takes. Each tool's own zod shape decides which are present. */
type ReadInput = {
	page?: number
	page_size?: number
	from_date?: string
	to_date?: string
	skip?: number
	voucher_guid?: string
}

export function createDineroMcpServer(
	ctx: DineroMcpContext,
	/** Called before any tool is registered, e.g. to gate tools on the caller's access. */
	onServer?: (server: McpServer) => void,
): McpServer {
	const server = new McpServer(
		{ name: 'maskin-dinero', version: '0.1.0' },
		{ capabilities: { tools: {} } },
	)
	onServer?.(server)

	const tracked = async (tool: string, run: () => Promise<Outcome>): Promise<ToolResult> => {
		const outcome = await run()
		await (ctx.trackToolCalled ?? trackIntegrationToolCalled)({
			provider: DINERO_PROVIDER,
			tool,
			outcome: outcome.errorCode ? 'error' : 'success',
			errorCode: outcome.errorCode,
			actorId: ctx.actorId,
			sessionId: ctx.sessionId ?? null,
			workspaceId: ctx.workspaceId,
		})
		return outcome.result
	}

	/** A read that is one call and one trim. */
	const registerRead = (
		tool: string,
		description: string,
		inputSchema: z.ZodRawShape,
		toOperation: (input: ReadInput) => DineroOperation | Outcome,
		trim: (body: unknown, input: ReadInput) => unknown,
	) => {
		server.registerTool(
			tool,
			{ description, inputSchema, annotations: { readOnlyHint: true } },
			async (input: ReadInput) =>
				tracked(tool, async () => {
					const operation = toOperation(input)
					if ('errorCode' in operation) return operation
					const auth = await authFor(ctx, tool)
					if (isOutcome(auth)) return auth
					const res = await call(ctx, auth, tool, operation)
					if (!res.ok) return res.outcome
					const trimmed = trim(res.body, input)
					return trimmed === null ? unexpected() : success(trimmed)
				}),
		)
	}

	registerRead(
		'dinero_get_company',
		'Check the Dinero connection and name the company it is for: company id, name, VAT number, country. Call this first to see that the keys work.',
		{},
		() => ({ op: 'list_organizations' }),
		(body) => {
			// A personal integration is made for one company. Show that one, not every company
			// the owner has.
			if (!Array.isArray(body)) return null
			return { companies: body.map(trimOrganization).filter(Boolean) }
		},
	)

	registerRead(
		'dinero_list_purchase_accounts',
		'List the purchase (expense) accounts of the company, with the VAT code each one uses. Use the account numbers when saving a draft voucher.',
		{},
		() => ({ op: 'list_purchase_accounts' }),
		(body) => {
			const items = trimAccounts(body)
			return items === null ? null : { items }
		},
	)

	registerRead(
		'dinero_list_vat_types',
		"List the company's VAT codes with name and rate.",
		{},
		() => ({ op: 'list_vat_types' }),
		(body) => {
			const items = trimVatTypes(body)
			return items === null ? null : { items }
		},
	)

	registerRead(
		'dinero_list_contacts',
		"List the contacts (suppliers and customers) of the company, a page at a time. Returns items, page and has_more. Use a supplier's contact_guid on a credit purchase.",
		{
			page: z.number().int().min(0).max(1000).optional().describe('0-based page. Default 0.'),
			page_size: z.number().int().min(1).max(100).optional().describe('Rows per page. Default 50.'),
		},
		({ page, page_size }) => ({
			op: 'list_contacts',
			page: page ?? 0,
			pageSize: page_size ?? 50,
		}),
		(body, { page, page_size }) => trimContacts(body, page ?? 0, page_size ?? 50),
	)

	registerRead(
		'dinero_list_entries',
		'List the booked entries (the lines of booked vouchers) between two dates, with voucher number and guid. Dinero cannot cross accounting years, so keep both dates inside one. Returns items, has_more and next_skip.',
		{
			from_date: dateField,
			to_date: dateField,
			skip: z
				.number()
				.int()
				.min(0)
				.max(100_000)
				.optional()
				.describe('Rows to skip. Use next_skip.'),
		},
		({ from_date, to_date }) => {
			if (!from_date || !to_date) {
				return failure('INVALID_INPUT', 'from_date and to_date are required.')
			}
			if (from_date > to_date) return failure('INVALID_INPUT', 'from_date is after to_date.')
			return { op: 'list_entries', fromDate: from_date, toDate: to_date }
		},
		(body, { skip }) => trimEntries(body, skip ?? 0),
	)

	registerRead(
		'dinero_get_purchase_voucher',
		'Read one purchase voucher by its guid: status (Draft means not booked), lines, totals and attached file.',
		{ voucher_guid: z.string().regex(DINERO_GUID_RE).describe('The voucher guid from Dinero.') },
		({ voucher_guid }) =>
			voucher_guid
				? { op: 'get_purchase_voucher', guid: voucher_guid }
				: failure('INVALID_INPUT', 'voucher_guid is required.'),
		(body) => trimVoucher(body),
	)

	server.registerTool(
		'dinero_save_draft_purchase_voucher',
		{
			description:
				'Save one purchase voucher in Dinero as a DRAFT from a receipt or invoice. A draft has no effect on the books until a person books it in Dinero (Bilagsoversigt); this tool cannot book, change or delete anything. Call it once per receipt: a second call makes a second draft. Read the answer: is_draft must be true, and the totals should match the receipt.',
			inputSchema: draftInput,
		},
		async (input: DraftInput) =>
			tracked('dinero_save_draft_purchase_voucher', async () => {
				const tool = 'dinero_save_draft_purchase_voucher'
				const wrong = wrongTypeFields(input)
				if (wrong.length > 0) {
					return failure(
						'INVALID_INPUT',
						`${wrong.join(', ')} ${wrong.length > 1 ? 'are' : 'is'} not used for a ${input.purchase_type} purchase. Leave ${wrong.length > 1 ? 'them' : 'it'} out.`,
					)
				}
				// Read the receipt before asking Dinero for anything, so a bad file costs no call.
				let receipt: FormData | null = null
				if (input.file_id) {
					const loaded = await loadReceipt(ctx, input.file_id)
					if (!loaded.ok) return loaded.outcome
					receipt = loaded.form
				}
				const auth = await authFor(ctx, tool)
				if (isOutcome(auth)) return auth

				let fileGuid: string | null = null
				if (receipt) {
					const uploaded = await call(ctx, auth, tool, { op: 'upload_file', form: receipt })
					if (!uploaded.ok) return uploaded.outcome
					const guid = (uploaded.body as { FileGuid?: unknown } | null)?.FileGuid
					if (typeof guid !== 'string' || !DINERO_GUID_RE.test(guid)) return unexpected()
					fileGuid = guid
				}

				const res = await call(ctx, auth, tool, {
					op: 'create_purchase_voucher_draft',
					body: {
						PurchaseType: input.purchase_type,
						VoucherDate: input.voucher_date,
						Lines: input.lines.map((l) => ({
							Description: l.description,
							Amount: l.amount,
							...(l.account_number !== undefined ? { AccountNumber: l.account_number } : {}),
							...(l.vat_code ? { VatCode: l.vat_code } : {}),
						})),
						...(fileGuid ? { FileGuid: fileGuid } : {}),
						...(input.contact_guid ? { ContactGuid: input.contact_guid } : {}),
						...(input.payment_date ? { PaymentDate: input.payment_date } : {}),
						...(input.currency_key ? { CurrencyKey: input.currency_key } : {}),
						...(input.deposit_account_number !== undefined
							? { DepositAccountNumber: input.deposit_account_number }
							: {}),
						...(input.region_key ? { RegionKey: input.region_key } : {}),
						...(input.external_reference ? { ExternalReference: input.external_reference } : {}),
					},
				})
				if (!res.ok) return res.outcome
				const voucher = trimVoucher(res.body)
				if (!voucher) return unexpected()
				if (!voucher.is_draft) {
					// Dinero answered with a voucher that is not a draft. Say so plainly: a person
					// has to look at it in Dinero. Nothing here can undo it.
					logger.warn('Dinero saved a voucher that is not a draft', {
						workspaceId: ctx.workspaceId,
						status: voucher.status,
					})
					return failure(
						'NOT_A_DRAFT',
						`Dinero saved the voucher (${voucher.voucher_guid}) but reports its status as "${voucher.status}", not Draft. Do not save more. Tell a person to check it in Dinero.`,
					)
				}
				await (ctx.countDraft ?? countSavedDraft)(ctx)
				return success(voucher)
			}),
	)

	return server
}
