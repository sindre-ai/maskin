import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
	ResponsivePopover,
	ResponsivePopoverContent,
	ResponsivePopoverTrigger,
} from '@/components/ui/responsive-popover'

const mockUseIsMobile = vi.fn(() => false)
vi.mock('@/hooks/use-mobile', () => ({
	useIsMobile: () => mockUseIsMobile(),
}))

function Fixture() {
	return (
		<ResponsivePopover open>
			<ResponsivePopoverTrigger>open</ResponsivePopoverTrigger>
			<ResponsivePopoverContent>
				<div>popover body</div>
			</ResponsivePopoverContent>
		</ResponsivePopover>
	)
}

afterEach(() => {
	mockUseIsMobile.mockReset()
	mockUseIsMobile.mockReturnValue(false)
})

describe('ResponsivePopover', () => {
	it('renders popover content on desktop', () => {
		mockUseIsMobile.mockReturnValue(false)
		render(<Fixture />)
		const body = screen.getByText('popover body')
		expect(body).toBeInTheDocument()
		// Popover content lives in a portal but renders <div role="dialog"> in
		// non-modal mode; check the nearest ancestor with popover width.
		const panel = body.closest('[role="dialog"]') ?? body.parentElement
		expect(panel?.className ?? '').toMatch(/w-72/)
	})

	it('renders as bottom sheet on mobile', () => {
		mockUseIsMobile.mockReturnValue(true)
		render(<Fixture />)
		const dialog = screen.getByRole('dialog')
		expect(dialog).toBeInTheDocument()
		expect(dialog.className).toMatch(/rounded-t-lg/)
		expect(dialog.className).toMatch(/max-w-none/)
		expect(screen.getByText('popover body')).toBeInTheDocument()
	})

	it('does not render content when closed', () => {
		mockUseIsMobile.mockReturnValue(true)
		render(
			<ResponsivePopover>
				<ResponsivePopoverTrigger>open</ResponsivePopoverTrigger>
				<ResponsivePopoverContent>
					<div>popover body</div>
				</ResponsivePopoverContent>
			</ResponsivePopover>,
		)
		expect(screen.queryByText('popover body')).not.toBeInTheDocument()
	})
})
