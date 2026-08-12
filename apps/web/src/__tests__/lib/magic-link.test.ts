import { getApiKey } from '@/lib/auth'
import { applyMagicLinkFragment, consumeMagicLink } from '@/lib/magic-link'
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

describe('applyMagicLinkFragment', () => {
	it('returns false and stores nothing when no fragment is given', () => {
		expect(applyMagicLinkFragment('')).toBe(false)
		expect(getApiKey()).toBeNull()
	})

	it('returns false without a key or a non-ank_ key', () => {
		expect(applyMagicLinkFragment('#foo=bar')).toBe(false)
		expect(applyMagicLinkFragment('#key=notanapikey')).toBe(false)
		expect(getApiKey()).toBeNull()
	})

	it('accepts a fragment with or without the leading hash', () => {
		expect(applyMagicLinkFragment('#key=ank_hash')).toBe(true)
		expect(getApiKey()).toBe('ank_hash')
		localStorage.clear()
		expect(applyMagicLinkFragment('key=ank_nohash')).toBe(true)
		expect(getApiKey()).toBe('ank_nohash')
	})

	it('stores actor info alongside the key', () => {
		expect(
			applyMagicLinkFragment('#key=ank_x&actor_id=a-9&actor_name=Ada&actor_email=a%40b.com'),
		).toBe(true)
		const parsed = JSON.parse(localStorage.getItem('maskin-actor') ?? '{}')
		expect(parsed.id).toBe('a-9')
		expect(parsed.name).toBe('Ada')
		expect(parsed.email).toBe('a@b.com')
	})
})
