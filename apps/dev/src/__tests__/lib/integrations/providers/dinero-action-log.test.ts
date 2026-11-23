import { describe, expect, it } from 'vitest'
import {
	DINERO_LOGGED_TOOLS,
	dineroCallRefusal,
	toolAnswerText,
} from '../../../../lib/integrations/providers/dinero/action-log'
import { DINERO_WITH_BOOKING_TOOLS } from '../../../../lib/integrations/providers/dinero/allowed-tools'

describe('Dinero action log', () => {
	it('logs every tool that changes something and that an agent may call', () => {
		for (const tool of DINERO_LOGGED_TOOLS) expect(DINERO_WITH_BOOKING_TOOLS).toContain(tool)
		expect([...DINERO_LOGGED_TOOLS].sort()).toEqual([
			'BookVoucher',
			'CreatePurchaseVoucher',
			'add_invoice_payment',
			'add_purchase_payment',
			'upload_file',
		])
	})

	it('needs the version stamp on a booking or payment, and on nothing else', () => {
		for (const tool of ['BookVoucher', 'add_purchase_payment', 'add_invoice_payment']) {
			expect(dineroCallRefusal(tool, {})).toContain('needs the timestamp')
			expect(dineroCallRefusal(tool, { timestamp: null })).toContain('needs the timestamp')
			expect(dineroCallRefusal(tool, { timestamp: '  ' })).toContain('needs the timestamp')
			expect(dineroCallRefusal(tool, undefined)).toContain('needs the timestamp')
			expect(dineroCallRefusal(tool, { timestamp: '2026-11-23T10:00:00Z' })).toBeNull()
		}
		expect(dineroCallRefusal('CreatePurchaseVoucher', {})).toBeNull()
		expect(dineroCallRefusal('list_vouchers', {})).toBeNull()
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
})
