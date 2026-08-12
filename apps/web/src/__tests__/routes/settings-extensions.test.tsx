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

vi.mock('@/components/extensions/extensions-manager', () => ({
	ExtensionsManager: () => <div>ExtensionsManager</div>,
}))

import { Route } from '@/routes/_authed/$workspaceId/settings/extensions'

const ExtensionsPage = (Route as unknown as { component: React.FC }).component

describe('ExtensionsPage', () => {
	it('renders the Extensions card with the shared extension list', () => {
		render(<ExtensionsPage />)
		expect(screen.getByText('Extensions')).toBeInTheDocument()
		expect(screen.getByText('ExtensionsManager')).toBeInTheDocument()
	})

	it('explains that enabled extensions add object types and navigation', () => {
		render(<ExtensionsPage />)
		expect(screen.getByText(/Enable or disable extensions for this workspace/)).toBeInTheDocument()
	})
})
