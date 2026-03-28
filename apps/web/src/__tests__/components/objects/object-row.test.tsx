import { ObjectRow } from '@/components/objects/object-row'
import { render, screen } from '@testing-library/react'
import { buildObjectResponse } from '../../factories'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

vi.mock('@/components/shared/agent-working-badge', () => ({
	AgentWorkingBadge: () => <span>working</span>,
}))

describe('ObjectRow', () => {
	it('renders object title', () => {
		const object = buildObjectResponse({ title: 'My Bet' })
		render(<ObjectRow object={object} workspaceId="ws-1" />)
		expect(screen.getByText('My Bet')).toBeInTheDocument()
	})

	it('renders "Untitled" when title is null', () => {
		const object = buildObjectResponse({ title: null })
		render(<ObjectRow object={object} workspaceId="ws-1" />)
		expect(screen.getByText('Untitled')).toBeInTheDocument()
	})

	it('renders "Untitled" when title is empty', () => {
		const object = buildObjectResponse({ title: '' })
		render(<ObjectRow object={object} workspaceId="ws-1" />)
		expect(screen.getByText('Untitled')).toBeInTheDocument()
	})

	it('renders status badge', () => {
		const object = buildObjectResponse({ status: 'active' })
		render(<ObjectRow object={object} workspaceId="ws-1" />)
		expect(screen.getByText('active')).toBeInTheDocument()
	})

	it('renders type badge', () => {
		const object = buildObjectResponse({ type: 'bet' })
		render(<ObjectRow object={object} workspaceId="ws-1" />)
		expect(screen.getByText('bet')).toBeInTheDocument()
	})

	it('shows AgentWorkingBadge when activeSessionId is set', () => {
		const object = buildObjectResponse({ activeSessionId: 'session-1' })
		render(<ObjectRow object={object} workspaceId="ws-1" />)
		expect(screen.getByText('working')).toBeInTheDocument()
	})

	it('does not show AgentWorkingBadge when activeSessionId is null', () => {
		const object = buildObjectResponse({ activeSessionId: null })
		render(<ObjectRow object={object} workspaceId="ws-1" />)
		expect(screen.queryByText('working')).not.toBeInTheDocument()
	})
})
