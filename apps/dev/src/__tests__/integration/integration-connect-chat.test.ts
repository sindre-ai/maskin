import { OpenAPIHono } from '@hono/zod-openapi'
import {
	conversationParticipants,
	conversations,
	integrations,
	messages,
	workspaceMembers,
} from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:dns/promises', async (orig) => ({
	...(await orig<typeof import('node:dns/promises')>()),
	lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
}))
vi.mock('../../lib/analytics/posthog', () => ({ capturePosthogEvent: vi.fn(async () => {}) }))

// The responder would start a real agent session; what matters is that it is asked to answer the
// connect message, and that a failure in it never reaches the connect.
const evaluateAndRespond = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('../../services/conversation-responder', () => ({ evaluateAndRespond }))

import { createApiError } from '../../lib/errors'
import { _resetFeatureFlagConfig } from '../../lib/feature-flags'
import customMcpServersRoutes from '../../routes/custom-mcp-servers'
import {
	buildIntegrationConnectPrompt,
	startIntegrationConnectChat,
} from '../../services/integration-connect-chat'
import type { SessionManager } from '../../services/session-manager'
import { buildActor, insertActor, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

beforeAll(() => {
	process.env.INTEGRATION_ENCRYPTION_KEY ??= 'a'.repeat(64)
})

const sessionManager = {} as SessionManager

function flagOn(actorId: string) {
	vi.stubEnv('FF_TESTER_ACTOR_IDS', actorId)
	vi.stubEnv('FF_TESTER_FEATURES', 'integration-connect-chat')
	_resetFeatureFlagConfig()
}

async function setup() {
	const human = getTestActorId()
	const ws = await insertWorkspace(db, human, { enterpriseGranted: true })
	const chief = await insertActor(db, buildActor({ type: 'agent', name: 'Chief of Staff' }))
	await db
		.insert(workspaceMembers)
		.values({ workspaceId: ws.id, actorId: chief.id, role: 'member' })
	return { human, ws, chief }
}

async function chatsOf(workspaceId: string) {
	return db.select().from(conversations).where(eq(conversations.workspaceId, workspaceId))
}

afterEach(() => {
	vi.unstubAllEnvs()
	_resetFeatureFlagConfig()
})

describe('startIntegrationConnectChat', () => {
	beforeEach(() => {
		evaluateAndRespond.mockReset()
		evaluateAndRespond.mockResolvedValue(undefined)
	})

	it('does nothing while the flag is off', async () => {
		const { human, ws } = await setup()
		const result = await startIntegrationConnectChat({
			db,
			sessionManager,
			workspaceId: ws.id,
			actorId: human,
			integrationId: '11111111-1111-4111-8111-111111111111',
			provider: 'slack',
		})
		expect(result).toBeNull()
		expect(await chatsOf(ws.id)).toHaveLength(0)
		expect(evaluateAndRespond).not.toHaveBeenCalled()
	})

	it('opens a chat with the Chief of Staff and wakes it with provider, integration id and connect type', async () => {
		const { human, ws, chief } = await setup()
		flagOn(human)
		const integrationId = '22222222-2222-4222-8222-222222222222'

		const result = await startIntegrationConnectChat({
			db,
			sessionManager,
			workspaceId: ws.id,
			actorId: human,
			integrationId,
			provider: 'slack',
			label: 'Slack',
		})
		if (!result) throw new Error('chat was not started')

		const [chat] = await chatsOf(ws.id)
		expect(chat?.id).toBe(result.conversationId)
		expect(chat?.title).toBe('Connect Slack')
		expect(chat?.createdBy).toBe(human)
		expect(chat?.subjectId).toBeNull()
		expect(chat?.directPairKey).toBeNull()

		const participants = await db
			.select({ actorId: conversationParticipants.actorId })
			.from(conversationParticipants)
			.where(eq(conversationParticipants.conversationId, result.conversationId))
		expect(participants.map((p) => p.actorId).sort()).toEqual([human, chief.id].sort())

		const [message] = await db
			.select()
			.from(messages)
			.where(eq(messages.conversationId, result.conversationId))
		expect(message?.actorId).toBe(human)
		expect(message?.content).toBe(
			buildIntegrationConnectPrompt({
				label: 'Slack',
				provider: 'slack',
				integrationId,
				connectType: 'new',
			}),
		)
		expect(message?.content).toContain('integration-connect-checklist')
		expect(message?.content).toContain(integrationId)
		expect(message?.metadata).toMatchObject({ mentions: [chief.id], hidden_from_chat: true })
		expect(evaluateAndRespond).toHaveBeenCalledWith(
			expect.objectContaining({
				workspaceId: ws.id,
				conversationId: result.conversationId,
				messageId: message?.id,
			}),
		)
	})

	it('reuses the open chat for the same person and provider, and opens a new one once it is archived', async () => {
		const { human, ws } = await setup()
		flagOn(human)
		const args = {
			db,
			sessionManager,
			workspaceId: ws.id,
			actorId: human,
			provider: 'slack',
			label: 'Slack',
		}

		const first = await startIntegrationConnectChat({
			...args,
			integrationId: '33333333-3333-4333-8333-333333333333',
		})
		const second = await startIntegrationConnectChat({
			...args,
			integrationId: '33333333-3333-4333-8333-333333333333',
			connectType: 'reconnect',
		})
		expect(second?.conversationId).toBe(first?.conversationId)
		expect(await chatsOf(ws.id)).toHaveLength(1)
		const inChat = await db
			.select()
			.from(messages)
			.where(eq(messages.conversationId, first?.conversationId as string))
		expect(inChat).toHaveLength(2)
		expect(inChat[1]?.content).toContain('connect type reconnect')

		// A different provider is a different chat.
		const other = await startIntegrationConnectChat({
			...args,
			provider: 'linear',
			label: 'Linear',
			integrationId: '44444444-4444-4444-8444-444444444444',
		})
		expect(other?.conversationId).not.toBe(first?.conversationId)

		// Marked Done by the person: the next connect opens a fresh chat.
		await db
			.update(conversationParticipants)
			.set({ archived: true })
			.where(
				and(
					eq(conversationParticipants.conversationId, first?.conversationId as string),
					eq(conversationParticipants.actorId, human),
				),
			)
		const after = await startIntegrationConnectChat({
			...args,
			integrationId: '33333333-3333-4333-8333-333333333333',
		})
		expect(after?.conversationId).not.toBe(first?.conversationId)
	})

	it('does nothing when the workspace has no Chief of Staff', async () => {
		const human = getTestActorId()
		const ws = await insertWorkspace(db, human)
		flagOn(human)
		const result = await startIntegrationConnectChat({
			db,
			sessionManager,
			workspaceId: ws.id,
			actorId: human,
			integrationId: '55555555-5555-4555-8555-555555555555',
			provider: 'slack',
		})
		expect(result).toBeNull()
		expect(await chatsOf(ws.id)).toHaveLength(0)
	})

	it('swallows a failure in the responder instead of throwing', async () => {
		const { human, ws } = await setup()
		flagOn(human)
		evaluateAndRespond.mockRejectedValueOnce(new Error('no agent capacity'))
		await expect(
			startIntegrationConnectChat({
				db,
				sessionManager,
				workspaceId: ws.id,
				actorId: human,
				integrationId: '66666666-6666-4666-8666-666666666666',
				provider: 'slack',
			}),
		).resolves.toBeNull()
	})
})

describe('a failed chat start does not break the connect', () => {
	it('still saves a custom tool server and returns 201 when the chat cannot start', async () => {
		const { human, ws } = await setup()
		flagOn(human)
		evaluateAndRespond.mockReset()
		evaluateAndRespond.mockRejectedValue(new Error('no agent capacity'))

		const app = new OpenAPIHono<{
			Variables: { db: typeof db; actorId: string; actorType: string; sessionManager: unknown }
		}>()
		app.use('*', async (c, next) => {
			c.set('db', db)
			c.set('actorId', human)
			c.set('actorType', 'human')
			c.set('sessionManager', sessionManager)
			await next()
		})
		app.onError((_e, c) => c.json(createApiError('INTERNAL_ERROR', 'Internal server error'), 500))
		app.route('/api/custom-mcp-servers', customMcpServersRoutes)

		const res = await app.request('/api/custom-mcp-servers', {
			method: 'POST',
			headers: { 'X-Workspace-Id': ws.id, 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'Docs search',
				server: { type: 'http', url: 'https://tools.example.com/mcp' },
			}),
		})
		expect(res.status).toBe(201)
		const { id } = (await res.json()) as { id: string }

		await vi.waitFor(() => expect(evaluateAndRespond).toHaveBeenCalled())
		const [row] = await db.select().from(integrations).where(eq(integrations.id, id))
		expect(row?.status).toBe('active')
		expect((await chatsOf(ws.id)).map((c) => c.title)).toEqual(['Connect Docs search'])
	})
})
