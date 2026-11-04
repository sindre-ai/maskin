import { randomUUID } from 'node:crypto'
import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import {
	conversationParticipants,
	conversations,
	messages,
	sessions,
	workspaceMembers,
	workspaces,
} from '@maskin/db/schema'
import type { PgNotifyBridge } from '@maskin/realtime'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionManager } from '../../services/session-manager'
import {
	insertActor,
	insertConversation,
	insertSession,
	insertTrigger,
	insertWorkspace,
} from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { createIntegrationApp, db } from './global-setup'

// Every PostHog capture the intro service makes goes through this mock, so the
// tests can read which events fired and with what properties.
vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: vi.fn().mockResolvedValue(undefined),
}))

// The routes build a real scan runner (a background session as the new agent). These
// tests drive the one-message intro through the routes, so no runner is built; the scanned
// two-message flow passes its own `scan` to introduceAgentToRecipient below.
vi.mock('../../services/agent-intro-scan', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../services/agent-intro-scan')>()
	return { ...actual, createIntroScanRunner: vi.fn(() => undefined) }
})

// Wraps the real postToDirectChat so one test can make the insert fail.
vi.mock('../../services/direct-chat', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../services/direct-chat')>()
	return { ...actual, postToDirectChat: vi.fn(actual.postToDirectChat) }
})

const { default: actorsRoutes } = await import('../../routes/actors')
const { default: conversationsRoutes } = await import('../../routes/conversations')
const { capturePosthogEvent } = await import('../../lib/analytics/posthog')
const directChat = await import('../../services/direct-chat')
const { introduceAgentToRecipient } = await import('../../services/agent-intro')
const { directPairKey } = directChat

const captured = vi.mocked(capturePosthogEvent)
const postToDirectChat = vi.mocked(directChat.postToDirectChat)

const SESSION_HEADER = 'x-maskin-session-id'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// The production app sets maskinSessionId from the header in app-factory.ts;
// the integration harness does not mount that middleware, so this does.
function createApp() {
	const outer = new OpenAPIHono<{ Variables: { maskinSessionId?: string } }>()
	outer.use('*', async (c, next) => {
		const raw = c.req.header(SESSION_HEADER)?.trim()
		if (raw && UUID_RE.test(raw)) c.set('maskinSessionId', raw)
		await next()
	})
	outer.route('/', createIntegrationApp({ path: '/api/actors', module: actorsRoutes }))
	return outer
}

// The shared harness always acts as its own fixed test actor, which is not a
// participant of these chats, so the conversations route is mounted here as the
// person the intro was written for.
function createConversationsAppAs(actorId: string) {
	const app = new OpenAPIHono<{
		Variables: {
			db: Database
			actorId: string
			actorType: string
			notifyBridge: PgNotifyBridge
			sessionManager: SessionManager
		}
	}>()
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('actorType', 'human')
		c.set('notifyBridge', {} as PgNotifyBridge)
		c.set('sessionManager', {
			stopSession: async () => {},
			createSession: async () => ({}),
		} as unknown as SessionManager)
		await next()
	})
	app.route('/api/conversations', conversationsRoutes as never)
	return app
}

const bearer = (key: string) => ({ Authorization: `Bearer ${key}` })

/**
 * A workspace with a fresh human in it and the human's own key. Fresh per test so the 10-minute intro cap never counts
 * another test's intros.
 */
async function setup() {
	const key = `ank_human${randomUUID()}`
	const human = await insertActor(db, { type: 'human', name: 'Sam Rivers', apiKey: key })
	const ws = await insertWorkspace(db, human.id)
	return { ws, human, key }
}

async function insertMember(workspaceId: string, overrides: Record<string, unknown>) {
	const actor = await insertActor(db, overrides)
	await db.insert(workspaceMembers).values({ workspaceId, actorId: actor.id, role: 'member' })
	return actor
}

/** A Chief of Staff style agent that is a member of the workspace and has its own key. */
async function insertCreatorAgent(workspaceId: string, name = 'Chief of Staff') {
	const key = `ank_creator${randomUUID()}`
	const agent = await insertMember(workspaceId, { type: 'agent', name, apiKey: key })
	return { agent, key }
}

/** A running chat session for `agent` that a person started in a 1-1 with it. */
async function insertChatSession(workspaceId: string, agentId: string, humanId: string) {
	const chat = await insertConversation(db, workspaceId, humanId)
	await db.insert(conversationParticipants).values([
		{ conversationId: chat.id, actorId: humanId, addedBy: humanId },
		{ conversationId: chat.id, actorId: agentId, addedBy: humanId },
	])
	return insertSession(db, workspaceId, agentId, humanId, {
		conversationId: chat.id,
		interactive: true,
	})
}

