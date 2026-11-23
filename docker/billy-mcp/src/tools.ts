/**
 * The tool list. Reads, one draft bill, one receipt upload. Nothing here approves, voids,
 * updates, deletes or pays: BillyClient has no such call.
 */

import { BillyApiError, BillyClient, type Credentials } from './client.js'

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
	key: string
	label: string
}

const RESOURCES: Resource[] = [
	{ singular: 'account', plural: 'accounts', path: 'accounts', key: 'accounts', label: 'accounts' },
	{ singular: 'contact', plural: 'contacts', path: 'contacts', key: 'contacts', label: 'contacts' },
	{
		singular: 'tax_rate',
		plural: 'tax_rates',
		path: 'taxRates',
		key: 'taxRates',
		label: 'tax rates',
	},
	{ singular: 'bill', plural: 'bills', path: 'bills', key: 'bills', label: 'bills' },
]

const listSchema = {
	type: 'object',
	properties: {
		pageSize: { type: 'integer', minimum: 1, maximum: 1000 },
		maxItems: { type: 'integer', minimum: 1, maximum: 5000 },
	},
	additionalProperties: false,
}

const MISSING =
	'No Billy access token was sent. Save the token (Billy, Settings, Access tokens) as a credential and send it as header X-Access-Token on this tool server.'

const ID = /^[A-Za-z0-9_-]+$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

function num(value: unknown): number | undefined {
	return typeof value === 'number' ? value : undefined
}

function id(value: unknown, what: string): string {
	const text = String(value ?? '')
	if (!ID.test(text)) throw new Error(`${what} may only hold letters, digits, - and _`)
	return text
}

/** Says what to fix, in plain words, for the first run. */
export function explainFailure(err: unknown): string {
	if (err instanceof BillyApiError) {
		if (err.status === 401 || err.status === 403) {
			return 'Billy did not accept the token. Make a new access token in Billy under Settings, Access tokens, for this company, and save it again.'
		}
		if (err.status === 404) return 'Billy does not know that address or record.'
		if (err.status === 429) return 'Billy says too many requests. Wait a minute and try again.'
		return err.message
	}
	return err instanceof Error ? err.message : 'Something went wrong'
}

/** Keeps only the bill fields we allow, so nothing else (like a state) can slip through. */
export function pickBill(args: Record<string, unknown>, organizationId: string) {
	const contactId = id(args.contactId, 'contactId')
	const entryDate = String(args.entryDate ?? '')
	if (!DATE.test(entryDate)) throw new Error('entryDate must look like 2026-01-31')
	const lines = Array.isArray(args.lines) ? args.lines : []
	if (lines.length === 0) throw new Error('A bill needs at least one line')
	if (lines.length > 50) throw new Error('A bill can have at most 50 lines')
	const bill: Record<string, unknown> = {
		organizationId,
		contactId,
		entryDate,
		lines: lines.map((raw, i) => {
			const line = (raw ?? {}) as Record<string, unknown>
			const amount = num(line.amount)
			if (amount === undefined) throw new Error(`Line ${i + 1} needs a numeric amount`)
			const out: Record<string, unknown> = {
				accountId: id(line.accountId, `Line ${i + 1} accountId`),
				amount,
				description: String(line.description ?? '').slice(0, 500),
			}
			if (line.taxRateId !== undefined)
				out.taxRateId = id(line.taxRateId, `Line ${i + 1} taxRateId`)
			return out
		}),
	}
	if (args.paymentDate !== undefined) {
		const paymentDate = String(args.paymentDate)
		if (!DATE.test(paymentDate)) throw new Error('paymentDate must look like 2026-01-31')
		bill.paymentDate = paymentDate
	}
	if (args.currencyId !== undefined) bill.currencyId = String(args.currencyId).slice(0, 3)
	if (args.voucherNo !== undefined) bill.voucherNo = String(args.voucherNo).slice(0, 50)
	return bill
}

