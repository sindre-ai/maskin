import type { MessageResponse } from '@/lib/api'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { TestWrapper } from '../../setup'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

vi.mock('@/lib/auth', () => ({
	getStoredActor: () => ({ id: 'human-1', name: 'You', type: 'human' }),
}))

// The REFERENCED rail renders each context object through <ObjectReference>,
// which resolves the title itself — so the mock answers per id rather than
// returning one fixed object.
vi.mock('@/hooks/use-objects', () => ({
	useObject: (id: string) => ({
		data: {
			id,
			workspaceId: 'ws-1',
			type: 'bet',
			title: { 'obj-1': 'First bet', 'obj-2': 'Second bet' }[id] ?? 'Retry window',
			status: 'active',
		},
		isLoading: false,
	}),
}))

import { MessageBubble } from '@/components/chat/message-bubble'

function buildMessage(overrides: Partial<MessageResponse> = {}): MessageResponse {
	return {
		id: 1,
		conversationId: 'convo-1',
		actorId: 'human-1',
		actorName: 'You',
		actorType: 'human',
		kind: 'message',
		content: 'hey team',
		metadata: null,
		sessionId: null,
		createdAt: new Date().toISOString(),
		editedAt: null,
		...overrides,
	}
}

function renderBubble(message: MessageResponse) {
	return render(<MessageBubble workspaceId="ws-1" message={message} />, { wrapper: TestWrapper })
}

const CHART_MESSAGE = [
	'Signup completion by step:',
	'',
	'```chart',
	JSON.stringify({
		type: 'bar',
		x: 'step',
		series: ['completed'],
		data: [{ step: 'Email', completed: 820 }],
		caption: 'Drop-off concentrates on step two.',
	}),
	'```',
].join('\n')

describe('MessageBubble', () => {
	it('renders an own message as an ink plate with no avatar or name', () => {
		renderBubble(buildMessage({ content: 'Here is what I found.' }))
		const body = screen.getByText('Here is what I found.')
		expect(body.parentElement?.className).toContain('bg-primary')
		expect(screen.queryByText('You')).not.toBeInTheDocument()
	})

	it('renders another actor as an avatar + name with no card wrapper', () => {
		const { container } = renderBubble(
			buildMessage({ actorId: 'agent-1', actorName: 'Billing Agent', actorType: 'agent' }),
		)
		expect(screen.getByText('Billing Agent')).toBeInTheDocument()
		// v2 drops the bordered card around an agent's body — it sits on the page.
		expect(container.querySelector('.border.border-border.bg-card')).toBeNull()
	})

	it('lifts attached objects above an own message under a YOU ATTACHED label', () => {
		renderBubble(
			buildMessage({
				metadata: { context_objects: [{ id: 'obj-1', title: 'First bet', type: 'bet' }] },
			}),
		)
		const label = screen.getByText('You attached')
		expect(label.className).toContain('eyebrow')
		// The chips row is a sibling of the plate, not a child of it.
		expect(label.closest('div')?.className).not.toContain('bg-primary')
	})

	it('renders a REFERENCED rail under an agent message body', () => {
		renderBubble(
			buildMessage({
				actorId: 'agent-1',
				actorName: 'Billing Agent',
				actorType: 'agent',
				metadata: { context_objects: [{ id: 'obj-1', title: 'First bet', type: 'bet' }] },
			}),
		)
		expect(screen.getByText('Referenced')).toBeInTheDocument()
		expect(screen.getByRole('link', { name: /First bet/ })).toBeInTheDocument()
	})

	it('renders a system message as a hairline divider, not a pill', () => {
		const { container } = renderBubble(
			buildMessage({ kind: 'system', content: 'Billing Agent joined' }),
		)
		expect(screen.getByText('Billing Agent joined')).toBeInTheDocument()
		expect(container.querySelectorAll('.bg-border')).toHaveLength(2)
		expect(container.querySelector('.rounded-full')).toBeNull()
	})
})

describe('MessageBubble — agent data-viz', () => {
	it('renders a fenced chart block from an incoming agent message as a visual', () => {
		renderBubble(
			buildMessage({
				actorId: 'agent-1',
				actorName: 'Billing Agent',
				actorType: 'agent',
				content: CHART_MESSAGE,
			}),
		)

		// The caption belongs to the rendered figure, not to a code block.
		expect(screen.getByText('Drop-off concentrates on step two.')).toBeInTheDocument()
		expect(screen.queryByText(/"type": "bar"/)).not.toBeInTheDocument()
	})
})

