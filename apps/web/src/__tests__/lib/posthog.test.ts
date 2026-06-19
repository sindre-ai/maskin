import {
	__clearChatActiveUserSessionForTesting,
	__setInitializedForTesting,
	capture,
	hashDistinctId,
	identifyForWorkspace,
	isPosthogReady,
	registerWorkspaceProperties,
	setCapturingEnabled,
	trackChatActiveUserSession,
	trackChatMessageSent,
	trackChatSessionOpened,
} from '@/lib/posthog'
import posthog from 'posthog-js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const TEST_WORKSPACE_ID = 'ws-test'

beforeEach(() => {
	__setInitializedForTesting(false)
	__clearChatActiveUserSessionForTesting(TEST_WORKSPACE_ID)
})

afterEach(() => {
	__setInitializedForTesting(false)
	__clearChatActiveUserSessionForTesting(TEST_WORKSPACE_ID)
	vi.restoreAllMocks()
	vi.useRealTimers()
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
})

describe('chat ship-metric events', () => {
	it('trackChatSessionOpened emits chat_session_opened and ticks active-user-session once initialised', () => {
		const capSpy = vi.spyOn(posthog, 'capture').mockImplementation((() => {}) as never)
		__setInitializedForTesting(true)

		trackChatSessionOpened({ workspace_id: TEST_WORKSPACE_ID, surface: 'sheet' })

		expect(capSpy).toHaveBeenCalledWith('chat_session_opened', {
			workspace_id: TEST_WORKSPACE_ID,
			surface: 'sheet',
		})
		expect(capSpy).toHaveBeenCalledWith('chat_active_user_session', {
			workspace_id: TEST_WORKSPACE_ID,
		})
	})

	it('trackChatMessageSent emits chat_message_sent with attachment counts and target agent', () => {
		const capSpy = vi.spyOn(posthog, 'capture').mockImplementation((() => {}) as never)
		__setInitializedForTesting(true)

		trackChatMessageSent({
			workspace_id: TEST_WORKSPACE_ID,
			surface: 'pulse-bar',
			target_agent_id: 'agent-42',
			attached_objects: 2,
			attached_notifications: 0,
			attached_files: 1,
		})

		expect(capSpy).toHaveBeenCalledWith('chat_message_sent', {
			workspace_id: TEST_WORKSPACE_ID,
			surface: 'pulse-bar',
			target_agent_id: 'agent-42',
			attached_objects: 2,
			attached_notifications: 0,
			attached_files: 1,
		})
	})

	it('trackChatActiveUserSession fires once per 24h per workspace then debounces', () => {
		const capSpy = vi.spyOn(posthog, 'capture').mockImplementation((() => {}) as never)
		__setInitializedForTesting(true)
		const start = new Date('2026-06-18T00:00:00Z').getTime()
		vi.useFakeTimers({ now: start })

		trackChatActiveUserSession({ workspace_id: TEST_WORKSPACE_ID })
		const firstCount = capSpy.mock.calls.filter((c) => c[0] === 'chat_active_user_session').length
		expect(firstCount).toBe(1)

		// Within 24h — debounced.
		vi.setSystemTime(start + 23 * 60 * 60 * 1000)
		trackChatActiveUserSession({ workspace_id: TEST_WORKSPACE_ID })
		expect(capSpy.mock.calls.filter((c) => c[0] === 'chat_active_user_session').length).toBe(1)

		// After 24h — fires again.
		vi.setSystemTime(start + 25 * 60 * 60 * 1000)
		trackChatActiveUserSession({ workspace_id: TEST_WORKSPACE_ID })
		expect(capSpy.mock.calls.filter((c) => c[0] === 'chat_active_user_session').length).toBe(2)
	})

	it('trackChatActiveUserSession debounces per workspace independently', () => {
		const capSpy = vi.spyOn(posthog, 'capture').mockImplementation((() => {}) as never)
		__setInitializedForTesting(true)
		__clearChatActiveUserSessionForTesting('ws-other')

		trackChatActiveUserSession({ workspace_id: TEST_WORKSPACE_ID })
		trackChatActiveUserSession({ workspace_id: 'ws-other' })

		const calls = capSpy.mock.calls.filter((c) => c[0] === 'chat_active_user_session')
		expect(calls).toHaveLength(2)
		expect(calls[0][1]).toEqual({ workspace_id: TEST_WORKSPACE_ID })
		expect(calls[1][1]).toEqual({ workspace_id: 'ws-other' })

		__clearChatActiveUserSessionForTesting('ws-other')
	})

	it('chat helpers are no-ops before posthog initialises', () => {
		const capSpy = vi.spyOn(posthog, 'capture').mockImplementation((() => {}) as never)

		trackChatSessionOpened({ workspace_id: TEST_WORKSPACE_ID, surface: 'sheet' })
		trackChatMessageSent({
			workspace_id: TEST_WORKSPACE_ID,
			surface: 'sheet',
			target_agent_id: null,
			attached_objects: 0,
			attached_notifications: 0,
			attached_files: 0,
		})
		trackChatActiveUserSession({ workspace_id: TEST_WORKSPACE_ID })

		expect(capSpy).not.toHaveBeenCalled()
	})

	it('trackChatActiveUserSession swallows localStorage errors', () => {
		vi.spyOn(posthog, 'capture').mockImplementation((() => {}) as never)
		__setInitializedForTesting(true)
		const original = window.localStorage.getItem
		// Force a throw path inside the try/catch.
		const getSpy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
			throw new Error('quota exceeded')
		})

		expect(() => trackChatActiveUserSession({ workspace_id: TEST_WORKSPACE_ID })).not.toThrow()

		getSpy.mockRestore()
		void original
	})
})
