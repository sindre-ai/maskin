/**
 * The tool list. Every tool but two reads through GET. The two others, economic_save_voucher_draft
 * and economic_attach_receipt, are only listed when the server is started with writes on (see
 * writesEnabled in server.ts). Neither can book, change or delete. The resource table is from
 * src/tools/typed.ts in available-dev/e-conomic-mcp at commit 164567c (MIT).
 */

import {
	type Credentials,
	EconomicApiError,
	EconomicClient,
	MAX_RECEIPT_BYTES,
	safePath,
} from './client.js'

export interface ToolDefinition {
	name: string
	description: string
	inputSchema: Record<string, unknown>
	handler: (args: Record<string, unknown>) => Promise<unknown>
}

interface Resource {
	singular: string
	plural: string
	path: string
	label: string
}

const RESOURCES: Resource[] = [
	{ singular: 'customer', plural: 'customers', path: 'customers', label: 'customers' },
	{ singular: 'supplier', plural: 'suppliers', path: 'suppliers', label: 'suppliers' },
	{ singular: 'product', plural: 'products', path: 'products', label: 'products' },
	{ singular: 'account', plural: 'accounts', path: 'accounts', label: 'chart of accounts' },
	{
		singular: 'draft_invoice',
		plural: 'draft_invoices',
		path: 'invoices/drafts',
		label: 'draft invoices',
	},
	{
		singular: 'booked_invoice',
		plural: 'booked_invoices',
		path: 'invoices/booked',
		label: 'booked invoices',
	},
	{ singular: 'journal', plural: 'journals', path: 'journals', label: 'journals' },
	{ singular: 'department', plural: 'departments', path: 'departments', label: 'departments' },
	{
		singular: 'payment_term',
		plural: 'payment_terms',
		path: 'payment-terms',
		label: 'payment terms',
	},
	{ singular: 'vat_zone', plural: 'vat_zones', path: 'vat-zones', label: 'VAT zones' },
	{ singular: 'vat_account', plural: 'vat_accounts', path: 'vat-accounts', label: 'VAT accounts' },
	{ singular: 'currency', plural: 'currencies', path: 'currencies', label: 'currencies' },
	{ singular: 'employee', plural: 'employees', path: 'employees', label: 'employees' },
]

const listSchema = {
	type: 'object',
	properties: {
		filter: { type: 'string', description: 'e-conomic filter, for example "name$like:Acme".' },
		sort: { type: 'string', description: 'Field to sort by, "-" first for descending.' },
		pageSize: { type: 'integer', minimum: 1, maximum: 1000 },
		maxItems: { type: 'integer', minimum: 1, maximum: 5000 },
	},
	additionalProperties: false,
}

function str(value: unknown): string | undefined {
	return typeof value === 'string' && value !== '' ? value : undefined
}

function num(value: unknown): number | undefined {
	return typeof value === 'number' ? value : undefined
}

/** Says what to fix, in plain words, for the first run. */
export function explainFailure(err: unknown): string {
	if (err instanceof EconomicApiError) {
		const code = (err.body as { errorCode?: unknown } | null)?.errorCode
		if (err.status === 403 && code === 'E02002') {
			return 'e-conomic says this agreement is read-only, so nothing can be saved. The public demo company is read-only. Use an agreement that allows writes.'
		}
		if (err.status === 401 || err.status === 403) {
			return 'e-conomic did not accept the tokens. Check that the app secret token is the one for this app and that the agreement grant token was made by the owner through the install link for this company.'
		}
		if (err.status === 404) return 'e-conomic does not know that address or record.'
		if (err.status === 429) return 'e-conomic says too many requests. Wait a minute and try again.'
		return err.message
	}
	return err instanceof Error ? err.message : 'Something went wrong'
}

export interface ToolOptions {
	/** Lists the draft and receipt tools. Off unless the server is started with it on. */
	writesEnabled?: boolean
}

