import { describe, expect, it } from 'vitest'
import {
	approvalSubject,
	bookedByCall,
	callDineroAsOwner,
	counterPostingArguments,
	isIsoDate,
} from '../../../../lib/integrations/providers/dinero/review'
import { hashFigures } from '../../../../lib/owner-approval'

const voucher = {
	organizationId: 7,
	date: '2026-11-10',
	book: true,
	lines: [
		{
			amount: 4000,
			description: 'Group entry',
			accountNumber: 1000,
			balancingAccountNumber: 55000,
		},
		{
			amount: -250.5,
			description: 'Fee',
			accountNumber: 7000,
			balancingAccountNumber: 1000,
			accountVatCode: 'I25',
		},
	],
}

describe('Dinero review: what counts as booked', () => {
	it('counts a booked finance voucher and BookVoucher, only when Dinero said yes', () => {
		expect(bookedByCall('CreateFinanceVoucher', voucher, 'success')).toBe(true)
		expect(bookedByCall('CreateFinanceVoucher', { ...voucher, book: false }, 'success')).toBe(false)
		expect(bookedByCall('CreateFinanceVoucher', voucher, 'error')).toBe(false)
		expect(bookedByCall('BookVoucher', {}, 'success')).toBe(true)
		expect(bookedByCall('CreatePurchaseVoucher', {}, 'success')).toBe(false)
	})
})

describe('Dinero review: the counter-posting', () => {
	it('turns every amount, keeps accounts and VAT, books in one call on the voucher date', () => {
		const plan = counterPostingArguments('CreateFinanceVoucher', voucher, 42)
		expect(plan.ok).toBe(true)
		if (!plan.ok) return
		expect(plan.args).toMatchObject({ organizationId: 7, date: '2026-11-10', book: true })
		const lines = plan.args.lines as Array<Record<string, unknown>>
		expect(lines.map((l) => l.amount)).toEqual([-4000, 250.5])
		expect(lines[1]).toMatchObject({
			accountNumber: 7000,
			balancingAccountNumber: 1000,
			accountVatCode: 'I25',
		})
		// A second click returns the first counter-posting instead of making another.
		expect(plan.args.idempotencyKey).toBe('maskin-reverse-42')
		expect(voucher.lines[0]?.amount).toBe(4000)
	})

	it('says plainly when there is no one-click reversal', () => {
		const book = counterPostingArguments('BookVoucher', {}, 1)
		expect(book.ok).toBe(false)
		expect(!book.ok && book.reason).toMatch(/credit note/)
		expect(counterPostingArguments('CreateFinanceVoucher', { ...voucher, lines: [] }, 1).ok).toBe(
			false,
		)
		expect(
			counterPostingArguments('CreateFinanceVoucher', { ...voucher, date: undefined }, 1).ok,
		).toBe(false)
		expect(counterPostingArguments('CreateFinanceVoucher', null, 1).ok).toBe(false)
		expect(
			counterPostingArguments('CreateFinanceVoucher', { ...voucher, lines: [{ amount: 'x' }] }, 1)
				.ok,
		).toBe(false)
	})
})

describe('Dinero review: figures hash and subject', () => {
	it('gives equal hashes for equal figures whatever the key order, and differs when a figure moves', () => {
		expect(hashFigures({ a: 1, b: [{ c: 2, d: 3 }] })).toBe(
			hashFigures({ b: [{ d: 3, c: 2 }], a: 1 }),
		)
		expect(hashFigures({ a: 1 })).not.toBe(hashFigures({ a: 2 }))
	})

	it('checks dates and builds the subject the lock reads back', () => {
		expect(isIsoDate('2026-11-30')).toBe(true)
		expect(isIsoDate('2026-13-40')).toBe(false)
		expect(isIsoDate('30-11-2026')).toBe(false)
		expect(
			approvalSubject('11111111-1111-1111-1111-111111111111', '2026-11-01', '2026-11-30'),
		).toBe('dinero:11111111-1111-1111-1111-111111111111:2026-11-01:2026-11-30')
	})
})

describe('Dinero review: calling Dinero as the owner', () => {
	const sse = (id: number, text: string, isError = false) =>
		`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id, result: { isError, content: [{ type: 'text', text }] } })}\n\n`

	it('initializes, then calls the tool with the owner token, and reads the answer', async () => {
		const calls: Array<{
			headers: Record<string, string>
			body: { method?: string; params?: unknown }
		}> = []
		const fetchImpl = (async (_url: string, init: RequestInit) => {
			const body = JSON.parse(init.body as string)
			calls.push({ headers: init.headers as Record<string, string>, body })
			if (body.method === 'initialize') {
				return new Response(sse(1, 'ok'), { status: 200, headers: { 'mcp-session-id': 'sess-1' } })
			}
			if (body.method === 'tools/call')
				return new Response(sse(2, 'Voucher 12 booked'), { status: 200 })
			return new Response('', { status: 202 })
		}) as unknown as typeof fetch
		const out = await callDineroAsOwner('tok', 'CreateFinanceVoucher', { book: true }, fetchImpl)
		expect(out).toEqual({ ok: true, text: 'Voucher 12 booked' })
		expect(calls.map((c) => c.body.method)).toEqual([
			'initialize',
			'notifications/initialized',
			'tools/call',
		])
		expect(calls[2]?.headers.authorization).toBe('Bearer tok')
		expect(calls[2]?.headers['mcp-session-id']).toBe('sess-1')
	})

	it('reports Dinero refusing, with its words', async () => {
		const fetchImpl = (async (_url: string, init: RequestInit) => {
			const body = JSON.parse(init.body as string)
			if (body.method === 'tools/call')
				return new Response(sse(2, 'Voucher is out of balance', true), { status: 200 })
			return new Response(sse(1, 'ok'), { status: 200 })
		}) as unknown as typeof fetch
		const out = await callDineroAsOwner('tok', 'CreateFinanceVoucher', {}, fetchImpl)
		expect(out).toEqual({ ok: false, text: 'Voucher is out of balance' })
	})
})
