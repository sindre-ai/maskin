import type { MessageResponse } from '@/lib/api'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TestWrapper } from '../../setup'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

vi.mock('@/lib/auth', () => ({ getStoredActor: () => ({ id: 'me', name: 'Me', type: 'human' }) }))

vi.mock('@/hooks/use-objects', () => ({
	useObject: () => ({
		data: {
			id: 'obj-1',
			workspaceId: 'ws-1',
			type: 'bet',
			title: 'Retry window',
			status: 'active',
		},
		isLoading: false,
	}),
}))

const retryMutate = vi.fn()
vi.mock('@/hooks/use-conversation', () => ({
	useEditMessage: () => ({ mutate: vi.fn(), isPending: false }),
	useRetryMessage: () => ({ mutate: retryMutate, isPending: false }),
}))

import { MessageBubble } from '@/components/chat/message-bubble'

function buildMessage(overrides: Partial<MessageResponse> = {}): MessageResponse {
	return {
		id: 1,
		conversationId: 'conv-1',
		actorId: 'agent-1',
		actorName: 'Billing Agent',
		actorType: 'agent',
		kind: 'message',
		content: 'Here is what I found.',
		metadata: null,
		editedAt: null,
		sessionId: null,
		createdAt: new Date().toISOString(),
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
		renderBubble(buildMessage({ actorId: 'me', actorName: 'Me', actorType: 'human' }))
		const body = screen.getByText('Here is what I found.')
		expect(body.parentElement?.className).toContain('bg-primary')
		expect(screen.queryByText('Me')).not.toBeInTheDocument()
	})

	it('renders another actor as an avatar + name with no card wrapper', () => {
		const { container } = renderBubble(buildMessage())
		expect(screen.getByText('Billing Agent')).toBeInTheDocument()
		// v2 drops the bordered card around an agent's body — it sits on the page.
		expect(container.querySelector('.border.border-border.bg-card')).toBeNull()
	})

	it('lifts attached objects above an own message under a YOU ATTACHED label', () => {
		renderBubble(
			buildMessage({
				actorId: 'me',
				actorName: 'Me',
				actorType: 'human',
				metadata: { context_objects: [{ id: 'obj-1', title: 'Retry window', type: 'bet' }] },
			}),
		)
		// Raw source string is uppercase — the .eyebrow class only renders visual
		// case, but v4 fixes the DOM text so it's semantically an eyebrow too.
		const label = screen.getByText('YOU ATTACHED')
		expect(label.className).toContain('eyebrow')
		// The chips row is a sibling of the plate, not a child of it.
		expect(label.closest('div')?.className).not.toContain('bg-primary')
	})

	it('renders a REFERENCED rail under an agent message body', () => {
		renderBubble(
			buildMessage({
				metadata: { context_objects: [{ id: 'obj-1', title: 'Retry window', type: 'bet' }] },
			}),
		)
		expect(screen.getByText('Referenced')).toBeInTheDocument()
		expect(screen.getByRole('link', { name: /Retry window/ })).toBeInTheDocument()
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

describe('MessageBubble — agent hover row (v4)', () => {
	beforeEach(() => {
		retryMutate.mockReset()
	})

	it('renders Copy and Retry buttons on an agent message', () => {
		renderBubble(buildMessage())
		expect(screen.getByRole('button', { name: 'Copy message' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
	})

	it('deliberately does NOT render Rate up / Rate down on the agent hover row', () => {
		renderBubble(buildMessage())
		expect(screen.queryByRole('button', { name: /rate up/i })).not.toBeInTheDocument()
		expect(screen.queryByRole('button', { name: /rate down/i })).not.toBeInTheDocument()
	})

	it('copies the message text to the clipboard when Copy is clicked', async () => {
		const writeText = vi.fn().mockResolvedValue(undefined)
		Object.defineProperty(navigator, 'clipboard', {
			configurable: true,
			value: { writeText },
		})
		renderBubble(buildMessage({ content: 'Hello from the agent.' }))
		fireEvent.click(screen.getByRole('button', { name: 'Copy message' }))
		expect(writeText).toHaveBeenCalledWith('Hello from the agent.')
	})

	it('triggers the existing regenerate mutation with the message id when Retry is clicked', () => {
		renderBubble(buildMessage({ id: 42 }))
		fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
		expect(retryMutate).toHaveBeenCalledWith({ messageId: 42 })
	})

	it('leaves the user branch hover row unchanged (Edit + Retry, no new Copy)', () => {
		renderBubble(buildMessage({ actorId: 'me', actorName: 'Me', actorType: 'human', id: 7 }))
		// The pre-v4 own-message action row uses Edit + Retry; v4 must not add
		// a new "Copy message" button here. (The label 'Copy message' is the
		// agent branch's new button — asserting it is absent proves the user
		// row still has the same two actions it had before.)
		expect(screen.getByRole('button', { name: 'Edit message' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /Ask agents to respond again/ })).toBeInTheDocument()
		expect(screen.queryByRole('button', { name: 'Copy message' })).not.toBeInTheDocument()
	})

	it('does not render the hover row on an optimistic bubble (id ≤ 0)', () => {
		renderBubble(buildMessage({ id: -1 }))
		expect(screen.queryByRole('button', { name: 'Copy message' })).not.toBeInTheDocument()
		expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
	})
})

describe('MessageBubble — agent data-viz', () => {
	it('renders a fenced chart block from an incoming agent message as a visual', () => {
		renderBubble(buildMessage({ content: CHART_MESSAGE }))

		// The caption belongs to the rendered figure, not to a code block.
		expect(screen.getByText('Drop-off concentrates on step two.')).toBeInTheDocument()
		expect(screen.queryByText(/"type": "bar"/)).not.toBeInTheDocument()
	})
})
