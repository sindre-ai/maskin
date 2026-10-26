import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import {
	events,
	conversationParticipants,
	conversations,
	notifications,
	workspaceMembers,
} from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { vi } from 'vitest'
import { createApiError, formatZodError } from '../../lib/errors'
import { insertConversationMessage } from '../../services/conversation-messages'
import { insertActor, insertObject, insertSession, insertWorkspace } from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

const { default: sessionsRoutes } = await import('../../routes/sessions')
const { default: notificationsRoutes } = await import('../../routes/notifications')

/**
 * The producers behind smarter push: an agent's question (/ask) and an agent's
 * chat reply each create notification rows, which NotificationPushFanout turns
 * into pushes. Real Postgres because what matters is the rows: who got one,
 * exactly once, and what they carry. The dedupe path leans on the messages
 * unique index (insert returns null on conflict), which a mock cannot show.
 */

type Env = {
	Variables: { db: Database; actorId: string; actorType: string; sessionManager: unknown }
}

function createSessionsApp(actorId: string) {
	const app = new OpenAPIHono<Env>({
		defaultHook: (result, c) => {
			if (!result.success) {
				return c.json(
					createApiError('VALIDATION_ERROR', 'invalid', formatZodError(result.error)),
					400,
				)
			}
			return undefined
		},
	})
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('actorType', 'agent')
		c.set('sessionManager', { createSession: vi.fn(), writeInput: vi.fn() })
		await next()
	})
	app.route('/api/sessions', sessionsRoutes)
	return app
}

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