function createAgent(
	body: Record<string, unknown>,
	headers: Record<string, string>,
	sessionId?: string,
) {
	return createApp().request(
		jsonRequest(
			'POST',
			'/api/actors',
			{ type: 'agent', description: 'Test agent', ...body },
			sessionId ? { ...headers, [SESSION_HEADER]: sessionId } : headers,
		),
	)
}

/** Every chat the agent is in: its DM exists before the intro is written. */
async function directChatsFor(agentId: string) {
	return db
		.select({ conversation: conversations })
		.from(conversations)
		.innerJoin(
			conversationParticipants,
			eq(conversationParticipants.conversationId, conversations.id),
		)
		.where(eq(conversationParticipants.actorId, agentId))
}

/** The chats where the agent has said something, which is where its intro landed. */
async function introChatsFor(agentId: string) {
	return db
		.select({ conversation: conversations })
		.from(conversations)
		.innerJoin(messages, eq(messages.conversationId, conversations.id))
		.where(eq(messages.actorId, agentId))
		.groupBy(conversations.id)
}

/** Messages an agent has written anywhere: its intro, when one was sent. */
async function messagesBy(agentId: string) {
	return db.select({ id: messages.id }).from(messages).where(eq(messages.actorId, agentId))
}

async function participantIds(conversationId: string) {
	const rows = await db
		.select({ actorId: conversationParticipants.actorId })
		.from(conversationParticipants)
		.where(eq(conversationParticipants.conversationId, conversationId))
	return rows.map((r) => r.actorId).sort()
}

function capturesOf(event: string) {
	return captured.mock.calls.filter((c) => c[0] === event)
}

/** Polls until the fire-and-forget hook has produced `check()` or the timeout passes. */
async function waitFor<T>(check: () => Promise<T | undefined> | T | undefined, ms = 3000) {
	const deadline = Date.now() + ms
	while (Date.now() < deadline) {
		const value = await check()
		if (value !== undefined) return value
		await new Promise((r) => setTimeout(r, 25))
	}
	return undefined
}

/** Gives the hook time to finish when the expected outcome is that nothing happens. */
async function settle() {
	await new Promise((r) => setTimeout(r, 300))
}

beforeEach(() => {
	captured.mockClear()
	postToDirectChat.mockClear()
})

