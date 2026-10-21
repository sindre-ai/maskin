import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import {
	events,
	conversationParticipants,
	conversations,
	messageDecisions,
	messages,
	subscriptions,
	workspaceMembers,
} from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { vi } from 'vitest'
import { createApiError, formatZodError } from '../../lib/errors'
import { configureSessionLifecycle } from '../../services/session-lifecycle'
import type { SessionManager } from '../../services/session-manager'
import { insertActor, insertObject, insertWorkspace } from '../factories'
import { jsonDelete, jsonGet, jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

const { default: conversationsRoutes } = await import('../../routes/conversations')

type Env = {
	Variables: { db: Database; actorId: string; actorType: string; sessionManager: unknown }
}

function appFor(actorId: string) {
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
	const sessionManager = {
		createSession: vi.fn().mockResolvedValue({ id: crypto.randomUUID() }),
		findActiveConversationSession: vi.fn().mockResolvedValue(null),
		findConversationSessionAnyActive: vi.fn().mockResolvedValue(null),
		drainPendingConversationTurns: vi.fn().mockResolvedValue(undefined),
		writeInput: vi.fn().mockResolvedValue(undefined),
	}
	configureSessionLifecycle({ db, sessionManager: sessionManager as unknown as SessionManager })
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('actorType', 'human')
		c.set('sessionManager', sessionManager)
		await next()
	})
	app.route('/api/conversations', conversationsRoutes)
	return app
}

// The worked example from the decision schema's own description, so it passes the house style.
const DECISION = {
	title: 'Is the onboarding bet worth running?',
	summary:
		'3 of 5 signups stall on step 2, costing about 40 activations a week. I have drafted the replacement copy and the migration.',
	ask: 'This changes what every new customer sees first, so I will not ship it alone.',
	options: [
		{
			label: '7-day window',
			recommended: true,
			consequences: ['Ships with cycle 1 tomorrow', 'Adds 18 support tickets in week one'],
		},
		{
			label: 'Hold',
			consequences: ['Nothing ships this cycle', 'Keeps losing 40 activations a week'],
		},
	],
}

type FeedItem = {
	message_id: number
	conversation_id: string
	object_id: string | null
	decision: { title: string }
	status: string
	attention: number | null
	reply_count: number
	answer: { option_index: number; answered_by: string | null } | null
	posted_by: { id: string }
}

