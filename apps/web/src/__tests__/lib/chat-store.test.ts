import {
	apiConversationRepository,
	conversationToMarkdown,
	createConversation,
	createId,
	deriveConversationTitle,
	localStorageRepository,
} from '@/lib/chat-store'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth', () => ({
	getApiKey: vi.fn(() => 'ank_test'),
	getStoredActor: vi.fn(() => ({ id: 'user-1', name: 'Magnus' })),
}))

// biome-ignore lint/suspicious/noExplicitAny: test spy type
let fetchSpy: any

beforeEach(() => {
	vi.clearAllMocks()
	window.localStorage.clear()
	fetchSpy = vi.spyOn(globalThis, 'fetch')
})

afterEach(() => {
	fetchSpy.mockRestore()
})

const WS = 'ws-1'

describe('createId', () => {
	it('returns prefixed unique ids', () => {
		const a = createId('msg')
		const b = createId('msg')
		expect(a).not.toBe(b)
		expect(a.startsWith('msg_')).toBe(true)
	})
})

describe('createConversation', () => {
	it('seeds a fresh conversation with empty state and matching timestamps', () => {
		const before = Date.now()
		const c = createConversation()
		expect(c.title).toBe('New conversation')
		expect(c.messages).toEqual([])
		expect(c.participantIds).toEqual([])
		expect(c.createdAt).toBeGreaterThanOrEqual(before)
		expect(c.updatedAt).toBe(c.createdAt)
	})
})

describe('deriveConversationTitle', () => {
	it('uses the first user message text', () => {
		const c = createConversation()
		c.messages = [
			{
				id: 'msg_1',
				role: 'user',
				senderId: 'u',
				senderName: 'You',
				text: 'How do bets and tasks differ?',
				createdAt: Date.now(),
			},
		]
		expect(deriveConversationTitle(c)).toBe('How do bets and tasks differ?')
	})

	it('truncates titles past 48 chars', () => {
		const c = createConversation()
		const longText = 'x'.repeat(100)
		c.messages = [
			{
				id: 'msg_1',
				role: 'user',
				senderId: 'u',
				senderName: 'You',
				text: longText,
				createdAt: Date.now(),
			},
		]
		const title = deriveConversationTitle(c)
		expect(title.endsWith('…')).toBe(true)
		expect(title.length).toBeLessThanOrEqual(49)
	})

	it('keeps default title when the conversation has no user turns', () => {
		const c = createConversation()
		expect(deriveConversationTitle(c)).toBe('New conversation')
	})
})

describe('conversationToMarkdown', () => {
	it('renders user and agent turns with bolded speakers', () => {
		const md = conversationToMarkdown([
			{
				id: 'm1',
				role: 'user',
				senderId: 'u',
				senderName: 'Magnus',
				text: 'Hello there',
				createdAt: 0,
			},
			{
				id: 'm2',
				role: 'agent',
				senderId: 'a',
				senderName: 'Sindre',
				events: [{ kind: 'text', text: 'Hi!' }],
				status: 'complete',
				createdAt: 0,
			},
		])
		expect(md).toContain('**Magnus**')
		expect(md).toContain('Hello there')
		expect(md).toContain('**Sindre**')
		expect(md).toContain('Hi!')
	})

	it('drops messages with empty bodies', () => {
		const md = conversationToMarkdown([
			{
				id: 'm1',
				role: 'agent',
				senderId: 'a',
				senderName: 'Sindre',
				events: [],
				status: 'cancelled',
				createdAt: 0,
			},
		])
		expect(md).toBe('')
	})
})

