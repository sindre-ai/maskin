import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

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
	useWorkspace: () => ({ workspaceId: 'ws-1' }),
}))

import { Route } from '@/routes/_authed/$workspaceId/settings'

const SettingsLayout = (Route as unknown as { component: React.FC }).component

describe('SettingsLayout', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockMatchRoute.mockReturnValue(false)
	})

	it('renders Settings heading', () => {
		render(<SettingsLayout />)
		expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument()
	})

	it('renders the six settings sections in mockup order', () => {
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

	it('does not render retired legacy nav labels (Skills, LLM, MCP)', () => {
		render(<SettingsLayout />)
		expect(screen.queryByText('Skills')).not.toBeInTheDocument()
		expect(screen.queryByText('LLM')).not.toBeInTheDocument()
		expect(screen.queryByText('MCP')).not.toBeInTheDocument()
	})

	it('renders Outlet for child content', () => {
		render(<SettingsLayout />)
		expect(screen.getByTestId('outlet')).toBeInTheDocument()
	})
})
