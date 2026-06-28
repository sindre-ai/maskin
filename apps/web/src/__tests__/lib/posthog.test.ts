import {
	__setInitializedForTesting,
	capture,
	hashDistinctId,
	identifyForWorkspace,
	inheritDistinctIdFromUrl,
	isPosthogReady,
	registerWorkspaceProperties,
	setCapturingEnabled,
} from '@/lib/posthog'
import posthog from 'posthog-js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => {
	__setInitializedForTesting(false)
})

afterEach(() => {
	__setInitializedForTesting(false)
	vi.restoreAllMocks()
})

describe('posthog helper', () => {
	it('capture and register are no-ops until posthog is initialised', () => {
		const capSpy = vi.spyOn(posthog, 'capture').mockImplementation((() => {}) as never)
		const regSpy = vi.spyOn(posthog, 'register').mockImplementation((() => {}) as never)

		expect(isPosthogReady()).toBe(false)
		capture('bet_opened', { bet_id: 'b1' })
		registerWorkspaceProperties({ workspace_id: 'w1', actor_id: 'a1', actor_type: 'human' })

		expect(capSpy).not.toHaveBeenCalled()
		expect(regSpy).not.toHaveBeenCalled()
	})

	it('forwards the Synthesizer join keys to posthog.register once initialised', () => {
		const regSpy = vi.spyOn(posthog, 'register').mockImplementation((() => {}) as never)
		__setInitializedForTesting(true)

		registerWorkspaceProperties({ workspace_id: 'w1', actor_id: 'a1', actor_type: 'agent' })

		expect(regSpy).toHaveBeenCalledTimes(1)
		expect(regSpy).toHaveBeenCalledWith({
			workspace_id: 'w1',
			actor_id: 'a1',
			actor_type: 'agent',
		})
	})

	it('swallows posthog.capture errors so analytics cannot break the UI', () => {
		vi.spyOn(posthog, 'capture').mockImplementation(() => {
			throw new Error('network down')
		})
		__setInitializedForTesting(true)

		expect(() => capture('bet_opened', { bet_id: 'b1' })).not.toThrow()
	})

	it('setCapturingEnabled is a no-op before init', () => {
		const inSpy = vi.spyOn(posthog, 'opt_in_capturing').mockImplementation(() => {})
		const outSpy = vi.spyOn(posthog, 'opt_out_capturing').mockImplementation(() => {})

		setCapturingEnabled(true)
		setCapturingEnabled(false)

		expect(inSpy).not.toHaveBeenCalled()
		expect(outSpy).not.toHaveBeenCalled()
	})

	it('setCapturingEnabled routes opt-in and opt-out once initialised', () => {
		const inSpy = vi.spyOn(posthog, 'opt_in_capturing').mockImplementation(() => {})
		const outSpy = vi.spyOn(posthog, 'opt_out_capturing').mockImplementation(() => {})
		__setInitializedForTesting(true)

		setCapturingEnabled(true)
		expect(inSpy).toHaveBeenCalledTimes(1)
		expect(outSpy).not.toHaveBeenCalled()

		setCapturingEnabled(false)
		expect(outSpy).toHaveBeenCalledTimes(1)
	})

	it('setCapturingEnabled swallows posthog errors', () => {
		vi.spyOn(posthog, 'opt_in_capturing').mockImplementation(() => {
			throw new Error('boom')
		})
		__setInitializedForTesting(true)

		expect(() => setCapturingEnabled(true)).not.toThrow()
	})

	it('hashDistinctId returns a deterministic SHA-256 hex string', async () => {
		const hash = await hashDistinctId('actor-1')
		// SHA-256 hex is 64 chars; stable across runs.
		expect(hash).toMatch(/^[0-9a-f]{64}$/)
		expect(await hashDistinctId('actor-1')).toBe(hash)
		expect(await hashDistinctId('actor-2')).not.toBe(hash)
	})

	it('hashDistinctId falls back to the raw value when Web Crypto is unavailable', async () => {
		const original = globalThis.crypto
		Object.defineProperty(globalThis, 'crypto', {
			value: undefined,
			configurable: true,
		})
		try {
			expect(await hashDistinctId('actor-1')).toBe('actor-1')
		} finally {
			Object.defineProperty(globalThis, 'crypto', {
				value: original,
				configurable: true,
			})
		}
	})

	it('identifyForWorkspace is a no-op before init', async () => {
		const idSpy = vi.spyOn(posthog, 'identify').mockImplementation((() => {}) as never)

		await identifyForWorkspace('actor-1', false)
		await identifyForWorkspace('actor-1', true)

		expect(idSpy).not.toHaveBeenCalled()
	})

	it('identifyForWorkspace uses the raw actor id when anonymise is off', async () => {
		const idSpy = vi.spyOn(posthog, 'identify').mockImplementation((() => {}) as never)
		__setInitializedForTesting(true)

		await identifyForWorkspace('actor-1', false)

		expect(idSpy).toHaveBeenCalledTimes(1)
		expect(idSpy).toHaveBeenCalledWith('actor-1')
	})

	it('identifyForWorkspace hashes the distinct_id when anonymise is on', async () => {
		const idSpy = vi.spyOn(posthog, 'identify').mockImplementation((() => {}) as never)
		__setInitializedForTesting(true)

		await identifyForWorkspace('actor-1', true)
		const expected = await hashDistinctId('actor-1')

		expect(idSpy).toHaveBeenCalledTimes(1)
		expect(idSpy).toHaveBeenCalledWith(expected)
		expect(idSpy).not.toHaveBeenCalledWith('actor-1')
	})

	it('identifyForWorkspace swallows posthog errors', async () => {
		vi.spyOn(posthog, 'identify').mockImplementation(() => {
			throw new Error('boom')
		})
		__setInitializedForTesting(true)

		await expect(identifyForWorkspace('actor-1', false)).resolves.toBeUndefined()
	})

	describe('inheritDistinctIdFromUrl', () => {
		const originalHref = window.location.href

		afterEach(() => {
			window.history.replaceState({}, '', originalHref)
		})

		it('is a no-op when no ph_distinct_id param is present', () => {
			const aliasSpy = vi.spyOn(posthog, 'alias').mockImplementation((() => {}) as never)
			const replaceSpy = vi.spyOn(window.history, 'replaceState')
			__setInitializedForTesting(true)
			window.history.replaceState({}, '', '/workspace/abc?foo=bar')

			inheritDistinctIdFromUrl()

			expect(aliasSpy).not.toHaveBeenCalled()
			expect(replaceSpy).toHaveBeenCalledTimes(1) // only the setup call above
		})

		it('aliases the docs distinct_id to the current browser distinct_id and strips the param', () => {
			const aliasSpy = vi.spyOn(posthog, 'alias').mockImplementation((() => {}) as never)
			__setInitializedForTesting(true)
			window.history.replaceState({}, '', '/workspace/abc?ph_distinct_id=docs-anon-7&foo=bar')

			inheritDistinctIdFromUrl()

			expect(aliasSpy).toHaveBeenCalledTimes(1)
			expect(aliasSpy).toHaveBeenCalledWith('docs-anon-7')
			expect(window.location.search).toBe('?foo=bar')
		})

		it('strips the param even when posthog is not initialised so the URL stays clean', () => {
			const aliasSpy = vi.spyOn(posthog, 'alias').mockImplementation((() => {}) as never)
			window.history.replaceState({}, '', '/?ph_distinct_id=docs-anon-7')

			inheritDistinctIdFromUrl()

			expect(aliasSpy).not.toHaveBeenCalled()
			expect(window.location.search).toBe('')
		})

		it('swallows posthog.alias errors', () => {
			vi.spyOn(posthog, 'alias').mockImplementation(() => {
				throw new Error('boom')
			})
			__setInitializedForTesting(true)
			window.history.replaceState({}, '', '/?ph_distinct_id=docs-anon-7')

			expect(() => inheritDistinctIdFromUrl()).not.toThrow()
			expect(window.location.search).toBe('')
		})
	})
})