describe('Chat decisions', () => {
	let humanId: string
	let otherHumanId: string
	let outsiderId: string
	let agentId: string
	let workspaceId: string
	let objectId: string
	const ws = () => ({ 'x-workspace-id': workspaceId })

	const post = (body: Record<string, unknown>, as = agentId) =>
		appFor(as).request(jsonRequest('POST', '/api/conversations/decisions', body, ws()))
	const feed = async (as: string, state = 'open'): Promise<FeedItem[]> => {
		const res = await appFor(as).request(
			jsonGet(`/api/conversations/decisions?state=${state}`, ws()),
		)
		return ((await res.json()) as { decisions: FeedItem[] }).decisions
	}
	const answer = (as: string, c: string, m: number, optionIndex: number, note?: string) =>
		appFor(as).request(
			jsonRequest(
				'PUT',
				`/api/conversations/${c}/messages/${m}/decision`,
				{ option_index: optionIndex, ...(note ? { note } : {}) },
				ws(),
			),
		)
	const posted = async (extra: Record<string, unknown> = {}) => {
		const res = await post({
			object_id: objectId,
			decision: DECISION,
			for_actor_ids: [humanId, otherHumanId],
			attention: 4,
			...extra,
		})
		expect(res.status).toBe(201)
		return (await res.json()) as { conversation_id: string; message_id: number }
	}

	beforeEach(async () => {
		humanId = getTestActorId()
		workspaceId = (await insertWorkspace(db, humanId)).id
		otherHumanId = (await insertActor(db, { type: 'human' })).id
		outsiderId = (await insertActor(db, { type: 'human' })).id
		agentId = (await insertActor(db, { type: 'agent' })).id
		for (const actorId of [otherHumanId, outsiderId, agentId]) {
			await db.insert(workspaceMembers).values({ workspaceId, actorId, role: 'member' })
		}
		objectId = (await insertObject(db, workspaceId, humanId)).id
	})

	it('puts the card in the object chat and lists it for the people it is for, most urgent first', async () => {
		const { conversation_id, message_id } = await posted()

		const [chat] = await db
			.select()
			.from(conversations)
			.where(eq(conversations.id, conversation_id))
		expect([chat?.subjectType, chat?.subjectId]).toEqual(['object', objectId])
		const people = await db
			.select()
			.from(conversationParticipants)
			.where(eq(conversationParticipants.conversationId, conversation_id))
		expect(people.map((p) => p.actorId).sort()).toEqual([agentId, humanId, otherHumanId].sort())

		const mine = await feed(humanId)
		expect(mine).toHaveLength(1)
		expect(mine[0]).toMatchObject({
			message_id,
			conversation_id,
			object_id: objectId,
			status: 'open',
			attention: 4,
			reply_count: 0,
			answer: null,
		})
		expect(mine[0]?.decision.title).toBe(DECISION.title)
		expect(mine[0]?.posted_by.id).toBe(agentId)
		expect(await feed(outsiderId)).toHaveLength(0)

		// A more urgent card sorts above it.
		const second = await post({
			object_id: objectId,
			decision: { ...DECISION, title: 'Is the pricing change worth running?' },
			for_actor_ids: [humanId],
			attention: 5,
		})
		const urgent = (await second.json()) as { message_id: number }
		expect((await feed(humanId)).map((d) => d.message_id)).toEqual([urgent.message_id, message_id])
	})

	it('routes to the driver, then the creator, then the followers when no one is named', async () => {
		const to = async (id: string) => {
			const res = await post({ object_id: id, decision: DECISION })
			expect(res.status).toBe(201)
			return ((await res.json()) as { for_actor_ids: string[] }).for_actor_ids
		}
		// A human driver wins over the creator.
		const driven = await insertObject(db, workspaceId, humanId, { driver: otherHumanId })
		expect(await to(driven?.id as string)).toEqual([otherHumanId])
		// No driver: whoever made it.
		expect(await to(objectId)).toEqual([humanId])
		// Made by an agent, nobody driving: the humans following it.
		const byAgent = await insertObject(db, workspaceId, agentId)
		await db.insert(subscriptions).values({
			workspaceId,
			actorId: outsiderId,
			entityType: 'object',
			entityId: byAgent?.id as string,
			source: 'manual',
		})
		expect(await to(byAgent?.id as string)).toEqual([outsiderId])
		// Nobody at all: the agent is told to name someone.
		const orphan = await insertObject(db, workspaceId, agentId)
		const none = await post({ object_id: orphan?.id, decision: DECISION })
		expect(none.status).toBe(400)
	})

	it('refuses a card that breaks the house style, and an object from another workspace', async () => {
		const bad = await post({
			object_id: objectId,
			decision: { ...DECISION, title: 'Reviewing the funnel' },
			for_actor_ids: [humanId],
		})
		expect(bad.status).toBe(400)

		const elsewhere = await post({
			object_id: crypto.randomUUID(),
			decision: DECISION,
			for_actor_ids: [humanId],
		})
		expect(elsewhere.status).toBe(404)
	})

	it('records the first answer, tells the poster in the card thread, and refuses a second', async () => {
		const { conversation_id, message_id } = await posted()

		const first = await answer(humanId, conversation_id, message_id, 0)
		expect(first.status).toBe(200)
		expect(await first.json()).toMatchObject({
			status: 'answered',
			option_index: 0,
			label: '7-day window',
		})

		const [row] = await db
			.select()
			.from(messageDecisions)
			.where(eq(messageDecisions.messageId, message_id))
		expect([row?.status, row?.answerOptionIndex, row?.answeredBy]).toEqual(['answered', 0, humanId])

		const reply = await db
			.select()
			.from(messages)
			.where(
				and(eq(messages.conversationId, conversation_id), eq(messages.threadRootId, message_id)),
			)
		expect(reply.map((m) => m.content)).toEqual(['Chose “7-day window”'])
		expect((reply[0]?.metadata as { mentions: string[] }).mentions).toEqual([agentId])

		// It shows up as an answered card with the thread counted, and the open list is empty.
		expect(await feed(humanId)).toHaveLength(0)
		const done = await feed(humanId, 'answered')
		expect(done[0]).toMatchObject({ status: 'answered', reply_count: 1 })
		expect(done[0]?.answer).toMatchObject({ option_index: 0, answered_by: humanId })

		const second = await answer(otherHumanId, conversation_id, message_id, 1)
		expect(second.status).toBe(409)

		const recorded = await db
			.select()
			.from(events)
			.where(and(eq(events.entityId, conversation_id), eq(events.action, 'decision_answered')))
		expect(recorded).toHaveLength(1)
	})

	it('carries the reason typed with an answer into the card thread', async () => {
		const { conversation_id, message_id } = await posted()
		expect(
			(await answer(humanId, conversation_id, message_id, 1, 'Need the legal check first')).status,
		).toBe(200)
		const reply = await db
			.select()
			.from(messages)
			.where(
				and(eq(messages.conversationId, conversation_id), eq(messages.threadRootId, message_id)),
			)
		expect(reply.map((m) => m.content)).toEqual(['Chose “Hold” · Need the legal check first'])
	})

	it('keeps answers to the people it is for, and to real options', async () => {
		const { conversation_id, message_id } = await posted({ for_actor_ids: [humanId] })
		// Someone in the chat but not addressed cannot answer.
		await db.insert(conversationParticipants).values({
			conversationId: conversation_id,
			actorId: outsiderId,
			addedBy: humanId,
		})
		expect((await answer(outsiderId, conversation_id, message_id, 0)).status).toBe(403)
		expect((await answer(humanId, conversation_id, message_id, 7)).status).toBe(400)
		// Not in the chat at all: it does not exist for you.
		expect((await answer(otherHumanId, conversation_id, message_id, 0)).status).toBe(404)
	})

	it('lets only the poster withdraw an open card', async () => {
		const { conversation_id, message_id } = await posted()
		const del = (as: string) =>
			appFor(as).request(
				jsonDelete(`/api/conversations/${conversation_id}/messages/${message_id}/decision`, ws()),
			)

		expect((await del(humanId)).status).toBe(403)
		expect((await del(agentId)).status).toBe(204)
		expect(await feed(humanId)).toHaveLength(0)
		expect((await del(agentId)).status).toBe(409)
		expect((await answer(humanId, conversation_id, message_id, 0)).status).toBe(409)
	})

	it('shows where a card stands on the message list', async () => {
		const { conversation_id, message_id } = await posted()
		await answer(humanId, conversation_id, message_id, 1)
		const res = await appFor(humanId).request(
			jsonGet(`/api/conversations/${conversation_id}/messages`, ws()),
		)
		const { messages: page } = (await res.json()) as {
			messages: { id: number; decision: { status: string; answerOptionIndex: number } | null }[]
		}
		const card = page.find((m) => m.id === message_id)
		expect(card?.decision).toMatchObject({ status: 'answered', answerOptionIndex: 1 })
		expect(page.filter((m) => m.decision === null).length).toBeGreaterThan(0)
	})

	it('drops the decision row with its message', async () => {
		const { message_id } = await posted()
		await db.delete(messages).where(eq(messages.id, message_id))
		const rows = await db
			.select()
			.from(messageDecisions)
			.where(eq(messageDecisions.messageId, message_id))
		expect(rows).toHaveLength(0)
	})

	describe('curation by the Chief of Staff', () => {
		let cosId: string
		const curate = (as: string, c: string, m: number, body: Record<string, unknown>) =>
			appFor(as).request(
				jsonRequest('PATCH', `/api/conversations/${c}/messages/${m}/decision`, body, ws()),
			)

		beforeEach(async () => {
			cosId = (await insertActor(db, { type: 'agent', name: 'Chief of Staff', isSystem: true })).id
			await db.insert(workspaceMembers).values({ workspaceId, actorId: cosId, role: 'member' })
		})

		it('re-ranks and reassigns, telling the new people in the card thread', async () => {
			const { conversation_id, message_id } = await posted({ for_actor_ids: [humanId] })

			const res = await curate(cosId, conversation_id, message_id, {
				attention: 5,
				for_actor_ids: [otherHumanId],
			})
			expect(res.status).toBe(200)
			expect(await res.json()).toMatchObject({
				status: 'open',
				attention: 5,
				for_actor_ids: [otherHumanId],
			})
			expect(await feed(humanId)).toHaveLength(0)
			const theirs = await feed(otherHumanId)
			expect(theirs.map((d) => [d.message_id, d.attention])).toEqual([[message_id, 5]])

			const thread = await db
				.select()
				.from(messages)
				.where(
					and(eq(messages.conversationId, conversation_id), eq(messages.threadRootId, message_id)),
				)
			expect(thread).toHaveLength(1)
			expect(thread[0]?.actorId).toBe(cosId)
			expect(thread[0]?.content).toMatch(/^Handed to /)
		})

		it('withdraws a duplicate with a reason, pointing at the one it was folded into', async () => {
			const keep = await posted()
			const dupe = await posted()

			const res = await curate(cosId, dupe.conversation_id, dupe.message_id, {
				withdraw: { reason: 'Same question as the other card', merged_into: keep.message_id },
			})
			expect(res.status).toBe(200)

			const [row] = await db
				.select()
				.from(messageDecisions)
				.where(eq(messageDecisions.messageId, dupe.message_id))
			expect([row?.status, row?.mergedIntoMessageId]).toEqual(['withdrawn', keep.message_id])
			expect((await feed(humanId)).map((d) => d.message_id)).toEqual([keep.message_id])
			const gone = await feed(humanId, 'withdrawn')
			expect(gone[0]?.withdrawn_reason).toBe('Same question as the other card')
		})

		it('lets the Chief of Staff see every decision, and nobody else', async () => {
			const a = await posted({ for_actor_ids: [humanId] })
			const b = await posted({ for_actor_ids: [otherHumanId] })
			const all = (as: string) =>
				appFor(as).request(jsonGet('/api/conversations/decisions?scope=all', ws()))

			const seen = (await (await all(cosId)).json()) as { decisions: FeedItem[] }
			expect(seen.decisions.map((d) => d.message_id).sort()).toEqual(
				[a.message_id, b.message_id].sort(),
			)
			// Its own list is still only what is addressed to it.
			expect(await feed(cosId)).toHaveLength(0)
			expect((await all(agentId)).status).toBe(403)
			expect((await all(humanId)).status).toBe(403)
		})

		it('is for the Chief of Staff only: other agents and people get a 403', async () => {
			const { conversation_id, message_id } = await posted()
			for (const as of [agentId, humanId, otherHumanId]) {
				const res = await curate(as, conversation_id, message_id, { attention: 1 })
				expect(res.status).toBe(403)
			}
			// A look-alike that is not the built-in system agent does not count.
			const fake = (await insertActor(db, { type: 'agent', name: 'Chief of Staff' })).id
			await db.insert(workspaceMembers).values({ workspaceId, actorId: fake, role: 'member' })
			expect((await curate(fake, conversation_id, message_id, { attention: 1 })).status).toBe(403)
		})

		it('refuses to touch a card that was answered, to merge into a closed one, or to do nothing', async () => {
			const { conversation_id, message_id } = await posted()
			const other = await posted()
			expect((await curate(cosId, conversation_id, message_id, {})).status).toBe(400)
			expect(
				(
					await curate(cosId, conversation_id, message_id, {
						withdraw: { reason: 'x', merged_into: 999999 },
					})
				).status,
			).toBe(400)

			await answer(humanId, other.conversation_id, other.message_id, 0)
			expect(
				(
					await curate(cosId, conversation_id, message_id, {
						withdraw: { reason: 'x', merged_into: other.message_id },
					})
				).status,
			).toBe(400)
			expect(
				(await curate(cosId, other.conversation_id, other.message_id, { attention: 2 })).status,
			).toBe(409)
		})
	})
})