describe('push producers', () => {
	let workspaceId: string
	let humanId: string
	let secondHumanId: string
	let agentId: string
	let otherAgentId: string
	let conversationId: string
	let replySessionId: string

	beforeEach(async () => {
		humanId = getTestActorId()
		const ws = await insertWorkspace(db, humanId)
		workspaceId = ws.id
		secondHumanId = (await insertActor(db, { type: 'human' })).id
		agentId = (await insertActor(db, { type: 'agent', name: 'Ada' })).id
		otherAgentId = (await insertActor(db, { type: 'agent' })).id
		for (const actorId of [agentId, otherAgentId]) {
			await db.insert(workspaceMembers).values({ workspaceId, actorId, role: 'member' })
		}
		const [conversation] = await db
			.insert(conversations)
			.values({ workspaceId, title: 'Chat', createdBy: humanId })
			.returning()
		conversationId = (conversation as { id: string }).id
		await db.insert(conversationParticipants).values(
			[humanId, secondHumanId, agentId, otherAgentId].map((actorId) => ({
				conversationId,
				actorId,
			})),
		)
		// The final-output dedupe index is keyed on (session_id, dedupe_key).
		const replySession = await insertSession(db, workspaceId, agentId, humanId, {
			status: 'running',
		})
		replySessionId = (replySession as { id: string }).id
	})

	const rowsFor = (conversation = conversationId) =>
		db
			.select()
			.from(notifications)
			.where(
				and(eq(notifications.workspaceId, workspaceId), eq(notifications.sourceActorId, agentId)),
			)
			.then((rows) =>
				rows.filter(
					(r) => (r.metadata as { conversation_id?: string }).conversation_id === conversation,
				),
			)

	function finalReply(dedupeKey: string, over: Record<string, unknown> = {}) {
		return insertConversationMessage(db, {
			conversationId,
			workspaceId,
			actorId: agentId,
			content: '**All done.** The report is [here](https://x.test).',
			metadata: { source: 'final_output', final_output: { dedupe_key: dedupeKey } },
			sessionId: replySessionId,
			...over,
		})
	}

	describe('POST /sessions/:id/ask', () => {
		it('creates exactly one needs_input row per human in the chat, carrying the push contract', async () => {
			const object = await insertObject(db, workspaceId, humanId)
			const session = await insertSession(db, workspaceId, agentId, humanId, {
				interactive: true,
				conversationId,
				status: 'running',
				initiatedFromObjectId: object?.id,
			})
			const app = createSessionsApp(agentId)

			const res = await app.request(
				jsonRequest(
					'POST',
					`/api/sessions/${session?.id}/ask`,
					{ questions: QUESTIONS },
					{ 'X-Workspace-Id': workspaceId },
				),
			)
			expect(res.status).toBe(200)
			const { message_id } = (await res.json()) as { message_id: number }

			const rows = await rowsFor()
			expect(rows.map((r) => r.targetActorId).sort()).toEqual([humanId, secondHumanId].sort())
			for (const row of rows) {
				expect(row).toMatchObject({
					type: 'needs_input',
					status: 'pending',
					title: 'Ada has a question',
					content: 'How should I reach Spotify?',
					objectId: object?.id,
					sessionId: session?.id,
				})
				expect(row.metadata).toMatchObject({
					push_category: 'needs_you',
					push_collapse_key: `chat:${conversationId}`,
					conversation_id: conversationId,
					message_id,
				})
			}
			// The fan-out listens for this event; one per row.
			const created = await db
				.select()
				.from(events)
				.where(and(eq(events.entityType, 'notification'), eq(events.action, 'created')))
			expect(created.map((e) => e.entityId)).toEqual(expect.arrayContaining(rows.map((r) => r.id)))
		})

		it('stays out of the For You feed (no metadata.kind) and is listed in the inbox', async () => {
			const session = await insertSession(db, workspaceId, agentId, humanId, {
				interactive: true,
				conversationId,
				status: 'running',
			})
			await createSessionsApp(agentId).request(
				jsonRequest(
					'POST',
					`/api/sessions/${session?.id}/ask`,
					{ questions: QUESTIONS },
					{ 'X-Workspace-Id': workspaceId },
				),
			)
			const app = createIntegrationApp({ path: '/api/notifications', module: notificationsRoutes })
			const forYou = await (
				await app.request(
					jsonGet('/api/notifications?kind=for_you', { 'X-Workspace-Id': workspaceId }),
				)
			).json()
			expect(forYou).toHaveLength(0)
			const inbox = await (
				await app.request(
					jsonGet('/api/notifications?type=needs_input', { 'X-Workspace-Id': workspaceId }),
				)
			).json()
			expect(inbox).toHaveLength(2)
		})
	})

	describe('agent chat replies', () => {
		it('creates one row per human participant, none for the author or other agents', async () => {
			const created = await finalReply('turn-1')
			expect(created).not.toBeNull()

			const rows = await rowsFor()
			expect(rows.map((r) => r.targetActorId).sort()).toEqual([humanId, secondHumanId].sort())
			for (const row of rows) {
				expect(row).toMatchObject({
					title: 'Ada',
					content: 'All done. The report is here.',
					sourceActorId: agentId,
					type: 'good_news',
					status: 'seen',
				})
				expect(row.metadata).toMatchObject({
					push_category: 'conversation',
					push_collapse_key: `chat:${conversationId}`,
					push_delay_seconds: 25,
					push_only: true,
					conversation_id: conversationId,
					message_id: created?.id,
				})
			}
		})

		it('creates nothing for a replayed (duplicate dedupe key) insert', async () => {
			await finalReply('turn-1')
			expect(await rowsFor()).toHaveLength(2)

			const replay = await finalReply('turn-1')
			expect(replay).toBeNull()
			expect(await rowsFor()).toHaveLength(2)
		})

		it('creates nothing for mid-turn, system, human or failed-turn messages', async () => {
			await finalReply('x', { metadata: { delivery: 'proactive' } })
			await finalReply('x', {
				kind: 'system',
				metadata: { source: 'final_output', final_output: { dedupe_key: 's' } },
			})
			await finalReply('x', {
				metadata: { source: 'final_output', final_output: { dedupe_key: 'e', is_error: true } },
			})
			await insertConversationMessage(db, {
				conversationId,
				workspaceId,
				actorId: humanId,
				content: 'hello',
				metadata: null,
				sessionId: null,
			})
			expect(
				await db.select().from(notifications).where(eq(notifications.workspaceId, workspaceId)),
			).toHaveLength(0)
		})

		it('creates nothing in an agent-to-agent conversation', async () => {
			const [agentChat] = await db
				.insert(conversations)
				.values({ workspaceId, title: 'a2a', createdBy: agentId })
				.returning()
			const id = (agentChat as { id: string }).id
			for (const actorId of [agentId, otherAgentId]) {
				await db.insert(conversationParticipants).values({ conversationId: id, actorId })
			}
			await finalReply('a2a', { conversationId: id })
			expect(await rowsFor(id)).toHaveLength(0)
		})

		it('skips participants who left or archived the chat', async () => {
			await db
				.update(conversationParticipants)
				.set({ leftAt: new Date() })
				.where(
					and(
						eq(conversationParticipants.conversationId, conversationId),
						eq(conversationParticipants.actorId, secondHumanId),
					),
				)
			await finalReply('turn-1')
			expect((await rowsFor()).map((r) => r.targetActorId)).toEqual([humanId])
		})

		it('keeps the rows out of the inbox list and For You', async () => {
			await finalReply('turn-1')
			expect(await rowsFor()).toHaveLength(2)
			const app = createIntegrationApp({ path: '/api/notifications', module: notificationsRoutes })
			for (const qs of ['', '?kind=for_you', '?type=needs_input', '?status=pending']) {
				const body = await (
					await app.request(jsonGet(`/api/notifications${qs}`, { 'X-Workspace-Id': workspaceId }))
				).json()
				expect(body).toHaveLength(0)
			}
		})
	})
	describe('chat mentions', () => {
		const mentionRows = () =>
			db
				.select()
				.from(notifications)
				.where(eq(notifications.workspaceId, workspaceId))
				.then((rows) => rows.filter((r) => r.title.endsWith('mentioned you')))

		beforeEach(async () => {
			await db
				.insert(workspaceMembers)
				.values({ workspaceId, actorId: secondHumanId, role: 'member' })
		})

		function post(actorId: string, mentions: string[], over: Record<string, unknown> = {}) {
			return insertConversationMessage(db, {
				conversationId,
				workspaceId,
				actorId,
				content: 'Can you take a look?',
				metadata: { mentions },
				...over,
			})
		}

		it('creates one push row for a mentioned person, none for the author or a mentioned agent', async () => {
			const created = await post(humanId, [secondHumanId, humanId, agentId])

			const rows = await mentionRows()
			expect(rows).toHaveLength(1)
			expect(rows[0]).toMatchObject({
				targetActorId: secondHumanId,
				sourceActorId: humanId,
				type: 'good_news',
				status: 'seen',
			})
			expect(rows[0]?.metadata).toMatchObject({
				push_category: 'conversation',
				push_collapse_key: `chat-mention:${conversationId}:${created?.id}`,
				push_only: true,
				conversation_id: conversationId,
				message_id: created?.id,
			})
			expect(rows[0]?.metadata).not.toHaveProperty('push_delay_seconds')
		})

		it('notifies a person an agent mentions mid-turn, naming the agent', async () => {
			await post(agentId, [humanId])

			const rows = await mentionRows()
			expect(rows.map((r) => r.targetActorId)).toEqual([humanId])
			expect(rows[0]?.title).toBe('Ada mentioned you')
		})

		it('does not notify a person who is not a member of the workspace', async () => {
			const outsider = await insertActor(db, { type: 'human' })

			await post(humanId, [outsider.id])

			expect(await mentionRows()).toHaveLength(0)
		})

		it('leaves an auto-posted final output to the reply push, with no extra mention row', async () => {
			await finalReply('turn-1', {
				metadata: {
					source: 'final_output',
					final_output: { dedupe_key: 'turn-1' },
					mentions: [humanId],
				},
			})

			expect(await mentionRows()).toHaveLength(0)
		})
	})

	describe('thread replies', () => {
		let thirdHumanId: string
		let rootId: number

		beforeEach(async () => {
			thirdHumanId = (await insertActor(db, { type: 'human' })).id
			await db.insert(conversationParticipants).values({ conversationId, actorId: thirdHumanId })
			// Mentions only reach workspace members.
			await db.insert(workspaceMembers).values(
				[secondHumanId, thirdHumanId].map((actorId) => ({
					workspaceId,
					actorId,
					role: 'member' as const,
				})),
			)
			// The root is a person's top-level message: it pushes nobody.
			const root = await insertConversationMessage(db, {
				conversationId,
				workspaceId,
				actorId: humanId,
				content: 'Who owns the Q4 plan?',
				metadata: null,
				sessionId: null,
			})
			rootId = (root as { id: number }).id
		})

		const allRows = () =>
			db.select().from(notifications).where(eq(notifications.workspaceId, workspaceId))

		function reply(actorId: string, over: Record<string, unknown> = {}) {
			return insertConversationMessage(db, {
				conversationId,
				workspaceId,
				actorId,
				content: 'I can take it.',
				metadata: null,
				sessionId: null,
				threadRootId: rootId,
				...over,
			})
		}

		it("pushes the root's author when someone replies, and nobody else in the chat", async () => {
			const created = await reply(secondHumanId)
			const rows = await allRows()
			expect(rows.map((r) => r.targetActorId)).toEqual([humanId])
			expect(rows[0]?.metadata).toMatchObject({
				push_category: 'conversation',
				push_collapse_key: `chat:${conversationId}:thread:${rootId}`,
				push_delay_seconds: 25,
				push_only: true,
				conversation_id: conversationId,
				message_id: created?.id,
				thread_root_id: rootId,
			})
		})

		it('widens to everyone who has replied, still leaving out people who never joined the thread', async () => {
			await reply(secondHumanId)
			await db.delete(notifications).where(eq(notifications.workspaceId, workspaceId))
			await reply(humanId)
			expect((await allRows()).map((r) => r.targetActorId)).toEqual([secondHumanId])
		})

		it("sends an agent's end-of-turn reply in a thread to the thread's people only", async () => {
			await reply(secondHumanId)
			await db.delete(notifications).where(eq(notifications.workspaceId, workspaceId))
			await finalReply('turn-thread', { threadRootId: rootId })
			expect((await allRows()).map((r) => r.targetActorId).sort()).toEqual(
				[humanId, secondHumanId].sort(),
			)
		})

		it("pushes everyone in the chat for an agent's end-of-turn reply that is also in the main chat, opening the thread", async () => {
			await finalReply('turn-thread-also', { threadRootId: rootId, threadAlsoInChannel: true })
			const rows = await allRows()
			expect(rows.map((r) => r.targetActorId).sort()).toEqual(
				[humanId, secondHumanId, thirdHumanId].sort(),
			)
			expect(rows[0]?.metadata).toMatchObject({ thread_root_id: rootId })
		})

		it('leaves a mentioned newcomer to the mention push, which opens the thread', async () => {
			await reply(secondHumanId, { metadata: { mentions: [thirdHumanId] } })
			const rows = await allRows()
			const forThird = rows.filter((r) => r.targetActorId === thirdHumanId)
			expect(forThird).toHaveLength(1)
			expect(forThird[0]).toMatchObject({ title: expect.stringMatching(/mentioned you$/) })
			expect(forThird[0]?.metadata).toMatchObject({
				thread_root_id: rootId,
				push_collapse_key: expect.stringContaining('chat-mention:'),
			})
			// The thread push still goes to the root's author.
			expect(rows.filter((r) => r.targetActorId === humanId)).toHaveLength(1)
		})

		it('gives a thread participant who is also mentioned one push, the immediate mention', async () => {
			await reply(secondHumanId, { metadata: { mentions: [humanId] } })
			const rows = (await allRows()).filter((r) => r.targetActorId === humanId)
			expect(rows).toHaveLength(1)
			expect(rows[0]?.title).toMatch(/mentioned you$/)
			expect(rows[0]?.metadata).toMatchObject({ thread_root_id: rootId })
			expect(rows[0]?.metadata).not.toHaveProperty('push_delay_seconds')
		})

		it('stays quiet for an agent interim note in a thread', async () => {
			await reply(agentId, { metadata: { delivery: 'proactive' } })
			expect(await allRows()).toHaveLength(0)
		})

		it('does not notify the author of their own reply', async () => {
			await reply(humanId)
			expect(await allRows()).toHaveLength(0)
		})
	})

	describe('answering an agent question in the chat', () => {
		async function ask(sessionId: string) {
			const res = await createSessionsApp(agentId).request(
				jsonRequest(
					'POST',
					`/api/sessions/${sessionId}/ask`,
					{ questions: QUESTIONS },
					{ 'X-Workspace-Id': workspaceId },
				),
			)
			expect(res.status).toBe(200)
		}

		async function askerSession() {
			const session = await insertSession(db, workspaceId, agentId, humanId, {
				interactive: true,
				conversationId,
				status: 'running',
			})
			return (session as { id: string }).id
		}

		const humanReply = (actorId: string, inConversation = conversationId) =>
			insertConversationMessage(db, {
				conversationId: inConversation,
				workspaceId,
				actorId,
				content: 'Use the API token.',
				metadata: {},
			})

		it("resolves only the replying person's question rows, and records the resolve", async () => {
			await ask(await askerSession())
			await humanReply(humanId)

			const rows = await rowsFor()
			const mine = rows.find((r) => r.targetActorId === humanId)
			const theirs = rows.find((r) => r.targetActorId === secondHumanId)
			expect(mine).toMatchObject({ status: 'resolved' })
			expect(mine?.resolvedAt).toBeTruthy()
			expect(theirs).toMatchObject({ status: 'pending' })

			const resolvedEvents = await db
				.select()
				.from(events)
				.where(and(eq(events.entityType, 'notification'), eq(events.action, 'resolved')))
			expect(resolvedEvents.map((e) => e.entityId)).toEqual([mine?.id])
		})

		it('does not close a question asked after the answer, nor one in another chat', async () => {
			const sessionId = await askerSession()
			await ask(sessionId)
			await humanReply(humanId)
			await ask(sessionId)

			const pendingMine = (await rowsFor()).filter(
				(r) => r.targetActorId === humanId && r.status === 'pending',
			)
			expect(pendingMine).toHaveLength(1)

			const [other] = await db
				.insert(conversations)
				.values({ workspaceId, title: 'Elsewhere', createdBy: humanId })
				.returning()
			await humanReply(humanId, (other as { id: string }).id)
			const stillPending = (await rowsFor()).filter(
				(r) => r.targetActorId === humanId && r.status === 'pending',
			)
			expect(stillPending).toHaveLength(1)
		})

		it("an agent message never resolves a human's question", async () => {
			await ask(await askerSession())
			await finalReply('turn-1')
			const pending = (await rowsFor()).filter(
				(r) => r.type === 'needs_input' && r.status === 'pending',
			)
			expect(pending).toHaveLength(2)
		})
	})
})
