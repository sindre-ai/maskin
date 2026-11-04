import { shouldReloadForStaleBuild } from '@/lib/stale-build-reload'
import { beforeEach, describe, expect, it } from 'vitest'

describe('shouldReloadForStaleBuild', () => {
	beforeEach(() => {
		sessionStorage.clear()
	})

	it('reloads on the first stale-file error', () => {
		expect(shouldReloadForStaleBuild(1_000_000)).toBe(true)
	})

	it('does not reload again within the cooldown', () => {
		expect(shouldReloadForStaleBuild(1_000_000)).toBe(true)
		expect(shouldReloadForStaleBuild(1_005_000)).toBe(false)
	})

	it('reloads again once the cooldown has passed', () => {
		expect(shouldReloadForStaleBuild(1_000_000)).toBe(true)
		expect(shouldReloadForStaleBuild(1_011_000)).toBe(true)
	})
})
