import {
	__resetServerReachabilityForTesting,
	getServerReachability,
	onServerRecovered,
	reportServerFailure,
	reportServerOk,
} from '@/lib/server-reachability'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fetchMock = vi.fn()

function healthResponds(ok: boolean) {
	fetchMock.mockResolvedValue({ ok })
}

// Lets the awaited probe inside the module settle.
const settle = () => vi.advanceTimersByTimeAsync(0)

describe('server-reachability', () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.stubGlobal('fetch', fetchMock)
		fetchMock.mockReset()
		__resetServerReachabilityForTesting()
	})

	afterEach(() => {
		__resetServerReachabilityForTesting()
		vi.unstubAllGlobals()
		vi.useRealTimers()
	})

	it('stays reachable after a single failure and does not probe', async () => {
		reportServerFailure()
		await settle()
		expect(getServerReachability().unreachable).toBe(false)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('stays reachable when repeated failures are followed by a healthy probe', async () => {
		healthResponds(true)
		reportServerFailure()
		reportServerFailure()
		await settle()
		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(getServerReachability().unreachable).toBe(false)
	})

	it('marks the server unreachable when repeated failures are confirmed by a failed probe', async () => {
		healthResponds(false)
		reportServerFailure()
		reportServerFailure()
		await settle()
		expect(getServerReachability().unreachable).toBe(true)
	})

	it('resets the failure count when the server answers in between', async () => {
		healthResponds(false)
		reportServerFailure()
		reportServerOk()
		reportServerFailure()
		await settle()
		expect(fetchMock).not.toHaveBeenCalled()
		expect(getServerReachability().unreachable).toBe(false)
	})

	it('ignores failures while the device itself is offline', async () => {
		healthResponds(false)
		vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
		reportServerFailure()
		reportServerFailure()
		await settle()
		expect(fetchMock).not.toHaveBeenCalled()
		expect(getServerReachability().unreachable).toBe(false)
		vi.restoreAllMocks()
	})

	it('probes again with backoff and recovers when /api/health answers', async () => {
		const recovered = vi.fn()
		onServerRecovered(recovered)
		healthResponds(false)
		reportServerFailure()
		reportServerFailure()
		await settle()
		expect(getServerReachability().unreachable).toBe(true)

		await vi.advanceTimersByTimeAsync(5_000)
		expect(fetchMock).toHaveBeenCalledTimes(2)
		expect(getServerReachability().unreachable).toBe(true)

		healthResponds(true)
		await vi.advanceTimersByTimeAsync(10_000)
		expect(getServerReachability().unreachable).toBe(false)
		expect(recovered).toHaveBeenCalledTimes(1)
	})

	it('recovers at once when a real request succeeds', async () => {
		const recovered = vi.fn()
		onServerRecovered(recovered)
		healthResponds(false)
		reportServerFailure()
		reportServerFailure()
		await settle()
		reportServerOk()
		expect(getServerReachability().unreachable).toBe(false)
		expect(recovered).toHaveBeenCalledTimes(1)
	})

	it('remembers when the server last answered', async () => {
		vi.setSystemTime(new Date('2026-11-09T14:20:00Z'))
		reportServerOk()
		healthResponds(false)
		reportServerFailure()
		reportServerFailure()
		await settle()
		expect(getServerReachability().lastOkAt).toBe(new Date('2026-11-09T14:20:00Z').getTime())
	})

	it('probes immediately when the tab regains focus', async () => {
		healthResponds(false)
		reportServerFailure()
		reportServerFailure()
		await settle()
		expect(fetchMock).toHaveBeenCalledTimes(1)

		window.dispatchEvent(new Event('focus'))
		await settle()
		expect(fetchMock).toHaveBeenCalledTimes(2)
	})
})
