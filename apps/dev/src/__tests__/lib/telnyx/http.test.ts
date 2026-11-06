import { describe, expect, it, vi } from 'vitest'
import { TelnyxHttpError, telnyxFetch } from '../../../lib/integrations/providers/telnyx/http'

const res = (status: number, body = '{}') => new Response(body, { status })
const base = { method: 'POST', sleep: async () => {}, random: () => 0.5 }

describe('telnyxFetch', () => {
	it('returns a 2xx response on the first attempt and sends the idempotency key', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(res(200))
		await telnyxFetch('https://x/v2/calls', { ...base, fetchImpl, idempotencyKey: 'c1:1' })
		expect(fetchImpl).toHaveBeenCalledTimes(1)
		expect((fetchImpl.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject({
			'Idempotency-Key': 'c1:1',
		})
	})

	it('retries a 5xx and succeeds on the third attempt', async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(res(503))
			.mockResolvedValueOnce(res(502))
			.mockResolvedValueOnce(res(200))
		const onDeadLetter = vi.fn()
		const out = await telnyxFetch('https://x', { ...base, fetchImpl, onDeadLetter })
		expect(out.status).toBe(200)
		expect(fetchImpl).toHaveBeenCalledTimes(3)
		expect(onDeadLetter).not.toHaveBeenCalled()
	})

	it('surfaces a 4xx immediately: no retry, no dead letter', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(res(422, '{"errors":[]}'))
		const onDeadLetter = vi.fn()
		await expect(
			telnyxFetch('https://x', { ...base, fetchImpl, onDeadLetter }),
		).rejects.toMatchObject({
			name: 'TelnyxHttpError',
			status: 422,
		})
		expect(fetchImpl).toHaveBeenCalledTimes(1)
		expect(onDeadLetter).not.toHaveBeenCalled()
	})

	it('dead-letters after three failed attempts on 5xx', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(res(500))
		const onDeadLetter = vi.fn()
		await expect(
			telnyxFetch('https://x/v2/calls', {
				...base,
				fetchImpl,
				onDeadLetter,
				idempotencyKey: 'c1:2',
			}),
		).rejects.toBeInstanceOf(TelnyxHttpError)
		expect(fetchImpl).toHaveBeenCalledTimes(3)
		expect(onDeadLetter).toHaveBeenCalledTimes(1)
		expect(onDeadLetter).toHaveBeenCalledWith(
			expect.objectContaining({ attempts: 3, status: 500, idempotencyKey: 'c1:2' }),
		)
	})

	it('retries connect timeouts and dead-letters when they persist', async () => {
		const timeout = Object.assign(new Error('connect timeout'), { name: 'TimeoutError' })
		const fetchImpl = vi.fn().mockRejectedValue(timeout)
		const onDeadLetter = vi.fn()
		await expect(
			telnyxFetch('https://x', { ...base, fetchImpl, onDeadLetter }),
		).rejects.toBeInstanceOf(TelnyxHttpError)
		expect(fetchImpl).toHaveBeenCalledTimes(3)
		expect(onDeadLetter).toHaveBeenCalledWith(expect.objectContaining({ status: null }))
	})

	it('does not retry other network errors', async () => {
		const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
		await expect(telnyxFetch('https://x', { ...base, fetchImpl })).rejects.toThrow('ECONNREFUSED')
		expect(fetchImpl).toHaveBeenCalledTimes(1)
	})

	it('backs off exponentially with jitter between attempts', async () => {
		const sleeps: number[] = []
		const fetchImpl = vi.fn().mockResolvedValue(res(500))
		await telnyxFetch('https://x', {
			method: 'POST',
			fetchImpl,
			random: () => 0.5,
			sleep: async (ms) => {
				sleeps.push(ms)
			},
		}).catch(() => undefined)
		// 250 * 2^0 * 0.5, 250 * 2^1 * 0.5; no sleep after the last attempt.
		expect(sleeps).toEqual([125, 250])
	})

	it('still throws the original failure if the dead-letter handler itself throws', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(res(500))
		await expect(
			telnyxFetch('https://x', {
				...base,
				fetchImpl,
				onDeadLetter: () => {
					throw new Error('slack down')
				},
			}),
		).rejects.toBeInstanceOf(TelnyxHttpError)
	})
})
