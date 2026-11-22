import type { Database } from '@maskin/db'
import type { StorageProvider } from '@maskin/storage'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../../../lib/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
const recordEvent = vi.hoisted(() => vi.fn(async (): Promise<void> => undefined))
vi.mock('../../../../../lib/events/record-event', () => ({ recordEvent }))

import type { AgentAccess } from '../../../../../lib/integrations/agent-access'
import { IntegrationAuthRevokedError } from '../../../../../lib/integrations/errors'
import {
	type DineroMcpContext,
	createDineroMcpServer,
	sniffReceiptType,
} from '../../../../../lib/integrations/providers/dinero/mcp-server'
import { gateMcpServer } from '../../../../../lib/integrations/tool-gate'
import { classifyTool } from '../../../../../lib/integrations/tool-kinds'

const TOKEN = 'dinero-access-token-do-not-leak'
const VOUCHER_GUID = '11111111-2222-4333-8444-555555555555'
const FILE_GUID = '99999999-2222-4333-8444-555555555555'
const FILE_ID = '77777777-2222-4333-8444-555555555555'

const READS = [
	'dinero_get_company',
	'dinero_get_purchase_voucher',
	'dinero_list_contacts',
	'dinero_list_entries',
	'dinero_list_purchase_accounts',
	'dinero_list_vat_types',
]
const WRITE = 'dinero_save_draft_purchase_voucher'

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status })
}

const draftVoucher = (status = 'Draft') => ({
	Guid: VOUCHER_GUID,
	Status: status,
	VoucherNumber: 7,
	VoucherDate: '2026-11-20',
	PurchaseType: 'cash',
	FileGuid: FILE_GUID,
	Lines: [{ Description: 'Printer paper', AccountNumber: 3010, AmountInclVatValue: 125 }],
	VoucherTotals: [{ Label: 'Total', Type: 'Total', Total: 125 }],
})

const PDF = Buffer.from('%PDF-1.7 test receipt')

/** A db whose one select returns the receipt file row. */
function dbWithFile(row: Record<string, unknown> | null): Database {
	return {
		select: () => ({ from: () => ({ where: () => ({ limit: async () => (row ? [row] : []) }) }) }),
	} as unknown as Database
}

const fileRow = { id: FILE_ID, name: 'receipt.pdf', sizeBytes: PDF.length, storageKey: 'k' }

async function connect(
	overrides: Partial<DineroMcpContext> = {},
	opts: { access?: AgentAccess; fetchImpl?: ReturnType<typeof vi.fn> } = {},
) {
	const fetchImpl =
		opts.fetchImpl ?? vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => json([]))
	const getAuth = vi.fn(async () => ({ token: TOKEN, organizationId: 42 }))
	const trackToolCalled = vi.fn(async () => undefined)
	const ctx: DineroMcpContext = {
		db: {} as Database,
		workspaceId: 'ws-1',
		actorId: 'agent-1',
		sessionId: 'sess-1',
		integrationId: 'int-1',
		getAuth,
		fetchImpl: fetchImpl as unknown as typeof fetch,
		trackToolCalled,
		...overrides,
	}
	const server = createDineroMcpServer(
		ctx,
		opts.access
			? (s) =>
					gateMcpServer(s, {
						db: ctx.db,
						workspaceId: ctx.workspaceId,
						actorId: ctx.actorId,
						integrationId: 'int-1',
						provider: 'dinero',
						providerLabel: 'Dinero',
						access: opts.access as AgentAccess,
					})
			: undefined,
	)
	const client = new Client({ name: 'c', version: '0.0.0' })
	const [a, b] = InMemoryTransport.createLinkedPair()
	await Promise.all([server.connect(a), client.connect(b)])
	return { client, fetchImpl, getAuth, trackToolCalled }
}

function payload(result: Awaited<ReturnType<Client['callTool']>>) {
	return JSON.parse((result.content as Array<{ text: string }>)[0].text)
}

const cashDraft = {
	purchase_type: 'cash',
	voucher_date: '2026-11-20',
	lines: [{ description: 'Printer paper', amount: 125, account_number: 3010 }],
	deposit_account_number: 55000,
	region_key: 'DK',
}

