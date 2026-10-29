import { render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
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
		objects: { get: vi.fn() },
		events: { history: vi.fn() },
	},
}))

// One line of text per card the bubble draws, so the test reads which messages get one.
vi.mock('@/components/chat/linked-object-preview', () => ({
	renderLinkedCard: (
		target: { kind: string; id: string },
		_fallback: ReactNode,
		context: { updated?: boolean },
	): ReactNode => <p>{`${context.updated ? 'Updated card' : 'Card'} for ${target.id}`}</p>,
	renderLinkedChip: (_target: unknown, fallback: ReactNode): ReactNode => fallback,
	renderLinkedGithubChip: (): ReactNode => null,
}))

import { ThreadMessages } from '@/components/chat/thread-messages'
import type { MessageResponse } from '@/lib/api'
import { api } from '@/lib/api'

const A = 'a7167fde-3f84-42ce-800d-2ba2362944ea'
const B = '4aee24db-5d54-476a-8399-9586516e7de1'
const link = (id: string) => `[the page](https://maskin.io/ws-1/objects/${id})`

function buildMessage(id: number, overrides: Partial<MessageResponse> = {}): MessageResponse {
	return {
		id,
		conversationId: 'conv-1',
		actorId: 'agent-1',
		actorName: 'Chief',
		actorType: 'agent',
		kind: 'message',
		content: `message ${id}`,
		metadata: null,
		editedAt: null,
		sessionId: null,
		createdAt: new Date(2026, 0, 1, 0, 0, id).toISOString(),
		...overrides,
	}
}

// A draft has a preview; any other object does not.
const objectRow = (id: string, draft: boolean) =>
	({ id, workspaceId: 'ws-1', preview: draft ? { content_hash: 'h' } : null }) as never
const event = (action: string, atMs: number, field?: string) =>
	({
		id: atMs,
		action,
		createdAt: new Date(2026, 0, 1, 0, 0, 2, atMs).toISOString(),
		data: field ? { changes: [{ field }] } : null,
	}) as never

const messageWith = (text: RegExp) =>
	screen.getByText(text).closest('[data-message-id]') as HTMLElement

describe('ThreadMessages: object cards', () => {
	beforeEach(() => {
		vi.mocked(api.conversations.get).mockReset()
		vi.mocked(api.conversations.messages).mockReset()
		vi.mocked(api.conversations.get).mockResolvedValue({
			id: 'conv-1',
			participants: [],
			last_read_message_id: null,
		} as never)
		vi.mocked(api.objects.get).mockReset()
		vi.mocked(api.objects.get).mockImplementation(async (id: string) => objectRow(id, false))
		vi.mocked(api.events.history).mockReset()
		vi.mocked(api.events.history).mockResolvedValue([])
	})

	it('draws one card per object, under the first agent message that links it', async () => {
		// Newest first, the way the API returns them. The person links A first; their own
		// bubble draws no card, so A's card still goes on the agent's first link to it.
		vi.mocked(api.conversations.messages).mockResolvedValue({
			messages: [
				buildMessage(5, { content: `Third look at ${link(A)} today` }),
				buildMessage(4, { content: `Now also ${link(B)} and ${link(A)} too` }),
				buildMessage(3, { content: `Again ${link(A)} here` }),
				buildMessage(2, { content: `Here it is ${link(A)} for you` }),
				buildMessage(1, {
					actorId: 'me',
					actorName: 'Me',
					actorType: 'human',
					content: `See ${link(A)} please`,
				}),
			],
			has_more: false,
		} as never)

		render(<ThreadMessages workspaceId="ws-1" conversationId="conv-1" />, {
			wrapper: TestWrapper,
		})

		expect(await screen.findByText(/Here it is/)).toBeInTheDocument()
		expect(screen.getAllByText(`Card for ${A}`)).toHaveLength(1)
		expect(screen.getAllByText(`Card for ${B}`)).toHaveLength(1)
		expect(within(messageWith(/Here it is/)).getByText(`Card for ${A}`)).toBeInTheDocument()
		expect(within(messageWith(/Now also/)).getByText(`Card for ${B}`)).toBeInTheDocument()
		expect(within(messageWith(/Now also/)).queryByText(`Card for ${A}`)).toBeNull()
		expect(within(messageWith(/Again/)).queryByText(`Card for ${A}`)).toBeNull()
		expect(within(messageWith(/Third look/)).queryByText(`Card for ${A}`)).toBeNull()
	})

	describe('a draft linked again', () => {
		// Message 2 holds the draft first; message 3 links it again 1 second later.
		const messages = () =>
			({
				messages: [
					buildMessage(3, { content: `Revised ${link(A)} here` }),
					buildMessage(2, { content: `First draft ${link(A)} here` }),
				],
				has_more: false,
			}) as never
		const setup = (events: unknown[]) => {
			vi.mocked(api.objects.get).mockImplementation(async (id: string) => objectRow(id, true))
			vi.mocked(api.events.history).mockResolvedValue(events as never)
			vi.mocked(api.conversations.messages).mockResolvedValue(messages())
			render(<ThreadMessages workspaceId="ws-1" conversationId="conv-1" />, {
				wrapper: TestWrapper,
			})
		}

		it('moves the card to the newest message with an Updated tag when it was edited in between', async () => {
			setup([event('updated', 500, 'content')])
			expect(await screen.findByText(`Updated card for ${A}`)).toBeInTheDocument()
			expect(within(messageWith(/Revised/)).getByText(`Updated card for ${A}`)).toBeInTheDocument()
			expect(within(messageWith(/First draft/)).queryByText(/card for/i)).toBeNull()
			expect(screen.getAllByText(/card for/i)).toHaveLength(1)
			expect(api.events.history).toHaveBeenCalledWith('ws-1', { entity_id: A, limit: '50' })
		})

		it('keeps the card on the first message when the draft is unchanged', async () => {
			setup([])
			expect(await screen.findByText(`Card for ${A}`)).toBeInTheDocument()
			expect(within(messageWith(/First draft/)).getByText(`Card for ${A}`)).toBeInTheDocument()
			await vi.waitFor(() => expect(api.events.history).toHaveBeenCalled())
			expect(screen.getAllByText(/card for/i)).toHaveLength(1)
			expect(screen.queryByText(/Updated card/)).toBeNull()
		})

		it('does not count an approval or a status move as a revision', async () => {
			setup([event('approved', 500), event('status_changed', 600, 'status')])
			expect(await screen.findByText(`Card for ${A}`)).toBeInTheDocument()
			await vi.waitFor(() => expect(api.events.history).toHaveBeenCalled())
			expect(within(messageWith(/First draft/)).getByText(`Card for ${A}`)).toBeInTheDocument()
			expect(screen.queryByText(/Updated card/)).toBeNull()
		})

		it('reads no edit history for objects that are linked once or are not drafts', async () => {
			vi.mocked(api.conversations.messages).mockResolvedValue({
				messages: [
					buildMessage(3, { content: `Look at ${link(B)}` }),
					buildMessage(2, { content: `First ${link(A)} here` }),
				],
				has_more: false,
			} as never)
			render(<ThreadMessages workspaceId="ws-1" conversationId="conv-1" />, {
				wrapper: TestWrapper,
			})
			expect(await screen.findByText(`Card for ${A}`)).toBeInTheDocument()
			expect(api.objects.get).not.toHaveBeenCalled()
			expect(api.events.history).not.toHaveBeenCalled()
		})
	})
})