const VOUCHER_DRAFT_SCHEMA = {
	type: 'object',
	properties: {
		journalNumber: {
			type: 'integer',
			minimum: 1,
			description: 'The journal to save the draft in.',
		},
		accountingYear: { type: 'string', pattern: '^\\d{4}$', description: 'For example "2025".' },
		date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Voucher date.' },
		text: { type: 'string', minLength: 1, maxLength: 250, description: 'What the entry is for.' },
		amount: { type: 'number', description: 'Amount including VAT, in the given currency.' },
		account: {
			type: 'integer',
			minimum: 1,
			description: 'Account number, for example the expense.',
		},
		contraAccount: {
			type: 'integer',
			minimum: 1,
			description: 'The other account, for example the bank or the supplier.',
		},
		currency: { type: 'string', pattern: '^[A-Z]{3}$', description: 'Defaults to DKK.' },
		vatCode: { type: 'string', maxLength: 10, description: 'Optional VAT code on the account.' },
	},
	required: [
		'journalNumber',
		'accountingYear',
		'date',
		'text',
		'amount',
		'account',
		'contraAccount',
	],
	additionalProperties: false,
}

const RECEIPT_SCHEMA = {
	type: 'object',
	properties: {
		journalNumber: { type: 'integer', minimum: 1 },
		accountingYear: { type: 'string', pattern: '^\\d{4}$' },
		voucherNumber: {
			type: 'integer',
			minimum: 1,
			description: 'The draft this receipt belongs to.',
		},
		filename: { type: 'string', minLength: 1, maxLength: 120 },
		mimeType: { type: 'string', enum: ['application/pdf', 'image/png', 'image/jpeg', 'image/gif'] },
		contentBase64: { type: 'string', description: 'The file, base64 encoded.' },
	},
	required: [
		'journalNumber',
		'accountingYear',
		'voucherNumber',
		'filename',
		'mimeType',
		'contentBase64',
	],
	additionalProperties: false,
}

function requireString(value: unknown, name: string, pattern?: RegExp): string {
	if (typeof value !== 'string' || value === '' || (pattern && !pattern.test(value))) {
		throw new Error(`${name} is missing or not in the expected form`)
	}
	return value
}

function requireNumber(value: unknown, name: string): number {
	if (typeof value !== 'number' || !Number.isFinite(value))
		throw new Error(`${name} must be a number`)
	return value
}

