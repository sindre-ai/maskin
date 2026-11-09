import { render, screen } from '@testing-library/react'
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

import { ThreadMessages } from '@/components/chat/thread-messages'
import type { MessageResponse } from '@/lib/api'
import { api } from '@/lib/api'

function buildMessage(id: number, overrides: Partial<MessageResponse> = {}): MessageResponse {
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

const QUESTION = {
	session_id: '11111111-1111-1111-1111-111111111111',
	questions: [
		{
			question: 'When should it go live?',
			header: 'Listing date',
			multi_select: false,
			options: [{ label: 'Hold until clear' }, { label: 'Publish Sunday' }],
		},
	],
}

describe('ThreadMessages — an agent question the person answered by typing', () => {
	beforeEach(() => {
		vi.mocked(api.conversations.get).mockReset()
		vi.mocked(api.conversations.messages).mockReset()
		vi.mocked(api.conversations.get).mockResolvedValue({
			id: 'conv-1',
			participants: [],
			last_read_message_id: null,
		} as never)
	})

	const agentQuestion = buildMessage(1, {
		actorId: 'agent-1',
		actorName: 'Strategist',
		actorType: 'agent',
		content: 'When should it go live?',
		metadata: { question: QUESTION },
	})

	it('keeps the options while nothing has been said after them', async () => {
		vi.mocked(api.conversations.messages).mockResolvedValue({
			messages: [agentQuestion],
			has_more: false,
		} as never)

		render(<ThreadMessages conversationId="conv-1" workspaceId="ws-1" />, { wrapper: TestWrapper })

		expect(await screen.findByRole('button', { name: 'Publish Sunday' })).toBeInTheDocument()
	})

	it('drops the options once the person writes a normal message', async () => {
		vi.mocked(api.conversations.messages).mockResolvedValue({
			messages: [buildMessage(2, { content: 'Publish the pages now.' }), agentQuestion],
			has_more: false,
		} as never)

		render(<ThreadMessages conversationId="conv-1" workspaceId="ws-1" />, { wrapper: TestWrapper })

		expect(await screen.findByText('Publish the pages now.')).toBeInTheDocument()
		expect(screen.queryByRole('button', { name: 'Publish Sunday' })).not.toBeInTheDocument()
	})

	it("keeps the options when the later message is someone else's", async () => {
		vi.mocked(api.conversations.messages).mockResolvedValue({
			messages: [
				buildMessage(2, { actorId: 'sam', actorName: 'Sam', content: 'I think Sunday.' }),
				agentQuestion,
			],
			has_more: false,
		} as never)

		render(<ThreadMessages conversationId="conv-1" workspaceId="ws-1" />, { wrapper: TestWrapper })

		expect(await screen.findByText('I think Sunday.')).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Publish Sunday' })).toBeInTheDocument()
	})

	it('keeps the options when the later message is only a hidden card nudge', async () => {
		vi.mocked(api.conversations.messages).mockResolvedValue({
			messages: [buildMessage(2, { metadata: { hidden_from_chat: true } }), agentQuestion],
			has_more: false,
		} as never)

		render(<ThreadMessages conversationId="conv-1" workspaceId="ws-1" />, { wrapper: TestWrapper })

		expect(await screen.findByRole('button', { name: 'Publish Sunday' })).toBeInTheDocument()
	})
})
