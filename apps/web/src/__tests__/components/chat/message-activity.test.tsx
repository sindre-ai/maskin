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

	it('names the agent, says what it is doing, and lists its steps while in progress', () => {
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
		expect(screen.getByText('Workspace Coach')).toBeInTheDocument()
		// Still mid-tool-call, so it is not claiming to be writing yet.
		expect(screen.getByText('is working on it')).toBeInTheDocument()
		expect(screen.getByText('Using search_objects')).toBeInTheDocument()
		// A live turn is drawn open — there is no disclosure control to click.
		expect(screen.queryByRole('button', { name: /toggle/i })).not.toBeInTheDocument()
	})

	it('switches the verb to writing once the agent has stopped calling tools', () => {
		render(
			<MessageActivity
				workspaceId="ws-1"
				turn={buildTurn({
					inProgress: true,
					steps: [
						{ id: '1', kind: 'tool_use', text: 'Using search_objects' },
						{ id: '2', kind: 'text', text: 'Drafting the reply' },
					],
				})}
			/>,
			{ wrapper: TestWrapper },
		)
		expect(screen.getByText('is writing a reply')).toBeInTheDocument()
	})

	it('shows a "Starting…" placeholder when in progress with no steps yet', () => {
		render(<MessageActivity workspaceId="ws-1" turn={buildTurn({ inProgress: true })} />, {
			wrapper: TestWrapper,
		})
		expect(screen.getByText('Starting…')).toBeInTheDocument()
	})

	it('collapses a finished turn to what it last did, expandable to the full trace', () => {
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
		// The trigger reads as what the agent did, not as its name — the message
		// beside it already carries the name.
		expect(screen.getByText('Checked the funnel by channel')).toBeInTheDocument()
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
