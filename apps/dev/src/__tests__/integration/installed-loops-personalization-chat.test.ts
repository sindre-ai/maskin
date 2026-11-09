import { randomUUID } from 'node:crypto'
import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import {
	conversationParticipants,
	conversations,
	marketplaceLoops,
	messages,
	workspaceMembers,
} from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createApiError, formatZodError } from '../../lib/errors'
import { AgentStorageManager } from '../../services/agent-storage'
import { buildLoopPersonalizationPrompt } from '../../services/loop-personalization-chat'
import { buildActor, insertActor, insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { db, getTestActorId, sql as rawSql } from './global-setup'

// The responder would start a real agent session; what matters here is that it is
// asked to answer the personalization message.
const evaluateAndRespond = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('../../services/conversation-responder', () => ({ evaluateAndRespond }))

const { default: installedLoopsRoutes } = await import('../../routes/installed-loops')

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		agentStorage: AgentStorageManager
		sessionManager: unknown
	}
}

function createMemoryStorage(): StorageProvider {
	const store = new Map<string, Buffer>()
	return {
		async put(key, data) {
			store.set(key, Buffer.isBuffer(data) ? data : Buffer.from(data as Uint8Array))
		},
		async get(key) {
			const buf = store.get(key)
			if (!buf) throw new Error(`Not found: ${key}`)
			return buf
		},
		async list(prefix) {
			return [...store.keys()].filter((k) => k.startsWith(prefix))
		},
		async listWithMetadata(prefix) {
			return [...store.entries()]
				.filter(([k]) => k.startsWith(prefix))
				.map(([key, buf]) => ({ key, size: buf.length }))
		},
		async delete(key) {
			store.delete(key)
		},
		async exists(key) {
			return store.has(key)
		},
		async ensureBucket() {
			// no-op
		},
	}
}

function makeApp(actorId: string) {
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
	const agentStorage = new AgentStorageManager(createMemoryStorage(), db)
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('actorType', 'human')
		c.set('agentStorage', agentStorage)
		c.set('sessionManager', {})
		await next()
	})
	app.route('/api/installed-loops', installedLoopsRoutes)
	return app
}

async function seedMarketplaceLoop() {
	const [loop] = await db
		.insert(marketplaceLoops)
		.values({
			name: 'Outreach Loop',
			slug: `outreach-loop-${randomUUID()}`,
			description: 'Send outreach and follow up',
			version: '1.0.0',
			useCase: 'growth',
		})
		.returning()
	if (!loop) throw new Error('marketplace_loops insert returned no row')
	return loop
}

async function addChiefOfStaff(workspaceId: string) {
	const chief = await insertActor(db, buildActor({ type: 'agent', name: 'Chief of Staff' }))
	await db.insert(workspaceMembers).values({ workspaceId, actorId: chief.id, role: 'member' })
	return chief
}

describe('Installing a marketplace loop → personalization chat with Chief of Staff', () => {
	let workspaceId: string
	let actorId: string

	beforeEach(async () => {
		await rawSql`TRUNCATE marketplace_loops, marketplace_loop_items CASCADE`
		evaluateAndRespond.mockClear()
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		if (!ws) throw new Error('workspace insert returned no row')
		workspaceId = ws.id
	})

	it('opens a chat about the install with the Chief of Staff and wakes it with a suggest-only ask', async () => {
		const chief = await addChiefOfStaff(workspaceId)
		const loop = await seedMarketplaceLoop()

		const res = await makeApp(actorId).request(
			jsonRequest('POST', '/api/installed-loops', { loopId: loop.id, workspaceId }),
		)
		expect(res.status).toBe(201)
		const installed = await res.json()

		// The chat is started after the response is built; wait for the responder call.
		await vi.waitFor(() => expect(evaluateAndRespond).toHaveBeenCalledTimes(1))

		const [conversation] = await db
			.select()
			.from(conversations)
			.where(eq(conversations.subjectId, installed.id))
		if (!conversation) throw new Error('personalization chat was not created')
		expect(conversation.workspaceId).toBe(workspaceId)
		expect(conversation.subjectType).toBe('loop')

		const participants = await db
			.select({ actorId: conversationParticipants.actorId })
			.from(conversationParticipants)
			.where(eq(conversationParticipants.conversationId, conversation.id))
		expect(participants.map((p) => p.actorId).sort()).toEqual([actorId, chief.id].sort())

		const [message] = await db
			.select()
			.from(messages)
			.where(eq(messages.conversationId, conversation.id))
		if (!message) throw new Error('personalization prompt was not posted')
		expect(message.actorId).toBe(actorId)
		expect(message.content).toBe(buildLoopPersonalizationPrompt(loop))
		expect(message.metadata).toMatchObject({ mentions: [chief.id], hidden_from_chat: true })

		expect(evaluateAndRespond).toHaveBeenCalledWith(
			expect.objectContaining({
				workspaceId,
				conversationId: conversation.id,
				messageId: message.id,
			}),
		)
	})

	it('installs without a chat when the workspace has no Chief of Staff', async () => {
		const loop = await seedMarketplaceLoop()

		const res = await makeApp(actorId).request(
			jsonRequest('POST', '/api/installed-loops', { loopId: loop.id, workspaceId }),
		)
		expect(res.status).toBe(201)

		const chats = await db
			.select({ id: conversations.id })
			.from(conversations)
			.where(eq(conversations.workspaceId, workspaceId))
		expect(chats).toHaveLength(0)
		expect(evaluateAndRespond).not.toHaveBeenCalled()
	})
})

describe('buildLoopPersonalizationPrompt', () => {
	it('asks for suggestions only and names the loop', () => {
		const prompt = buildLoopPersonalizationPrompt({ name: 'Outreach Loop', description: null })
		expect(prompt).toContain('"Outreach Loop"')
		expect(prompt).toContain('suggestions only')
		expect(prompt).toContain('Do not change anything yet')
	})
})
