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

function card() {
	return screen.getByTestId('sidebar-activity')
}

describe('SidebarActivity', () => {
	beforeEach(() => {
		mockUseActiveAgents.mockReset()
		trackNavItemClicked.mockReset()
		setOpenMobile.mockReset()
	})

	it('reads "idle" with nothing running when no agent holds a live session', () => {
		mockUseActiveAgents.mockReturnValue({ agents: [], isLoading: false, isError: false })
		render(<SidebarActivity workspaceId="ws-1" />)
		expect(card()).toHaveTextContent('idle')
		expect(card()).toHaveTextContent('nothing running')
	})

	it('reads "working" and counts sessions, not agents', () => {
		// Two agents, three live sessions — `useActiveAgents` returns one row per
		// session, so the card must de-duplicate for the avatar stack.
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
		expect(card()).toHaveTextContent('working')
		expect(card()).toHaveTextContent('3 sessions running')
		expect(screen.getAllByTitle('Quill')).toHaveLength(1)
		expect(screen.getAllByTitle('Analyst')).toHaveLength(1)
	})

	it('singularises a lone session', () => {
		mockUseActiveAgents.mockReturnValue({
			agents: [agent()],
			isLoading: false,
			isError: false,
		})
		render(<SidebarActivity workspaceId="ws-1" />)
		expect(card()).toHaveTextContent('1 session running')
	})

	it('collapses the avatar stack past four agents into a +N tile', () => {
		mockUseActiveAgents.mockReturnValue({
			agents: Array.from({ length: 6 }, (_, i) =>
				agent({ actorId: `a-${i}`, name: `Agent ${i}`, sessionId: `s-${i}` }),
			),
			isLoading: false,
			isError: false,
		})
		render(<SidebarActivity workspaceId="ws-1" />)
		expect(screen.getByTitle('2 more')).toHaveTextContent('+2')
	})

	it('links to Agents and emits the footer nav event on click', () => {
		mockUseActiveAgents.mockReturnValue({
			agents: [agent()],
			isLoading: false,
			isError: false,
		})
		render(<SidebarActivity workspaceId="ws-1" />)
		fireEvent.click(card())
		expect(trackNavItemClicked).toHaveBeenCalledWith({ item_key: 'agents', source: 'footer' })
		expect(setOpenMobile).toHaveBeenCalledWith(false)
	})

	it('renders a skeleton card while loading', () => {
		mockUseActiveAgents.mockReturnValue({ agents: [], isLoading: true, isError: false })
		render(<SidebarActivity workspaceId="ws-1" />)
		expect(screen.getByTestId('sidebar-activity-loading')).toBeInTheDocument()
	})

	it('renders nothing when the sessions query errors', () => {
		mockUseActiveAgents.mockReturnValue({ agents: [], isLoading: false, isError: true })
		const { container } = render(<SidebarActivity workspaceId="ws-1" />)
		expect(container).toBeEmptyDOMElement()
	})

	it('hides the card and shows the bare dot in icon-collapsed mode', () => {
		mockUseActiveAgents.mockReturnValue({
			agents: [agent()],
			isLoading: false,
			isError: false,
		})
		render(<SidebarActivity workspaceId="ws-1" />)
		expect(card().className).toContain('group-data-[collapsible=icon]:hidden')
		expect(screen.getByLabelText('Agents').className).toContain(
			'group-data-[collapsible=icon]:grid',
		)
	})
})
