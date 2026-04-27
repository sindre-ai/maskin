import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../mocks/router')
	return {
		...mockTanStackRouter(),
		createFileRoute: () => (options: Record<string, unknown>) => ({
			...options,
			useParams: () => ({ taskId: 'task-123' }),
		}),
	}
})

vi.mock('@/components/layout/page-header', () => ({
	PageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
}))

vi.mock('@/components/shared/route-error', () => ({
	RouteError: () => <div>Error</div>,
}))

import { Route } from '@/routes/_authed/$workspaceId/work/$taskId'

const RouteOptions = Route as unknown as { component: React.FC }
const WorkTaskDetailPage = RouteOptions.component

describe('WorkTaskDetailPage', () => {
	it('renders the placeholder for the task detail page', () => {
		render(<WorkTaskDetailPage />)
		expect(screen.getByRole('heading', { name: 'Work' })).toBeInTheDocument()
		expect(screen.getByText('Task detail (coming soon)')).toBeInTheDocument()
	})

	it('mentions the resolved taskId in the placeholder copy', () => {
		render(<WorkTaskDetailPage />)
		expect(screen.getByText(/task-123/)).toBeInTheDocument()
	})
})