describe('localStorageRepository', () => {
	it('round-trips conversations through createConversation + postUserMessage', async () => {
		const conv = await localStorageRepository.createConversation(WS, { title: 'Stand-up' })
		await localStorageRepository.postUserMessage(WS, conv.id, {
			id: 'msg_1',
			role: 'user',
			senderId: 'u',
			senderName: 'Me',
			text: 'hi',
			createdAt: Date.now(),
		})
		const loaded = await localStorageRepository.list(WS)
		expect(loaded).toHaveLength(1)
		expect(loaded[0].title).toBe('Stand-up')
		expect(loaded[0].messages[0]).toMatchObject({ text: 'hi', role: 'user' })
	})

	it('survives a corrupted blob', async () => {
		window.localStorage.setItem(`maskin.chat.v1.${WS}`, '{notjson}')
		const loaded = await localStorageRepository.list(WS)
		expect(loaded).toEqual([])
	})

	it('downgrades a stranded streaming agent message to cancelled on hydrate', async () => {
		const conv = await localStorageRepository.createConversation(WS, {})
		await localStorageRepository.postUserMessage(WS, conv.id, {
			id: 'msg_1',
			role: 'user',
			senderId: 'u',
			senderName: 'Me',
			text: 'hi',
			createdAt: Date.now(),
		})
		// Synthesise a stranded agent message directly in storage.
		const raw = window.localStorage.getItem(`maskin.chat.v1.${WS}`)
		expect(raw).not.toBeNull()
		const parsed = JSON.parse(raw as string)
		parsed[0].messages.push({
			id: 'msg_2',
			role: 'agent',
			senderId: 'a',
			senderName: 'Sindre',
			events: [],
			status: 'streaming',
			createdAt: Date.now(),
		})
		window.localStorage.setItem(`maskin.chat.v1.${WS}`, JSON.stringify(parsed))
		const loaded = await localStorageRepository.list(WS)
		const agent = loaded[0].messages.find((m) => m.role === 'agent')
		expect(agent?.role).toBe('agent')
		if (agent?.role === 'agent') expect(agent.status).toBe('cancelled')
	})

	it('downgrades a stranded sending user message to error on hydrate', async () => {
		const conv = await localStorageRepository.createConversation(WS, {})
		await localStorageRepository.postUserMessage(WS, conv.id, {
			id: 'msg_1',
			role: 'user',
			senderId: 'u',
			senderName: 'Me',
			text: 'hi',
			createdAt: Date.now(),
			status: 'sending',
		})
		const loaded = await localStorageRepository.list(WS)
		const user = loaded[0].messages.find((m) => m.role === 'user')
		expect(user?.role).toBe('user')
		if (user?.role === 'user') {
			expect(user.status).toBe('error')
			expect(user.errorText).toBe("Couldn't send")
		}
	})

	it('adds and removes participants', async () => {
		const conv = await localStorageRepository.createConversation(WS, {})
		await localStorageRepository.addParticipant(WS, conv.id, 'agent-1')
		await localStorageRepository.addParticipant(WS, conv.id, 'agent-1')
		let loaded = await localStorageRepository.list(WS)
		expect(loaded[0].participantIds).toEqual(['agent-1'])

		await localStorageRepository.removeParticipant(WS, conv.id, 'agent-1')
		loaded = await localStorageRepository.list(WS)
		expect(loaded[0].participantIds).toEqual([])
	})
})