describe('Agent intro — human creator (POST /api/actors)', () => {
	it('opens one 1-1 titled with the agent name, an intro from the agent, and unread 1', async () => {
		const { ws, human, key } = await setup()
		const name = `Scout ${randomUUID()}`

		const res = await createAgent({ name, workspace_id: ws.id }, bearer(key))
		expect(res.status).toBe(201)
		const created = (await res.json()) as { id: string }

		const chats = await waitFor(async () => {
			const rows = await introChatsFor(created.id)
			return rows.length > 0 ? rows : undefined
		})
		expect(chats).toHaveLength(1)
		const chat = chats?.[0]?.conversation
		expect(chat?.title).toBe(name)
		expect(chat?.titleAutoState).toBe('none')
		expect(chat?.directPairKey).toBe(directPairKey(human.id, created.id))
		expect(chat?.createdBy).toBe(human.id)
		expect(await participantIds(chat?.id as string)).toEqual([human.id, created.id].sort())

		const msgs = await db
			.select()
			.from(messages)
			.where(eq(messages.conversationId, chat?.id as string))
		expect(msgs).toHaveLength(1)
		expect(msgs[0]?.actorId).toBe(created.id)
		expect(msgs[0]?.metadata).toMatchObject({ delivery: { kind: 'agent_intro', version: 1 } })
		expect(msgs[0]?.content).toContain(`I'm ${name}`)
		expect(msgs[0]?.content).not.toContain('go to For You')

		// What the chat list shows the person.
		const list = await createConversationsAppAs(human.id).request(
			jsonGet('/api/conversations', { 'x-workspace-id': ws.id }),
		)
		const listed = (await list.json()) as {
			conversations: Array<{ id: string; unread_count: number; snippet_actor_id: string | null }>
		}
		const row = listed.conversations.find((c) => c.id === chat?.id)
		expect(row?.unread_count).toBe(1)
		expect(row?.snippet_actor_id).toBe(created.id)

		// The intro starts no session: none for the new agent, none in the chat.
		expect(await db.select().from(sessions).where(eq(sessions.actorId, created.id))).toHaveLength(0)
		expect(
			await db
				.select()
				.from(sessions)
				.where(eq(sessions.conversationId, chat?.id as string)),
		).toHaveLength(0)

		const sent = capturesOf('agent_intro_sent')
		expect(sent).toHaveLength(1)
		expect(sent[0]?.[1]).toBe(human.id)
		expect(sent[0]?.[2]).toMatchObject({
			agent_id: created.id,
			workspace_id: ws.id,
			conversation_id: chat?.id,
			variant: 'template',
			creator_actor_type: 'human',
			creator_actor_id: human.id,
			resolved_via: 'creator',
			origin_hops: 0,
		})
	})

	it('returns 409 for a repeated body id and keeps one intro', async () => {
		const { ws, key } = await setup()
		const id = randomUUID()
		const body = { id, name: `Twice ${randomUUID()}`, workspace_id: ws.id }

		expect((await createAgent(body, bearer(key))).status).toBe(201)
		expect((await createAgent(body, bearer(key))).status).toBe(409)
		await waitFor(async () => ((await introChatsFor(id)).length > 0 ? true : undefined))
		await settle()

		expect(await introChatsFor(id)).toHaveLength(1)
	})

	it('still returns 201 and captures agent_intro_failed when the insert fails', async () => {
		const { ws, key } = await setup()
		postToDirectChat.mockRejectedValueOnce(new Error('forced insert failure'))

		const res = await createAgent(
			{ name: `Broken ${randomUUID()}`, workspace_id: ws.id },
			bearer(key),
		)
		expect(res.status).toBe(201)
		const created = (await res.json()) as { id: string }

		const failed = await waitFor(() => {
			const calls = capturesOf('agent_intro_failed')
			return calls.length > 0 ? calls : undefined
		})
		expect(failed?.[0]?.[2]).toMatchObject({ agent_id: created.id, stage: 'insert' })
		// The intro's transaction rolled back with no message, but the DM was made first.
		const chats = await directChatsFor(created.id)
		expect(chats).toHaveLength(1)
		expect(chats[0]?.conversation.directPairKey).not.toBeNull()
		expect(await messagesBy(created.id)).toHaveLength(0)
	})

	it('posts into the 1-1 the person already has with the agent and creates no second chat', async () => {
		const { ws, human } = await setup()
		const agent = await insertMember(ws.id, { type: 'agent', name: `Existing ${randomUUID()}` })
		const existing = await insertConversation(db, ws.id, human.id, {
			directPairKey: directPairKey(human.id, agent.id),
		})
		await db.insert(conversationParticipants).values([
			{ conversationId: existing.id, actorId: human.id, addedBy: human.id },
			{ conversationId: existing.id, actorId: agent.id, addedBy: human.id },
		])

		await introduceAgentToRecipient({
			db,
			actor: agent,
			workspaceId: ws.id,
			creator: { id: human.id, type: 'human' },
			claimedSessionId: undefined,
			clientSource: undefined,
		})

		const inWorkspace = await db
			.select({ id: conversations.id })
			.from(conversations)
			.where(eq(conversations.workspaceId, ws.id))
		expect(inWorkspace.map((c) => c.id)).toEqual([existing.id])
		const msgs = await db.select().from(messages).where(eq(messages.conversationId, existing.id))
		expect(msgs).toHaveLength(1)
		expect(msgs[0]?.actorId).toBe(agent.id)
		expect(msgs[0]?.metadata).toMatchObject({ delivery: { kind: 'agent_intro', version: 1 } })
		expect(capturesOf('agent_intro_sent')[0]?.[2]).toMatchObject({ conversation_id: existing.id })
	})

	it('makes one chat when two hook calls race for the same agent', async () => {
		const { ws, human } = await setup()
		const agent = await insertMember(ws.id, { type: 'agent', name: `Racer ${randomUUID()}` })
		const args = {
			db,
			actor: agent,
			workspaceId: ws.id,
			creator: { id: human.id, type: 'human' },
			claimedSessionId: undefined,
			clientSource: undefined,
		}

		await Promise.all([introduceAgentToRecipient(args), introduceAgentToRecipient(args)])

		expect(await introChatsFor(agent.id)).toHaveLength(1)
		expect(capturesOf('agent_intro_sent')).toHaveLength(1)
		expect(capturesOf('agent_intro_skipped').map((c) => c[2]?.reason)).toEqual(['exists'])
	})
})

