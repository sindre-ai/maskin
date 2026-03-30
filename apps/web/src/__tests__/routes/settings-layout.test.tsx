import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const mockMatchRoute = vi.fn()

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../mocks/router')
	return {
		...mockTanStackRouter(),
		createFileRoute: () => (options: any) => options,
		useMatchRoute: () => mockMatchRoute,
		Outlet: () => <div data-testid="outlet" />,
	}
})

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspaceId: 'ws-1' }),
}))

import { Route } from '@/routes/_authed/$workspaceId/settings'

const SettingsLayout = Route.component as React.FC

describe('SettingsLayout', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockMatchRoute.mockReturnValue(false)
	})

	it('renders Settings heading', () => {
		render(<SettingsLayout />)
		expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument()
	})

	it('renders all navigation links', () => {
		render(<SettingsLayout />)
		expect(screen.getByText('General')).toBeInTheDocument()
		expect(screen.getByText('Objects')).toBeInTheDocument()
		expect(screen.getByText('Members')).toBeInTheDocument()
		expect(screen.getByText('Integrations')).toBeInTheDocument()
		expect(screen.getByText('LLM')).toBeInTheDocument()
		expect(screen.getByText('MCP')).toBeInTheDocument()
	})

	it('renders Outlet for child content', () => {
		render(<SettingsLayout />)
		expect(screen.getByTestId('outlet')).toBeInTheDocument()
	})
})
