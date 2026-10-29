import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import {
	conversationParticipants,
	conversations,
	messages,
	workspaceMembers,
} from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { vi } from 'vitest'
import { createApiError, formatZodError } from '../../lib/errors'
import { configureSessionLifecycle } from '../../services/session-lifecycle'
import type { SessionManager } from '../../services/session-manager'
import { insertActor, insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

const { default: conversationsRoutes } = await import('../../routes/conversations')

type Env = {
	Variables: { db: Database; actorId: string; actorType: string; sessionManager: unknown }
}

function appFor(actorId: string, actorType: 'human' | 'agent' = 'human') {
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
		c.set('actorType', actorType)
		c.set('sessionManager', sessionManager)
		await next()
	})
	app.route('/api/conversations', conversationsRoutes)
	return app
}

describe('POST /api/conversations: the 1-1 with one agent', () => {
	let personId: string
	let agentId: string
	let workspaceId: string
	const ws = () => ({ 'x-workspace-id': workspaceId })
	const open = (actor: string, body: Record<string, unknown>, type: 'human' | 'agent' = 'human') =>
		appFor(actor, type).request(jsonRequest('POST', '/api/conversations', body, ws()))
	const idOf = async (res: Response) => ((await res.json()) as { id: string }).id

	async function addMember(role = 'member') {
		const actor = await insertActor(db, { type: role === 'agent' ? 'agent' : 'human' })
		await db.insert(workspaceMembers).values({ workspaceId, actorId: actor.id, role: 'member' })
		return actor.id
	}

	async function chatsWith(actorId: string) {
		const rows = await db
			.select({ id: conversations.id })
			.from(conversations)
			.innerJoin(
				conversationParticipants,
				eq(conversationParticipants.conversationId, conversations.id),
			)
			.where(
				and(
					eq(conversations.workspaceId, workspaceId),
					eq(conversationParticipants.actorId, actorId),
				),
			)
		return rows.map((r) => r.id)
	}

	beforeEach(async () => {
		personId = getTestActorId()
		workspaceId = (await insertWorkspace(db, personId)).id
		agentId = await addMember('agent')
	})

	it('returns the existing 1-1 the second time and creates it only the first time', async () => {
		const first = await open(personId, { title: 'Scout', participant_actor_ids: [agentId] })
		expect(first.status).toBe(201)
		const firstId = await idOf(first)

		const second = await open(personId, { title: 'Another try', participant_actor_ids: [agentId] })
		expect(second.status).toBe(200)
		expect(await idOf(second)).toBe(firstId)

		expect(await chatsWith(agentId)).toEqual([firstId])
	})

	it('puts the first message of a repeat request into the existing 1-1', async () => {
		const firstId = await idOf(
			await open(personId, { title: 'Scout', participant_actor_ids: [agentId] }),
		)

		const res = await open(personId, {
			title: 'Draft the launch note',
			participant_actor_ids: [agentId],
			initial_message: 'Draft the launch note',
		})
		expect(res.status).toBe(200)
		expect(await idOf(res)).toBe(firstId)

		const posted = await db
			.select({ actorId: messages.actorId, content: messages.content })
			.from(messages)
			.where(eq(messages.conversationId, firstId))
		expect(posted).toEqual([{ actorId: personId, content: 'Draft the launch note' }])
	})

	it('creates one chat when two requests arrive at the same time', async () => {
		const results = await Promise.all([
			open(personId, { title: 'Race', participant_actor_ids: [agentId] }),
			open(personId, { title: 'Race', participant_actor_ids: [agentId] }),
		])
		expect(results.map((r) => r.status).sort()).toEqual([200, 201])
		const ids = await Promise.all(results.map(idOf))
		expect(ids[0]).toBe(ids[1])
		expect(await chatsWith(agentId)).toHaveLength(1)
	})

	it('keeps a separate 1-1 per person', async () => {
		const otherPerson = await addMember()
		const mine = await idOf(
			await open(personId, { title: 'Mine', participant_actor_ids: [agentId] }),
		)
		const theirs = await idOf(
			await open(otherPerson, { title: 'Theirs', participant_actor_ids: [agentId] }),
		)
		expect(theirs).not.toBe(mine)
	})

	it('creates a new chat when a third participant is named, and leaves the 1-1 alone', async () => {
		const oneToOne = await idOf(
			await open(personId, { title: 'Scout', participant_actor_ids: [agentId] }),
		)
		const colleague = await addMember()

		const group = await open(personId, {
			title: 'Team chat',
			participant_actor_ids: [agentId, colleague],
		})
		expect(group.status).toBe(201)
		const groupId = await idOf(group)
		expect(groupId).not.toBe(oneToOne)

		// Asking for the group again makes another one: only a 1-1 is reused.
		const again = await open(personId, {
			title: 'Team chat',
			participant_actor_ids: [agentId, colleague],
		})
		expect(again.status).toBe(201)
		expect(await idOf(again)).not.toBe(groupId)

		// The 1-1 is still the one a plain request finds, not the group.
		const repeat = await open(personId, { title: 'Scout', participant_actor_ids: [agentId] })
		expect(await idOf(repeat)).toBe(oneToOne)
	})

	it('does not reuse a chat with two agents, and a person asking for a person gets a new chat', async () => {
		const secondAgent = await addMember('agent')
		const person = await addMember()
		const pair = await open(personId, {
			title: 'Pair',
			participant_actor_ids: [agentId, secondAgent],
		})
		expect(pair.status).toBe(201)

		const first = await open(personId, { title: 'Hi', participant_actor_ids: [person] })
		const second = await open(personId, { title: 'Hi', participant_actor_ids: [person] })
		expect([first.status, second.status]).toEqual([201, 201])
		expect(await idOf(first)).not.toBe(await idOf(second))
	})

	it('does not reuse the 1-1 when an agent starts the chat', async () => {
		await open(personId, { title: 'Scout', participant_actor_ids: [agentId] })
		const fromAgent = await open(
			agentId,
			{ title: 'Hello', participant_actor_ids: [personId] },
			'agent',
		)
		expect(fromAgent.status).toBe(201)
		expect(await chatsWith(agentId)).toHaveLength(2)
	})
})
