import { describe, expect, it, vi } from 'vitest'
import { ApiError, isRetriable, withRetries } from '../retry'

const noSleep = () => Promise.resolve()

describe('isRetriable', () => {
	it('treats transient HTTP statuses as retriable', () => {
		for (const status of [408, 425, 429, 500, 502, 503, 504]) {
			const err = new ApiError(status, 'GET', '/x', '', '')
			expect(isRetriable(err), `expected ${status} retriable`).toBe(true)
		}
	})

	it('does not retry 4xx client errors (except the explicit transient ones)', () => {
		for (const status of [400, 401, 403, 404, 409, 422]) {
			const err = new ApiError(status, 'GET', '/x', '', '')
			expect(isRetriable(err), `expected ${status} non-retriable`).toBe(false)
		}
	})

	it('treats fetch network failures (TypeError) as retriable', () => {
		expect(isRetriable(new TypeError('fetch failed'))).toBe(true)
	})

	it('does not retry other Errors', () => {
		expect(isRetriable(new Error('boom'))).toBe(false)
		expect(isRetriable('not an error')).toBe(false)
	})
})

describe('withRetries', () => {
	it('returns the value on first success without sleeping', async () => {
		const op = vi.fn().mockResolvedValue('ok')
		const sleep = vi.fn(noSleep)
		const result = await withRetries(op, { label: 'test', sleep })
		expect(result).toBe('ok')
		expect(op).toHaveBeenCalledTimes(1)
		expect(sleep).not.toHaveBeenCalled()
	})

	it('retries on transient ApiError until success', async () => {
		const op = vi
			.fn()
			.mockRejectedValueOnce(new ApiError(503, 'GET', '/x', '', 'Service Unavailable'))
			.mockRejectedValueOnce(new ApiError(502, 'GET', '/x', '', 'Bad Gateway'))
			.mockResolvedValueOnce('ok')
		const sleep = vi.fn(noSleep)
		const onRetry = vi.fn()
		const result = await withRetries(op, {
			label: 'GET /x',
			retries: 3,
			baseDelayMs: 10,
			sleep,
			onRetry,
		})
		expect(result).toBe('ok')
		expect(op).toHaveBeenCalledTimes(3)
		expect(onRetry).toHaveBeenCalledTimes(2)
		// Exponential backoff: base * 2^attempt
		expect(sleep).toHaveBeenNthCalledWith(1, 10)
		expect(sleep).toHaveBeenNthCalledWith(2, 20)
	})

	it('retries on TypeError (network failure)', async () => {
		const op = vi
			.fn()
			.mockRejectedValueOnce(new TypeError('fetch failed'))
			.mockResolvedValueOnce('ok')
		const result = await withRetries(op, { label: 't', baseDelayMs: 1, sleep: noSleep })
		expect(result).toBe('ok')
		expect(op).toHaveBeenCalledTimes(2)
	})

	it('throws immediately on non-retriable errors without sleeping', async () => {
		const fatal = new ApiError(401, 'GET', '/x', '', 'Unauthorized')
		const op = vi.fn().mockRejectedValue(fatal)
		const sleep = vi.fn(noSleep)
		await expect(
			withRetries(op, { label: 'GET /x', retries: 5, baseDelayMs: 10, sleep }),
		).rejects.toBe(fatal)
		expect(op).toHaveBeenCalledTimes(1)
		expect(sleep).not.toHaveBeenCalled()
	})

	it('gives up after retries are exhausted and rethrows the last error', async () => {
		const last = new ApiError(503, 'GET', '/x', '', 'Service Unavailable')
		const op = vi.fn().mockRejectedValue(last)
		const sleep = vi.fn(noSleep)
		await expect(
			withRetries(op, { label: 'GET /x', retries: 2, baseDelayMs: 1, sleep }),
		).rejects.toBe(last)
		// retries=2 means 1 initial + 2 retries = 3 attempts
		expect(op).toHaveBeenCalledTimes(3)
		expect(sleep).toHaveBeenCalledTimes(2)
	})
})
