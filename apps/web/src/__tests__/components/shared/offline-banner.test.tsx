import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/hooks/use-online-status', () => ({
	useOnlineStatus: vi.fn(),
}))

import { OfflineBanner } from '@/components/shared/offline-banner'
import { useOnlineStatus } from '@/hooks/use-online-status'

describe('OfflineBanner', () => {
	it('returns null when online', () => {
		vi.mocked(useOnlineStatus).mockReturnValue(true)
		const { container } = render(<OfflineBanner />)
		expect(container.firstChild).toBeNull()
	})

	it('renders offline message when offline', () => {
		vi.mocked(useOnlineStatus).mockReturnValue(false)
		render(<OfflineBanner />)
		expect(screen.getByText(/you are offline/i)).toBeInTheDocument()
	})

	it('adds iOS safe-area top padding so the banner clears the notch when viewport-fit=cover', () => {
		vi.mocked(useOnlineStatus).mockReturnValue(false)
		const { container } = render(<OfflineBanner />)
		const banner = container.firstChild as HTMLElement
		expect(banner.className).toMatch(/pt-\[calc\(0\.5rem\+env\(safe-area-inset-top\)\)\]/)
	})
})