describe('MessageBubble mentions', () => {
	it('renders an @mention chip for metadata.mentions, resolved via participantNames', () => {
		const message = buildMessage({ metadata: { mentions: ['agent-1'] } })
		const participantNames = new Map([['agent-1', 'Builder']])
		render(
			<MessageBubble workspaceId="ws-1" message={message} participantNames={participantNames} />,
			{ wrapper: TestWrapper },
		)
		expect(screen.getByText('@Builder')).toBeInTheDocument()
	})

	it('falls back to the raw actor id when the name is not resolvable', () => {
		renderBubble(
			buildMessage({
				actorId: 'other-1',
				actorName: 'Someone Else',
				metadata: { mentions: ['agent-unknown'] },
			}),
		)
		expect(screen.getByText('@agent-unknown')).toBeInTheDocument()
	})

	it('renders no context row when there are no mentions, objects, or notifications', () => {
		renderBubble(buildMessage())
		expect(screen.queryByLabelText('Attached context')).not.toBeInTheDocument()
	})
})

describe('MessageBubble context objects/notifications', () => {
	it('renders one chip per selected object and notification, in order', () => {
		renderBubble(
			buildMessage({
				metadata: {
					context_objects: [
						{ id: 'obj-1', title: 'First bet', type: 'bet' },
						{ id: 'obj-2', title: 'Second bet', type: 'bet' },
					],
					context_notifications: [{ id: 'notif-1', title: 'Heads up' }],
				},
			}),
		)
		expect(screen.getByText('First bet')).toBeInTheDocument()
		expect(screen.getByText('Second bet')).toBeInTheDocument()
		expect(screen.getByText('Heads up')).toBeInTheDocument()
	})
})

describe('MessageBubble pending final output', () => {
	const agentMessage = () =>
		buildMessage({
			actorId: 'agent-1',
			actorName: 'Builder',
			actorType: 'agent',
			content: 'Here is **the answer**.',
			metadata: { source: 'final_output' },
			createdAt: null,
		})

	it('shows a finishing-up status instead of a timestamp while unsaved', () => {
		render(<MessageBubble workspaceId="ws-1" message={agentMessage()} pending />, {
			wrapper: TestWrapper,
		})
		expect(screen.getByText('Finishing up…')).toBeInTheDocument()
	})

	it('says the output is not saved once the persisted row is overdue', () => {
		render(<MessageBubble workspaceId="ws-1" message={agentMessage()} pending unconfirmed />, {
			wrapper: TestWrapper,
		})
		// The text stays on screen — losing the agent's answer would be worse
		// than showing it unlabelled — but it is not passed off as saved.
		expect(screen.getByText('Not saved yet')).toBeInTheDocument()
		expect(screen.getByText('the answer')).toBeInTheDocument()
	})

	it('renders the pending content as markdown, not escaped text', () => {
		render(<MessageBubble workspaceId="ws-1" message={agentMessage()} pending />, {
			wrapper: TestWrapper,
		})
		expect(screen.getByText('the answer').tagName).toBe('STRONG')
	})

	it('renders a normal timestamp when not pending', () => {
		const message = { ...agentMessage(), createdAt: new Date().toISOString() }
		renderBubble(message)
		expect(screen.queryByText('Finishing up…')).not.toBeInTheDocument()
	})
})

describe('MessageBubble edit and retry', () => {
	it('shows edit and retry actions on own persisted messages', () => {
		renderBubble(buildMessage())
		expect(screen.getByLabelText('Edit message')).toBeInTheDocument()
		expect(screen.getByLabelText('Ask agents to respond again')).toBeInTheDocument()
	})

	it("hides the actions on other participants' messages", () => {
		renderBubble(buildMessage({ actorId: 'other-1', actorName: 'Someone Else' }))
		expect(screen.queryByLabelText('Edit message')).not.toBeInTheDocument()
		expect(screen.queryByLabelText('Ask agents to respond again')).not.toBeInTheDocument()
	})

	it('opens an inline editor prefilled with the current content when edit is clicked', async () => {
		const user = userEvent.setup()
		renderBubble(buildMessage())
		await user.click(screen.getByLabelText('Edit message'))
		const editor = screen.getByLabelText('Edit message', { selector: 'textarea' })
		expect(editor).toHaveValue('hey team')
		expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
	})

	it('marks edited messages with an (edited) label', () => {
		renderBubble(buildMessage({ editedAt: new Date().toISOString() }))
		expect(screen.getByText('(edited)')).toBeInTheDocument()
	})
})

describe('MessageBubble redo on agent responses', () => {
	it('shows a redo action on an agent final-output message that knows its triggering message', () => {
		renderBubble(
			buildMessage({
				actorId: 'agent-1',
				actorName: 'Builder',
				actorType: 'agent',
				metadata: { source: 'final_output', final_output: { dedupe_key: 'k1', message_id: 42 } },
			}),
		)
		expect(screen.getByLabelText('Redo this response')).toBeInTheDocument()
	})

	it('hides the redo action when the triggering message is unknown', () => {
		renderBubble(
			buildMessage({
				actorId: 'agent-1',
				actorName: 'Builder',
				actorType: 'agent',
				metadata: { source: 'final_output', final_output: { dedupe_key: 'k1', message_id: null } },
			}),
		)
		expect(screen.queryByLabelText('Redo this response')).not.toBeInTheDocument()
	})
})
