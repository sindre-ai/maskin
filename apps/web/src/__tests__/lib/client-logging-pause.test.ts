import { isClientErrorLoggingPaused, pauseClientErrorLogging } from '@/lib/client-logging-pause'
import { describe, expect, it } from 'vitest'

describe('pauseClientErrorLogging', () => {
	it('is paused from the call until the release function runs', () => {
		expect(isClientErrorLoggingPaused()).toBe(false)
		const release = pauseClientErrorLogging()
		expect(isClientErrorLoggingPaused()).toBe(true)
		release()
		expect(isClientErrorLoggingPaused()).toBe(false)
	})

	it('stays paused until every caller has released', () => {
		const a = pauseClientErrorLogging()
		const b = pauseClientErrorLogging()
		a()
		expect(isClientErrorLoggingPaused()).toBe(true)
		b()
		expect(isClientErrorLoggingPaused()).toBe(false)
	})

	it('ignores a second release from the same caller', () => {
		const a = pauseClientErrorLogging()
		const b = pauseClientErrorLogging()
		a()
		a()
		expect(isClientErrorLoggingPaused()).toBe(true)
		b()
		expect(isClientErrorLoggingPaused()).toBe(false)
	})
})
