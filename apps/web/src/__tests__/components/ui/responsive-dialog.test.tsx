import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
	ResponsiveDialog,
	ResponsiveDialogContent,
	ResponsiveDialogDescription,
	ResponsiveDialogHeader,
	ResponsiveDialogTitle,
	ResponsiveDialogTrigger,
} from '@/components/ui/responsive-dialog'

const mockUseIsMobile = vi.fn(() => false)
vi.mock('@/hooks/use-mobile', () => ({
	useIsMobile: () => mockUseIsMobile(),
}))

function Fixture() {
	return (
		<ResponsiveDialog open>
			<ResponsiveDialogTrigger>open</ResponsiveDialogTrigger>
			<ResponsiveDialogContent>
				<ResponsiveDialogHeader>
					<ResponsiveDialogTitle>title text</ResponsiveDialogTitle>
					<ResponsiveDialogDescription>body text</ResponsiveDialogDescription>
				</ResponsiveDialogHeader>
			</ResponsiveDialogContent>
		</ResponsiveDialog>
	)
}

afterEach(() => {
	mockUseIsMobile.mockReset()
	mockUseIsMobile.mockReturnValue(false)
})

describe('ResponsiveDialog', () => {
	it('renders dialog content on desktop', () => {
		mockUseIsMobile.mockReturnValue(false)
		render(<Fixture />)
		const dialog = screen.getByRole('dialog')
		expect(dialog).toBeInTheDocument()
		expect(dialog.className).toMatch(/max-w-lg/)
		expect(screen.getByText('title text')).toBeInTheDocument()
		expect(screen.getByText('body text')).toBeInTheDocument()
	})

	it('renders as full-screen sheet on mobile', () => {
		mockUseIsMobile.mockReturnValue(true)
		render(<Fixture />)
		const dialog = screen.getByRole('dialog')
		expect(dialog).toBeInTheDocument()
		expect(dialog.className).toMatch(/max-w-none/)
		expect(screen.getByText('title text')).toBeInTheDocument()
	})

	it('does not render content when closed', () => {
		mockUseIsMobile.mockReturnValue(false)
		render(
			<ResponsiveDialog>
				<ResponsiveDialogTrigger>open</ResponsiveDialogTrigger>
				<ResponsiveDialogContent>
					<ResponsiveDialogHeader>
						<ResponsiveDialogTitle>title text</ResponsiveDialogTitle>
					</ResponsiveDialogHeader>
				</ResponsiveDialogContent>
			</ResponsiveDialog>,
		)
		expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
	})
})
