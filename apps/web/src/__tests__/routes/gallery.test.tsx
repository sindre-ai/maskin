import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../mocks/router')
	return {
		...mockTanStackRouter(),
		createFileRoute: () => (options: Record<string, unknown>) => options,
	}
})

import { ThemeProvider } from '@/lib/theme'
import { Route } from '@/routes/gallery'

const GalleryPage = (Route as unknown as { component: React.FC }).component

describe('GalleryPage', () => {
	it('renders all 23 specimen numbers in the grid', () => {
		render(
			<ThemeProvider>
				<GalleryPage />
			</ThemeProvider>,
		)
		expect(screen.getByText('Repeating pattern gallery')).toBeInTheDocument()
		for (let n = 1; n <= 23; n++) {
			expect(screen.getByText(`#${n} / 23`)).toBeInTheDocument()
		}
	})

	it('switches between light and dark by toggling the .dark class on <html>', async () => {
		const user = userEvent.setup()
		document.documentElement.classList.remove('dark')
		render(
			<ThemeProvider>
				<GalleryPage />
			</ThemeProvider>,
		)
		expect(document.documentElement.classList.contains('dark')).toBe(false)
		await user.click(screen.getByRole('button', { name: /dark/i }))
		expect(document.documentElement.classList.contains('dark')).toBe(true)
		await user.click(screen.getByRole('button', { name: /light/i }))
		expect(document.documentElement.classList.contains('dark')).toBe(false)
	})
})
