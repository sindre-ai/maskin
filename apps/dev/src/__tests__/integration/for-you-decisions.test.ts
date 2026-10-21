import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { notifications, workspaceMembers } from '@maskin/db/schema'
import { FOR_YOU_KIND } from '@maskin/shared'
import { vi } from 'vitest'
import { createApiError, formatZodError } from '../../lib/errors'
import { configureSessionLifecycle } from '../../services/session-lifecycle'
import type { SessionManager } from '../../services/session-manager'
import { insertActor, insertObject, insertWorkspace } from '../factories'
import { jsonDelete, jsonGet, jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

type Env = {
	Variables: { db: Database; actorId: string; actorType: string; sessionManager: unknown }
}

const { default: conversationsRoutes } = await import('../../routes/conversations')
const { default: forYouRoutes } = await import('../../routes/for-you')

function appAs(actorId: string) {
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
	app.route('/api/for-you', forYouRoutes)
	return app
}

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

type Item = {
	notification_id: string | null
	rank: number | null
	headline: string
	rationale: string | null
	entity_id: string | null
	chat_decision?: { message_id: number; conversation_id: string; attention: number | null }
}

describe('For You gathers decision cards from chats', () => {
	let humanId: string
	let otherId: string
	let agentId: string
	let workspaceId: string
	const ws = () => ({ 'x-workspace-id': workspaceId })

	beforeEach(async () => {
		humanId = getTestActorId()
		workspaceId = (await insertWorkspace(db, humanId)).id
		otherId = (await insertActor(db, { type: 'human' })).id
		agentId = (await insertActor(db, { type: 'agent' })).id
		for (const actorId of [otherId, agentId]) {
			await db.insert(workspaceMembers).values({ workspaceId, actorId, role: 'member' })
		}
	})

	const post = async (objectId: string, forActorIds: string[], attention?: number) => {
		const res = await appAs(agentId).request(
			jsonRequest(
				'POST',
				'/api/conversations/decisions',
				{
					object_id: objectId,
					decision: DECISION,
					for_actor_ids: forActorIds,
					...(attention ? { attention } : {}),
				},
				ws(),
			),
		)
		expect(res.status).toBe(201)
		return (await res.json()) as { conversation_id: string; message_id: number }
	}
	const list = async (as: string): Promise<Item[]> => {
		const res = await appAs(as).request(jsonGet('/api/for-you', ws()))
		expect(res.status).toBe(200)
		return ((await res.json()) as { items: Item[] }).items
	}
	const ranked = (messageId: number, meta: Record<string, unknown>, target = humanId) =>
		db
			.insert(notifications)
			.values({
				workspaceId,
				type: 'needs_input',
				title: 'Needs you',
				sourceActorId: agentId,
				targetActorId: target,
				status: 'pending',
				metadata: {
					kind: FOR_YOU_KIND,
					rank: 1,
					headline: 'Approve the launch',
					source_decision_message_id: messageId,
					...meta,
				},
			})
			.returning()

	it('shows a card addressed to you on its own, and not to anyone else', async () => {
		const object = await insertObject(db, workspaceId, humanId)
		const card = await post(object?.id as string, [humanId])

		const mine = await list(humanId)
		expect(mine).toHaveLength(1)
		expect(mine[0]).toMatchObject({
			notification_id: null,
			rank: null,
			headline: DECISION.title,
			entity_id: object?.id,
		})
		expect(mine[0]?.chat_decision).toMatchObject({
			message_id: card.message_id,
			conversation_id: card.conversation_id,
		})
		expect(await list(otherId)).toHaveLength(0)
	})

	it('merges a ranked item that points at the card, so it shows once with its headline and reason', async () => {
		const object = await insertObject(db, workspaceId, humanId)
		const card = await post(object?.id as string, [humanId])
		const [note] = await ranked(card.message_id, {
			rank: 2,
			headline: 'Launch needs a call today',
			rationale: 'It sends mail to real customers',
		})

		const items = await list(humanId)
		expect(items).toHaveLength(1)
		expect(items[0]).toMatchObject({
			notification_id: note?.id,
			rank: 2,
			headline: 'Launch needs a call today',
			rationale: 'It sends mail to real customers',
		})
		expect(items[0]?.chat_decision?.message_id).toBe(card.message_id)
	})

	it('puts ranked items first, then unranked cards by urgency', async () => {
		const a = await insertObject(db, workspaceId, humanId)
		const b = await insertObject(db, workspaceId, humanId)
		const c = await insertObject(db, workspaceId, humanId)
		const low = await post(a?.id as string, [humanId], 2)
		const urgent = await post(b?.id as string, [humanId], 5)
		const boosted = await post(c?.id as string, [humanId], 1)
		await ranked(boosted.message_id, { rank: 1, headline: 'Boosted by the Chief of Staff' })

		const items = await list(humanId)
		expect(items.map((i) => i.chat_decision?.message_id)).toEqual([
			boosted.message_id,
			urgent.message_id,
			low.message_id,
		])
	})

	it('drops a card once it is answered or withdrawn, and a ranked item with it', async () => {
		const first = await insertObject(db, workspaceId, humanId)
		const second = await insertObject(db, workspaceId, humanId)
		const answered = await post(first?.id as string, [humanId])
		const withdrawn = await post(second?.id as string, [humanId])
		await ranked(answered.message_id, { headline: 'Answer me' })
		expect(await list(humanId)).toHaveLength(2)

		const put = await appAs(humanId).request(
			jsonRequest(
				'PUT',
				`/api/conversations/${answered.conversation_id}/messages/${answered.message_id}/decision`,
				{ option_index: 0 },
				ws(),
			),
		)
		expect(put.status).toBe(200)
		const del = await appAs(agentId).request(
			jsonDelete(
				`/api/conversations/${withdrawn.conversation_id}/messages/${withdrawn.message_id}/decision`,
				ws(),
			),
		)
		expect(del.status).toBe(204)
		expect(await list(humanId)).toHaveLength(0)
	})

	it('drops a card whose task is closed, and a ranked item for a card not addressed to you', async () => {
		const closed = await insertObject(db, workspaceId, humanId, { status: 'done' })
		await post(closed?.id as string, [humanId])
		expect(await list(humanId)).toHaveLength(0)

		const open = await insertObject(db, workspaceId, humanId)
		const theirs = await post(open?.id as string, [otherId])
		await ranked(theirs.message_id, { headline: 'Not yours' })
		expect(await list(humanId)).toHaveLength(0)
		expect(await list(otherId)).toHaveLength(1)
	})
})
