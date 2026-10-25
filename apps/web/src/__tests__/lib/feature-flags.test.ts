import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: {
		featureFlags: { get: vi.fn() },
	},
}))

import { api } from '@/lib/api'

const STORAGE_KEY = 'maskin-feature-flags:2'

// The module seeds itself from localStorage at import time, so each case has to
// seed storage first and then re-import with a fresh module registry.
async function loadModule() {
	vi.resetModules()
	return await import('@/lib/feature-flags')
}

beforeEach(() => {
	localStorage.clear()
	vi.mocked(api.featureFlags.get).mockReset()
	vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
	vi.restoreAllMocks()
})

describe('feature flags cache', () => {
	it('reports no cache and all-false before the first successful fetch', async () => {
		const ff = await loadModule()
		expect(ff.hasCachedFlags()).toBe(false)
		expect(ff.getFlag('sample-flag')).toBe(false)
	})

	it('seeds synchronously from the localStorage cache at import time', async () => {
		localStorage.setItem(STORAGE_KEY, JSON.stringify({ 'sample-flag': true }))
		const ff = await loadModule()
		expect(ff.hasCachedFlags()).toBe(true)
		expect(ff.getFlag('sample-flag')).toBe(true)
	})

	it('returns false for a flag id the server never sent', async () => {
		localStorage.setItem(STORAGE_KEY, JSON.stringify({ 'sample-flag': true }))
		const ff = await loadModule()
		expect(ff.getFlag('never-heard-of-it')).toBe(false)
	})

	it('writes the response to localStorage and notifies subscribers', async () => {
		vi.mocked(api.featureFlags.get).mockResolvedValue({ flags: { 'sample-flag': true } })
		const ff = await loadModule()
		const listener = vi.fn()
		ff.subscribeToFlags(listener)

		await ff.loadFeatureFlags()

		expect(ff.getFlag('sample-flag')).toBe(true)
		expect(ff.hasCachedFlags()).toBe(true)
		expect(JSON.parse(localStorage.getItem(STORAGE_KEY) as string)).toEqual({
			'sample-flag': true,
		})
		expect(listener).toHaveBeenCalled()
	})

	it('revalidates a stale cached value in the background', async () => {
		localStorage.setItem(STORAGE_KEY, JSON.stringify({ 'sample-flag': true }))
		vi.mocked(api.featureFlags.get).mockResolvedValue({ flags: { 'sample-flag': false } })
		const ff = await loadModule()

		// Synchronous read before revalidation still serves the stale value, so the
		// UI does not flash.
		expect(ff.getFlag('sample-flag')).toBe(true)
		await ff.loadFeatureFlags()
		expect(ff.getFlag('sample-flag')).toBe(false)
	})

	it('ignores an unparseable cache instead of throwing', async () => {
		localStorage.setItem(STORAGE_KEY, 'not json')
		const ff = await loadModule()
		expect(ff.hasCachedFlags()).toBe(false)
		expect(ff.getFlag('sample-flag')).toBe(false)
	})
})

describe('test-only localStorage override', () => {
	it('an override of on beats a server response of false', async () => {
		vi.mocked(api.featureFlags.get).mockResolvedValue({ flags: { 'sample-flag': false } })
		const ff = await loadModule()
		await ff.loadFeatureFlags()

		localStorage.setItem('ff:sample-flag', 'on')
		expect(ff.getFlag('sample-flag')).toBe(true)
	})

	it('an override of off beats a server response of true', async () => {
		vi.mocked(api.featureFlags.get).mockResolvedValue({ flags: { 'sample-flag': true } })
		const ff = await loadModule()
		await ff.loadFeatureFlags()

		localStorage.setItem('ff:sample-flag', 'off')
		expect(ff.getFlag('sample-flag')).toBe(false)
	})

	it('ignores any override value other than on/off', async () => {
		localStorage.setItem(STORAGE_KEY, JSON.stringify({ 'sample-flag': true }))
		const ff = await loadModule()
		localStorage.setItem('ff:sample-flag', 'maybe')
		expect(ff.getFlag('sample-flag')).toBe(true)
	})
})

