import type { MessageResponse } from '@/lib/api'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
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
		const label = screen.getByText('You attached')
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

describe('MessageBubble — agent data-viz', () => {
	it('renders a fenced chart block from an incoming agent message as a visual', async () => {
		renderBubble(buildMessage({ content: CHART_MESSAGE }))

		// CommentVisual is lazy-loaded to keep recharts out of the shared bundle;
		// findByText awaits the dynamic import resolving. The caption belongs to
		// the rendered figure, not to a code block.
		expect(
			await screen.findByText('Drop-off concentrates on step two.', undefined, { timeout: 5000 }),
		).toBeInTheDocument()
		expect(screen.queryByText(/"type": "bar"/)).not.toBeInTheDocument()
	})
})
