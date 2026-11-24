import type { Database } from '@maskin/db'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
	DINERO_LOGGED_TOOLS,
	dineroCallRefusal,
	loggedArguments,
	recordDineroAction,
	toolAnswerText,
} from '../../../../lib/integrations/providers/dinero/action-log'
import { DINERO_WITH_BOOKING_TOOLS } from '../../../../lib/integrations/providers/dinero/allowed-tools'

const { recordEvent } = vi.hoisted(() => ({ recordEvent: vi.fn() }))
vi.mock('../../../../lib/events/record-event', () => ({ recordEvent }))

beforeEach(() => recordEvent.mockReset())

describe('Dinero action log', () => {
	it('logs every tool that changes something and that an agent may call', () => {
		for (const tool of DINERO_LOGGED_TOOLS) expect(DINERO_WITH_BOOKING_TOOLS).toContain(tool)
		expect([...DINERO_LOGGED_TOOLS].sort()).toEqual([
			'BookVoucher',
			'CreateFinanceVoucher',
			'CreatePurchaseVoucher',
			'add_invoice_payment',
			'add_invoice_reminder',
			'add_purchase_payment',
			'book_invoice_reminder',
			'send_invoice_email',
			'send_invoice_reminder_email',
			'upload_file',
		])
	})

	it('needs the version stamp on a booking or payment, and on nothing else', () => {
		for (const tool of [
			'BookVoucher',
			'add_purchase_payment',
			'add_invoice_payment',
			'send_invoice_email',
			'add_invoice_reminder',
			'book_invoice_reminder',
			'send_invoice_reminder_email',
		]) {
			expect(dineroCallRefusal(tool, {})).toContain('needs the timestamp')
			expect(dineroCallRefusal(tool, { timestamp: null })).toContain('needs the timestamp')
			expect(dineroCallRefusal(tool, { timestamp: '  ' })).toContain('needs the timestamp')
			expect(dineroCallRefusal(tool, undefined)).toContain('needs the timestamp')
			expect(dineroCallRefusal(tool, { timestamp: '2026-11-23T10:00:00Z' })).toBeNull()
		}
		expect(dineroCallRefusal('CreatePurchaseVoucher', {})).toBeNull()
		expect(dineroCallRefusal('list_vouchers', {})).toBeNull()
	})

	it('lets CreateFinanceVoucher through only as a draft while booking is off', () => {
		const tool = 'CreateFinanceVoucher'
		expect(dineroCallRefusal(tool, { organizationId: 1, book: false })).toBeNull()
		expect(dineroCallRefusal(tool, { book: false, lines: [{ amount: 4000 }] })).toBeNull()
		for (const args of [
			undefined,
			null,
			{},
			{ organizationId: 1 },
			{ book: true },
			{ book: 'false' },
			{ book: 0 },
			{ book: null },
			{ Book: true, book: false },
			{ book: false, autoBook: true },
			{ book: false, voucher: { book: true } },
			{ book: false, lines: [{ bookNow: true }] },
		]) {
			expect(dineroCallRefusal(tool, args)).toContain('booking is off')
		}
		// With the owner's switch on, the arguments are the agent's to set.
		expect(dineroCallRefusal(tool, { book: true }, true)).toBeNull()
		expect(dineroCallRefusal(tool, {}, true)).toBeNull()
	})

	it('reads the text of the answer to one call, from plain JSON or an event stream', () => {
		const answer = {
			jsonrpc: '2.0',
			id: 7,
			result: { content: [{ type: 'text', text: 'booked' }] },
		}
		expect(toolAnswerText(JSON.stringify(answer), 7)).toBe('booked')
		expect(toolAnswerText(`event: message\ndata: ${JSON.stringify(answer)}\n\n`, 7)).toBe('booked')
		expect(toolAnswerText(JSON.stringify(answer), 8)).toBeNull()
		expect(toolAnswerText('not json {', 7)).toBeNull()
	})

	it('cuts a long answer', () => {
		const long = 'x'.repeat(10_000)
		const answer = { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: long }] } }
		expect(toolAnswerText(JSON.stringify(answer), 1)?.length).toBe(4000)
	})

	it('keeps the figures and replaces a long text argument by its size and a fingerprint', () => {
		const file = 'A'.repeat(3_000_000)
		const logged = loggedArguments({
			organizationId: 1,
			fileName: 'receipt.pdf',
			file,
			voucher: { amount: 125.5, note: 'Lunch' },
		}) as Record<string, unknown>
		expect(logged).toEqual({
			organizationId: 1,
			fileName: 'receipt.pdf',
			file: {
				omitted: 'file content',
				length: 3_000_000,
				sha256: expect.stringMatching(/^[0-9a-f]{16}$/),
			},
			voucher: { amount: 125.5, note: 'Lunch' },
		})
		expect(JSON.stringify(logged).length).toBeLessThan(500)
		expect(loggedArguments({ file: 'B'.repeat(3_000_000) })).not.toEqual(
			loggedArguments({ file: 'A'.repeat(3_000_000) }),
		)
		expect(loggedArguments(undefined)).toBeUndefined()
	})

	it('writes an upload to the log without the file', async () => {
		const answer = {
			jsonrpc: '2.0',
			id: 3,
			result: { content: [{ type: 'text', text: 'stored' }] },
		}
		await recordDineroAction({
			db: {} as Database,
			upstream: new Response(JSON.stringify(answer), { status: 200 }),
			requestId: 3,
			tool: 'upload_file',
			args: { organizationId: 1, fileName: 'receipt.pdf', file: 'A'.repeat(2_000_000) },
			booking: true,
			integrationId: 'i-1',
			workspaceId: 'w-1',
			actorId: 'a-1',
			sessionId: undefined,
		})
		expect(recordEvent).toHaveBeenCalledOnce()
		const data = recordEvent.mock.calls[0][1].data
		expect(data.arguments).toMatchObject({ fileName: 'receipt.pdf', file: { length: 2_000_000 } })
		expect(JSON.stringify(data).length).toBeLessThan(1000)
	})
})