describe('failure policy', () => {
	it('falls back to the cached value when the endpoint fails, and never throws', async () => {
		localStorage.setItem(STORAGE_KEY, JSON.stringify({ 'sample-flag': true }))
		vi.mocked(api.featureFlags.get).mockRejectedValue(new Error('500 Internal Server Error'))
		const ff = await loadModule()

		await expect(ff.loadFeatureFlags()).resolves.toBeUndefined()
		expect(ff.getFlag('sample-flag')).toBe(true)
		expect(console.error).toHaveBeenCalled()
	})

	it('falls back to all-false when the endpoint fails and there is no cache', async () => {
		vi.mocked(api.featureFlags.get).mockRejectedValue(new Error('500 Internal Server Error'))
		const ff = await loadModule()

		await expect(ff.loadFeatureFlags()).resolves.toBeUndefined()
		expect(ff.getFlag('sample-flag')).toBe(false)
		expect(ff.hasCachedFlags()).toBe(false)
	})

	it('keeps the cached value when the endpoint returns a malformed body', async () => {
		localStorage.setItem(STORAGE_KEY, JSON.stringify({ 'sample-flag': true }))
		vi.mocked(api.featureFlags.get).mockResolvedValue({} as { flags: Record<string, boolean> })
		const ff = await loadModule()

		await ff.loadFeatureFlags()
		expect(ff.getFlag('sample-flag')).toBe(true)
	})

	it('does not fire a second request while one is already in flight', async () => {
		vi.mocked(api.featureFlags.get).mockResolvedValue({ flags: { 'sample-flag': true } })
		const ff = await loadModule()

		await Promise.all([ff.loadFeatureFlags(), ff.loadFeatureFlags()])
		expect(api.featureFlags.get).toHaveBeenCalledTimes(1)
	})
})

describe('workspace-keyed cache', () => {
	const WS_A = 'e2877e32-2c11-489e-96c8-a76200908ed4'
	const WS_B = 'f79e3751-c680-47e0-9a9a-824a4a2a7908'

	it('asks the backend about the selected workspace and stores the answer under its key', async () => {
		vi.mocked(api.featureFlags.get).mockResolvedValue({ flags: { 'sample-flag': true } })
		const ff = await loadModule()
		ff.setFlagsWorkspace(WS_A)

		await ff.loadFeatureFlags()

		expect(api.featureFlags.get).toHaveBeenCalledWith(WS_A)
		expect(ff.getFlag('sample-flag')).toBe(true)
		expect(JSON.parse(localStorage.getItem(`${STORAGE_KEY}:${WS_A}`) as string)).toEqual({
			'sample-flag': true,
		})
		expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
	})

	it('asks without a workspace when none is selected', async () => {
		vi.mocked(api.featureFlags.get).mockResolvedValue({ flags: {} })
		const ff = await loadModule()

		await ff.loadFeatureFlags()

		expect(api.featureFlags.get).toHaveBeenCalledWith(undefined)
	})

	it('seeds from the selected workspace and never shows another workspace its flag', async () => {
		localStorage.setItem(`${STORAGE_KEY}:${WS_A}`, JSON.stringify({ 'sample-flag': true }))
		const ff = await loadModule()

		ff.setFlagsWorkspace(WS_A)
		expect(ff.hasCachedFlags()).toBe(true)
		expect(ff.getFlag('sample-flag')).toBe(true)

		ff.setFlagsWorkspace(WS_B)
		expect(ff.hasCachedFlags()).toBe(false)
		expect(ff.getFlag('sample-flag')).toBe(false)
	})

	it('tells subscribers when the workspace changes', async () => {
		const ff = await loadModule()
		const listener = vi.fn()
		ff.subscribeToFlags(listener)

		ff.setFlagsWorkspace(WS_A)
		ff.setFlagsWorkspace(WS_A)

		expect(listener).toHaveBeenCalledTimes(1)
	})

	it('drops an answer that arrives after the user moved to another workspace', async () => {
		let resolveA: (value: { flags: Record<string, boolean> }) => void = () => {}
		vi.mocked(api.featureFlags.get).mockReturnValueOnce(
			new Promise((resolve) => {
				resolveA = resolve
			}),
		)
		const ff = await loadModule()
		ff.setFlagsWorkspace(WS_A)
		const loading = ff.loadFeatureFlags()

		ff.setFlagsWorkspace(WS_B)
		resolveA({ flags: { 'sample-flag': true } })
		await loading

		expect(ff.getFlag('sample-flag')).toBe(false)
		// A's answer is still kept for A.
		expect(JSON.parse(localStorage.getItem(`${STORAGE_KEY}:${WS_A}`) as string)).toEqual({
			'sample-flag': true,
		})
	})
})
