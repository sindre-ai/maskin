import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import {
	conversationParticipants,
	conversations,
	messages,
	workspaceMembers,
} from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { createApiError, formatZodError } from '../../lib/errors'
import { insertActor, insertConversation, insertSession, insertWorkspace } from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

const { default: conversationsRoutes } = await import('../../routes/conversations')

/**
 * What the chat list says about each chat: Needs you (an agent question or request card nobody
 * answered, or a failed last turn), who is working, Later, and why the last turn failed. All of it
 * is read per chat from the chat's own messages and sessions, never from an agent's global state.
 */

type Env = { Variables: { db: Database; actorId: string; actorType: string } }

function createApp(actorId: string) {
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
		c.set('actorType', 'human')
		await next()
	})
	app.route('/api/conversations', conversationsRoutes)
	return app
}

type Row = {
	id: string
	needs_you: boolean
	later: boolean
	working: Array<{ agent_id: string; session_id: string }>
	error: { reason: string; last_person_message_id: number | null } | null
}

const question = (sessionId: string) => ({
	question: {
		session_id: sessionId,
		questions: [
			{
				question: 'Which one?',
				header: 'Pick',
				multi_select: false,
				options: [{ label: 'a' }, { label: 'b' }],
			},
		],
	},
})

describe('GET /api/conversations needs_you, working, later and error', () => {
	let workspaceId: string
	let humanId: string
	let otherHumanId: string
	let agentId: string

	beforeEach(async () => {
		humanId = getTestActorId()
		workspaceId = (await insertWorkspace(db, humanId)).id
		agentId = (await insertActor(db, { type: 'agent', description: 'Builds things' })).id
		otherHumanId = (await insertActor(db, { type: 'human' })).id
		for (const actorId of [agentId, otherHumanId]) {
			await db.insert(workspaceMembers).values({ workspaceId, actorId, role: 'member' })
		}
	})

	/** A chat the caller is in with the agent (and others), with a plain opening message. */
	async function seedChat(title: string, others: string[] = [agentId]) {
		const chat = await insertConversation(db, workspaceId, humanId, { title })
		await db
			.insert(conversationParticipants)
			.values([
				{ conversationId: chat.id, actorId: humanId },
				...others.map((actorId) => ({ conversationId: chat.id, actorId })),
			])
		await say(chat.id, humanId, 'hello')
		return chat.id
	}

	/** One message, with the chat's last_message_at moved to it as every real insert does. */
	async function say(conversationId: string, actorId: string, content: string, metadata?: object) {
		const [message] = await db
			.insert(messages)
			.values({ conversationId, actorId, content, metadata: metadata ?? null })
			.returning()
		await db
			.update(conversations)
			.set({ lastMessageAt: message?.createdAt ?? new Date() })
			.where(eq(conversations.id, conversationId))
		if (!message) throw new Error('failed to seed message')
		return message
	}

	async function list(query = '', callerId = humanId) {
		const res = await createApp(callerId).request(
			jsonGet(`/api/conversations?limit=100${query ? `&${query}` : ''}`, {
				'x-workspace-id': workspaceId,
			}),
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as { conversations: Row[] }
		return new Map(body.conversations.map((c) => [c.id, c]))
	}

	async function patchMe(conversationId: string, body: object, callerId = humanId) {
		const res = await createApp(callerId).request(
			jsonRequest('PATCH', `/api/conversations/${conversationId}/me`, body, {
				'x-workspace-id': workspaceId,
			}),
		)
		expect(res.status).toBe(200)
		return (await res.json()) as { later: boolean; archived: boolean }
	}

	describe('needs_you', () => {
		it('lights only the chat with an unanswered question, not every chat of that agent', async () => {
			const asked = await seedChat('asked')
			const quiet = await seedChat('quiet')
			await say(asked, agentId, 'Which one?', question(crypto.randomUUID()))

			const rows = await list()
			expect(rows.get(asked)?.needs_you).toBe(true)
			expect(rows.get(quiet)?.needs_you).toBe(false)
		})

		it('lights only the chat with an unanswered request card', async () => {
			const asked = await seedChat('card chat')
			const quiet = await seedChat('no card')
			await say(asked, agentId, 'I need a key', { keychain_request: { name: 'X' } })

			const rows = await list()
			expect(rows.get(asked)?.needs_you).toBe(true)
			expect(rows.get(quiet)?.needs_you).toBe(false)
		})

		it('clears when a pick answers the question', async () => {
			const chat = await seedChat('picked')
			const asked = await say(chat, agentId, 'Which one?', question(crypto.randomUUID()))
			expect((await list()).get(chat)?.needs_you).toBe(true)

			await say(chat, humanId, 'a', {
				question_answer: {
					question_message_id: asked.id,
					answers: [{ header: 'Pick', selected: ['a'] }],
				},
			})
			expect((await list()).get(chat)?.needs_you).toBe(false)
		})

		it('clears when the caller types a reply in the same place, and not for a reply elsewhere', async () => {
			const chat = await seedChat('typed reply')
			const root = await say(chat, humanId, 'thread root')
			const asked = await say(chat, agentId, 'Which one?', question(crypto.randomUUID()))
			await db.update(messages).set({ threadRootId: root.id }).where(eq(messages.id, asked.id))
			expect((await list()).get(chat)?.needs_you).toBe(true)

			// A reply in the main chat does not answer a question asked in a thread.
			await say(chat, humanId, 'main chat message')
			expect((await list()).get(chat)?.needs_you).toBe(true)

			const reply = await say(chat, humanId, 'option a please')
			await db.update(messages).set({ threadRootId: root.id }).where(eq(messages.id, reply.id))
			expect((await list()).get(chat)?.needs_you).toBe(false)
		})

		it("does not clear when someone else types after the caller's question", async () => {
			const chat = await seedChat('group', [agentId, otherHumanId])
			await say(chat, agentId, 'Which one?', question(crypto.randomUUID()))
			await say(chat, otherHumanId, 'I would pick b')
			expect((await list()).get(chat)?.needs_you).toBe(true)
		})

		it('clears when the card carries the resolved stamp, and ignores a card from before stamps', async () => {
			const chat = await seedChat('resolved card')
			const old = await seedChat('old card')
			const card = await say(chat, agentId, 'I need a key', { keychain_request: { name: 'X' } })
			const oldCard = await say(old, agentId, 'I need a key', { keychain_request: { name: 'X' } })
			await db
				.update(messages)
				.set({ createdAt: new Date('2026-10-01T00:00:00Z') })
				.where(eq(messages.id, oldCard.id))
			expect((await list()).get(chat)?.needs_you).toBe(true)
			expect((await list()).get(old)?.needs_you).toBe(false)

			await db
				.update(messages)
				.set({
					metadata: {
						keychain_request: { name: 'X' },
						card_resolved: { at: new Date().toISOString(), by_actor_id: humanId, outcome: 'done' },
					},
				})
				.where(eq(messages.id, card.id))
			expect((await list()).get(chat)?.needs_you).toBe(false)
		})

		it('does not light a chat the caller marked Done or Later', async () => {
			const done = await seedChat('done')
			const later = await seedChat('later')
			await say(done, agentId, 'Which one?', question(crypto.randomUUID()))
			await say(later, agentId, 'Which one?', question(crypto.randomUUID()))
			expect((await list()).get(done)?.needs_you).toBe(true)

			await patchMe(done, { archived: true })
			await patchMe(later, { later: true })

			expect((await list('archived=true')).get(done)?.needs_you).toBe(false)
			expect((await list('later=true')).get(later)?.needs_you).toBe(false)
		})
	})

	describe('error', () => {
		const failure = (final_output: object) => ({ source: 'final_output', final_output })

		it('reports the reason and the last person message when the last turn failed', async () => {
			const chat = await seedChat('failed')
			const mine = await say(chat, humanId, 'please do it')
			await say(
				chat,
				agentId,
				"I couldn't complete that turn: You've hit your limit",
				failure({ dedupe_key: 'a', is_error: true, error_kind: 'permanent' }),
			)

			const row = (await list()).get(chat)
			expect(row?.needs_you).toBe(true)
			expect(row?.error).toEqual({ reason: 'usage_limit', last_person_message_id: mine.id })
		})

		it('reads a model-API blip as connection and anything else as other', async () => {
			const blip = await seedChat('blip')
			await say(blip, humanId, 'go')
			await say(
				blip,
				agentId,
				'could not reach the model',
				failure({ dedupe_key: 'b', is_error: true, error_kind: 'transient', retry: 'unavailable' }),
			)
			const odd = await seedChat('odd')
			await say(odd, humanId, 'go')
			await say(
				odd,
				agentId,
				'something broke',
				failure({ dedupe_key: 'c', is_error: true, error_kind: 'permanent' }),
			)

			const rows = await list()
			expect(rows.get(blip)?.error?.reason).toBe('connection')
			expect(rows.get(odd)?.error?.reason).toBe('other')
		})

		it('clears when a new message follows the failed turn, and a normal reply is no failure', async () => {
			const chat = await seedChat('recovers')
			await say(chat, humanId, 'go')
			await say(
				chat,
				agentId,
				'broke',
				failure({ dedupe_key: 'd', is_error: true, error_kind: 'permanent' }),
			)
			expect((await list()).get(chat)?.error).not.toBeNull()

			await say(chat, humanId, 'try again')
			expect((await list()).get(chat)?.error).toBeNull()
			await say(chat, agentId, 'Done.', failure({ dedupe_key: 'e' }))
			const row = (await list()).get(chat)
			expect(row?.error).toBeNull()
			expect(row?.needs_you).toBe(false)
		})
	})

	describe('working', () => {
		it('names the agent and session of the chat that has the open turn, not its other chats', async () => {
			const busy = await seedChat('busy')
			const idle = await seedChat('idle')
			const session = await insertSession(db, workspaceId, agentId, humanId, {
				conversationId: busy,
				status: 'running',
				interactive: false,
			})

			const rows = await list()
			expect(rows.get(busy)?.working).toEqual([{ agent_id: agentId, session_id: session.id }])
			expect(rows.get(idle)?.working).toEqual([])
		})
	})

	describe('later', () => {
		it('takes the chat out of the list, shows it under later=true, and a new message brings it back', async () => {
			const chat = await seedChat('wait')
			const other = await seedChat('stays')

			expect((await patchMe(chat, { later: true })).later).toBe(true)
			expect((await list()).has(chat)).toBe(false)
			expect((await list()).has(other)).toBe(true)
			const later = await list('later=true')
			expect(later.get(chat)?.later).toBe(true)
			expect(later.has(other)).toBe(false)

			await say(chat, agentId, 'Back again')
			const back = await list()
			expect(back.get(chat)?.later).toBe(false)
			expect((await list('later=true')).has(chat)).toBe(false)
		})

		it('can be taken back by hand', async () => {
			const chat = await seedChat('oops')
			await patchMe(chat, { later: true })
			expect((await patchMe(chat, { later: false })).later).toBe(false)
			expect((await list()).get(chat)?.later).toBe(false)
		})

		it('is the caller own: another person never sees it and cannot change it', async () => {
			const chat = await seedChat('shared', [agentId, otherHumanId])
			await patchMe(chat, { later: true })

			const theirs = await list('', otherHumanId)
			expect(theirs.get(chat)?.later).toBe(false)

			// Their own Later and taking it back leaves mine alone.
			await patchMe(chat, { later: true }, otherHumanId)
			await patchMe(chat, { later: false }, otherHumanId)
			expect((await list('later=true')).get(chat)?.later).toBe(true)
		})

		it('still finds a chat on Later by its subject', async () => {
			const subjectId = crypto.randomUUID()
			const chat = await insertConversation(db, workspaceId, humanId, {
				title: 'about a thing',
				subjectType: 'loop',
				subjectId,
			})
			await db
				.insert(conversationParticipants)
				.values({ conversationId: chat.id, actorId: humanId })
			await patchMe(chat.id, { later: true })
			const found = await list(`subject_type=loop&subject_id=${subjectId}`)
			expect(found.get(chat.id)?.later).toBe(true)
		})

		it('rejects a body that changes nothing', async () => {
			const chat = await seedChat('empty')
			const res = await createApp(humanId).request(
				jsonRequest(
					'PATCH',
					`/api/conversations/${chat}/me`,
					{},
					{ 'x-workspace-id': workspaceId },
				),
			)
			expect(res.status).toBe(400)
		})
	})
})
