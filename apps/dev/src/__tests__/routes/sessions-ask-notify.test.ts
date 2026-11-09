import { buildSession } from '../factories'
import { jsonRequest } from '../helpers'
import { createSessionTestApp } from '../setup'

// The /ask route's notification step: one needs_input push row per posted
// question, best effort. The message insert and the notification service are
// mocked so these tests pin the route's wiring (who is notified, with what,
// and that a failure here can never change the response). The real rows are
// covered against Postgres in integration/push-producers.test.ts.

const {
	insertConversationMessage,
	notifyAgentQuestion,
	humanParticipants,
	resolveAskTargetHuman,
	findOrCreateDirectChat,
} = vi.hoisted(() => ({
	insertConversationMessage: vi.fn(),
	notifyAgentQuestion: vi.fn(),
	humanParticipants: vi.fn(),
	resolveAskTargetHuman: vi.fn(),
	findOrCreateDirectChat: vi.fn(),
}))

vi.mock('../../services/conversation-messages', () => ({ insertConversationMessage }))
vi.mock('../../services/chat-notifications', () => ({ notifyAgentQuestion, humanParticipants }))
vi.mock('../../services/chief-of-staff-chat', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../services/chief-of-staff-chat')>()),
	resolveAskTargetHuman,
}))
vi.mock('../../services/direct-chat', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../services/direct-chat')>()),
	findOrCreateDirectChat,
}))

const { default: sessionsRoutes } = await import('../../routes/sessions')

const wsId = '00000000-0000-0000-0000-000000000001'
const conversationId = '00000000-0000-0000-0000-0000000000c1'
const humanA = '00000000-0000-0000-0000-0000000000a1'
const humanB = '00000000-0000-0000-0000-0000000000a2'
const objectId = '00000000-0000-0000-0000-0000000000b1'

const QUESTIONS = [
	{
		question: 'How should I reach Spotify?',
		header: 'Spotify access',
		multi_select: false,
		options: [
			{ label: 'API token', description: 'You create a developer app' },
			{ label: 'No login', description: 'Curate a shareable link instead' },
		],
	},
]

function setup(sessionOverrides?: Record<string, unknown>) {
	const session = buildSession({
		workspaceId: wsId,
		actorId: 'test-actor-id',
		interactive: true,
		conversationId,
		initiatedFromObjectId: objectId,
		...sessionOverrides,
	})
	const ctx = createSessionTestApp(sessionsRoutes, '/api/sessions', 'test-actor-id', 'agent')
	ctx.mockResults.select = [session]
	return { ...ctx, session }
}

const ask = (sessionId: string) =>
	jsonRequest(
		'POST',
		`/api/sessions/${sessionId}/ask`,
		{ questions: QUESTIONS },
		{ 'x-workspace-id': wsId },
	)

describe('POST /api/sessions/:id/ask notification', () => {
	beforeEach(() => {
		insertConversationMessage.mockReset().mockResolvedValue({ id: 77 })
		notifyAgentQuestion.mockReset().mockResolvedValue(undefined)
		humanParticipants.mockReset().mockResolvedValue([humanA, humanB])
		resolveAskTargetHuman.mockReset()
		findOrCreateDirectChat.mockReset()
	})

	it('notifies the conversation humans once, keyed on the posted message', async () => {
		const { app, session } = setup()

		const res = await app.request(ask(session.id))

		expect(res.status).toBe(200)
		expect(notifyAgentQuestion).toHaveBeenCalledTimes(1)
		expect(notifyAgentQuestion.mock.calls[0]?.[1]).toMatchObject({
			workspaceId: wsId,
			agentId: 'test-actor-id',
			conversationId,
			messageId: 77,
			targets: [humanA, humanB],
			firstQuestion: 'How should I reach Spotify?',
			objectId,
			sessionId: session.id,
		})
	})

	it('notifies only the resolved person for a question put in a direct message', async () => {
		resolveAskTargetHuman.mockResolvedValue(humanA)
		findOrCreateDirectChat.mockResolvedValue({ id: conversationId, created: false })
		const { app, session } = setup({ conversationId: null, interactive: false })

		const res = await app.request(ask(session.id))

		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({ posted: true, delivered_to: 'master' })
		expect(humanParticipants).not.toHaveBeenCalled()
		expect(notifyAgentQuestion).toHaveBeenCalledTimes(1)
		expect(notifyAgentQuestion.mock.calls[0]?.[1]).toMatchObject({
			conversationId,
			targets: [humanA],
			sessionId: session.id,
		})
	})

	it('does not notify when the question could not be posted', async () => {
		insertConversationMessage.mockResolvedValue(null)
		const { app, session } = setup()

		const res = await app.request(ask(session.id))

		expect(res.status).toBe(500)
		expect(notifyAgentQuestion).not.toHaveBeenCalled()
	})

	it('does not notify when the caller does not own the session', async () => {
		const { app, session } = setup({ actorId: 'someone-else' })

		const res = await app.request(ask(session.id))

		expect(res.status).toBe(403)
		expect(notifyAgentQuestion).not.toHaveBeenCalled()
	})

	it('still answers 200 when resolving the recipients throws', async () => {
		humanParticipants.mockRejectedValue(new Error('db down'))
		const { app, session } = setup()

		const res = await app.request(ask(session.id))

		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({ message_id: 77, posted: true, delivered_to: 'chat' })
		expect(notifyAgentQuestion).not.toHaveBeenCalled()
	})

	it('still answers 200 when the notification step itself throws', async () => {
		notifyAgentQuestion.mockRejectedValue(new Error('insert failed'))
		const { app, session } = setup()

		const res = await app.request(ask(session.id))

		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({ message_id: 77, posted: true })
	})
})