export function buildTools(
	credentials: Credentials | null,
	options: ToolOptions = {},
): ToolDefinition[] {
	const client = credentials ? new EconomicClient(credentials) : null
	const need = (): EconomicClient => {
		if (!client) {
			throw new Error(
				'No e-conomic tokens were sent. Add the app secret token as header X-AppSecretToken and the agreement grant token as header X-AgreementGrantToken on this tool server, using the saved credentials.',
			)
		}
		return client
	}

	const tools: ToolDefinition[] = [
		{
			name: 'economic_check_connection',
			description:
				'Check that the saved e-conomic tokens work. Run this first. Returns ok, or says what to fix.',
			inputSchema: { type: 'object', properties: {}, additionalProperties: false },
			handler: async () => {
				if (!client) return { ok: false, fix: explainMissing() }
				try {
					const root = (await client.get('')) as Record<string, unknown> | null
					const resources = root ? Object.keys(root).length : 0
					return { ok: true, resources }
				} catch (err) {
					return { ok: false, fix: explainFailure(err) }
				}
			},
		},
	]

	for (const res of RESOURCES) {
		tools.push({
			name: `economic_list_${res.plural}`,
			description: `List ${res.label} in e-conomic. Read only.`,
			inputSchema: listSchema,
			handler: async (args) => {
				const result = await need().collection(res.path, {
					filter: str(args.filter),
					sort: str(args.sort),
					pageSize: num(args.pageSize),
					maxItems: num(args.maxItems),
				})
				return { count: result.items.length, truncated: result.truncated, items: result.items }
			},
		})
		tools.push({
			name: `economic_get_${res.singular}`,
			description: `Get one ${res.singular.replace(/_/g, ' ')} in e-conomic by its number. Read only.`,
			inputSchema: {
				type: 'object',
				properties: { id: { type: ['string', 'integer'] } },
				required: ['id'],
				additionalProperties: false,
			},
			handler: async (args) => {
				const id = String(args.id ?? '')
				if (!/^[A-Za-z0-9_-]+$/.test(id))
					throw new Error('id may only hold letters, digits, - and _')
				return need().get(`${res.path}/${id}`)
			},
		})
	}

	tools.push({
		name: 'economic_get_collection',
		description:
			'Read any collection on the e-conomic API, for example "accounting-years/2025/entries" or "journals/1/vouchers". GET only, relative paths only.',
		inputSchema: {
			type: 'object',
			properties: { path: { type: 'string' }, ...listSchema.properties },
			required: ['path'],
			additionalProperties: false,
		},
		handler: async (args) => {
			const result = await need().collection(safePath(String(args.path ?? '')), {
				filter: str(args.filter),
				sort: str(args.sort),
				pageSize: num(args.pageSize),
				maxItems: num(args.maxItems),
			})
			return { count: result.items.length, truncated: result.truncated, items: result.items }
		},
	})

	if (options.writesEnabled) {
		tools.push(
			{
				name: 'economic_save_voucher_draft',
				description:
					"Save one entry as a draft in an e-conomic journal. It stays in the journal, not booked, until a person books the journal in e-conomic. Changes the owner's data, so it needs the owner's approval first.",
				inputSchema: VOUCHER_DRAFT_SCHEMA,
				handler: async (args) => {
					const journalNumber = requireNumber(args.journalNumber, 'journalNumber')
					const entry: Record<string, unknown> = {
						account: { accountNumber: requireNumber(args.account, 'account') },
						contraAccount: { accountNumber: requireNumber(args.contraAccount, 'contraAccount') },
						amount: requireNumber(args.amount, 'amount'),
						currency: { code: requireString(args.currency ?? 'DKK', 'currency', /^[A-Z]{3}$/) },
						date: requireString(args.date, 'date', /^\d{4}-\d{2}-\d{2}$/),
						text: requireString(args.text, 'text').slice(0, 250),
					}
					const vatCode = str(args.vatCode)
					if (vatCode) entry.vatAccount = { vatCode }
					const saved = await need().createVoucher(journalNumber, {
						accountingYear: {
							year: requireString(args.accountingYear, 'accountingYear', /^\d{4}$/),
						},
						journal: { journalNumber },
						entries: { financeVouchers: [entry] },
					})
					return { booked: false, saved }
				},
			},
			{
				name: 'economic_attach_receipt',
				description: `Attach one receipt file (PDF, PNG, JPEG or GIF, up to ${MAX_RECEIPT_BYTES / 1_000_000} MB) to a draft voucher that is still in the journal. Changes the owner's data, so it needs the owner's approval first.`,
				inputSchema: RECEIPT_SCHEMA,
				handler: async (args) => {
					const encoded = requireString(args.contentBase64, 'contentBase64', /^[A-Za-z0-9+/=\s]+$/)
					const bytes = Buffer.from(encoded, 'base64')
					const attached = await need().attachReceipt(
						requireNumber(args.journalNumber, 'journalNumber'),
						requireString(args.accountingYear, 'accountingYear'),
						requireNumber(args.voucherNumber, 'voucherNumber'),
						{
							filename: requireString(args.filename, 'filename')
								.replace(/[^\w.\- ]/g, '_')
								.slice(0, 120),
							mimeType: requireString(args.mimeType, 'mimeType'),
							bytes,
						},
					)
					return { booked: false, attached }
				},
			},
		)
	}

	return tools
}

export function explainMissing(): string {
	return 'No e-conomic tokens were sent. Save the app secret token and the agreement grant token as credentials and send them as headers X-AppSecretToken and X-AgreementGrantToken.'
}
