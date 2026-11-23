import { describe, expect, it, vi } from 'vitest'
import {
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
	it('lists four write tools, each asking for the organization, the invoice and a timestamp', () => {
		expect(DINERO_BRIDGE_TOOL_NAMES).toEqual([
			'send_invoice_email',
			'add_invoice_reminder',
			'book_invoice_reminder',
			'send_invoice_reminder_email',
		])
		for (const tool of DINERO_BRIDGE_TOOLS) {
			const schema = tool.inputSchema as { required: string[] }
			expect(schema.required).toEqual(expect.arrayContaining(['organizationId', 'timestamp']))
		}
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
})