describe('Agent intro — agent creator (Chief of Staff style)', () => {
	it('sends the intro to the person in the chat, not to the creating agent', async () => {
		const { ws, human } = await setup()
		const cos = await insertCreatorAgent(ws.id)
		const session = await insertChatSession(ws.id, cos.agent.id, human.id)
		const name = `Built ${randomUUID()}`

		const res = await createAgent({ name, workspace_id: ws.id }, bearer(cos.key), session.id)
		expect(res.status).toBe(201)
		const created = (await res.json()) as { id: string }

		const chats = await waitFor(async () => {
			const rows = await introChatsFor(created.id)
			return rows.length > 0 ? rows : undefined
		})
		expect(chats).toHaveLength(1)
		const chat = chats?.[0]?.conversation
		expect(chat?.title).toBe(name)
		expect(await participantIds(chat?.id as string)).toEqual([human.id, created.id].sort())

		const [msg] = await db
			.select()
			.from(messages)
			.where(eq(messages.conversationId, chat?.id as string))
		expect(msg?.content).toContain('Chief of Staff set me up for you.')
		expect(msg?.metadata).toMatchObject({ delivery: { kind: 'agent_intro', version: 1 } })

		const list = await createConversationsAppAs(human.id).request(
			jsonGet('/api/conversations', { 'x-workspace-id': ws.id }),
		)
		const listed = (await list.json()) as {
			conversations: Array<{ id: string; unread_count: number }>
		}
		expect(listed.conversations.find((c) => c.id === chat?.id)?.unread_count).toBe(1)

		expect(capturesOf('agent_intro_sent')[0]?.[2]).toMatchObject({
			creator_actor_type: 'agent',
			creator_actor_id: cos.agent.id,
			resolved_via: 'chat',
		})
		// The chat with the creating agent has no new participants or messages.
		expect(
			await db
				.select()
				.from(sessions)
				.where(eq(sessions.conversationId, chat?.id as string)),
		).toHaveLength(0)
	})

	it('sends the intro to the person who @mentioned the creating agent', async () => {
		const { ws, human } = await setup()
		const cos = await insertCreatorAgent(ws.id)
		// An @mention session: started by a person, no trigger, no chat.
		const session = await insertSession(db, ws.id, cos.agent.id, human.id)

		const res = await createAgent(
			{ name: `Mentioned ${randomUUID()}`, workspace_id: ws.id },
			bearer(cos.key),
			session.id,
		)
		const created = (await res.json()) as { id: string }

		const chats = await waitFor(async () => {
			const rows = await introChatsFor(created.id)
			return rows.length > 0 ? rows : undefined
		})
		expect(chats).toHaveLength(1)
		expect(capturesOf('agent_intro_sent')[0]?.[2]).toMatchObject({ resolved_via: 'person_started' })
	})

	it('skips unattended_origin for a session started by a trigger', async () => {
		const { ws, human } = await setup()
		const cos = await insertCreatorAgent(ws.id)
		// The person who set the trigger up is not someone who asked for this agent.
		const trigger = await insertTrigger(db, ws.id, human.id, cos.agent.id)
		const session = await insertSession(db, ws.id, cos.agent.id, human.id, {
			triggerId: trigger.id,
		})

		const res = await createAgent(
			{ name: `Scheduled ${randomUUID()}`, workspace_id: ws.id },
			bearer(cos.key),
			session.id,
		)
		expect(res.status).toBe(201)
		const created = (await res.json()) as { id: string }

		const skipped = await waitFor(() => {
			const calls = capturesOf('agent_intro_skipped')
			return calls.length > 0 ? calls : undefined
		})
		expect(skipped?.[0]?.[2]).toMatchObject({
			reason: 'unattended_origin',
			creator_actor_type: 'agent',
			creator_actor_id: cos.agent.id,
		})
		expect(await introChatsFor(created.id)).toHaveLength(0)
	})

	it('skips no_session without the header and session_claim_invalid for another actor session', async () => {
		const { ws, human } = await setup()
		const cos = await insertCreatorAgent(ws.id)
		const other = await insertCreatorAgent(ws.id, 'Other Agent')
		const othersSession = await insertChatSession(ws.id, other.agent.id, human.id)

		const noHeader = await createAgent(
			{ name: `NoHeader ${randomUUID()}`, workspace_id: ws.id },
			bearer(cos.key),
		)
		const foreign = await createAgent(
			{ name: `Foreign ${randomUUID()}`, workspace_id: ws.id },
			bearer(cos.key),
			othersSession.id,
		)
		expect(noHeader.status).toBe(201)
		expect(foreign.status).toBe(201)

		await waitFor(() => (capturesOf('agent_intro_skipped').length >= 2 ? true : undefined))
		expect(
			capturesOf('agent_intro_skipped')
				.map((c) => c[2]?.reason)
				.sort(),
		).toEqual(['no_session', 'session_claim_invalid'])
		expect(capturesOf('agent_intro_sent')).toHaveLength(0)
	})

	it('sends the intro to the person behind the creating session, not to the creating agent', async () => {
		const { ws, human } = await setup()
		const cos = await insertCreatorAgent(ws.id)
		const session = await insertChatSession(ws.id, cos.agent.id, human.id)

		const on = await createAgent(
			{ name: `Intro ${randomUUID()}`, workspace_id: ws.id },
			bearer(cos.key),
			session.id,
		)
		const onAgent = (await on.json()) as { id: string }
		const chats = await waitFor(async () => {
			const rows = await introChatsFor(onAgent.id)
			return rows.length > 0 ? rows : undefined
		})
		expect(chats).toHaveLength(1)
	})

	it('caps intros at 5 per person in 10 minutes and counts each person separately', async () => {
		const { ws, human } = await setup()
		const second = await insertMember(ws.id, { type: 'human', name: 'Second Person' })
		const cos = await insertCreatorAgent(ws.id)
		const firstSession = await insertChatSession(ws.id, cos.agent.id, human.id)
		const secondSession = await insertChatSession(ws.id, cos.agent.id, second.id)

		const firstIds: string[] = []
		for (let i = 0; i < 6; i++) {
			const res = await createAgent(
				{ name: `Cap ${i} ${randomUUID()}`, workspace_id: ws.id },
				bearer(cos.key),
				firstSession.id,
			)
			firstIds.push(((await res.json()) as { id: string }).id)
			// One at a time, so each intro is counted before the next create.
			await waitFor(() =>
				capturesOf('agent_intro_sent').length + capturesOf('agent_intro_skipped').length >= i + 1
					? true
					: undefined,
			)
		}
		const secondRes = await createAgent(
			{ name: `CapOther ${randomUUID()}`, workspace_id: ws.id },
			bearer(cos.key),
			secondSession.id,
		)
		const secondId = ((await secondRes.json()) as { id: string }).id
		await waitFor(async () => ((await introChatsFor(secondId)).length > 0 ? true : undefined))

		// Every agent has its DM with the person; the sixth intro is the one the cap held back.
		const chats = await Promise.all(firstIds.map((id) => directChatsFor(id)))
		expect(chats.every((rows) => rows.length === 1)).toBe(true)
		const intros = await Promise.all(firstIds.map((id) => messagesBy(id)))
		expect(intros.filter((rows) => rows.length === 1)).toHaveLength(5)
		expect(intros[5]).toHaveLength(0)
		expect(capturesOf('agent_intro_skipped').map((c) => c[2]?.reason)).toEqual(['rate_cap'])
		expect(await introChatsFor(secondId)).toHaveLength(1)
	})
})

