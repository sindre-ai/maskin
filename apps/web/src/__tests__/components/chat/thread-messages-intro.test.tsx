import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TestWrapper } from '../../setup'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

vi.mock('@/lib/auth', () => ({ getStoredActor: () => ({ id: 'me', name: 'Me', type: 'human' }) }))

vi.mock('@/lib/api', () => ({
	api: {
		conversations: {
			get: vi.fn(),
			messages: vi.fn(),
		},
	},
}))

let actorsQuery: { isSuccess: boolean; data?: Array<{ id: string }> } = { isSuccess: false }
vi.mock('@/hooks/use-actors', () => ({ useActors: () => actorsQuery }))

// The rows have their own tests; here only whether the block is drawn matters.
vi.mock('@/components/chat/needed-tools', () => ({
	NeededTools: ({ tools }: { tools: Array<{ provider: string }> }) => (
		<div data-testid="needed-tools">{tools.map((t) => t.provider).join(',')}</div>
	),
}))

import { ThreadMessages } from '@/components/chat/thread-messages'
import type { MessageResponse } from '@/lib/api'
import { api } from '@/lib/api'

const BODY = [
	"Hey Sam, I'm Scout.",
	'Start with one of these, or tell me what you need.',
	'1. Read my inbox\n2. Draft a reply',
	"For this job I use Gmail. Add any that aren't connected yet under Settings, Integrations.",
].join('\n\n')

const STEPS = [
	{ label: 'Read my inbox', prompt: 'Read my inbox', action: 'send' },
	{ label: 'Draft a reply', prompt: 'Draft a reply to: ', action: 'fill' },
]

function message(id: number, overrides: Partial<MessageResponse> = {}): MessageResponse {
	return {
		id,
		conversationId: 'conv-1',
		actorId: 'me',
		actorName: 'Me',
		actorType: 'human',
		kind: 'message',
		content: `message ${id}`,
		metadata: null,
		editedAt: null,
		sessionId: null,
		createdAt: new Date(2026, 0, 1, 0, 0, id).toISOString(),
		...overrides,
	}
}

function intro(overrides: Partial<MessageResponse> = {}): MessageResponse {
	return message(1, {
		actorId: 'agent-1',
		actorName: 'Scout',
		actorType: 'agent',
		content: BODY,
		metadata: {
			delivery: { kind: 'agent_intro', version: 1 },
			suggested_steps: STEPS,
			needed_tools: [{ provider: 'gmail' }],
			plain_tail: 2,
		} as never,
		...overrides,
	})
}

function mockMessages(...newestFirst: MessageResponse[]) {
	vi.mocked(api.conversations.messages).mockResolvedValue({
		messages: newestFirst,
		has_more: false,
	} as never)
}

function renderThread(props: Partial<React.ComponentProps<typeof ThreadMessages>> = {}) {
	const onPickStep = vi.fn()
	const onSendStep = vi.fn()
	const view = render(
		<ThreadMessages
			workspaceId="ws-1"
			conversationId="conv-1"
			onPickStep={onPickStep}
			onSendStep={onSendStep}
			{...props}
		/>,
		{ wrapper: TestWrapper },
	)
	return { onPickStep, onSendStep, unmount: view.unmount }
}

describe('ThreadMessages — agent intro steps and tools', () => {
	beforeEach(() => {
		actorsQuery = { isSuccess: false }
		vi.mocked(api.conversations.get).mockReset()
		vi.mocked(api.conversations.messages).mockReset()
		vi.mocked(api.conversations.get).mockResolvedValue({
			id: 'conv-1',
			participants: [],
			last_read_message_id: null,
		} as never)
	})

	it('draws the buttons and the tool block and drops the plain list and tools sentence', async () => {
		mockMessages(intro())
		renderThread()

		expect(
			await screen.findByText('Start with one of these, or tell me what you need.'),
		).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /Read my inbox/ })).toBeInTheDocument()
		expect(screen.getByTestId('needed-tools')).toHaveTextContent('gmail')
		expect(screen.queryByText(/1\. Read my inbox/)).not.toBeInTheDocument()
		expect(screen.queryByText(/For this job I use Gmail/)).not.toBeInTheDocument()
	})

	it('sends a send step with the intro message id and the step index as the marker', async () => {
		mockMessages(intro())
		const { onSendStep } = renderThread()

		await userEvent.click(await screen.findByRole('button', { name: /Read my inbox/ }))

		expect(onSendStep).toHaveBeenCalledWith('Read my inbox', {
			from_suggested_step: { intro_message_id: 1, index: 0 },
		})
	})

	it('shows the whole body and draws nothing when the steps do not parse', async () => {
		mockMessages(
			intro({
				metadata: {
					suggested_steps: [{ label: 'x', prompt: 'y', action: 'send' }],
					needed_tools: [{ provider: 'gmail' }],
					plain_tail: 2,
				} as never,
			}),
		)
		renderThread()

		expect(await screen.findByText(/For this job I use Gmail/)).toBeInTheDocument()
		expect(screen.queryByRole('button', { name: /sends now/ })).not.toBeInTheDocument()
		expect(screen.queryByTestId('needed-tools')).not.toBeInTheDocument()
	})

	it('removes the steps once the person has written after the intro, and keeps the tool block', async () => {
		mockMessages(message(2, { content: 'What can you help me with?' }), intro())
		renderThread()

		expect(await screen.findByText('What can you help me with?')).toBeInTheDocument()
		expect(screen.queryByRole('button', { name: /sends now/ })).not.toBeInTheDocument()
		expect(screen.getByTestId('needed-tools')).toBeInTheDocument()
	})

	it('disables the steps when the actor list loaded without the agent', async () => {
		actorsQuery = { isSuccess: true, data: [{ id: 'someone-else' }] }
		mockMessages(intro())
		renderThread()

		expect(await screen.findByRole('button', { name: /Read my inbox/ })).toBeDisabled()
		expect(screen.getByRole('button', { name: /Draft a reply/ })).toBeDisabled()
	})

	it('keeps the steps usable while the actor list is loading, or when it holds the agent', async () => {
		mockMessages(intro())
		const { unmount } = renderThread()
		expect(await screen.findByRole('button', { name: /Read my inbox/ })).toBeEnabled()
		unmount()

		actorsQuery = { isSuccess: true, data: [{ id: 'agent-1' }] }
		renderThread()
		expect(await screen.findByRole('button', { name: /Read my inbox/ })).toBeEnabled()
	})
})
