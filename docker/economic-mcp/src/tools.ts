/**
 * The tool list. Read tools only: every tool here issues GET requests through
 * EconomicClient, which has no other method. The resource table is from
 * src/tools/typed.ts in available-dev/e-conomic-mcp at commit 164567c (MIT).
 */

import { type Credentials, EconomicApiError, EconomicClient, safePath } from './client.js'

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
		if (err.status === 401 || err.status === 403) {
			return 'e-conomic did not accept the tokens. Check that the app secret token is the one for this app and that the agreement grant token was made by the owner through the install link for this company.'
		}
		if (err.status === 404) return 'e-conomic does not know that address or record.'
		if (err.status === 429) return 'e-conomic says too many requests. Wait a minute and try again.'
		if (err.status === 0) return err.message
		const hint =
			err.body && typeof err.body === 'object'
				? str((err.body as Record<string, unknown>).message)
				: undefined
		return `${err.message}${hint ? `: ${hint}` : ''}`
	}
	return err instanceof Error ? err.message : 'Something went wrong'
}

export function buildTools(credentials: Credentials | null): ToolDefinition[] {
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

	return tools
}

export function explainMissing(): string {
	return 'No e-conomic tokens were sent. Save the app secret token and the agreement grant token as credentials and send them as headers X-AppSecretToken and X-AgreementGrantToken.'
}