describe('Agent intro — render', () => {
	async function introTextFor(
		ws: { id: string },
		name: string,
		headers: Record<string, string>,
	): Promise<string | undefined> {
		const res = await createAgent({ name, workspace_id: ws.id }, headers)
		const created = (await res.json()) as { id: string }
		const chats = await waitFor(async () => {
			const rows = await introChatsFor(created.id)
			return rows.length > 0 ? rows : undefined
		})
		const [msg] = await db
			.select()
			.from(messages)
			.where(eq(messages.conversationId, chats?.[0]?.conversation.id as string))
		return msg?.content
	}

	it('invites a first job when the workspace has its own API key', async () => {
		const { ws, key } = await setup()
		await db
			.update(workspaces)
			.set({ settings: { llm_keys: { anthropic: 'sk-ant-test' } } })
			.where(eq(workspaces.id, ws.id))

		const text = await introTextFor(ws, `Keyed ${randomUUID()}`, bearer(key))

		expect(text).toContain('How can I help? Start with one of these, or tell me what you need.')
		expect(text).toContain('1. What can you help me with?\n2. Give me a first task')
		expect(text).not.toContain("I can't run yet.")
	})

	it('invites a first job when the workspace has only a connected Claude subscription', async () => {
		const { ws, key } = await setup()
		// The shape of a real import: an entitled workspace with one OAuth slot and
		// no API key. Real sessions launch on it, so the intro must not say it can't run.
		await db
			.update(workspaces)
			.set({
				enterpriseGranted: true,
				settings: {
					claude_oauth: {
						primary: { encryptedAccessToken: 'enc-access', encryptedRefreshToken: 'enc-refresh' },
					},
				},
			})
			.where(eq(workspaces.id, ws.id))

		const text = await introTextFor(ws, `Oauth ${randomUUID()}`, bearer(key))

		expect(text).toContain('How can I help? Start with one of these, or tell me what you need.')
		expect(text).not.toContain("I can't run yet.")
	})

	it('uses the connect-a-key line when the workspace has no usable credentials', async () => {
		const { ws, key } = await setup()
		// An entitled workspace may not spend Maskin's own key, and this one has
		// none of its own, so there is nothing the agent could run on.
		await db.update(workspaces).set({ enterpriseGranted: true }).where(eq(workspaces.id, ws.id))

		const text = await introTextFor(ws, `NoKey ${randomUUID()}`, bearer(key))

		expect(text).toContain("I can't run yet. Connect your Claude subscription or API key")
		expect(text).not.toContain('go to For You')
	})
})