describe('apiConversationRepository', () => {
	it('createConversation POSTs /api/conversations and maps the response', async () => {
		fetchSpy.mockResolvedValue(
			new Response(
				JSON.stringify({
					id: 'conv-1',
					workspaceId: WS,
					title: 'Stand-up',
					metadata: {},
					createdBy: 'user-1',
					createdAt: '2026-06-19T10:00:00.000Z',
					updatedAt: '2026-06-19T10:00:00.000Z',
				}),
				{ status: 201 },
			),
		)
		const created = await apiConversationRepository.createConversation(WS, {
			title: 'Stand-up',
			participantActorIds: ['agent-1'],
		})
		expect(created.id).toBe('conv-1')
		expect(created.title).toBe('Stand-up')
		expect(created.participantIds).toEqual(['agent-1'])

		const [url, init] = fetchSpy.mock.calls[0]
		expect(url).toBe('/api/conversations')
		expect((init as RequestInit).method).toBe('POST')
		const body = JSON.parse(String((init as RequestInit).body))
		expect(body).toEqual({ title: 'Stand-up', participant_actor_ids: ['agent-1'] })
	})

	it('postUserMessage POSTs /api/conversations/:id/messages and returns the event id', async () => {
		fetchSpy.mockResolvedValue(
			new Response(
				JSON.stringify({
					id: 4242,
					workspaceId: WS,
					conversationId: 'conv-1',
					actorId: 'user-1',
					content: 'hi',
					mentions: null,
					parentEventId: null,
					attachmentFileIds: null,
					metadata: null,
					createdAt: null,
				}),
				{ status: 201 },
			),
		)
		const res = await apiConversationRepository.postUserMessage(
			WS,
			'conv-1',
			{
				id: 'msg_1',
				role: 'user',
				senderId: 'user-1',
				senderName: 'Me',
				text: 'hi',
				createdAt: Date.now(),
			},
			{ mentions: ['agent-1'] },
		)
		expect(res.remoteId).toBe(4242)

		const [url, init] = fetchSpy.mock.calls[0]
		expect(url).toBe('/api/conversations/conv-1/messages')
		const body = JSON.parse(String((init as RequestInit).body))
		expect(body).toEqual({ content: 'hi', mentions: ['agent-1'] })
	})

	it('list hydrates user/agent messages from commented events keyed off the stored actor', async () => {
		fetchSpy.mockImplementation(async (url: string) => {
			if (url === '/api/conversations') {
				return new Response(
					JSON.stringify([
						{
							id: 'conv-1',
							workspaceId: WS,
							title: 'Stand-up',
							metadata: {},
							createdBy: 'user-1',
							createdAt: '2026-06-19T10:00:00.000Z',
							updatedAt: '2026-06-19T10:05:00.000Z',
						},
					]),
					{ status: 200 },
				)
			}
			if (url === '/api/conversations/conv-1/messages?limit=200') {
				return new Response(
					JSON.stringify([
						{
							id: 10,
							workspaceId: WS,
							conversationId: 'conv-1',
							actorId: 'user-1',
							content: 'hi',
							mentions: null,
							parentEventId: null,
							attachmentFileIds: null,
							metadata: null,
							createdAt: '2026-06-19T10:00:01.000Z',
						},
						{
							id: 11,
							workspaceId: WS,
							conversationId: 'conv-1',
							actorId: 'agent-1',
							content: 'hello human',
							mentions: null,
							parentEventId: null,
							attachmentFileIds: null,
							metadata: null,
							createdAt: '2026-06-19T10:00:02.000Z',
						},
					]),
					{ status: 200 },
				)
			}
			if (url === '/api/conversations/conv-1/participants') {
				return new Response(
					JSON.stringify([
						{ conversationId: 'conv-1', actorId: 'user-1', source: 'author', createdAt: null },
						{ conversationId: 'conv-1', actorId: 'agent-1', source: 'manual', createdAt: null },
					]),
					{ status: 200 },
				)
			}
			throw new Error(`unexpected fetch: ${url}`)
		})
		const loaded = await apiConversationRepository.list(WS)
		expect(loaded).toHaveLength(1)
		expect(loaded[0].id).toBe('conv-1')
		expect(loaded[0].participantIds).toEqual(['agent-1'])
		expect(loaded[0].messages).toHaveLength(2)
		const [first, second] = loaded[0].messages
		expect(first).toMatchObject({ role: 'user', text: 'hi', remoteId: 10 })
		expect(second.role).toBe('agent')
		if (second.role === 'agent') {
			expect(second.status).toBe('complete')
			expect(second.events).toEqual([{ kind: 'text', text: 'hello human' }])
		}
	})

	it('addParticipant + removeParticipant hit the participants subresource', async () => {
		fetchSpy
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						conversationId: 'conv-1',
						actorId: 'agent-2',
						source: 'manual',
						createdAt: null,
					}),
					{ status: 201 },
				),
			)
			.mockResolvedValueOnce(new Response(JSON.stringify({ removed: true }), { status: 200 }))

		await apiConversationRepository.addParticipant(WS, 'conv-1', 'agent-2')
		await apiConversationRepository.removeParticipant(WS, 'conv-1', 'agent-2')

		expect(fetchSpy.mock.calls[0][0]).toBe('/api/conversations/conv-1/participants')
		expect((fetchSpy.mock.calls[0][1] as RequestInit).method).toBe('POST')
		expect(fetchSpy.mock.calls[1][0]).toBe('/api/conversations/conv-1/participants/agent-2')
		expect((fetchSpy.mock.calls[1][1] as RequestInit).method).toBe('DELETE')
	})

	it('updateConversation + deleteConversation are no-ops against the API', async () => {
		await apiConversationRepository.updateConversation(WS, 'conv-1', { title: 'x' })
		await apiConversationRepository.deleteConversation(WS, 'conv-1')
		expect(fetchSpy).not.toHaveBeenCalled()
	})
})
