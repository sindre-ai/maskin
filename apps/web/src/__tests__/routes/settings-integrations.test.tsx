import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../mocks/router')
	return {
		...mockTanStackRouter(),
		createFileRoute: () => (options: Record<string, unknown>) => options,
	}
})

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspaceId: 'ws-1' }),
}))

vi.mock('@/components/shared/route-error', () => ({
	RouteError: () => <div>Error</div>,
}))

vi.mock('@/components/integrations/integrations-manager', () => ({
	IntegrationsManager: () => <div>IntegrationsManager</div>,
}))

import { Route } from '@/routes/_authed/$workspaceId/settings/integrations'

const IntegrationsPage = (Route as unknown as { component: React.FC }).component

describe('IntegrationsPage', () => {
	// The screen's title belongs to the shared top nav, so the page body opens
	// with the lead paragraph (mockup 2765), not a duplicate heading.
	it('renders no heading of its own, only the lead paragraph and the shared list', () => {
		render(<IntegrationsPage />)
		expect(screen.queryByRole('heading')).not.toBeInTheDocument()
		expect(
			screen.getByText(/Connect the tools your agents read from and write to/),
		).toBeInTheDocument()
		expect(screen.getByText('IntegrationsManager')).toBeInTheDocument()
	})

	it('offers entry points to the model-provider and MCP credential routes', () => {
		render(<IntegrationsPage />)

		const modelProviders = screen.getByRole('link', { name: /Model providers/ })
		expect(modelProviders).toHaveAttribute('href', expect.stringContaining('/settings/keys'))

		const mcp = screen.getByRole('link', { name: /Connect your coding agent/ })
		expect(mcp).toHaveAttribute('href', expect.stringContaining('/settings/mcp'))
	})
})
