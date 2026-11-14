import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import {
	conversationParticipants,
	conversations,
	integrations,
	messages,
	sessions,
	workspaceMembers,
} from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { vi } from 'vitest'
import { createApiError, formatZodError } from '../../lib/errors'
import { insertActor, insertSession, insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

// The helper's computer: a stand-in, so a Done can be answered with a screenshot or without one.
const desktop = vi.hoisted(() => ({ control: vi.fn() }))
vi.mock('../../services/workspace-desktop', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../services/workspace-desktop')>()),
	createWorkspaceDesktopService: () => ({ control: desktop.control }),
}))

const { default: sessionsRoutes } = await import('../../routes/sessions')

/**
 * The four card routes (connect, keychain, computer, keychain access) for a helper: a session
 * another agent started from a chat. It has no chat of its own, so its card goes into the
 * chat it was started from, the helper is marked as waiting on the person, and the card says
 * its answer goes to the helper's session. A run with no chat at all keeps the 409.
 *
 * Against real Postgres: each case is a message row plus a change to the session's config.
 */

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		workspaceRole?: string
		sessionManager: Record<string, ReturnType<typeof vi.fn>>
	}
}

function appFor(
	actorId: string,
	actorType: 'human' | 'agent',
	writeInput: ReturnType<typeof vi.fn> = vi.fn(async () => {}),
) {
	const app = new OpenAPIHono<Env>({
		defaultHook: (result, c) => {
			if (!result.success) {
				return c.json(
					createApiError(
						'VALIDATION_ERROR',
						'Request validation failed',
						formatZodError(result.error),
					),
					400,
				)
			}
			return undefined
		},
	})
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('actorType', actorType)
		c.set('sessionManager', {
			createSession: vi.fn(),
			writeInput,
		} as unknown as Env['Variables']['sessionManager'])
		await next()
	})
	app.route('/api/sessions', sessionsRoutes)
	return app
}

const H = (workspaceId: string) => ({ 'X-Workspace-Id': workspaceId })

async function setup() {
	const human = getTestActorId()
	const ws = await insertWorkspace(db, human)
	const agent = await insertActor(db, { type: 'agent' })
	await db
		.insert(workspaceMembers)
		.values({ workspaceId: ws.id, actorId: agent.id, role: 'member' })
	const [chat] = await db
		.insert(conversations)
		.values({ workspaceId: ws.id, title: 'Origin chat', createdBy: human })
		.returning()
	await db.insert(conversationParticipants).values({ conversationId: chat.id, actorId: human })
	const [ownChat] = await db
		.insert(conversations)
		.values({ workspaceId: ws.id, title: 'Own chat', createdBy: human })
		.returning()
	const credential = (
		await db
			.insert(integrations)
			.values({
				workspaceId: ws.id,
				provider: 'custom',
				providerMode: 'byo_apikey',
				displayName: 'Stripe',
				status: 'active',
				credentials: 'x',
				defaultAgentAccess: 'none',
				createdBy: human,
			})
			.returning()
	)[0]

	// Started by another agent from `chat`: no chat of its own, asks in `chat`.
	const helper = await insertSession(db, ws.id, agent.id, human, {
		interactive: true,
		conversationId: null,
		status: 'running',
		config: { stop_on_result: true, ask_conversation_id: chat.id, origin_conversation_id: chat.id },
	})
	// A chat session: its own conversation.
	const chatSession = await insertSession(db, ws.id, agent.id, human, {
		interactive: true,
		conversationId: ownChat.id,
		status: 'running',
	})
	// A cron or trigger run: nobody to show a card to.
	const background = await insertSession(db, ws.id, agent.id, human, {
		interactive: true,
		conversationId: null,
		status: 'running',
		config: {},
	})
	return { human, ws, agent, chat, ownChat, credential, helper, chatSession, background }
}
type Setup = Awaited<ReturnType<typeof setup>>

const messagesIn = (conversationId: string) =>
	db.select().from(messages).where(eq(messages.conversationId, conversationId))

const configOf = async (sessionId: string) =>
	(await db.select({ config: sessions.config }).from(sessions).where(eq(sessions.id, sessionId)))[0]
		?.config as { awaiting?: { message_id: number } } | null

const CARDS = [
	{
		name: 'connect',
		path: 'connect-card',
		marker: 'integration_connect',
		body: () => ({ provider: 'linear' }),
	},
	{
		name: 'keychain',
		path: 'keychain-card',
		marker: 'keychain_request',
		body: () => ({ kind: 'api_key', suggested_name: 'stripe' }),
	},
	{
		name: 'computer',
		path: 'computer-card',
		marker: 'computer_request',
		body: () => ({ task: 'Approve the 2FA prompt.' }),
	},
	{
		name: 'keychain access',
		path: 'keychain-access-card',
		marker: 'keychain_access_request',
		body: () => ({ credential_name: 'Stripe' }),
	},
] as const

const post = (s: Setup, card: (typeof CARDS)[number], sessionId: string) =>
	appFor(s.agent.id, 'agent').request(
		jsonRequest('POST', `/api/sessions/${sessionId}/${card.path}`, card.body(), H(s.ws.id)),
	)

