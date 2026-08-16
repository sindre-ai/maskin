import { AgentWorkingBadge } from '@/components/shared/agent-working-badge'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { buildActorResponse, buildSessionResponse } from '../../factories'
import { TestWrapper } from '../../setup'

vi.mock('@/hooks/use-sessions', () => ({
	useSession: vi.fn(() => ({ data: buildSessionResponse({ actorId: 'actor-1' }) })),
	useSessionLogs: vi.fn(() => ({ data: [] })),
}))

vi.mock('@/hooks/use-actors', () => ({
	useActor: vi.fn(() => ({ data: buildActorResponse({ name: 'Scout Agent', type: 'agent' }) })),
}))

vi.mock('@/hooks/use-duration', () => ({
	useDuration: vi.fn(() => '3m 15s'),
}))

import { useActor } from '@/hooks/use-actors'
import { useDuration } from '@/hooks/use-duration'
import { useSession, useSessionLogs } from '@/hooks/use-sessions'

function logRow(stream: 'stdout' | 'stderr' | 'system', content: string, id = 1) {
	return { id, sessionId: 's', stream, content, createdAt: null }
}

describe('AgentWorkingBadge', () => {
	it('renders with compact variant showing agent name', () => {
		render(<AgentWorkingBadge sessionId="sess-1" workspaceId="ws-1" />, { wrapper: TestWrapper })
		expect(screen.getByText(/Scout Agent/)).toBeInTheDocument()
	})

	it('renders with banner variant', () => {
		render(<AgentWorkingBadge sessionId="sess-1" workspaceId="ws-1" variant="banner" />, {
			wrapper: TestWrapper,
		})
		expect(screen.getByText('Scout Agent')).toBeInTheDocument()
	})

	it('shows agent name from actor data', () => {
		render(<AgentWorkingBadge sessionId="sess-1" workspaceId="ws-1" />, { wrapper: TestWrapper })
		expect(screen.getByText(/Scout Agent/)).toBeInTheDocument()
	})

	it('shows fallback text when no actor', () => {
		vi.mocked(useActor).mockReturnValue({ data: undefined } as ReturnType<typeof useActor>)
		render(<AgentWorkingBadge sessionId="sess-1" workspaceId="ws-1" />, { wrapper: TestWrapper })
		expect(screen.getByText(/Agent working/)).toBeInTheDocument()
	})

	it('shows a parsed activity preview from the latest log', () => {
		vi.mocked(useActor).mockReturnValue({
			data: buildActorResponse({ name: 'Scout Agent', type: 'agent' }),
		} as ReturnType<typeof useActor>)
		const assistant = JSON.stringify({
			type: 'assistant',
			message: { id: 'm1', content: [{ type: 'text', text: 'Analyzing codebase' }] },
		})
		vi.mocked(useSessionLogs).mockReturnValue({
			data: [logRow('stdout', assistant)],
		} as unknown as ReturnType<typeof useSessionLogs>)
		render(<AgentWorkingBadge sessionId="sess-1" workspaceId="ws-1" />, { wrapper: TestWrapper })
		expect(screen.getByText(/Analyzing codebase/)).toBeInTheDocument()
	})

	it('flips to "Agent" + idle preview once the agent finishes a turn', () => {
		vi.mocked(useActor).mockReturnValue({
			data: buildActorResponse({ name: 'Scout Agent', type: 'agent' }),
		} as ReturnType<typeof useActor>)
		const result = JSON.stringify({
			type: 'result',
			subtype: 'success',
			is_error: false,
			result: 'done',
		})
		vi.mocked(useSessionLogs).mockReturnValue({
			data: [logRow('stdout', result)],
		} as unknown as ReturnType<typeof useSessionLogs>)
		render(<AgentWorkingBadge sessionId="sess-1" workspaceId="ws-1" />, { wrapper: TestWrapper })
		expect(screen.getByText(/Awaiting input/)).toBeInTheDocument()
	})

	it('shows duration from useDuration', () => {
		vi.mocked(useSessionLogs).mockReturnValue({
			data: [],
		} as unknown as ReturnType<typeof useSessionLogs>)
		render(<AgentWorkingBadge sessionId="sess-1" workspaceId="ws-1" />, { wrapper: TestWrapper })
		expect(screen.getByText(/3m 15s/)).toBeInTheDocument()
	})

	it('shows current_activity row in banner variant when set', () => {
		vi.mocked(useSession).mockReturnValue({
			data: buildSessionResponse({ actorId: 'actor-1', currentActivity: 'Searching codebase' }),
		} as ReturnType<typeof useSession>)
		render(<AgentWorkingBadge sessionId="sess-1" workspaceId="ws-1" variant="banner" />, {
			wrapper: TestWrapper,
		})
		expect(screen.getByText('Searching codebase')).toBeInTheDocument()
	})

	it('omits the activity row in banner variant when current_activity is null', () => {
		vi.mocked(useSession).mockReturnValue({
			data: buildSessionResponse({ actorId: 'actor-1', currentActivity: null }),
		} as ReturnType<typeof useSession>)
		render(<AgentWorkingBadge sessionId="sess-1" workspaceId="ws-1" variant="banner" />, {
			wrapper: TestWrapper,
		})
		expect(screen.queryByRole('status')).not.toBeInTheDocument()
		// The activity dot span has no accessible role, so verify no extra text content
		expect(screen.queryByText(/Searching/)).not.toBeInTheDocument()
	})

	describe('expandable banner (chain-of-thought dropdown)', () => {
		it('auto-expands to show the accumulated step history while the agent is active', () => {
			const tool = JSON.stringify({
				type: 'assistant',
				message: {
					id: 'm1',
					content: [{ type: 'tool_use', id: 't1', name: 'search_objects', input: {} }],
				},
			})
			const text = JSON.stringify({
				type: 'assistant',
				message: { id: 'm2', content: [{ type: 'text', text: 'Found 3 matches' }] },
			})
			vi.mocked(useSessionLogs).mockReturnValue({
				data: [logRow('stdout', tool, 1), logRow('stdout', text, 2)],
			} as unknown as ReturnType<typeof useSessionLogs>)
			render(
				<AgentWorkingBadge sessionId="sess-1" workspaceId="ws-1" variant="banner" expandable />,
				{ wrapper: TestWrapper },
			)
			expect(screen.getAllByText('Using search_objects')).toHaveLength(1)
			// "Found 3 matches" appears twice: once as the header's live preview
			// (the latest step) and once as its own row in the expanded history.
			expect(screen.getAllByText('Found 3 matches')).toHaveLength(2)
		})

		it('shows a placeholder when the session has no steps yet', () => {
			vi.mocked(useSessionLogs).mockReturnValue({
				data: [],
			} as unknown as ReturnType<typeof useSessionLogs>)
			render(
				<AgentWorkingBadge sessionId="sess-1" workspaceId="ws-1" variant="banner" expandable />,
				{ wrapper: TestWrapper },
			)
			expect(screen.getByText('Starting…')).toBeInTheDocument()
		})

		it('collapses the step history when the trigger is clicked', () => {
			const tool = JSON.stringify({
				type: 'assistant',
				message: {
					id: 'm1',
					content: [{ type: 'tool_use', id: 't1', name: 'search_objects', input: {} }],
				},
			})
			vi.mocked(useSessionLogs).mockReturnValue({
				data: [logRow('stdout', tool)],
			} as unknown as ReturnType<typeof useSessionLogs>)
			render(
				<AgentWorkingBadge sessionId="sess-1" workspaceId="ws-1" variant="banner" expandable />,
				{ wrapper: TestWrapper },
			)
			// Header preview + expanded history row both show the same text.
			expect(screen.getAllByText('Using search_objects')).toHaveLength(2)
			fireEvent.click(screen.getByRole('button', { name: /toggle agent activity/i }))
			// Only the header preview remains once collapsed.
			expect(screen.getAllByText('Using search_objects')).toHaveLength(1)
		})

		it('collapses the step history once the agent goes idle awaiting input', () => {
			const result = JSON.stringify({
				type: 'result',
				subtype: 'success',
				is_error: false,
				result: 'done',
			})
			vi.mocked(useSessionLogs).mockReturnValue({
				data: [logRow('stdout', result)],
			} as unknown as ReturnType<typeof useSessionLogs>)
			render(
				<AgentWorkingBadge sessionId="sess-1" workspaceId="ws-1" variant="banner" expandable />,
				{ wrapper: TestWrapper },
			)
			expect(screen.queryByText('Starting…')).not.toBeInTheDocument()
		})
	})
})
