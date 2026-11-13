import { OfflineBanner } from '@/components/shared/offline-banner'
import {
	__resetServerReachabilityForTesting,
	reportServerFailure,
	reportServerOk,
} from '@/lib/server-reachability'
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

async function takeServerDown() {
	vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }))
	await act(async () => {
		reportServerFailure()
		reportServerFailure()
	})
}

describe('OfflineBanner', () => {
	beforeEach(() => {
		__resetServerReachabilityForTesting()
	})

	afterEach(() => {
		__resetServerReachabilityForTesting()
		vi.unstubAllGlobals()
		vi.restoreAllMocks()
	})

	it('returns null when online and the server answers', () => {
		const { container } = render(<OfflineBanner />)
		expect(container.firstChild).toBeNull()
	})

	it('renders offline message when offline', async () => {
		vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
		render(<OfflineBanner />)
		await act(async () => {
			window.dispatchEvent(new Event('offline'))
		})
		expect(screen.getByText(/you are offline/i)).toBeInTheDocument()
	})

	it('says it cannot reach Maskin when the server is down, then goes away on recovery', async () => {
		render(<OfflineBanner />)
		await takeServerDown()
		expect(screen.getByRole('status')).toHaveTextContent(/Can.t reach Maskin/)

		await act(async () => {
			reportServerOk()
		})
		expect(screen.queryByRole('status')).not.toBeInTheDocument()
	})

	it('shows when the server last answered', async () => {
		render(<OfflineBanner />)
		reportServerOk()
		await takeServerDown()
		expect(screen.getByRole('status')).toHaveTextContent(/Showing what we had at/)
	})

	it('puts the device being offline ahead of the server message', async () => {
		render(<OfflineBanner />)
		await takeServerDown()
		vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
		await act(async () => {
			window.dispatchEvent(new Event('offline'))
		})
		expect(screen.getByRole('status')).toHaveTextContent('You are offline')
	})
})
