import { AgentWorkingBadge } from '@/components/shared/agent-working-badge'
import { render, screen } from '@testing-library/react'
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

function logRow(stream: 'stdout' | 'stderr' | 'system', content: string) {
	return { id: 1, sessionId: 's', stream, content, createdAt: null }
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
})
