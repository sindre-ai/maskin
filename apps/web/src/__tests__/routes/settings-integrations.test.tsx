import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../mocks/router')
	return {
		...mockTanStackRouter(),
		createFileRoute: () => (options: Record<string, unknown>) => options,
	}
})

vi.mock('@/components/shared/route-error', () => ({
	RouteError: () => <div>Error</div>,
}))

vi.mock('@/components/integrations/integrations-manager', () => ({
	IntegrationsManager: () => <div>IntegrationsManager</div>,
}))

import { Route } from '@/routes/_authed/$workspaceId/settings/integrations'

const IntegrationsPage = (Route as unknown as { component: React.FC }).component

describe('IntegrationsPage', () => {
	it('renders the Integrations card with the shared integrations list', () => {
		render(<IntegrationsPage />)
		expect(screen.getByText('Integrations')).toBeInTheDocument()
		expect(screen.getByText('IntegrationsManager')).toBeInTheDocument()
	})

	it('explains that connection state persists across reload', () => {
		render(<IntegrationsPage />)
		expect(screen.getByText(/Connect this workspace to third-party services/)).toBeInTheDocument()
		expect(screen.getByText(/persists across\s+reload/)).toBeInTheDocument()
	})
})
