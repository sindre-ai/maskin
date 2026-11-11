import {
	__setInitializedForTesting,
	beforeSend,
	capture,
	firstTouchFromPosthog,
	hashDistinctId,
	identifyForWorkspace,
	initPosthog,
	isPosthogReady,
	registerWorkspaceProperties,
	resetPosthogIdentity,
	setCapturingEnabled,
	setWorkspaceGroup,
	signupSourceFrom,
	withSharedProperties,
} from '@/lib/posthog'
import posthog from 'posthog-js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => {
	__setInitializedForTesting(false)
})

afterEach(() => {
	__setInitializedForTesting(false)
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
})

describe('posthog helper', () => {
	it('register is a no-op until posthog is initialised, but capture always forwards to posthog', () => {
		const capSpy = vi.spyOn(posthog, 'capture').mockImplementation((() => {}) as never)
		const regSpy = vi.spyOn(posthog, 'register').mockImplementation((() => {}) as never)

		expect(isPosthogReady()).toBe(false)
		capture('bet_opened', { bet_id: 'b1' })
		registerWorkspaceProperties({
			workspace_id: 'w1',
			actor_id: 'a1',
			actor_type: 'human',
			is_team: false,
		})

		// posthog-js is safe to call before init (it buffers), and the module-local
		// `initialized` flag has historically gone stale across HMR / dev races —
		// so capture no longer gates on it.
		expect(capSpy).toHaveBeenCalledTimes(1)
		expect(capSpy).toHaveBeenCalledWith('bet_opened', { bet_id: 'b1' })
		expect(regSpy).not.toHaveBeenCalled()
	})

	it('forwards the Synthesizer join keys to posthog.register once initialised', () => {
		const regSpy = vi.spyOn(posthog, 'register').mockImplementation((() => {}) as never)
		__setInitializedForTesting(true)

		registerWorkspaceProperties({
			workspace_id: 'w1',
			actor_id: 'a1',
			actor_type: 'agent',
			is_team: false,
		})

		expect(regSpy).toHaveBeenCalledTimes(1)
		expect(regSpy).toHaveBeenCalledWith({
			workspace_id: 'w1',
			actor_id: 'a1',
			actor_type: 'agent',
			is_team: false,
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

	it('identifyForWorkspace sends name and email as person properties when anonymise is off', async () => {
		const idSpy = vi.spyOn(posthog, 'identify').mockImplementation((() => {}) as never)
		__setInitializedForTesting(true)

		await identifyForWorkspace('actor-1', false, { name: 'Magnus Hansen', email: 'm@example.com' })

		expect(idSpy).toHaveBeenCalledWith('actor-1', { name: 'Magnus Hansen', email: 'm@example.com' })
	})

	it('identifyForWorkspace sets the sign-up source once', async () => {
		const idSpy = vi.spyOn(posthog, 'identify').mockImplementation((() => {}) as never)
		__setInitializedForTesting(true)

		await identifyForWorkspace('actor-1', false, { name: 'Magnus', signupSource: 'linkedin' })

		expect(idSpy).toHaveBeenCalledWith('actor-1', { name: 'Magnus' }, { signup_source: 'linkedin' })
	})

	it('identifyForWorkspace skips missing person fields', async () => {
		const idSpy = vi.spyOn(posthog, 'identify').mockImplementation((() => {}) as never)
		__setInitializedForTesting(true)

		await identifyForWorkspace('actor-1', false, { name: 'Magnus Hansen', email: null })

		expect(idSpy).toHaveBeenCalledWith('actor-1', { name: 'Magnus Hansen' })
	})

	it('identifyForWorkspace never sends name or email when anonymise is on', async () => {
		const idSpy = vi.spyOn(posthog, 'identify').mockImplementation((() => {}) as never)
		__setInitializedForTesting(true)

		await identifyForWorkspace('actor-1', true, { name: 'Magnus Hansen', email: 'm@example.com' })
		const expected = await hashDistinctId('actor-1')

		expect(idSpy).toHaveBeenCalledTimes(1)
		expect(idSpy).toHaveBeenCalledWith(expected)
	})

	it('resetPosthogIdentity is a no-op before init and resets after', () => {
		const resetSpy = vi.spyOn(posthog, 'reset').mockImplementation((() => {}) as never)

		resetPosthogIdentity()
		expect(resetSpy).not.toHaveBeenCalled()

		__setInitializedForTesting(true)
		resetPosthogIdentity()
		expect(resetSpy).toHaveBeenCalledTimes(1)
	})

	it('setWorkspaceGroup is a no-op before init', () => {
		const groupSpy = vi.spyOn(posthog, 'group').mockImplementation((() => {}) as never)

		setWorkspaceGroup('ws-1', '2026-10-01T00:00:00.000Z')

		expect(groupSpy).not.toHaveBeenCalled()
	})

	it('setWorkspaceGroup sets a workspace group with the id and created date, and no name', () => {
		const groupSpy = vi.spyOn(posthog, 'group').mockImplementation((() => {}) as never)
		__setInitializedForTesting(true)

		setWorkspaceGroup('ws-1', '2026-10-01T00:00:00.000Z')

		expect(groupSpy).toHaveBeenCalledWith('workspace', 'ws-1', {
			workspace_id: 'ws-1',
			created_at: '2026-10-01T00:00:00.000Z',
		})
	})

	it('setWorkspaceGroup leaves the created date out when the workspace has none', () => {
		const groupSpy = vi.spyOn(posthog, 'group').mockImplementation((() => {}) as never)
		__setInitializedForTesting(true)

		setWorkspaceGroup('ws-1', null)

		expect(groupSpy).toHaveBeenCalledWith('workspace', 'ws-1', { workspace_id: 'ws-1' })
	})

	it('setWorkspaceGroup swallows posthog errors', () => {
		vi.spyOn(posthog, 'group').mockImplementation(() => {
			throw new Error('boom')
		})
		__setInitializedForTesting(true)

		expect(() => setWorkspaceGroup('ws-1')).not.toThrow()
	})

	it('identifyForWorkspace swallows posthog errors', async () => {
		vi.spyOn(posthog, 'identify').mockImplementation(() => {
			throw new Error('boom')
		})
		__setInitializedForTesting(true)

		await expect(identifyForWorkspace('actor-1', false)).resolves.toBeUndefined()
	})

	describe('initPosthog', () => {
		it('initialises the SDK with the configured key and host, then reports ready', () => {
			vi.stubEnv('VITE_POSTHOG_KEY', 'phc_test_key')
			vi.stubEnv('VITE_POSTHOG_HOST', 'https://eu.i.posthog.com')
			const initSpy = vi.spyOn(posthog, 'init').mockImplementation((() => {}) as never)
			expect(isPosthogReady()).toBe(false)

			initPosthog()

			expect(initSpy).toHaveBeenCalledTimes(1)
			expect(initSpy).toHaveBeenCalledWith('phc_test_key', {
				api_host: 'https://eu.i.posthog.com',
				person_profiles: 'identified_only',
				capture_pageview: true,
				capture_pageleave: false,
				capture_performance: false,
				autocapture: false,
				before_send: beforeSend,
			})
			expect(isPosthogReady()).toBe(true)
		})

		it('falls back to the default EU host when no VITE_POSTHOG_HOST is set', () => {
			vi.stubEnv('VITE_POSTHOG_KEY', 'phc_test_key')
			const initSpy = vi.spyOn(posthog, 'init').mockImplementation((() => {}) as never)

			initPosthog()

			expect(initSpy).toHaveBeenCalledWith(
				'phc_test_key',
				expect.objectContaining({ api_host: 'https://eu.i.posthog.com' }),
			)
		})

		it('is a no-op without a key — bundled but never emitting is the failure mode this bet watches for', () => {
			vi.stubEnv('VITE_POSTHOG_KEY', '')
			const initSpy = vi.spyOn(posthog, 'init').mockImplementation((() => {}) as never)

			initPosthog()

			expect(initSpy).not.toHaveBeenCalled()
			expect(isPosthogReady()).toBe(false)
		})

		it('swallows posthog.init errors so boot cannot break', () => {
			vi.stubEnv('VITE_POSTHOG_KEY', 'phc_test_key')
			vi.spyOn(posthog, 'init').mockImplementation(() => {
				throw new Error('boom')
			})

			expect(() => initPosthog()).not.toThrow()
			expect(isPosthogReady()).toBe(false)
		})
	})
})

describe('signupSourceFrom', () => {
	it('prefers utm_source over the referrer', () => {
		expect(
			signupSourceFrom('?utm_source=LinkedIn', 'https://news.ycombinator.com/', 'app.maskin.io'),
		).toBe('linkedin')
	})

	it('falls back to the site that sent the person', () => {
		expect(signupSourceFrom('', 'https://www.google.com/search?q=x', 'app.maskin.io')).toBe(
			'google.com',
		)
	})

	it('is direct without a utm_source or an outside referrer', () => {
		expect(signupSourceFrom('', '', 'app.maskin.io')).toBe('direct')
		expect(signupSourceFrom('', 'https://app.maskin.io/login', 'app.maskin.io')).toBe('direct')
		expect(signupSourceFrom('', 'not a url', 'app.maskin.io')).toBe('direct')
	})

	it('uses the campaign tag from the first visit when the sign-up page has none', () => {
		// Home page with a tag, then a plain /signup link from our own site.
		expect(
			signupSourceFrom('', 'https://app.maskin.io/', 'app.maskin.io', { utmSource: 'LinkedIn' }),
		).toBe('linkedin')
	})

	it('lets a tag on the sign-up page win over the first visit', () => {
		expect(
			signupSourceFrom('?utm_source=newsletter', '', 'app.maskin.io', { utmSource: 'linkedin' }),
		).toBe('newsletter')
	})

	it('uses the site from the first visit when there was no tag', () => {
		expect(
			signupSourceFrom('', 'https://app.maskin.io/', 'app.maskin.io', {
				referringDomain: 'www.google.com',
			}),
		).toBe('google.com')
	})

	it('is still direct when the first visit had neither a tag nor an outside site', () => {
		expect(signupSourceFrom('', '', 'app.maskin.io', { referringDomain: '$direct' })).toBe('direct')
		expect(signupSourceFrom('', '', 'app.maskin.io', { referringDomain: 'app.maskin.io' })).toBe(
			'direct',
		)
		expect(signupSourceFrom('', '', 'app.maskin.io', {})).toBe('direct')
	})

	it('cleans the first-visit values the same way', () => {
		expect(signupSourceFrom('', '', 'app.maskin.io', { utmSource: 'a b<script>' })).toBe('abscript')
		expect(signupSourceFrom('', '', 'app.maskin.io', { utmSource: 42 })).toBe('direct')
	})

	it('keeps free text off the person', () => {
		expect(signupSourceFrom('?utm_source=a%20b%3Cscript%3E', '', 'app.maskin.io')).toBe('abscript')
		expect(signupSourceFrom(`?utm_source=${'x'.repeat(200)}`, '', 'app.maskin.io')).toHaveLength(60)
	})
})

describe('firstTouchFromPosthog', () => {
	it('reads the first-visit tag and referring site that posthog stored', () => {
		const persistence = {
			get_initial_props: () => ({
				$initial_utm_source: 'linkedin',
				$initial_referring_domain: 'www.google.com',
			}),
		}
		const holder = posthog as unknown as { persistence?: unknown }
		const original = holder.persistence
		holder.persistence = persistence
		try {
			expect(firstTouchFromPosthog()).toEqual({
				utmSource: 'linkedin',
				referringDomain: 'www.google.com',
			})
		} finally {
			holder.persistence = original
		}
	})

	it('is empty when posthog has no persistence yet', () => {
		const holder = posthog as unknown as { persistence?: unknown }
		const original = holder.persistence
		holder.persistence = undefined
		try {
			expect(firstTouchFromPosthog()).toEqual({ utmSource: undefined, referringDomain: undefined })
		} finally {
			holder.persistence = original
		}
	})
})

describe('withSharedProperties', () => {
	it('adds surface web and defaults actor_type to human', () => {
		expect(withSharedProperties({ event: 'x', properties: { a: 1 } })).toEqual({
			event: 'x',
			properties: { a: 1, actor_type: 'human', surface: 'web' },
		})
	})

	it('adds feature_area for an event that belongs to a product area', () => {
		expect(
			withSharedProperties({ event: 'chat_session_started', properties: {} })?.properties,
		).toMatchObject({ feature_area: 'chats' })
	})

	it('adds no feature_area to an event with no product area', () => {
		expect(
			withSharedProperties({ event: '$pageview', properties: {} })?.properties,
		).not.toHaveProperty('feature_area')
	})

	it('keeps a feature_area the caller set', () => {
		const out = withSharedProperties({
			event: 'chat_session_started',
			properties: { feature_area: 'voice' },
		})
		expect(out?.properties).toMatchObject({ feature_area: 'voice' })
	})

	it('keeps an actor_type that is already registered', () => {
		const out = withSharedProperties({ event: 'x', properties: { actor_type: 'agent' } })
		expect(out?.properties).toMatchObject({ actor_type: 'agent', surface: 'web' })
	})

	it('passes a dropped event through', () => {
		expect(withSharedProperties(null)).toBeNull()
	})
})
