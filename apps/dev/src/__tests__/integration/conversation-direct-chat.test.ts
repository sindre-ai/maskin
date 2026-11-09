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
import { findDirectChat } from '../../services/direct-chat'
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

describe('POST /api/conversations: the direct message', () => {
	let personId: string
	let agentId: string
	let workspaceId: string
	const ws = () => ({ 'x-workspace-id': workspaceId })
	const open = (actor: string, body: Record<string, unknown>, type: 'human' | 'agent' = 'human') =>
		appFor(actor, type).request(jsonRequest('POST', '/api/conversations', body, ws()))
	const idOf = async (res: Response) => ((await res.json()) as { id: string }).id
	const dmOf = (humanId: string, agent: string) =>
		findDirectChat(db, { workspaceId, humanId, agentId: agent })

	async function addMember(type: 'human' | 'agent' = 'human') {
		const actor = await insertActor(db, { type })
		await db.insert(workspaceMembers).values({ workspaceId, actorId: actor.id, role: 'member' })
		return actor.id
	}

	async function chatsWith(actorId: string) {
		const rows = await db
			.select({ id: conversations.id, key: conversations.directPairKey })
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
		return rows
	}

	beforeEach(async () => {
		personId = getTestActorId()
		workspaceId = (await insertWorkspace(db, personId)).id
		agentId = await addMember('agent')
	})

	it('creates the DM the first time and returns it every time after', async () => {
		const first = await open(personId, {
			title: 'Scout',
			participant_actor_ids: [agentId],
			direct: true,
		})
		expect(first.status).toBe(201)
		const firstId = await idOf(first)

		const second = await open(personId, {
			title: 'Anything else',
			participant_actor_ids: [agentId],
			direct: true,
		})
		expect(second.status).toBe(200)
		expect(await idOf(second)).toBe(firstId)

		expect(await chatsWith(agentId)).toHaveLength(1)
		expect(await dmOf(personId, agentId)).toEqual({ id: firstId })
	})

	it('puts a first message into the existing DM', async () => {
		const dmId = await idOf(
			await open(personId, { title: 'Scout', participant_actor_ids: [agentId], direct: true }),
		)

		const res = await open(personId, {
			title: 'Scout',
			participant_actor_ids: [agentId],
			direct: true,
			initial_message: 'Draft the launch note',
		})
		expect(res.status).toBe(200)
		expect(await idOf(res)).toBe(dmId)

		const posted = await db
			.select({ actorId: messages.actorId, content: messages.content })
			.from(messages)
			.where(eq(messages.conversationId, dmId))
		expect(posted).toEqual([{ actorId: personId, content: 'Draft the launch note' }])
	})

	it('creates one DM when two requests arrive at the same time', async () => {
		const results = await Promise.all([
			open(personId, { title: 'Race', participant_actor_ids: [agentId], direct: true }),
			open(personId, { title: 'Race', participant_actor_ids: [agentId], direct: true }),
		])
		expect(results.map((r) => r.status).sort()).toEqual([200, 201])
		const ids = await Promise.all(results.map(idOf))
		expect(ids[0]).toBe(ids[1])
		expect(await chatsWith(agentId)).toHaveLength(1)
	})

	it('keeps a plain create topical next to an existing DM', async () => {
		const dmId = await idOf(
			await open(personId, { title: 'Scout', participant_actor_ids: [agentId], direct: true }),
		)

		const plain = await open(personId, { title: 'Launch plan', participant_actor_ids: [agentId] })
		expect(plain.status).toBe(201)
		const plainId = await idOf(plain)
		expect(plainId).not.toBe(dmId)
		const again = await open(personId, { title: 'Launch plan', participant_actor_ids: [agentId] })
		expect(again.status).toBe(201)

		const chats = await chatsWith(agentId)
		expect(chats).toHaveLength(3)
		expect(chats.filter((c) => c.key !== null).map((c) => c.id)).toEqual([dmId])
		// The DM lookup still returns the DM, not the newest chat.
		expect(await dmOf(personId, agentId)).toEqual({ id: dmId })
		const reopened = await open(personId, {
			title: 'Scout',
			participant_actor_ids: [agentId],
			direct: true,
		})
		expect(await idOf(reopened)).toBe(dmId)
	})

	it('creates a topical chat first and a DM later without taking over the topical one', async () => {
		const topicalId = await idOf(
			await open(personId, { title: 'Launch plan', participant_actor_ids: [agentId] }),
		)
		expect(await dmOf(personId, agentId)).toBeNull()

		const dm = await open(personId, {
			title: 'Scout',
			participant_actor_ids: [agentId],
			direct: true,
		})
		expect(dm.status).toBe(201)
		expect(await idOf(dm)).not.toBe(topicalId)
	})

	it('gives each person their own DM with the agent', async () => {
		const otherPerson = await addMember()
		const mine = await idOf(
			await open(personId, { title: 'Mine', participant_actor_ids: [agentId], direct: true }),
		)
		const theirs = await idOf(
			await open(otherPerson, { title: 'Theirs', participant_actor_ids: [agentId], direct: true }),
		)
		expect(theirs).not.toBe(mine)
	})

	it('lands an agent reaching out to a person in the same DM the person opens', async () => {
		const fromAgent = await open(
			agentId,
			{ title: 'Hello', participant_actor_ids: [personId], direct: true },
			'agent',
		)
		expect(fromAgent.status).toBe(201)
		const dmId = await idOf(fromAgent)

		const fromPerson = await open(personId, {
			title: 'Scout',
			participant_actor_ids: [agentId],
			direct: true,
		})
		expect(fromPerson.status).toBe(200)
		expect(await idOf(fromPerson)).toBe(dmId)
	})

	it('has a DM between two agents too', async () => {
		const secondAgent = await addMember('agent')
		const first = await open(
			agentId,
			{ title: 'Peer', participant_actor_ids: [secondAgent], direct: true },
			'agent',
		)
		const second = await open(
			secondAgent,
			{ title: 'Peer', participant_actor_ids: [agentId], direct: true },
			'agent',
		)
		expect([first.status, second.status]).toEqual([201, 200])
		expect(await idOf(second)).toBe(await idOf(first))
	})

	it('refuses a DM with more than one other person, with nobody else, or about a subject', async () => {
		const colleague = await addMember()
		const group = await open(personId, {
			title: 'Team',
			participant_actor_ids: [agentId, colleague],
			direct: true,
		})
		const alone = await open(personId, {
			title: 'Me',
			participant_actor_ids: [personId],
			direct: true,
		})
		const about = await open(personId, {
			title: 'Bet',
			participant_actor_ids: [agentId],
			direct: true,
			subject: { type: 'object', id: crypto.randomUUID() },
		})
		expect([group.status, alone.status, about.status]).toEqual([400, 400, 400])
		expect(await chatsWith(agentId)).toHaveLength(0)
	})

	it('stops being the DM when a third person is added, and the pair gets a new one', async () => {
		const dmId = await idOf(
			await open(personId, { title: 'Scout', participant_actor_ids: [agentId], direct: true }),
		)
		const colleague = await addMember()

		const added = await appFor(personId).request(
			jsonRequest(
				'POST',
				`/api/conversations/${dmId}/participants`,
				{ actor_ids: [colleague] },
				ws(),
			),
		)
		expect(added.status).toBe(200)
		expect(await dmOf(personId, agentId)).toBeNull()

		const fresh = await open(personId, {
			title: 'Scout',
			participant_actor_ids: [agentId],
			direct: true,
		})
		expect(fresh.status).toBe(201)
		expect(await idOf(fresh)).not.toBe(dmId)
	})
})