describe('Dinero MCP server', () => {
	it('has six read tools and one draft tool, and no tool that books, changes or deletes', async () => {
		const { client } = await connect()
		const { tools } = await client.listTools()
		const names = tools.map((t) => t.name).sort()
		expect(names).toEqual([...READS, WRITE].sort())
		for (const name of names) expect(name).not.toMatch(/book|update|delete|remove|edit|pay/)
		for (const name of READS) expect(classifyTool('dinero', name, undefined)).toBe('read')
		expect(classifyTool('dinero', WRITE, undefined)).toBe('write')
	})

	it('names the company with the bearer token, and the token is not in the answer', async () => {
		const fetchImpl = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
			json([{ Id: 42, Name: 'Test ApS', VatNumber: '12345678', CountryKey: 'DK' }]),
		)
		const { client, getAuth } = await connect({}, { fetchImpl })
		const res = await client.callTool({ name: 'dinero_get_company', arguments: {} })
		const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
		expect(url).toBe('https://api.dinero.dk/v1.1/organizations')
		expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`)
		expect(getAuth).toHaveBeenCalledOnce()
		expect(payload(res).companies[0]).toMatchObject({ organization_id: 42, name: 'Test ApS' })
		expect(JSON.stringify(res)).not.toContain(TOKEN)
	})

	it('lists purchase accounts for the connected company only, hiding hidden ones', async () => {
		const fetchImpl = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
			json([
				{ AccountNumber: 3010, Name: 'Kontor', VatCode: 'I25', IsHidden: false },
				{ AccountNumber: 3020, Name: 'Skjult', IsHidden: true },
			]),
		)
		const { client } = await connect({}, { fetchImpl })
		const res = await client.callTool({ name: 'dinero_list_purchase_accounts', arguments: {} })
		expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://api.dinero.dk/v1/42/accounts/purchase')
		expect(payload(res).items).toEqual([
			{ account_number: 3010, name: 'Kontor', vat_code: 'I25', category: null },
		])
	})

	it('refuses reversed dates without calling Dinero', async () => {
		const { client, fetchImpl } = await connect()
		const res = await client.callTool({
			name: 'dinero_list_entries',
			arguments: { from_date: '2026-02-01', to_date: '2026-01-01' },
		})
		expect(res.isError).toBe(true)
		expect(payload(res).error.code).toBe('INVALID_INPUT')
		expect(fetchImpl).not.toHaveBeenCalled()
	})

	it('answers NOT_CONNECTED without calling Dinero when there is no integration', async () => {
		const { client, fetchImpl, trackToolCalled } = await connect({ integrationId: null })
		const res = await client.callTool({ name: 'dinero_list_vat_types', arguments: {} })
		expect(payload(res).error.code).toBe('NOT_CONNECTED')
		expect(fetchImpl).not.toHaveBeenCalled()
		expect(trackToolCalled).toHaveBeenCalledWith(
			expect.objectContaining({ outcome: 'error', errorCode: 'NOT_CONNECTED' }),
		)
	})

	it('says needs attention when the connection is revoked', async () => {
		const getAuth = vi.fn(async () => {
			throw new IntegrationAuthRevokedError('int-1', 'revoked')
		})
		const { client, fetchImpl } = await connect({ getAuth })
		const res = await client.callTool({ name: 'dinero_list_vat_types', arguments: {} })
		expect(payload(res).error.code).toBe('NEEDS_ATTENTION')
		expect(fetchImpl).not.toHaveBeenCalled()
	})

	it.each([
		[401, 'NEEDS_ATTENTION'],
		[403, 'NOT_ALLOWED'],
		[404, 'NOT_FOUND'],
		[429, 'RATE_LIMITED'],
		[503, 'TEMPORARILY_UNAVAILABLE'],
	])('maps a Dinero %i to %s', async (status, code) => {
		const fetchImpl = vi.fn(async () => json({ message: 'x' }, status))
		const { client } = await connect({}, { fetchImpl })
		const res = await client.callTool({ name: 'dinero_list_vat_types', arguments: {} })
		expect(res.isError).toBe(true)
		expect(payload(res).error.code).toBe(code)
	})

	it('reports only each event outcome, never arguments or rows', async () => {
		const { client, trackToolCalled } = await connect()
		await client.callTool({ name: 'dinero_list_vat_types', arguments: {} })
		expect(trackToolCalled).toHaveBeenCalledWith({
			provider: 'dinero',
			tool: 'dinero_list_vat_types',
			outcome: 'success',
			errorCode: null,
			actorId: 'agent-1',
			sessionId: 'sess-1',
			workspaceId: 'ws-1',
		})
	})
})

describe('dinero_save_draft_purchase_voucher', () => {
	it('saves one draft through the draft endpoint and says it is not booked', async () => {
		const fetchImpl = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
			json(draftVoucher()),
		)
		const { client } = await connect({}, { fetchImpl })
		const res = await client.callTool({ name: WRITE, arguments: cashDraft })

		expect(fetchImpl).toHaveBeenCalledOnce()
		const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
		expect(url).toBe('https://api.dinero.dk/v1.2/42/vouchers/purchase')
		expect(init.method).toBe('POST')
		expect(JSON.parse(String(init.body))).toEqual({
			PurchaseType: 'cash',
			VoucherDate: '2026-11-20',
			Lines: [{ Description: 'Printer paper', Amount: 125, AccountNumber: 3010 }],
			DepositAccountNumber: 55000,
			RegionKey: 'DK',
		})
		expect(res.isError).toBeUndefined()
		expect(payload(res)).toMatchObject({
			voucher_guid: VOUCHER_GUID,
			status: 'Draft',
			is_draft: true,
		})
		expect(JSON.stringify(res)).not.toContain(TOKEN)
	})

	it('uploads the receipt first and attaches it to the draft', async () => {
		const fetchImpl = vi.fn(async (url: string | URL | Request, _i?: RequestInit) =>
			String(url).endsWith('/files') ? json({ FileGuid: FILE_GUID }) : json(draftVoucher()),
		)
		const storage = { get: vi.fn(async () => PDF) } as unknown as StorageProvider
		const { client } = await connect({ db: dbWithFile(fileRow), storage }, { fetchImpl })
		const res = await client.callTool({
			name: WRITE,
			arguments: { ...cashDraft, file_id: FILE_ID },
		})

		expect(fetchImpl).toHaveBeenCalledTimes(2)
		const [uploadUrl, uploadInit] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
		expect(uploadUrl).toBe('https://api.dinero.dk/v1/42/files')
		expect(uploadInit.body).toBeInstanceOf(FormData)
		const created = JSON.parse(
			String((fetchImpl.mock.calls[1] as unknown as [string, RequestInit])[1].body),
		)
		expect(created.FileGuid).toBe(FILE_GUID)
		expect(payload(res).is_draft).toBe(true)
	})

	it('refuses a receipt that is not a PDF, PNG or JPEG before asking Dinero for anything', async () => {
		const storage = {
			get: vi.fn(async () => Buffer.from('plain text')),
		} as unknown as StorageProvider
		const { client, fetchImpl, getAuth } = await connect({ db: dbWithFile(fileRow), storage })
		const res = await client.callTool({
			name: WRITE,
			arguments: { ...cashDraft, file_id: FILE_ID },
		})
		expect(payload(res).error.code).toBe('INVALID_INPUT')
		expect(fetchImpl).not.toHaveBeenCalled()
		expect(getAuth).not.toHaveBeenCalled()
	})

	it('refuses a file that is not in this workspace', async () => {
		const { client, fetchImpl } = await connect({ db: dbWithFile(null) })
		const res = await client.callTool({
			name: WRITE,
			arguments: { ...cashDraft, file_id: FILE_ID },
		})
		expect(payload(res).error.code).toBe('INVALID_INPUT')
		expect(fetchImpl).not.toHaveBeenCalled()
	})

	it('refuses fields that belong to the other purchase type', async () => {
		const { client, fetchImpl } = await connect()
		const res = await client.callTool({
			name: WRITE,
			arguments: { ...cashDraft, contact_guid: VOUCHER_GUID },
		})
		expect(payload(res).error.code).toBe('INVALID_INPUT')
		expect(payload(res).error.message).toContain('contact_guid')
		expect(fetchImpl).not.toHaveBeenCalled()
	})

	it('stops and says so when Dinero reports anything but Draft', async () => {
		const fetchImpl = vi.fn(async () => json(draftVoucher('Paid')))
		const { client, trackToolCalled } = await connect({}, { fetchImpl })
		const res = await client.callTool({ name: WRITE, arguments: cashDraft })
		expect(res.isError).toBe(true)
		expect(payload(res).error.code).toBe('NOT_A_DRAFT')
		expect(trackToolCalled).toHaveBeenCalledWith(
			expect.objectContaining({ outcome: 'error', errorCode: 'NOT_A_DRAFT' }),
		)
	})

	it("hands back Dinero's own reason for a refused voucher", async () => {
		const fetchImpl = vi.fn(async () =>
			json(
				{
					message: 'Validation failed',
					validationErrors: [
						{ propertyName: 'Lines', message: 'Account 1 is not a purchase account' },
					],
				},
				400,
			),
		)
		const { client } = await connect({}, { fetchImpl })
		const res = await client.callTool({ name: WRITE, arguments: cashDraft })
		expect(payload(res).error.code).toBe('INVALID_INPUT')
		expect(payload(res).error.message).toContain('Lines: Account 1 is not a purchase account')
	})

	it('is refused for an agent held to Read, and Dinero is not called', async () => {
		const { client, fetchImpl, getAuth } = await connect({}, { access: 'read' })
		const res = await client.callTool({ name: WRITE, arguments: cashDraft })
		expect(res.isError).toBe(true)
		expect(JSON.stringify(res)).toContain('Access denied')
		expect(fetchImpl).not.toHaveBeenCalled()
		expect(getAuth).not.toHaveBeenCalled()
		// A Read agent can still read.
		const read = await client.callTool({ name: 'dinero_list_vat_types', arguments: {} })
		expect(read.isError).toBeUndefined()
	})

	it('is allowed for an agent with Read and write', async () => {
		const fetchImpl = vi.fn(async () => json(draftVoucher()))
		const { client } = await connect({}, { access: 'read_write', fetchImpl })
		const res = await client.callTool({ name: WRITE, arguments: cashDraft })
		expect(payload(res).is_draft).toBe(true)
	})
})

describe('sniffReceiptType', () => {
	it('reads the type from the first bytes, not the name', () => {
		expect(sniffReceiptType(PDF)).toBe('application/pdf')
		expect(sniffReceiptType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
		expect(sniffReceiptType(Buffer.from('MZ not a receipt'))).toBeNull()
	})
})