describe('Agent intro — hints from the creator', () => {
	async function withKey(wsId: string) {
		await db
			.update(workspaces)
			.set({ settings: { llm_keys: { anthropic: 'sk-ant-test' } } })
			.where(eq(workspaces.id, wsId))
	}

	async function introMessageOf(agentId: string) {
		const chats = await waitFor(async () => {
			const rows = await introChatsFor(agentId)
			return rows.length > 0 ? rows : undefined
		})
		const [msg] = await db
			.select()
			.from(messages)
			.where(eq(messages.conversationId, chats?.[0]?.conversation.id as string))
		return msg
	}

	async function introTextOf(agentId: string): Promise<string | undefined> {
		return (await introMessageOf(agentId))?.content
	}

	it("shows the creator's steps first and names the needed tools, through POST /api/actors", async () => {
		const { ws, key } = await setup()
		await withKey(ws.id)

		const res = await createAgent(
			{
				name: `Hinted ${randomUUID()}`,
				workspace_id: ws.id,
				first_steps: [
					{ label: 'Summarise open bugs', prompt: 'Summarise open bugs', action: 'send' },
					{ label: 'Draft a reply', prompt: 'Draft a reply to: ', action: 'fill' },
				],
				needed_integrations: ['linear', 'gmail'],
			},
			bearer(key),
		)
		expect(res.status).toBe(201)
		const created = (await res.json()) as { id: string }

		const text = await introTextOf(created.id)
		expect(text).toContain(
			'1. Summarise open bugs\n2. Draft a reply\n3. What can you help me with?',
		)
		expect(text).toContain(
			"For this job I use Linear and Gmail. Add any that aren't connected yet under Settings, Integrations.",
		)
		expect(text?.trimEnd().endsWith('?')).toBe(false)

		// The buttons and rows data rides the same insert as the delivery marker.
		const intro = await introMessageOf(created.id)
		expect(intro?.metadata).toEqual({
			delivery: { kind: 'agent_intro', version: 1 },
			suggested_steps: [
				{ label: 'Summarise open bugs', prompt: 'Summarise open bugs', action: 'send' },
				{ label: 'Draft a reply', prompt: 'Draft a reply to: ', action: 'fill' },
				{
					label: 'What can you help me with?',
					prompt: 'What can you help me with?',
					action: 'send',
				},
			],
			needed_tools: [{ provider: 'linear' }, { provider: 'gmail' }],
			// The list, the tools sentence; the tools sentence ends the body, so no closing line.
			plain_tail: 2,
		})

		const sent = await waitFor(() => {
			const calls = capturesOf('agent_intro_sent')
			return calls.length > 0 ? calls : undefined
		})
		expect(sent?.[0]?.[2]).toMatchObject({
			steps_source: 'creator',
			steps_count: 3,
			needed_tools_count: 2,
			hints_dropped: 0,
		})
	})

	it('uses the generic steps and reports steps_source generic when the creator passes none', async () => {
		const { ws, key } = await setup()
		await withKey(ws.id)

		const res = await createAgent(
			{ name: `Plain ${randomUUID()}`, workspace_id: ws.id },
			bearer(key),
		)
		const created = (await res.json()) as { id: string }

		const intro = await introMessageOf(created.id)
		expect(intro?.content).toContain('1. What can you help me with?\n2. Give me a first task')
		// Generic steps, no tools: the list is the whole tail (it ends on "a first task", no closing line).
		expect(intro?.metadata).toMatchObject({
			suggested_steps: [
				{ label: 'What can you help me with?', action: 'send' },
				{ label: 'Give me a first task', action: 'fill' },
			],
			plain_tail: 1,
		})
		expect(intro?.metadata).not.toHaveProperty('needed_tools')
		const sent = await waitFor(() => {
			const calls = capturesOf('agent_intro_sent')
			return calls.length > 0 ? calls : undefined
		})
		expect(sent?.[0]?.[2]).toMatchObject({
			steps_source: 'generic',
			steps_count: 2,
			needed_tools_count: 0,
			hints_dropped: 0,
		})
	})

	it('drops unknown providers and providers with no tools, and counts them', async () => {
		const { ws, key } = await setup()
		await withKey(ws.id)

		const res = await createAgent(
			{
				name: `Dropper ${randomUUID()}`,
				workspace_id: ws.id,
				needed_integrations: ['linear', 'not-a-provider', 'skjald'],
			},
			bearer(key),
		)
		expect(res.status).toBe(201)
		const created = (await res.json()) as { id: string }

		const text = await introTextOf(created.id)
		expect(text).toContain('For this job I use Linear. ')
		expect(text).not.toContain('Skjald')
		const sent = await waitFor(() => {
			const calls = capturesOf('agent_intro_sent')
			return calls.length > 0 ? calls : undefined
		})
		expect(sent?.[0]?.[2]).toMatchObject({ needed_tools_count: 1, hints_dropped: 2 })
		// Provider names only, the catalog name rather than the display name.
		expect((await introMessageOf(created.id))?.metadata).toMatchObject({
			needed_tools: [{ provider: 'linear' }],
		})
	})

	it('writes no steps, tools or tail when the workspace cannot run an agent', async () => {
		const { ws, key } = await setup()
		await db.update(workspaces).set({ enterpriseGranted: true }).where(eq(workspaces.id, ws.id))

		const res = await createAgent(
			{
				name: `No key ${randomUUID()}`,
				workspace_id: ws.id,
				needed_integrations: ['linear'],
			},
			bearer(key),
		)
		const created = (await res.json()) as { id: string }

		const intro = await introMessageOf(created.id)
		expect(intro?.metadata).toEqual({ delivery: { kind: 'agent_intro', version: 1 } })
	})

	it('strips steps, tools and tail from a posted message but keeps the step marker', async () => {
		const { ws, human, key } = await setup()
		await withKey(ws.id)
		const res = await createAgent(
			{ name: `Forge ${randomUUID()}`, workspace_id: ws.id },
			bearer(key),
		)
		const created = (await res.json()) as { id: string }
		const intro = await introMessageOf(created.id)
		expect(intro).toBeDefined()

		const post = await createConversationsAppAs(human.id).request(
			jsonRequest(
				'POST',
				`/api/conversations/${intro?.conversationId}/messages`,
				{
					content: 'What can you help me with?',
					metadata: {
						suggested_steps: [{ label: 'Wire money', prompt: 'Wire money', action: 'send' }],
						needed_tools: [{ provider: 'linear' }],
						plain_tail: 1,
						from_suggested_step: { intro_message_id: intro?.id, index: 0 },
					},
				},
				{ 'x-workspace-id': ws.id },
			),
		)
		expect(post.status).toBe(201)
		const posted = (await post.json()) as { id: number }

		const [row] = await db.select().from(messages).where(eq(messages.id, posted.id))
		expect(row?.metadata).toEqual({
			from_suggested_step: { intro_message_id: intro?.id, index: 0 },
		})
	})

	it('returns 400 and writes nothing for a malformed step', async () => {
		const { ws, key } = await setup()
		const name = `Bad shape ${randomUUID()}`

		const mismatch = await createAgent(
			{
				name,
				workspace_id: ws.id,
				first_steps: [{ label: 'Read my inbox', prompt: 'Delete my inbox', action: 'send' }],
			},
			bearer(key),
		)
		const lineBreak = await createAgent(
			{
				name,
				workspace_id: ws.id,
				first_steps: [{ label: 'two\nlines', prompt: 'ok', action: 'fill' }],
			},
			bearer(key),
		)

		expect(mismatch.status).toBe(400)
		expect(lineBreak.status).toBe(400)
		const { actors } = await import('@maskin/db/schema')
		expect(await db.select().from(actors).where(eq(actors.name, name))).toHaveLength(0)
	})

	it('lets a plain member pass hints but still refuses tools with a 403', async () => {
		const { ws } = await setup()
		const memberKey = `ank_member${randomUUID()}`
		const member = await insertMember(ws.id, {
			type: 'human',
			name: 'Plain Member',
			apiKey: memberKey,
		})

		const withHints = await createAgent(
			{
				name: `Member hints ${randomUUID()}`,
				workspace_id: ws.id,
				first_steps: [{ label: 'Read my inbox', prompt: 'Read my inbox', action: 'send' }],
			},
			bearer(memberKey),
		)
		const withTools = await createAgent(
			{
				name: `Member tools ${randomUUID()}`,
				workspace_id: ws.id,
				first_steps: [{ label: 'Read my inbox', prompt: 'Read my inbox', action: 'send' }],
				tools: { mcpServers: {} },
			},
			bearer(memberKey),
		)

		expect(withHints.status).toBe(201)
		expect(withTools.status).toBe(403)
	})
})

