import { getApiKey } from '@/lib/auth'
import { consumeMagicLink } from '@/lib/magic-link'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

describe('consumeMagicLink', () => {
	beforeEach(() => {
		localStorage.clear()
		window.history.replaceState(null, '', '/')
	})

	afterEach(() => {
		localStorage.clear()
		window.history.replaceState(null, '', '/')
	})

	it('does nothing when there is no fragment', () => {
		consumeMagicLink()
		expect(getApiKey()).toBeNull()
	})

	it('stores api key and strips the fragment when #key=ank_... is present', () => {
		window.history.replaceState(null, '', '/ws-abc#key=ank_testkey123')
		consumeMagicLink()
		expect(getApiKey()).toBe('ank_testkey123')
		expect(window.location.hash).toBe('')
		expect(window.location.pathname).toBe('/ws-abc')
	})

	it('ignores fragments without the ank_ prefix', () => {
		window.history.replaceState(null, '', '/ws-abc#key=notanapikey')
		consumeMagicLink()
		expect(getApiKey()).toBeNull()
	})

	it('preserves query string when stripping fragment', () => {
		window.history.replaceState(null, '', '/ws-abc?foo=bar#key=ank_xyz')
		consumeMagicLink()
		expect(window.location.pathname).toBe('/ws-abc')
		expect(window.location.search).toBe('?foo=bar')
		expect(window.location.hash).toBe('')
	})

	it('stores actor info when actor_id + actor_name + actor_email are present', () => {
		window.history.replaceState(
			null,
			'',
			'/ws-abc#key=ank_xyz&actor_id=a-1&actor_name=Magnus&actor_email=m%40example.com&actor_type=human',
		)
		consumeMagicLink()
		const stored = localStorage.getItem('maskin-actor')
		expect(stored).not.toBeNull()
		const parsed = stored ? JSON.parse(stored) : null
		expect(parsed.id).toBe('a-1')
		expect(parsed.name).toBe('Magnus')
		expect(parsed.email).toBe('m@example.com')
		expect(parsed.type).toBe('human')
	})
})