describe.each(CARDS)('POST /sessions/:id/$path for a helper (Integration)', (card) => {
	it('posts the card in the chat it was started from, flagged for the helper, and marks it waiting', async () => {
		const s = await setup()
		const res = await post(s, card, s.helper.id)
		expect(res.status).toBe(200)
		const out = (await res.json()) as { message_id: number }

		const rows = await messagesIn(s.chat.id)
		expect(rows).toHaveLength(1)
		expect(rows[0]?.id).toBe(out.message_id)
		expect(rows[0]?.actorId).toBe(s.agent.id)
		expect(rows[0]?.sessionId).toBe(s.helper.id)
		const marker = (rows[0]?.metadata as Record<string, Record<string, unknown>>)[card.marker]
		expect(marker?.session_id).toBe(s.helper.id)
		expect(marker?.reply_to_session).toBe(true)

		// Kept alive through the turn that ends with the card, and shown as waiting on the person.
		expect((await configOf(s.helper.id))?.awaiting?.message_id).toBe(out.message_id)
	})

	it('leaves a chat session as it was: its own chat, no helper flag, no waiting mark', async () => {
		const s = await setup()
		const res = await post(s, card, s.chatSession.id)
		expect(res.status).toBe(200)

		expect(await messagesIn(s.chat.id)).toHaveLength(0)
		const rows = await messagesIn(s.ownChat.id)
		expect(rows).toHaveLength(1)
		const marker = (rows[0]?.metadata as Record<string, Record<string, unknown>>)[card.marker]
		expect(marker).not.toHaveProperty('reply_to_session')
		expect((await configOf(s.chatSession.id))?.awaiting).toBeUndefined()
	})

	it('answers 409 for a run with no chat at all, and posts nothing', async () => {
		const s = await setup()
		const res = await post(s, card, s.background.id)
		expect(res.status).toBe(409)
		expect(await messagesIn(s.chat.id)).toHaveLength(0)
		expect(await messagesIn(s.ownChat.id)).toHaveLength(0)
	})

	it('answers 409 for a helper that is not interactive', async () => {
		const s = await setup()
		await db.update(sessions).set({ interactive: false }).where(eq(sessions.id, s.helper.id))
		const res = await post(s, card, s.helper.id)
		expect(res.status).toBe(409)
		expect(await messagesIn(s.chat.id)).toHaveLength(0)
	})
})

describe('POST /sessions/:id/input answering a helper card (Integration)', () => {
	async function helperWithCard() {
		const s = await setup()
		const res = await post(s, CARDS[2], s.helper.id)
		const { message_id } = (await res.json()) as { message_id: number }
		return { s, cardId: message_id }
	}
	const input = (s: Setup, body: Record<string, unknown>) =>
		appFor(s.human, 'human').request(
			jsonRequest('POST', `/api/sessions/${s.helper.id}/input`, body, H(s.ws.id)),
		)

	it('records a card answer hidden in the chat, clears the wait, and wakes nobody in the chat', async () => {
		const { s, cardId } = await helperWithCard()
		const res = await input(s, {
			content: 'Done: I have finished on the computer.',
			card_answer: { message_id: cardId, outcome: 'done' },
		})
		expect(res.status).toBe(200)

		expect((await configOf(s.helper.id))?.awaiting).toBeUndefined()
		const rows = await messagesIn(s.chat.id)
		expect(rows).toHaveLength(2)
		const answer = rows.find((r) => r.id !== cardId)
		expect(answer?.metadata).toEqual({
			hidden_from_chat: true,
			card_answer: { message_id: cardId, outcome: 'done' },
		})
		expect(answer?.actorId).toBe(s.human)
	})

	describe('the screenshot a Done sends the helper', () => {
		const SHOT = {
			status: 200,
			body: { image_base64: 'QUJD', mime_type: 'image/jpeg', width: 1920, height: 1080 },
		}
		async function answer(outcome: 'done' | 'declined') {
			const { s, cardId } = await helperWithCard()
			const writeInput = vi.fn(async () => {})
			const res = await appFor(s.human, 'human', writeInput).request(
				jsonRequest(
					'POST',
					`/api/sessions/${s.helper.id}/input`,
					{ content: 'Done: I have finished.', card_answer: { message_id: cardId, outcome } },
					H(s.ws.id),
				),
			)
			expect(res.status).toBe(200)
			return { s, writeInput }
		}
		// writeInput(sessionId, payload, attachments, messageId, logTags, images)
		const turn = (writeInput: ReturnType<typeof vi.fn>) => ({
			text: writeInput.mock.calls[0]?.[1]?.message?.content as string,
			images: writeInput.mock.calls[0]?.[5] as unknown,
		})

		it('starts the helper turn with a screenshot taken when Done was pressed', async () => {
			desktop.control.mockReset().mockResolvedValue(SHOT)
			const { s, writeInput } = await answer('done')

			expect(desktop.control).toHaveBeenCalledWith(
				s.ws.id,
				s.agent.id,
				'screenshot',
				{},
				expect.any(Number),
			)
			const { text, images } = turn(writeInput)
			expect(text).toContain('Done: I have finished.')
			expect(text).toContain('screenshot of your computer, taken just now')
			expect(images).toEqual([{ mediaType: 'image/jpeg', data: 'QUJD' }])
		})

		it('still sends the Done, and says no screenshot could be taken, when the computer fails', async () => {
			desktop.control.mockReset().mockResolvedValue(null)
			const { writeInput } = await answer('done')

			const { text, images } = turn(writeInput)
			expect(text).toContain('Done: I have finished.')
			expect(text).toContain('could not take a screenshot of your computer just now')
			expect(images).toEqual([])
		})

		it('takes no screenshot for a Not now', async () => {
			desktop.control.mockReset()
			const { writeInput } = await answer('declined')

			expect(desktop.control).not.toHaveBeenCalled()
			expect(turn(writeInput)).toEqual({ text: 'Done: I have finished.', images: undefined })
		})
	})

	it('ignores a card answer that names a different card than the one it waits on', async () => {
		const { s, cardId } = await helperWithCard()
		const res = await input(s, {
			content: 'Not now',
			card_answer: { message_id: cardId + 1000, outcome: 'declined' },
		})
		expect(res.status).toBe(200)
		expect(await messagesIn(s.chat.id)).toHaveLength(1)
	})
})
