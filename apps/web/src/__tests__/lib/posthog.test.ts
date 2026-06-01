import {
	__setInitializedForTesting,
	capture,
	isPosthogReady,
	registerWorkspaceProperties,
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
})
