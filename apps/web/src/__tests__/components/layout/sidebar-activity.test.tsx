import { SidebarActivity } from '@/components/layout/sidebar-activity'
import type { ActiveAgent } from '@/hooks/use-active-agents'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockUseActiveAgents = vi.fn()

vi.mock('@/hooks/use-active-agents', () => ({
	useActiveAgents: (workspaceId: string) => mockUseActiveAgents(workspaceId),
}))

vi.mock('@/components/ui/sidebar', () => {
	const passthrough = ({ children, ...rest }: React.ComponentProps<'div'>) => (
		<div {...rest}>{children}</div>
	)
	return {
		SidebarGroup: passthrough,
		SidebarGroupContent: passthrough,
		SidebarGroupLabel: passthrough,
		SidebarMenu: passthrough,
		SidebarMenuItem: passthrough,
		SidebarMenuButton: ({ children, onClick, ...rest }: React.ComponentProps<'button'>) => (
			<button type="button" onClick={onClick} {...rest}>
				{children}
			</button>
		),
	}
})

vi.mock('@/components/ui/popover', () => ({
	Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
	PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
	PopoverContent: () => null,
}))

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

describe('SidebarActivity', () => {
	beforeEach(() => {
		mockUseActiveAgents.mockReset()
	})

	it('renders the "Activity" group label', () => {
		mockUseActiveAgents.mockReturnValue({ agents: [], isLoading: false, isError: false })
		render(<SidebarActivity workspaceId="ws-1" />)
		expect(screen.getByText('Activity')).toBeInTheDocument()
	})

	it('renders "No agents running" when list is empty (AC-U6)', () => {
		mockUseActiveAgents.mockReturnValue({ agents: [], isLoading: false, isError: false })
		render(<SidebarActivity workspaceId="ws-1" />)
		expect(screen.getByText('No agents running')).toBeInTheDocument()
	})

	it('renders one row per active agent with the current activity (AC-U4)', () => {
		mockUseActiveAgents.mockReturnValue({
			agents: [
				agent({ actorId: 'a-1', name: 'Planner', currentActivity: 'Reading files' }),
				agent({ actorId: 'a-2', name: 'Reviewer', currentActivity: 'Reviewing diff' }),
			],
			isLoading: false,
			isError: false,
		})
		render(<SidebarActivity workspaceId="ws-1" />)
		expect(screen.getByText('Planner')).toBeInTheDocument()
		expect(screen.getByText('Reading files')).toBeInTheDocument()
		expect(screen.getByText('Reviewer')).toBeInTheDocument()
		expect(screen.getByText('Reviewing diff')).toBeInTheDocument()
	})

	it('collapses beyond 5 rows with a "+N more" toggle (AC-U5)', () => {
		mockUseActiveAgents.mockReturnValue({
			agents: Array.from({ length: 7 }, (_, i) => agent({ actorId: `a-${i}`, name: `Agent ${i}` })),
			isLoading: false,
			isError: false,
		})
		render(<SidebarActivity workspaceId="ws-1" />)
		expect(screen.getByText('Agent 0')).toBeInTheDocument()
		expect(screen.getByText('Agent 4')).toBeInTheDocument()
		expect(screen.queryByText('Agent 5')).not.toBeInTheDocument()
		const more = screen.getByText('+2 more')
		expect(more).toBeInTheDocument()
	})

	it('expands inline when "+N more" is clicked and collapses again on second click (AC-U5)', () => {
		mockUseActiveAgents.mockReturnValue({
			agents: Array.from({ length: 7 }, (_, i) => agent({ actorId: `a-${i}`, name: `Agent ${i}` })),
			isLoading: false,
			isError: false,
		})
		render(<SidebarActivity workspaceId="ws-1" />)
		fireEvent.click(screen.getByText('+2 more'))
		expect(screen.getByText('Agent 5')).toBeInTheDocument()
		expect(screen.getByText('Agent 6')).toBeInTheDocument()
		fireEvent.click(screen.getByText('Show fewer'))
		expect(screen.queryByText('Agent 5')).not.toBeInTheDocument()
	})

	it('renders skeleton rows while loading (AC-T2)', () => {
		mockUseActiveAgents.mockReturnValue({ agents: [], isLoading: true, isError: false })
		render(<SidebarActivity workspaceId="ws-1" />)
		expect(screen.getByTestId('sidebar-activity-loading')).toBeInTheDocument()
	})

	it('renders nothing when the sessions query errors (AC-T2)', () => {
		mockUseActiveAgents.mockReturnValue({ agents: [], isLoading: false, isError: true })
		const { container } = render(<SidebarActivity workspaceId="ws-1" />)
		expect(container).toBeEmptyDOMElement()
	})

	it('exposes an accessible label for each icon-mode dot (AC-T3)', () => {
		mockUseActiveAgents.mockReturnValue({
			agents: [agent({ actorId: 'a-1', name: 'Planner', currentActivity: 'Reading files' })],
			isLoading: false,
			isError: false,
		})
		render(<SidebarActivity workspaceId="ws-1" />)
		expect(screen.getByLabelText(/Planner — Reading files/)).toBeInTheDocument()
	})
})
