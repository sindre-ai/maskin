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

import { MessageActivity, toolSources } from '@/components/chat/message-activity'
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

	it('auto-expands and shows a working label while in progress', () => {
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
		expect(screen.getByText('Workspace Coach is working…')).toBeInTheDocument()
		expect(screen.getByText('Using search_objects')).toBeInTheDocument()
	})

	it('shows a "Starting…" placeholder when in progress with no steps yet', () => {
		render(<MessageActivity workspaceId="ws-1" turn={buildTurn({ inProgress: true })} />, {
			wrapper: TestWrapper,
		})
		expect(screen.getByText('Starting…')).toBeInTheDocument()
	})

	it('collapses a finished turn by default, expandable by clicking the trigger', () => {
		render(
			<MessageActivity
				workspaceId="ws-1"
				turn={buildTurn({
					steps: [{ id: '1', kind: 'tool_use', text: 'Using search_objects' }],
				})}
			/>,
			{ wrapper: TestWrapper },
		)
		expect(screen.getByText('Workspace Coach')).toBeInTheDocument()
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

	it('offers a Stop control only while the turn is in progress', () => {
		const { unmount } = render(
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
		unmount()

		render(
			<MessageActivity
				workspaceId="ws-1"
				turn={buildTurn({ steps: [{ id: '1', kind: 'tool_use', text: 'Using search_objects' }] })}
			/>,
			{ wrapper: TestWrapper },
		)
		expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument()
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

	it('summarises the sources it is reading as pills once the step list is collapsed', () => {
		render(
			<MessageActivity
				workspaceId="ws-1"
				turn={buildTurn({
					inProgress: true,
					steps: [
						{ id: '1', kind: 'tool_use', text: 'Reading Q3 pricing bet' },
						{ id: '2', kind: 'text', text: 'thinking out loud' },
					],
				})}
			/>,
			{ wrapper: TestWrapper },
		)

		// Expanded (the default for a live turn) the step list already says it —
		// no pills, no duplicate strings on screen.
		expect(screen.queryByRole('list', { name: 'Sources being read' })).not.toBeInTheDocument()

		fireEvent.click(screen.getByRole('button', { name: /toggle workspace coach activity/i }))
		const pills = screen.getByRole('list', { name: 'Sources being read' })
		expect(pills).toHaveTextContent('Reading Q3 pricing bet')
		expect(pills).not.toHaveTextContent('thinking out loud')
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

describe('toolSources', () => {
	it('keeps the newest distinct tool calls, capped at three', () => {
		expect(
			toolSources([
				{ id: '1', kind: 'tool_use', text: 'A' },
				{ id: '2', kind: 'text', text: 'not a tool' },
				{ id: '3', kind: 'tool_use', text: 'B' },
				{ id: '4', kind: 'tool_use', text: 'B' },
				{ id: '5', kind: 'tool_use', text: 'C' },
				{ id: '6', kind: 'tool_use', text: 'D' },
			]),
		).toEqual(['D', 'C', 'B'])
	})
})
