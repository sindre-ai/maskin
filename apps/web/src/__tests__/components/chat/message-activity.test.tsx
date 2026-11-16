import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { buildActorResponse } from '../../factories'
import { TestWrapper } from '../../setup'

vi.mock('@/hooks/use-actors', () => ({
	useActor: vi.fn(() => ({ data: buildActorResponse({ name: 'Workspace Coach', type: 'agent' }) })),
}))

const mockUseSession = vi.fn(() => ({ data: undefined }))
vi.mock('@/hooks/use-sessions', () => ({
	useSession: (...args: unknown[]) => mockUseSession(...(args as [])),
	useStopSession: () => ({ mutate: vi.fn(), isPending: false }),
}))

import { MessageActivity } from '@/components/chat/message-activity'
import type { MessageTurnActivity } from '@/hooks/use-conversation-activity'

function buildTurn(overrides: Partial<MessageTurnActivity> = {}): MessageTurnActivity {
	return {
		sessionId: 'sess-1',
		actorId: 'agent-1',
		steps: [],
		inProgress: false,
		...overrides,
	}
}

describe('MessageActivity', () => {
	it('renders nothing for a finished turn with no steps', () => {
		const { container } = render(<MessageActivity workspaceId="ws-1" turn={buildTurn()} />, {
			wrapper: TestWrapper,
		})
		expect(container).toBeEmptyDOMElement()
	})

	it('names the agent and says in plain words what it is doing while in progress', () => {
		render(
			<MessageActivity
				workspaceId="ws-1"
				turn={buildTurn({
					inProgress: true,
					steps: [
						{ id: '1', kind: 'tool_use', text: 'Get comments', tool: 'mcp__maskin__get_comments' },
					],
				})}
			/>,
			{ wrapper: TestWrapper },
		)
		expect(screen.getByText('Workspace Coach')).toBeInTheDocument()
		expect(screen.getByText('Reading comments')).toBeInTheDocument()
		// The raw tool name stays out of sight until the steps are opened.
		expect(screen.queryByText('Get comments')).not.toBeInTheDocument()
	})

	it('keeps the live step list closed until "Show steps" is clicked', () => {
		render(
			<MessageActivity
				workspaceId="ws-1"
				turn={buildTurn({
					inProgress: true,
					steps: [
						{ id: '1', kind: 'thinking', text: 'Thinking…' },
						{ id: '2', kind: 'tool_use', text: 'Get comments', tool: 'mcp__maskin__get_comments' },
					],
				})}
			/>,
			{ wrapper: TestWrapper },
		)
		expect(screen.queryByLabelText('Agent activity')).not.toBeInTheDocument()
		expect(screen.queryByText('THOUGHT')).not.toBeInTheDocument()
		fireEvent.click(screen.getByRole('button', { name: 'Show steps' }))
		expect(screen.getByLabelText('Agent activity')).toBeInTheDocument()
		expect(screen.getByText('Get comments')).toBeInTheDocument()
		fireEvent.click(screen.getByRole('button', { name: 'Hide steps' }))
		expect(screen.queryByLabelText('Agent activity')).not.toBeInTheDocument()
	})

	it('never shows Bash or a thought as the plain line', () => {
		render(
			<MessageActivity
				workspaceId="ws-1"
				turn={buildTurn({
					inProgress: true,
					steps: [
						{ id: '1', kind: 'tool_use', text: 'Get comments', tool: 'mcp__maskin__get_comments' },
						{ id: '2', kind: 'tool_use', text: 'Bash', tool: 'Bash' },
						{ id: '3', kind: 'thinking', text: 'Thinking…' },
					],
				})}
			/>,
			{ wrapper: TestWrapper },
		)
		expect(screen.getByText('Reading comments')).toBeInTheDocument()
		expect(screen.queryByText('Bash')).not.toBeInTheDocument()
	})

	it('says it is writing a reply once the agent is writing text', () => {
		render(
			<MessageActivity
				workspaceId="ws-1"
				turn={buildTurn({
					inProgress: true,
					steps: [
						{ id: '1', kind: 'tool_use', text: 'Get comments', tool: 'mcp__maskin__get_comments' },
						{ id: '2', kind: 'text', text: 'Drafting the reply' },
					],
				})}
			/>,
			{ wrapper: TestWrapper },
		)
		expect(screen.getByText('Writing a reply')).toBeInTheDocument()
	})

	it('shows a "Starting…" placeholder when in progress with no steps yet', () => {
		render(<MessageActivity workspaceId="ws-1" turn={buildTurn({ inProgress: true })} />, {
			wrapper: TestWrapper,
		})
		expect(screen.getByText('Starting…')).toBeInTheDocument()
	})

	it('renders the Stop button on a running live turn', () => {
		render(
			<MessageActivity
				workspaceId="ws-1"
				turn={buildTurn({
					inProgress: true,
					steps: [{ id: '1', kind: 'tool_use', text: 'Using search_objects' }],
				})}
			/>,
			{ wrapper: TestWrapper },
		)
		expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument()
	})

	it('hides the Stop button while the session is still booting (no live process to stop)', () => {
		render(
			<MessageActivity workspaceId="ws-1" turn={buildTurn({ inProgress: true, starting: true })} />,
			{ wrapper: TestWrapper },
		)
		// The spinner is still there so the user knows a reply is coming, but
		// there is no container/agent-server to stop yet — clicking Stop would
		// 400 with "no container" and silently fail, which is the reported bug.
		expect(screen.getByText('Starting…')).toBeInTheDocument()
		expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument()
	})

	it('collapses a finished turn to "Show work", expandable to the full trace', () => {
		render(
			<MessageActivity
				workspaceId="ws-1"
				turn={buildTurn({
					steps: [
						{ id: '1', kind: 'tool_use', text: 'Using search_objects' },
						{ id: '2', kind: 'text', text: 'Checked the funnel by channel' },
					],
				})}
			/>,
			{ wrapper: TestWrapper },
		)
		// The trigger never repeats the last step's tool name.
		expect(screen.getByText('Show work')).toBeInTheDocument()
		expect(screen.queryByText('Checked the funnel by channel')).not.toBeInTheDocument()
		expect(screen.queryByText('Using search_objects')).not.toBeInTheDocument()
		fireEvent.click(screen.getByRole('button', { name: /toggle workspace coach activity/i }))
		expect(screen.getByText('Using search_objects')).toBeInTheDocument()
	})

	it('auto-expands and shows a failure notice for a session that failed to start', () => {
		render(<MessageActivity workspaceId="ws-1" turn={buildTurn({ failed: true })} />, {
			wrapper: TestWrapper,
		})
		expect(screen.getByText('Workspace Coach failed to start')).toBeInTheDocument()
		expect(screen.getByText('The session could not be started.')).toBeInTheDocument()
	})

	it('shows how long the live turn has been running, off the session start time', () => {
		mockUseSession.mockReturnValue({
			data: { startedAt: new Date(Date.now() - 5 * 60_000).toISOString() },
		} as never)
		render(
			<MessageActivity
				workspaceId="ws-1"
				turn={buildTurn({
					inProgress: true,
					steps: [{ id: '1', kind: 'tool_use', text: 'Using search_objects' }],
				})}
			/>,
			{ wrapper: TestWrapper },
		)

		expect(screen.getByText('5m 0s')).toBeInTheDocument()
		mockUseSession.mockReturnValue({ data: undefined })
	})

	it('drops the avatar gutter when rendered inline inside the agent message', () => {
		const { container } = render(
			<MessageActivity
				workspaceId="ws-1"
				layout="inline"
				turn={buildTurn({ steps: [{ id: '1', kind: 'text', text: 'Checked the funnel' }] })}
			/>,
			{ wrapper: TestWrapper },
		)
		expect(container.querySelector('.pl-\\[39px\\]')).toBeNull()
	})

	it('shows the failure error message when the failed session recorded one', () => {
		render(
			<MessageActivity
				workspaceId="ws-1"
				turn={buildTurn({
					failed: true,
					steps: [{ id: '1', kind: 'error', text: 'No available LLM credentials' }],
				})}
			/>,
			{ wrapper: TestWrapper },
		)
		expect(screen.getByText('No available LLM credentials')).toBeInTheDocument()
	})
})
