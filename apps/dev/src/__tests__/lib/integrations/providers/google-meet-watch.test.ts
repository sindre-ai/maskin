import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	isOperationName,
	resolveSubscription,
} from '../../../../lib/integrations/providers/google-meet/watch'

const subscription = {
	name: 'subscriptions/abc',
	targetResource: '//cloudidentity.googleapis.com/users/1',
	eventTypes: [],
	expireTime: '2026-11-02T00:00:00Z',
}
const noSleep = async () => {}

describe('resolveSubscription', () => {
	afterEach(() => vi.restoreAllMocks())

	it('returns a real subscription untouched', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch')
		await expect(resolveSubscription('t', subscription, noSleep)).resolves.toBe(subscription)
		expect(fetchSpy).not.toHaveBeenCalled()
	})

	it('unwraps a finished operation without polling', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch')
		const op = { name: 'operations/xyz', done: true, response: subscription }
		await expect(resolveSubscription('t', op, noSleep)).resolves.toBe(subscription)
		expect(fetchSpy).not.toHaveBeenCalled()
	})

	it('polls an unfinished operation until it has the subscription', async () => {
		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(Response.json({ name: 'operations/xyz' }))
			.mockResolvedValueOnce(
				Response.json({ name: 'operations/xyz', done: true, response: subscription }),
			)
		const result = await resolveSubscription('t', { name: 'operations/xyz' }, noSleep)
		expect(result.name).toBe('subscriptions/abc')
		expect(fetchSpy).toHaveBeenCalledTimes(2)
		expect(fetchSpy.mock.calls[0][0]).toBe(
			'https://workspaceevents.googleapis.com/v1/operations/xyz',
		)
	})

	it('throws when the operation never finishes', async () => {
		vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
			Response.json({ name: 'operations/xyz' }),
		)
		await expect(resolveSubscription('t', { name: 'operations/xyz' }, noSleep)).rejects.toThrow(
			'did not finish',
		)
	})

	it('throws when the operation finished with an error', async () => {
		const op = { name: 'operations/xyz', done: true, error: { message: 'boom' } }
		await expect(resolveSubscription('t', op, noSleep)).rejects.toThrow('boom')
	})
})

describe('isOperationName', () => {
	it('flags operation names only', () => {
		expect(isOperationName('operations/xyz')).toBe(true)
		expect(isOperationName('subscriptions/abc')).toBe(false)
		expect(isOperationName(undefined)).toBe(false)
	})
})
