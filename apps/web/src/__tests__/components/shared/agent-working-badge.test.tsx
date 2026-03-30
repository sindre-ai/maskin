import { AgentWorkingBadge } from '@/components/shared/agent-working-badge'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { buildActorResponse, buildSessionResponse } from '../../factories'
import { TestWrapper } from '../../setup'

vi.mock('@/hooks/use-sessions', () => ({
	useSession: vi.fn(() => ({ data: buildSessionResponse({ actorId: 'actor-1' }) })),
	useSessionLatestLog: vi.fn(() => ({ data: null })),
}))

vi.mock('@/hooks/use-actors', () => ({
	useActor: vi.fn(() => ({ data: buildActorResponse({ name: 'Scout Agent', type: 'agent' }) })),
}))

vi.mock('@/hooks/use-duration', () => ({
	useDuration: vi.fn(() => '3m 15s'),
}))

import { useActor } from '@/hooks/use-actors'
import { useDuration } from '@/hooks/use-duration'
import { useSession, useSessionLatestLog } from '@/hooks/use-sessions'

describe('AgentWorkingBadge', () => {
	it('renders with compact variant showing agent name', () => {
		render(
			<AgentWorkingBadge sessionId="sess-1" workspaceId="ws-1" />,
			{ wrapper: TestWrapper },
		)
		expect(screen.getByText(/Scout Agent/)).toBeInTheDocument()
	})

	it('renders with banner variant', () => {
		render(
			<AgentWorkingBadge sessionId="sess-1" workspaceId="ws-1" variant="banner" />,
			{ wrapper: TestWrapper },
		)
		expect(screen.getByText('Scout Agent')).toBeInTheDocument()
	})

	it('shows agent name from actor data', () => {
		render(
			<AgentWorkingBadge sessionId="sess-1" workspaceId="ws-1" />,
			{ wrapper: TestWrapper },
		)
		expect(screen.getByText(/Scout Agent/)).toBeInTheDocument()
	})

	it('shows fallback text when no actor', () => {
		vi.mocked(useActor).mockReturnValue({ data: undefined } as ReturnType<typeof useActor>)
		render(
			<AgentWorkingBadge sessionId="sess-1" workspaceId="ws-1" />,
			{ wrapper: TestWrapper },
		)
		expect(screen.getByText(/Agent working/)).toBeInTheDocument()
	})

	it('shows latest log content', () => {
		vi.mocked(useActor).mockReturnValue({
			data: buildActorResponse({ name: 'Scout Agent', type: 'agent' }),
		} as ReturnType<typeof useActor>)
		vi.mocked(useSessionLatestLog).mockReturnValue({
			data: { content: 'Analyzing codebase' },
		} as ReturnType<typeof useSessionLatestLog>)
		render(
			<AgentWorkingBadge sessionId="sess-1" workspaceId="ws-1" />,
			{ wrapper: TestWrapper },
		)
		expect(screen.getByText(/Analyzing codebase/)).toBeInTheDocument()
	})

	it('shows duration from useDuration', () => {
		vi.mocked(useSessionLatestLog).mockReturnValue({
			data: null,
		} as unknown as ReturnType<typeof useSessionLatestLog>)
		render(
			<AgentWorkingBadge sessionId="sess-1" workspaceId="ws-1" />,
			{ wrapper: TestWrapper },
		)
		expect(screen.getByText(/3m 15s/)).toBeInTheDocument()
	})
})
