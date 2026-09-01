import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockMatchRoute = vi.fn()

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../mocks/router')
	return {
		...mockTanStackRouter(),
		createFileRoute: () => (options: Record<string, unknown>) => options,
		useMatchRoute: () => mockMatchRoute,
		Outlet: () => <div data-testid="outlet" />,
	}
})

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspaceId: 'ws-1', workspace: { id: 'ws-1', name: 'My Workspace' } }),
}))

import { Route } from '@/routes/_authed/$workspaceId/settings'

const SettingsLayout = (Route as unknown as { component: React.FC }).component

// These specs cover the v2 branch of the `new-design` boundary, so they drive
// the flag on through the test-only localStorage override.
beforeEach(() => {
	localStorage.setItem('ff:new-design', 'on')
})

describe('SettingsLayout', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockMatchRoute.mockReturnValue(false)
	})

	// The "Settings" title is not this layout's — in v2 it belongs to the shared
	// top nav, which renders the per-screen <h1> (mockup lines 195-199). This
	// layout owns only the section nav and the outlet.
	it('renders no heading of its own', () => {
		render(<SettingsLayout />)
		expect(screen.queryByRole('heading')).not.toBeInTheDocument()
	})

	it('marks the active section with the bg-muted / font-bold rail state', () => {
		mockMatchRoute.mockImplementation(
			({ to }: { to: string }) => to === '/$workspaceId/settings/billing',
		)
		render(<SettingsLayout />)
		const billing = screen.getByRole('link', { name: 'Billing' })
		expect(billing.className).toContain('bg-muted')
		expect(billing.className).toContain('font-bold')
	})

	it('renders the settings sections in mockup order', () => {
		render(<SettingsLayout />)
		const labels = screen.getAllByRole('link').map((link) => link.textContent)
		expect(labels).toEqual([
			'General',
			'Objects',
			'Members',
			'Integrations',
			'Extensions',
			'Billing',
		])
	})

	it('points Billing at its own page, not the LLM credentials page', () => {
		render(<SettingsLayout />)
		expect(screen.getByRole('link', { name: 'Billing' })).toHaveAttribute(
			'href',
			expect.stringContaining('/settings/billing'),
		)
	})

	it('renders Outlet for child content', () => {
		render(<SettingsLayout />)
		expect(screen.getByTestId('outlet')).toBeInTheDocument()
	})
})
