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
})
