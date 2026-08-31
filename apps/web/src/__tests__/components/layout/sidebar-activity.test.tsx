import { SidebarActivity } from '@/components/layout/sidebar-activity'
import type { ActiveAgent } from '@/hooks/use-active-agents'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockUseActiveAgents = vi.fn()

vi.mock('@/hooks/use-active-agents', () => ({
	useActiveAgents: (workspaceId: string) => mockUseActiveAgents(workspaceId),
}))

const trackNavItemClicked = vi.fn()
vi.mock('@/lib/analytics', () => ({
	trackNavItemClicked: (p: { item_key: string; source: string }) => trackNavItemClicked(p),
}))

const setOpenMobile = vi.fn()
vi.mock('@/components/ui/sidebar', () => ({
	useSidebar: () => ({ setOpenMobile }),
}))

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

function agent(overrides: Partial<ActiveAgent> = {}): ActiveAgent {
	return {
		actorId: 'a-1',
		name: 'Agent',
		type: 'agent',
		sessionId: 's-1',
		currentActivity: null,
		startedAt: null,
		...overrides,
	}
}

function row() {
	return screen.getByTestId('sidebar-activity')
}

describe('SidebarActivity', () => {
	beforeEach(() => {
		mockUseActiveAgents.mockReset()
		trackNavItemClicked.mockReset()
		setOpenMobile.mockReset()
	})

	it('reads idle with a zero tile and no live dot when nothing holds a session', () => {
		mockUseActiveAgents.mockReturnValue({ agents: [], isLoading: false, isError: false })
		render(<SidebarActivity workspaceId="ws-1" />)
		expect(row()).toHaveTextContent('Agents idle')
		expect(row()).toHaveTextContent('nothing running')
		expect(row()).toHaveTextContent('0')
	})

	it('counts agents in the tile and sessions in the sub-line', () => {
		// Two agents, three live sessions — `useActiveAgents` returns one row per
		// session, so the tile must de-duplicate by actor while the sub-line does not.
		mockUseActiveAgents.mockReturnValue({
			agents: [
				agent({ actorId: 'a-1', name: 'Quill', sessionId: 's-1' }),
				agent({ actorId: 'a-1', name: 'Quill', sessionId: 's-2' }),
				agent({ actorId: 'a-2', name: 'Analyst', sessionId: 's-3' }),
			],
			isLoading: false,
			isError: false,
		})
		render(<SidebarActivity workspaceId="ws-1" />)
		expect(row()).toHaveTextContent('Agents working')
		expect(row()).toHaveTextContent('2')
		expect(row()).toHaveTextContent('3 sessions running')
	})

	it('singularises a lone session', () => {
		mockUseActiveAgents.mockReturnValue({
			agents: [agent()],
			isLoading: false,
			isError: false,
		})
		render(<SidebarActivity workspaceId="ws-1" />)
		expect(row()).toHaveTextContent('1 session running')
	})

	it('summarises both counts on the rail tile title', () => {
		mockUseActiveAgents.mockReturnValue({
			agents: [
				agent({ actorId: 'a-1', sessionId: 's-1' }),
				agent({ actorId: 'a-2', sessionId: 's-2' }),
				agent({ actorId: 'a-2', sessionId: 's-3' }),
			],
			isLoading: false,
			isError: false,
		})
		render(<SidebarActivity workspaceId="ws-1" />)
		expect(screen.getByLabelText('Agents')).toHaveAttribute(
			'title',
			'2 agents working · 3 sessions running',
		)
	})

	it('links to Agents and emits the footer nav event on click', () => {
		mockUseActiveAgents.mockReturnValue({
			agents: [agent()],
			isLoading: false,
			isError: false,
		})
		render(<SidebarActivity workspaceId="ws-1" />)
		fireEvent.click(row())
		expect(trackNavItemClicked).toHaveBeenCalledWith({ item_key: 'agents', source: 'footer' })
		expect(setOpenMobile).toHaveBeenCalledWith(false)
	})

	it('renders a skeleton row while loading', () => {
		mockUseActiveAgents.mockReturnValue({ agents: [], isLoading: true, isError: false })
		render(<SidebarActivity workspaceId="ws-1" />)
		expect(screen.getByTestId('sidebar-activity-loading')).toBeInTheDocument()
	})

	it('renders nothing when the sessions query errors', () => {
		mockUseActiveAgents.mockReturnValue({ agents: [], isLoading: false, isError: true })
		const { container } = render(<SidebarActivity workspaceId="ws-1" />)
		expect(container).toBeEmptyDOMElement()
	})

	it('hides the row and keeps the count tile in icon-collapsed mode', () => {
		mockUseActiveAgents.mockReturnValue({
			agents: [agent()],
			isLoading: false,
			isError: false,
		})
		render(<SidebarActivity workspaceId="ws-1" />)
		expect(row().className).toContain('group-data-[collapsible=icon]:hidden')
		const rail = screen.getByLabelText('Agents')
		expect(rail.className).toContain('group-data-[collapsible=icon]:grid')
		// The rail keeps the number, not just a dot — it is the only agents
		// signal left once the labels are gone.
		expect(rail).toHaveTextContent('1')
	})
})
