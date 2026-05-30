import { SessionDetailPanel } from '@/components/agents/session-detail-panel'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildSessionResponse } from '../../factories'
import { createWorkspaceWrapper } from '../../setup'

const createSessionMutate = vi.fn()
let createSessionIsPending = false

vi.mock('@/hooks/use-sessions', () => ({
	useSessionLogs: () => ({ data: [], isLoading: false }),
	useCreateSession: () => ({ mutate: createSessionMutate, isPending: createSessionIsPending }),
}))

vi.mock('@/hooks/use-events', () => ({
	useSessionAffectedObjects: () => ({ affectedObjects: [], isLoading: false }),
}))

vi.mock('@tanstack/react-router', () => ({
	Link: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}))

vi.mock('@/components/shared/relative-time', () => ({
	RelativeTime: () => <span>some time ago</span>,
}))

vi.mock('@/components/shared/markdown-content', () => ({
	MarkdownContent: ({ content }: { content: string }) => <div>{content}</div>,
}))

function renderPanel(session: ReturnType<typeof buildSessionResponse>) {
	const Wrapper = createWorkspaceWrapper()
	return render(
		<Wrapper>
			<SessionDetailPanel
				session={session}
				workspaceId="ws-1"
				open={true}
				onOpenChange={() => {}}
			/>
		</Wrapper>,
	)
}

beforeEach(() => {
	createSessionMutate.mockReset()
	createSessionIsPending = false
	vi.spyOn(console, 'info').mockImplementation(() => {})
})

afterEach(() => {
	vi.restoreAllMocks()
})

describe('SessionDetailPanel Restart button', () => {
	it.each(['failed', 'timeout', 'completed'])('renders Restart on terminal status %s', (status) => {
		renderPanel(buildSessionResponse({ status }))
		expect(screen.getByRole('button', { name: 'Restart' })).toBeInTheDocument()
	})

	it.each(['running', 'starting', 'paused', 'snapshotting', 'idle'])(
		'does not render Restart on non-terminal status %s',
		(status) => {
			renderPanel(buildSessionResponse({ status }))
			expect(screen.queryByRole('button', { name: 'Restart' })).not.toBeInTheDocument()
		},
	)

	it('on click, fires createSession with actor_id + action_prompt and emits a tracked event', async () => {
		const user = userEvent.setup()
		const session = buildSessionResponse({
			id: 'sess-1',
			status: 'failed',
			actorId: 'actor-xyz',
			actionPrompt: 'Re-run the agent',
		})
		renderPanel(session)

		await user.click(screen.getByRole('button', { name: 'Restart' }))

		expect(createSessionMutate).toHaveBeenCalledTimes(1)
		expect(createSessionMutate).toHaveBeenCalledWith({
			actor_id: 'actor-xyz',
			action_prompt: 'Re-run the agent',
		})

		const analyticsCalls = vi
			.mocked(console.info)
			.mock.calls.filter(([tag]) => tag === '[analytics]')
		expect(analyticsCalls).toHaveLength(1)
		const payload = analyticsCalls[0][1] as Record<string, unknown>
		expect(payload).toMatchObject({
			name: 'session_restart_clicked',
			source: 'session-detail-panel',
			session_id: 'sess-1',
			actor_id: 'actor-xyz',
			prior_status: 'failed',
		})
	})

	it('shows pending label and ignores clicks while the mutation is in flight', async () => {
		const user = userEvent.setup()
		createSessionIsPending = true
		renderPanel(buildSessionResponse({ status: 'failed' }))
		const button = screen.getByRole('button', { name: 'Restarting…' })
		expect(button).toBeDisabled()

		await user.click(button)
		expect(createSessionMutate).not.toHaveBeenCalled()
	})
})
