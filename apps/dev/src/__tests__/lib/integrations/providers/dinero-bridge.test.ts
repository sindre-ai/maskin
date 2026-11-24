import { describe, expect, it, vi } from 'vitest'
import {
	DINERO_BRIDGE_BOOKING_TOOLS,
	DINERO_BRIDGE_BOOKING_TOOL_NAMES,
	DINERO_BRIDGE_DRAFT_TOOL_NAMES,
	DINERO_BRIDGE_TOOLS,
	DINERO_BRIDGE_TOOL_NAMES,
	callDineroBridge,
	isDineroBridgeTool,
} from '../../../../lib/integrations/providers/dinero/bridge'

const ORG = '11111111-2222-3333-4444-555555555555'
const INVOICE = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const base = { organizationId: ORG, invoiceGuid: INVOICE, timestamp: '2026-11-23T10:00:00Z' }

const answering = (status: number, body: string) =>
	vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch

const lastCall = (f: typeof fetch) => {
	const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
		string,
		{ method: string; headers: Record<string, string>; body: string },
	]
	return { url, init, body: JSON.parse(init.body) as Record<string, unknown> }
}

describe('Dinero bridge tools', () => {
	it('lists four booking tools, each asking for the organization, the invoice and a timestamp', () => {
		expect(DINERO_BRIDGE_BOOKING_TOOL_NAMES).toEqual([
			'send_invoice_email',
			'add_invoice_reminder',
			'book_invoice_reminder',
			'send_invoice_reminder_email',
		])
		for (const tool of DINERO_BRIDGE_BOOKING_TOOLS) {
			const schema = tool.inputSchema as { required: string[] }
			expect(schema.required).toEqual(expect.arrayContaining(['organizationId', 'timestamp']))
		}
		expect(DINERO_BRIDGE_DRAFT_TOOL_NAMES).toEqual([
			'list_posted_entries',
			'update_purchase_voucher_draft',
			'delete_finance_voucher_draft',
		])
		expect(DINERO_BRIDGE_TOOL_NAMES).toEqual([
			...DINERO_BRIDGE_BOOKING_TOOL_NAMES,
			...DINERO_BRIDGE_DRAFT_TOOL_NAMES,
		])
		expect(DINERO_BRIDGE_TOOLS).toHaveLength(7)
		expect(isDineroBridgeTool('delete_finance_voucher_draft')).toBe(true)
		expect(isDineroBridgeTool('send_invoice_email')).toBe(true)
		expect(isDineroBridgeTool('list_vouchers')).toBe(false)
	})

	it('emails an invoice through the public API with the sign-in token', async () => {
		const f = answering(200, '{"ok":true}')
		const res = await callDineroBridge(
			'send_invoice_email',
			{ ...base, receiver: 'kunde@example.dk', subject: 'Faktura', ccToSender: true },
			'Bearer t0',
			f,
		)
		expect(res).toEqual({ isError: false, text: '{"ok":true}' })
		const { url, init, body } = lastCall(f)
		expect(url).toBe(`https://api.dinero.dk/v1/${ORG}/invoices/${INVOICE}/email`)
		expect(init.method).toBe('POST')
		expect(init.headers.Authorization).toBe('Bearer t0')
		expect(body).toMatchObject({
			Timestamp: base.timestamp,
			Receiver: 'kunde@example.dk',
			Subject: 'Faktura',
			CcToSender: true,
		})
	})

	it('adds, books and sends a reminder on the reminder paths', async () => {
		const add = answering(200, '{"Id":"r-1"}')
		await callDineroBridge(
			'add_invoice_reminder',
			{ ...base, date: '2026-11-24', title: 'Rykker', withFee: true },
			'Bearer t0',
			add,
		)
		expect(lastCall(add).url).toBe(`https://api.dinero.dk/v1/${ORG}/invoices/${INVOICE}/reminders`)
		expect(lastCall(add).body).toMatchObject({
			Date: '2026-11-24',
			Title: 'Rykker',
			WithFee: true,
			WithInterestFee: false,
			WithCompensationFee: false,
			WithDebtCollectionWarning: false,
		})

		const book = answering(200, '{}')
		await callDineroBridge(
			'book_invoice_reminder',
			{ ...base, reminderId: 'r-1', timestamp: 'rt' },
			'Bearer t0',
			book,
		)
		expect(lastCall(book).url).toBe(
			`https://api.dinero.dk/v1/${ORG}/invoices/${INVOICE}/reminders/r-1/book`,
		)
		expect(lastCall(book).body).toEqual({ Timestamp: 'rt' })

		const send = answering(200, '')
		const sent = await callDineroBridge('send_invoice_reminder_email', base, 'Bearer t0', send)
		expect(lastCall(send).url).toBe(
			`https://api.dinero.dk/v1/${ORG}/invoices/${INVOICE}/reminders/email`,
		)
		expect(sent.isError).toBe(false)
		expect(sent.text).toContain('HTTP 200')
	})

	it('refuses what is not a guid or a date before calling Dinero', async () => {
		const f = answering(200, '{}')
		for (const [tool, args] of [
			['send_invoice_email', { ...base, organizationId: '../x' }],
			['send_invoice_email', { ...base, invoiceGuid: 'abc/../../x' }],
			['add_invoice_reminder', { ...base, date: '24/11/2026' }],
			['book_invoice_reminder', { ...base, reminderId: '1/../2' }],
			['send_invoice_email', undefined],
			['create_invoice', base],
		] as const) {
			const res = await callDineroBridge(tool, args, 'Bearer t0', f)
			expect(res.isError).toBe(true)
			expect(res.text).toContain('Nothing was sent to Dinero')
		}
		expect(f).not.toHaveBeenCalled()
	})

	it('reports Dinero errors and an unreachable Dinero as errors the agent can read', async () => {
		const refused = await callDineroBridge(
			'send_invoice_email',
			base,
			'Bearer t0',
			answering(400, 'Invoice must be booked'),
		)
		expect(refused).toEqual({
			isError: true,
			text: 'Dinero refused send_invoice_email (HTTP 400): Invoice must be booked',
		})
		const down = await callDineroBridge('send_invoice_email', base, 'Bearer t0', (async () => {
			throw new Error('down')
		}) as unknown as typeof fetch)
		expect(down.isError).toBe(true)
		expect(down.text).toContain('could not be reached')
	})

	describe('the draft tools', () => {
		const VOUCHER = '99999999-8888-7777-6666-555555555555'
		const CONTACT = '12345678-1234-1234-1234-123456789012'
		const calls = (f: typeof fetch) =>
			(f as unknown as ReturnType<typeof vi.fn>).mock.calls as Array<
				[string, { method: string; body?: string }]
			>

		it('lists posted entries for a date range with a GET and no body', async () => {
			const f = answering(200, '[{"Amount":100}]')
			const res = await callDineroBridge(
				'list_posted_entries',
				{ organizationId: ORG, fromDate: '2026-01-01', toDate: '2026-03-31', includePrimo: false },
				'Bearer t0',
				f,
			)
			expect(res).toEqual({ isError: false, text: '[{"Amount":100}]' })
			const [url, init] = calls(f)[0]
			expect(url).toBe(
				`https://api.dinero.dk/v1/${ORG}/entries?fromDate=2026-01-01&toDate=2026-03-31&includePrimo=false`,
			)
			expect(init.method).toBe('GET')
			expect(init.body).toBeUndefined()
		})

		it('keeps a long list of entries, and says when it had to cut it', async () => {
			const long = 'x'.repeat(50_000)
			const res = await callDineroBridge(
				'list_posted_entries',
				{ organizationId: ORG, fromDate: '2026-01-01', toDate: '2026-03-31' },
				'Bearer t0',
				answering(200, long),
			)
			expect(res.isError).toBe(false)
			expect(res.text).toBe(long)
			const huge = await callDineroBridge(
				'list_posted_entries',
				{ organizationId: ORG, fromDate: '2026-01-01', toDate: '2026-03-31' },
				'Bearer t0',
				answering(200, 'x'.repeat(250_000)),
			)
			expect(huge.text).toContain('Ask for a shorter date range')
		})

		it('refuses a bad range before calling Dinero', async () => {
			const f = answering(200, '[]')
			for (const args of [
				{ organizationId: ORG, fromDate: '2026-01-01' },
				{ organizationId: ORG, fromDate: '1 Jan', toDate: '2026-03-31' },
				{ organizationId: ORG, fromDate: '2026-01-01', toDate: '2026-03-31&x=1' },
				{ organizationId: 'x', fromDate: '2026-01-01', toDate: '2026-03-31' },
			]) {
				const res = await callDineroBridge('list_posted_entries', args, 'Bearer t0', f)
				expect(res.isError).toBe(true)
				expect(res.text).toContain('Nothing was sent to Dinero')
			}
			expect(f).not.toHaveBeenCalled()
		})

		it('edits a purchase voucher draft on the draft route with the version stamp', async () => {
			const f = answering(200, '{"Timestamp":"t2"}')
			const res = await callDineroBridge(
				'update_purchase_voucher_draft',
				{
					organizationId: ORG,
					voucherGuid: VOUCHER,
					timestamp: 't1',
					voucherDate: '2026-11-20',
					purchaseType: 'cash',
					contactGuid: CONTACT,
					lines: [
						{ amount: 125, accountNumber: 2000, description: 'Kontorartikler', vatCode: 'I25' },
					],
					fileGuid: 'file1',
				},
				'Bearer t0',
				f,
			)
			expect(res.isError).toBe(false)
			const [url, init] = calls(f)[0]
			expect(url).toBe(`https://api.dinero.dk/v1.1/${ORG}/vouchers/purchase/${VOUCHER}`)
			expect(init.method).toBe('PUT')
			expect(JSON.parse(init.body as string)).toMatchObject({
				Timestamp: 't1',
				VoucherDate: '2026-11-20',
				PurchaseType: 'cash',
				ContactGuid: CONTACT,
				FileGuid: 'file1',
				Lines: [
					{ Amount: 125, AccountNumber: 2000, Description: 'Kontorartikler', VatCode: 'I25' },
				],
			})
			// Nothing in the request can book it.
			expect(Object.keys(JSON.parse(init.body as string)).join(' ')).not.toMatch(/book/i)
		})

		it('refuses a purchase voucher edit with a missing or wrong part before calling Dinero', async () => {
			const f = answering(200, '{}')
			const ok = {
				organizationId: ORG,
				voucherGuid: VOUCHER,
				timestamp: 't1',
				voucherDate: '2026-11-20',
				purchaseType: 'cash',
				contactGuid: CONTACT,
				lines: [{ amount: 1 }],
			}
			for (const bad of [
				{ voucherGuid: '../x' },
				{ voucherDate: '20/11/2026' },
				{ purchaseType: 'barter' },
				{ contactGuid: 'nope' },
				{ lines: [] },
				{ lines: [{ amount: '12' }] },
				{ paymentDate: 'soon' },
			]) {
				const res = await callDineroBridge(
					'update_purchase_voucher_draft',
					{ ...ok, ...bad },
					'Bearer t0',
					f,
				)
				expect(res.isError).toBe(true)
			}
			expect(f).not.toHaveBeenCalled()
		})

		it('deletes a finance voucher only after reading that it is a draft, with the stamp it read', async () => {
			const f = vi
				.fn()
				.mockResolvedValueOnce(
					new Response('{"Status":"Draft","Timestamp":"ts-9"}', { status: 200 }),
				)
				.mockResolvedValueOnce(new Response('', { status: 200 })) as unknown as typeof fetch
			const res = await callDineroBridge(
				'delete_finance_voucher_draft',
				{ organizationId: ORG, voucherGuid: VOUCHER, timestamp: 'agent-supplied' },
				'Bearer t0',
				f,
			)
			expect(res.isError).toBe(false)
			const [read, del] = calls(f)
			expect(read[0]).toBe(`https://api.dinero.dk/v1/${ORG}/vouchers/manuel/${VOUCHER}`)
			expect(read[1].method).toBe('GET')
			expect(del[0]).toBe(read[0])
			expect(del[1].method).toBe('DELETE')
			expect(JSON.parse(del[1].body as string)).toEqual({ Timestamp: 'ts-9' })
		})

		it('refuses to delete a voucher that is booked, being edited or unreadable, and deletes nothing', async () => {
			for (const answer of [
				'{"Status":"Booked","Timestamp":"ts-9"}',
				'{"Status":"Editing","Timestamp":"ts-9"}',
				'{"Status":"draft","Timestamp":"ts-9"}',
				'{"Timestamp":"ts-9"}',
				'{"Status":"Draft"}',
				'not json',
				'null',
			]) {
				const f = answering(200, answer)
				const res = await callDineroBridge(
					'delete_finance_voucher_draft',
					{ organizationId: ORG, voucherGuid: VOUCHER },
					'Bearer t0',
					f,
				)
				expect(res.isError).toBe(true)
				expect(res.text).toContain('nothing was deleted')
				expect(calls(f)).toHaveLength(1)
				expect(calls(f)[0][1].method).toBe('GET')
			}
		})

		it('does not delete when the read fails or Dinero cannot be reached', async () => {
			const notFound = answering(404, 'no such voucher')
			const res = await callDineroBridge(
				'delete_finance_voucher_draft',
				{ organizationId: ORG, voucherGuid: VOUCHER },
				'Bearer t0',
				notFound,
			)
			expect(res.isError).toBe(true)
			expect(calls(notFound)).toHaveLength(1)
			const down = await callDineroBridge(
				'delete_finance_voucher_draft',
				{ organizationId: ORG, voucherGuid: VOUCHER },
				'Bearer t0',
				(async () => {
					throw new Error('down')
				}) as unknown as typeof fetch,
			)
			expect(down.isError).toBe(true)
			expect(down.text).toContain('Nothing was deleted')
			const bad = await callDineroBridge(
				'delete_finance_voucher_draft',
				{ organizationId: ORG, voucherGuid: 'not-a-guid' },
				'Bearer t0',
				answering(200, '{}'),
			)
			expect(bad.text).toContain('Nothing was sent to Dinero')
		})
	})
})