export function buildTools(credentials: Credentials | null): ToolDefinition[] {
	const client = credentials ? new BillyClient(credentials) : null
	const need = (): BillyClient => {
		if (!client) throw new Error(MISSING)
		return client
	}
	const organizationId = async (): Promise<string> => {
		const data = (await need().get('organization')) as { organization?: { id?: string } } | null
		const found = data?.organization?.id
		if (!found) throw new Error('Billy did not say which company this token belongs to')
		return found
	}

	const tools: ToolDefinition[] = [
		{
			name: 'billy_check_connection',
			description:
				'Check that the saved Billy token works. Run this first. Returns ok and the company name, or says what to fix.',
			inputSchema: { type: 'object', properties: {}, additionalProperties: false },
			handler: async () => {
				if (!client) return { ok: false, fix: MISSING }
				try {
					const data = (await client.get('organization')) as {
						organization?: { name?: string }
					} | null
					return { ok: true, company: data?.organization?.name ?? null }
				} catch (err) {
					return { ok: false, fix: explainFailure(err) }
				}
			},
		},
		{
			name: 'billy_get_organization',
			description: 'Get the Billy company the token belongs to. Read only.',
			inputSchema: { type: 'object', properties: {}, additionalProperties: false },
			handler: () => need().get('organization'),
		},
	]

	for (const res of RESOURCES) {
		tools.push({
			name: `billy_list_${res.plural}`,
			description: `List ${res.label} in Billy. Read only.`,
			inputSchema: listSchema,
			handler: async (args) => {
				const result = await need().collection(res.path, res.key, {
					pageSize: num(args.pageSize),
					maxItems: num(args.maxItems),
				})
				return { count: result.items.length, truncated: result.truncated, items: result.items }
			},
		})
		tools.push({
			name: `billy_get_${res.singular}`,
			description: `Get one ${res.singular.replace(/_/g, ' ')} in Billy by its id. Read only.`,
			inputSchema: {
				type: 'object',
				properties: { id: { type: 'string' } },
				required: ['id'],
				additionalProperties: false,
			},
			handler: (args) => need().get(`${res.path}/${id(args.id, 'id')}`),
		})
	}

	tools.push({
		name: 'billy_save_draft_bill',
		description:
			'Save one bill in Billy as a DRAFT. It is never approved: an owner approves it in Billy. Needs a supplier contactId, an entryDate and at least one line with accountId and amount.',
		inputSchema: {
			type: 'object',
			properties: {
				contactId: { type: 'string' },
				entryDate: { type: 'string', description: 'YYYY-MM-DD' },
				paymentDate: { type: 'string', description: 'YYYY-MM-DD, optional' },
				currencyId: { type: 'string', description: 'Three letters, for example DKK, optional' },
				voucherNo: { type: 'string' },
				lines: {
					type: 'array',
					minItems: 1,
					maxItems: 50,
					items: {
						type: 'object',
						properties: {
							accountId: { type: 'string' },
							amount: { type: 'number' },
							description: { type: 'string' },
							taxRateId: { type: 'string' },
						},
						required: ['accountId', 'amount'],
						additionalProperties: false,
					},
				},
			},
			required: ['contactId', 'entryDate', 'lines'],
			additionalProperties: false,
		},
		handler: async (args) => {
			const c = need()
			const bill = pickBill(args, await organizationId())
			return c.createDraftBill(bill)
		},
	})

	tools.push({
		name: 'billy_attach_receipt',
		description:
			'Upload a receipt (PDF or image, up to 10 MB, sent as base64) and attach it to an existing bill. Does not change the bill itself.',
		inputSchema: {
			type: 'object',
			properties: {
				billId: { type: 'string' },
				fileName: { type: 'string' },
				contentType: { type: 'string', enum: ['application/pdf', 'image/jpeg', 'image/png'] },
				contentBase64: { type: 'string' },
			},
			required: ['billId', 'fileName', 'contentType', 'contentBase64'],
			additionalProperties: false,
		},
		handler: async (args) => {
			const c = need()
			const billId = id(args.billId, 'billId')
			const contentType = String(args.contentType ?? '')
			if (!['application/pdf', 'image/jpeg', 'image/png'].includes(contentType)) {
				throw new Error('contentType must be application/pdf, image/jpeg or image/png')
			}
			const fileName = String(args.fileName ?? '').slice(0, 120)
			if (!fileName) throw new Error('fileName is needed')
			const bytes = Buffer.from(String(args.contentBase64 ?? ''), 'base64')
			const uploaded = (await c.uploadFile(
				fileName,
				contentType,
				bytes,
				await organizationId(),
			)) as { files?: { id?: string }[] } | null
			const fileId = uploaded?.files?.[0]?.id
			if (!fileId) throw new Error('Billy did not return the stored file')
			const attached = await c.attachFileToBill(billId, fileId)
			return { fileId, attached }
		},
	})

	return tools
}
