import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TestWrapper } from '../setup'

// Stub the SSE client: opening the stream is a side-effect we don't need to
// drive in this test, but the hook calls it after every successful
// api.sessions.create, so we have to keep it from throwing.
vi.mock('@microsoft/fetch-event-source', () => ({
	fetchEventSource: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/api', () => ({
	api: {
		sessions: {
			create: vi.fn(),
		},
	},
}))

vi.mock('@/lib/auth', () => ({
	getApiKey: vi.fn(() => 'ank_test'),
	getStoredActor: vi.fn(() => ({ id: 'human-1', name: 'Magnus' })),
}))

vi.mock('@/hooks/use-actors', () => ({
	useActors: vi.fn(() => ({
		data: [
			{ id: 'sindre-1', type: 'agent', name: 'Sindre', description: 'Default chat agent' },
			{ id: 'strategist-1', type: 'agent', name: 'Strategist', description: 'Bet shaping' },
			{ id: 'human-2', type: 'human', name: 'Noor', role: 'PM' },
			{ id: 'human-3', type: 'human', name: 'Jules', role: 'Design lead' },
		],
	})),
}))

vi.mock('@/lib/posthog', () => ({
	trackChatMessageSent: vi.fn(),
}))

const { mockRepository } = vi.hoisted(() => ({
	mockRepository: {
		list: vi.fn(),
		createConversation: vi.fn(),
		updateConversation: vi.fn(),
		deleteConversation: vi.fn(),
		postUserMessage: vi.fn(),
		addParticipant: vi.fn(),
		removeParticipant: vi.fn(),
	},
}))

vi.mock('@/lib/chat-store', async () => {
	const actual = await vi.importActual<typeof import('@/lib/chat-store')>('@/lib/chat-store')
	return {
		...actual,
		apiConversationRepository: mockRepository,
	}
})

import { useSindreConversation } from '@/hooks/use-sindre-conversation'
import { api } from '@/lib/api'

beforeEach(() => {
	vi.clearAllMocks()
	mockRepository.list.mockResolvedValue([
		{
			id: 'conv-7',
			title: 'New conversation',
			messages: [],
			participantIds: [],
			createdAt: Date.now(),
			updatedAt: Date.now(),
		},
	])
	mockRepository.postUserMessage.mockResolvedValue({ remoteId: 12345 })
	mockRepository.addParticipant.mockResolvedValue(undefined)
	mockRepository.removeParticipant.mockResolvedValue(undefined)
	mockRepository.createConversation.mockResolvedValue({
		id: 'conv-new',
		title: 'New conversation',
		messages: [],
		participantIds: [],
		createdAt: Date.now(),
		updatedAt: Date.now(),
	})
	vi.mocked(api.sessions.create).mockResolvedValue({
		id: 'session-1',
		// the hook only reads .id; the rest can be anything-shaped
	} as unknown as Awaited<ReturnType<typeof api.sessions.create>>)
})

afterEach(() => {
	vi.clearAllMocks()
})

describe('useSindreConversation send() — chat_reply config', () => {
	it('forwards the active conversation id to api.sessions.create as config.chat_reply.conversation_id', async () => {
		const { result } = renderHook(
			() => useSindreConversation({ workspaceId: 'ws-1', sindreActorId: 'sindre-1' }),
			{ wrapper: TestWrapper },
		)

		// Wait for the hook to hydrate the conversation from the repository.
		await waitFor(() => expect(result.current.activeId).toBe('conv-7'))

		act(() => {
			result.current.send({ text: 'hi sindre' })
		})

		await waitFor(() => expect(api.sessions.create).toHaveBeenCalledTimes(1))

		const [, body] = vi.mocked(api.sessions.create).mock.calls[0]
		expect(body.actor_id).toBe('sindre-1')
		expect(body.config?.chat_reply).toEqual({ conversation_id: 'conv-7' })
	})
})

describe('useSindreConversation — humans + agents in the room', () => {
	it('exposes humans alongside agents in allActors so the people picker can render them', async () => {
		const { result } = renderHook(
			() => useSindreConversation({ workspaceId: 'ws-1', sindreActorId: 'sindre-1' }),
			{ wrapper: TestWrapper },
		)

		await waitFor(() => expect(result.current.activeId).toBe('conv-7'))

		const agents = result.current.allAgents
		const allActors = result.current.allActors

		expect(agents.every((a) => a.kind === 'agent')).toBe(true)
		expect(allActors.find((a) => a.id === 'human-2')?.kind).toBe('human')
		expect(allActors.find((a) => a.id === 'human-3')?.role).toBe('Design lead')
		// Agents stay first so the picker lists them with role labels intact.
		expect(allActors.length).toBe(agents.length + 2)
	})

	it('resolves an invited human into the participants list as kind: human', async () => {
		mockRepository.list.mockResolvedValueOnce([
			{
				id: 'conv-9',
				title: 'Q3 planning',
				messages: [],
				participantIds: ['human-2'],
				createdAt: Date.now(),
				updatedAt: Date.now(),
			},
		])

		const { result } = renderHook(
			() => useSindreConversation({ workspaceId: 'ws-1', sindreActorId: 'sindre-1' }),
			{ wrapper: TestWrapper },
		)

		await waitFor(() => expect(result.current.activeId).toBe('conv-9'))

		const noor = result.current.participants.find((p) => p.id === 'human-2')
		expect(noor).toBeDefined()
		expect(noor?.kind).toBe('human')
		expect(noor?.name).toBe('Noor')
	})

	it('addParticipant pushes a human and calls the repository', async () => {
		mockRepository.list.mockResolvedValueOnce([
			{
				id: 'conv-10',
				title: 'New conversation',
				messages: [],
				participantIds: [],
				createdAt: Date.now(),
				updatedAt: Date.now(),
			},
		])

		const { result } = renderHook(
			() => useSindreConversation({ workspaceId: 'ws-1', sindreActorId: 'sindre-1' }),
			{ wrapper: TestWrapper },
		)

		await waitFor(() => expect(result.current.activeId).toBe('conv-10'))

		act(() => {
			result.current.addParticipant('human-2')
		})

		await waitFor(() =>
			expect(mockRepository.addParticipant).toHaveBeenCalledWith('ws-1', 'conv-10', 'human-2'),
		)

		expect(result.current.participants.some((p) => p.id === 'human-2' && p.kind === 'human')).toBe(
			true,
		)
	})

	it('addParticipant is a no-op (no API call) if the actor is already in the room', async () => {
		mockRepository.list.mockResolvedValueOnce([
			{
				id: 'conv-11',
				title: 'Q3 planning',
				messages: [],
				participantIds: ['human-2'],
				createdAt: Date.now(),
				updatedAt: Date.now(),
			},
		])

		const { result } = renderHook(
			() => useSindreConversation({ workspaceId: 'ws-1', sindreActorId: 'sindre-1' }),
			{ wrapper: TestWrapper },
		)

		await waitFor(() => expect(result.current.activeId).toBe('conv-11'))

		act(() => {
			result.current.addParticipant('human-2')
		})

		expect(mockRepository.addParticipant).not.toHaveBeenCalled()
	})
})
