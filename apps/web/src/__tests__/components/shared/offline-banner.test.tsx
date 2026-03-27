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
})
