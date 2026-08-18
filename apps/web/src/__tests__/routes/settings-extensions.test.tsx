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
	// The screen's title belongs to the shared top nav, so the page body opens
	// with the lead paragraph (mockup 2779), not a duplicate heading.
	it('renders no heading of its own, only the lead paragraph and the shared list', () => {
		render(<ExtensionsPage />)
		expect(screen.queryByRole('heading')).not.toBeInTheDocument()
		expect(screen.getByText('ExtensionsManager')).toBeInTheDocument()
	})

	it('promises that turning an extension off hides its objects without deleting them', () => {
		render(<ExtensionsPage />)
		expect(screen.getByText(/it never deletes them/)).toBeInTheDocument()
	})
})
