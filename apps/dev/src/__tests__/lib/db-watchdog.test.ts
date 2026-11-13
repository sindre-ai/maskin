import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	DB_WATCHDOG_FAIL_AFTER_DEFAULT_MS,
	isDbWatchdogEnabled,
	resolveDbWatchdogFailAfterMs,
	startDbWatchdog,
} from '../../lib/db-watchdog'

const MIN = 60_000

function setup(probe: () => Promise<unknown>) {
	const shutdown = vi.fn()
	const forceExit = vi.fn()
	const logError = vi.fn()
	const dog = startDbWatchdog({ probe, shutdown, forceExit, logError, inFlightCount: () => 20 })
	return { dog, shutdown, forceExit, logError }
}

/** A probe that succeeds until `state.mode` is changed. */
function switchable() {
	const state = { mode: 'ok' as 'ok' | 'fail' | 'hang' }
	const probe = vi.fn(async () => {
		if (state.mode === 'fail') throw new Error('down')
		if (state.mode === 'hang') await new Promise(() => {})
	})
	return { state, probe }
}

describe('startDbWatchdog', () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it('does not exit while probes succeed', async () => {
		const { dog, shutdown } = setup(async () => 1)
		await vi.advanceTimersByTimeAsync(30 * MIN)
		expect(shutdown).not.toHaveBeenCalled()
		dog.stop()
	})

	it('does not exit under 3 minutes of failures', async () => {
		const { state, probe } = switchable()
		const { dog, shutdown } = setup(probe)
		await vi.advanceTimersByTimeAsync(6 * MIN)
		state.mode = 'fail'
		await vi.advanceTimersByTimeAsync(2.5 * MIN)
		expect(shutdown).not.toHaveBeenCalled()
		dog.stop()
	})

	it('exits after 3 minutes of continuous failure, logging once', async () => {
		const { state, probe } = switchable()
		const { dog, shutdown, forceExit, logError } = setup(probe)
		await vi.advanceTimersByTimeAsync(6 * MIN)
		state.mode = 'fail'
		await vi.advanceTimersByTimeAsync(4 * MIN)
		expect(shutdown).toHaveBeenCalledTimes(1)
		expect(logError).toHaveBeenCalledTimes(1)
		expect(logError.mock.calls[0][1]).toMatchObject({ inFlight: 20 })
		expect(forceExit).toHaveBeenCalledWith(1)
		dog.stop()
	})

	it('forces the exit 5 s after the shutdown starts, even if it hangs', async () => {
		const { state, probe } = switchable()
		const { dog, shutdown, forceExit } = setup(probe)
		shutdown.mockImplementation(() => new Promise(() => {}))
		await vi.advanceTimersByTimeAsync(6 * MIN)
		state.mode = 'fail'
		for (let i = 0; i < 400 && shutdown.mock.calls.length === 0; i++) {
			await vi.advanceTimersByTimeAsync(1_000)
		}
		expect(shutdown).toHaveBeenCalledTimes(1)
		expect(forceExit).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(5_000)
		expect(forceExit).toHaveBeenCalledWith(1)
		dog.stop()
	})

	it('resets the counter on a success', async () => {
		const { state, probe } = switchable()
		const { dog, shutdown } = setup(probe)
		await vi.advanceTimersByTimeAsync(6 * MIN)
		state.mode = 'fail'
		await vi.advanceTimersByTimeAsync(2.5 * MIN)
		state.mode = 'ok'
		await vi.advanceTimersByTimeAsync(30_000)
		state.mode = 'fail'
		await vi.advanceTimersByTimeAsync(2.5 * MIN)
		expect(shutdown).not.toHaveBeenCalled()
		dog.stop()
	})

	it('counts a hanging probe as a failure and keeps probing', async () => {
		const { state, probe } = switchable()
		const { dog, shutdown } = setup(probe)
		await vi.advanceTimersByTimeAsync(6 * MIN)
		state.mode = 'hang'
		const before = probe.mock.calls.length
		await vi.advanceTimersByTimeAsync(MIN)
		expect(probe.mock.calls.length - before).toBeGreaterThanOrEqual(3)
		await vi.advanceTimersByTimeAsync(3 * MIN)
		expect(shutdown).toHaveBeenCalledTimes(1)
		dog.stop()
	})

	it('does not exit during the boot grace, then exits once it ends', async () => {
		const { state, probe } = switchable()
		state.mode = 'fail'
		const { dog, shutdown } = setup(probe)
		await vi.advanceTimersByTimeAsync(4.9 * MIN)
		expect(shutdown).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(0.5 * MIN)
		expect(shutdown).toHaveBeenCalledTimes(1)
		dog.stop()
	})
})

describe('resolveDbWatchdogFailAfterMs', () => {
	it('uses the default when unset or empty', () => {
		expect(resolveDbWatchdogFailAfterMs({})).toBe(DB_WATCHDOG_FAIL_AFTER_DEFAULT_MS)
		expect(resolveDbWatchdogFailAfterMs({ DB_WATCHDOG_FAIL_AFTER_MS: ' ' })).toBe(
			DB_WATCHDOG_FAIL_AFTER_DEFAULT_MS,
		)
	})

	it('accepts an integer in range', () => {
		expect(resolveDbWatchdogFailAfterMs({ DB_WATCHDOG_FAIL_AFTER_MS: '60000' })).toBe(60_000)
	})

	it.each(['abc', '1.5', '29999', '1800001', '-5', 'NaN', 'Infinity'])(
		'falls back to the default for %s',
		(v) => {
			expect(resolveDbWatchdogFailAfterMs({ DB_WATCHDOG_FAIL_AFTER_MS: v })).toBe(
				DB_WATCHDOG_FAIL_AFTER_DEFAULT_MS,
			)
		},
	)
})

describe('isDbWatchdogEnabled', () => {
	it('is on by default and off for DB_WATCHDOG=off or tests', () => {
		expect(isDbWatchdogEnabled({})).toBe(true)
		expect(isDbWatchdogEnabled({ DB_WATCHDOG: 'off' })).toBe(false)
		expect(isDbWatchdogEnabled({ DB_WATCHDOG: 'OFF' })).toBe(false)
		expect(isDbWatchdogEnabled({ NODE_ENV: 'test' })).toBe(false)
		expect(isDbWatchdogEnabled({ VITEST: 'true' })).toBe(false)
	})
})