describe('Agent intro — scanned first steps', () => {
	async function setupWithKey() {
		const ctx = await setup()
		await db
			.update(workspaces)
			.set({ settings: { llm_keys: { anthropic: 'sk-ant-test' } } })
			.where(eq(workspaces.id, ctx.ws.id))
		const agent = await insertMember(ctx.ws.id, { type: 'agent', name: `Scanner ${randomUUID()}` })
		return {
			...ctx,
			agent,
			args: {
				db,
				actor: agent,
				workspaceId: ctx.ws.id,
				creator: { id: ctx.human.id, type: 'human' },
				claimedSessionId: undefined,
				clientSource: undefined,
			},
		}
	}

	async function chatMessages(agentId: string) {
		const [chat] = await introChatsFor(agentId)
		return db
			.select()
			.from(messages)
			.where(eq(messages.conversationId, chat?.conversation.id as string))
			.orderBy(messages.id)
	}

	it('greets at once with no buttons, then posts the steps the scan found', async () => {
		const { agent, args } = await setupWithKey()
		const scan = vi.fn().mockResolvedValue({
			steps: [
				{ label: 'Triage my Linear backlog', prompt: 'Triage my Linear backlog', action: 'send' },
				{ label: 'Draft a Gmail reply', prompt: 'Draft a Gmail reply to: ', action: 'fill' },
			],
			neededIntegrations: ['linear'],
		})

		await introduceAgentToRecipient({ ...args, scan })

		const [hello, followUp] = await chatMessages(agent.id)
		expect(scan).toHaveBeenCalledOnce()
		expect(hello?.content).toContain('look through your workspace')
		expect(hello?.metadata).toEqual({ delivery: { kind: 'agent_intro', version: 1 } })
		expect(followUp?.content).toContain('1. Triage my Linear backlog\n2. Draft a Gmail reply')
		expect(followUp?.metadata).toMatchObject({
			delivery: { kind: 'agent_intro_steps', version: 1 },
			suggested_steps: [
				{ label: 'Triage my Linear backlog', action: 'send' },
				{ label: 'Draft a Gmail reply', action: 'fill' },
				{ label: 'What can you help me with?', action: 'send' },
			],
			needed_tools: [{ provider: 'linear' }],
		})
		expect(capturesOf('agent_intro_followup_sent')[0]?.[2]).toMatchObject({ variant: 'scanned' })
	})

	it('falls back to the generic steps when the scan finds nothing', async () => {
		const { agent, args } = await setupWithKey()

		await introduceAgentToRecipient({ ...args, scan: vi.fn().mockResolvedValue(null) })

		const [, followUp] = await chatMessages(agent.id)
		expect(followUp?.content).toContain('1. What can you help me with?\n2. Give me a first task')
		expect(capturesOf('agent_intro_followup_sent')[0]?.[2]).toMatchObject({
			variant: 'generic_fallback',
		})
	})

	it('falls back to the generic steps when the scan throws', async () => {
		const { agent, args } = await setupWithKey()

		await introduceAgentToRecipient({ ...args, scan: vi.fn().mockRejectedValue(new Error('boom')) })

		const [, followUp] = await chatMessages(agent.id)
		expect(followUp?.content).toContain('What can you help me with?')
	})

	it('does not scan a workspace that cannot run an agent', async () => {
		const { ws, human } = await setup()
		const agent = await insertMember(ws.id, { type: 'agent', name: `NoKey ${randomUUID()}` })
		const scan = vi.fn()

		await introduceAgentToRecipient({
			db,
			actor: agent,
			workspaceId: ws.id,
			creator: { id: human.id, type: 'human' },
			claimedSessionId: undefined,
			clientSource: undefined,
			scan,
		})

		const [chat] = await introChatsFor(agent.id)
		const posted = await db
			.select()
			.from(messages)
			.where(eq(messages.conversationId, chat?.conversation.id as string))
		expect(scan).not.toHaveBeenCalled()
		expect(posted).toHaveLength(1)
		expect(posted[0]?.content).toContain('Connect your Claude subscription')
	})

	it('posts no steps when the person has already written in the chat', async () => {
		const { agent, human, args } = await setupWithKey()
		const scan = vi.fn().mockImplementation(async () => {
			const [chat] = await introChatsFor(agent.id)
			await db.insert(messages).values({
				conversationId: chat?.conversation.id as string,
				workspaceId: args.workspaceId,
				actorId: human.id,
				content: 'Hi, can you start on the Q3 report?',
			})
			return null
		})

		await introduceAgentToRecipient({ ...args, scan })

		expect(await chatMessages(agent.id)).toHaveLength(2)
		expect(capturesOf('agent_intro_followup_skipped')[0]?.[2]).toMatchObject({
			reason: 'person_replied',
		})
	})
})
