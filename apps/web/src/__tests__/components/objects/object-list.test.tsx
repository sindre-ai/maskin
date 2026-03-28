import { ObjectList } from '@/components/objects/object-list'
import { render, screen } from '@testing-library/react'
import { buildObjectResponse } from '../../factories'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

vi.mock('@/components/shared/agent-working-badge', () => ({
	AgentWorkingBadge: () => <span data-testid="agent-working" />,
}))

describe('ObjectList', () => {
	it('shows empty state when objects array is empty', () => {
		render(<ObjectList objects={[]} workspaceId="ws-1" />)
		expect(screen.getByText('No objects found')).toBeInTheDocument()
	})

	it('renders one row per object', () => {
		const objects = [
			buildObjectResponse({ id: 'obj-1', title: 'First' }),
			buildObjectResponse({ id: 'obj-2', title: 'Second' }),
		]

		render(<ObjectList objects={objects} workspaceId="ws-1" />)

		expect(screen.getByText('First')).toBeInTheDocument()
		expect(screen.getByText('Second')).toBeInTheDocument()
	})
})
