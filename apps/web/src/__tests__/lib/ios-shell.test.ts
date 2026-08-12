import { getApiKey, getStoredActor } from '@/lib/auth'
import { initIosDeepLink, isTauri, magicLinkFragmentFromUrl } from '@/lib/ios-shell'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

describe('isTauri', () => {
	it('is false in a plain browser (jsdom has no __TAURI_INTERNALS__)', () => {
		expect(isTauri()).toBe(false)
	})
})

describe('magicLinkFragmentFromUrl', () => {
	it('extracts the fragment from a maskin:// deep link', () => {
		expect(magicLinkFragmentFromUrl('maskin://auth#key=ank_x&actor_id=a-1')).toBe(
			'#key=ank_x&actor_id=a-1',
		)
	})

	it('extracts the fragment from an https URL', () => {
		expect(magicLinkFragmentFromUrl('https://app.maskin.io/ws#key=ank_y')).toBe('#key=ank_y')
	})

	it('returns null for a URL with no fragment', () => {
		expect(magicLinkFragmentFromUrl('maskin://auth')).toBeNull()
	})

	it('returns null for a malformed URL', () => {
		expect(magicLinkFragmentFromUrl('not a url')).toBeNull()
	})
})

describe('initIosDeepLink', () => {
	beforeEach(() => {
		localStorage.clear()
	})

	afterEach(() => {
		localStorage.clear()
		vi.restoreAllMocks()
	})

	it('is a no-op in a plain browser (guard short-circuits before the plugin loads)', async () => {
		// In jsdom isTauri() is false, so initIosDeepLink returns without touching
		// the plugin or the session. It must not throw.
		initIosDeepLink()
		await Promise.resolve()
		expect(getApiKey()).toBeNull()
		expect(getStoredActor()).toBeNull()
	})
})
