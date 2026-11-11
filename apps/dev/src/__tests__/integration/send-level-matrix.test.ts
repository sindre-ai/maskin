import { OpenAPIHono } from '@hono/zod-openapi'
import { INTEGRATION_STATUS_ACTIVE, integrations, workspaceMembers } from '@maskin/db/schema'
import type { LinkedInMcpInstanceConfig } from '@maskin/mcp/linkedin'
import { toolName } from '@maskin/mcp/linkedin'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Hono } from 'hono'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { encrypt } from '../../lib/crypto'
import { createApiError } from '../../lib/errors'
import type { AgentAccess } from '../../lib/integrations/agent-access'
import { registerLinkedInMcpInstance } from '../../lib/integrations/providers/linkedin-unipile/mcp-server'
import { __setLinkedInClientForTests } from '../../lib/integrations/providers/linkedin-unipile/operations'
import type { LinkedInClient } from '../../lib/integrations/providers/linkedin-unipile/unipile-client'
import { createSlackMcpServer } from '../../lib/integrations/providers/slack/mcp-server'
import { gateMcpServer } from '../../lib/integrations/tool-gate'
import { recordObjectApproval } from '../../lib/object-delivery'
import { buildObjectPreview } from '../../lib/object-preview'
import integrationsGatewayRoutes, {
	clearGatewayAnnotationCache,
} from '../../routes/integrations-gateway'
import {
	insertActor,
	insertAgentGrant,
	insertLinkedinSendModes,
	insertObject,
	insertSendMode,
	insertWorkspace,
} from '../factories'
import { db, getTestActorId } from './global-setup'

vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: vi.fn().mockResolvedValue(undefined),
}))

const gmailRoutes = (await import('../../routes/integrations-gmail')).default

/**
 * The same three questions for every provider that sends in a person's or the company's name,
 * against real Postgres (the access level is a join over agent_grants, the send setting a row
 * in send_permissions, an approval an event bound to a content hash):
 *
 *   Read                       refused, whatever the send setting says
 *   Read & write, ask first    needs a draft and a person's approval (a tap, or a yes in the chat)
 *   Read & write, always allow sends the call as given, with no draft and no card
 *
 * Plus deny, which refuses everything. The provider itself is stubbed (a fetch, a client), so
 * this proves our rules, not what Slack, LinkedIn, Resend or Gmail do with the call.
 */

type Mode = 'always_allow' | 'ask_first' | 'deny'
type Level = 'read' | 'read_write'

async function agentInWorkspace() {
	const human = getTestActorId()
	const ws = await insertWorkspace(db, human)
	const agent = await insertActor(db, { type: 'agent' })
	await db
		.insert(workspaceMembers)
		.values({ workspaceId: ws.id, actorId: agent.id, role: 'member' })
	return { human, ws, agent }
}

async function connectIntegration(
	s: Awaited<ReturnType<typeof agentInWorkspace>>,
	provider: string,
	credentials: Record<string, unknown>,
	level: Level,
) {
	const [integration] = await db
		.insert(integrations)
		.values({
			workspaceId: s.ws.id,
			provider,
			status: INTEGRATION_STATUS_ACTIVE,
			externalId: `${provider}-account`,
			credentials: encrypt(JSON.stringify(credentials)),
			actorId: s.human,
			createdBy: s.human,
		})
		.returning()
	if (!integration) throw new Error('integration was not inserted')
	await insertAgentGrant(db, {
		workspaceId: s.ws.id,
		integrationId: integration.id,
		actorId: s.agent.id,
		access: level,
	})
	return integration
}

async function approve(
	wsId: string,
	humanId: string,
	object: { id: string; type: string; [k: string]: unknown },
) {
	const preview = buildObjectPreview(object as Parameters<typeof buildObjectPreview>[0])
	if (!preview) throw new Error('not a draft')
	await recordObjectApproval(db, {
		workspaceId: wsId,
		actorId: humanId,
		objectId: object.id,
		objectType: object.type,
		preview,
		via: 'approval',
	})
}

const CASES: Array<{ name: string; level: Level; mode: Mode }> = [
	{ name: 'Read, always allow', level: 'read', mode: 'always_allow' },
	{ name: 'Read, ask first', level: 'read', mode: 'ask_first' },
]

// ── Slack ───────────────────────────────────────────────────────────────────────

describe('send level matrix: Slack', () => {
	let fetchMock: ReturnType<typeof vi.fn>
	beforeEach(() => {
		fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ ok: true, ts: '1717000000.000100', channel: 'C0123456789' }),
		} as Response)
		vi.stubGlobal('fetch', fetchMock)
	})
	afterEach(() => vi.unstubAllGlobals())

	async function slack(level: Level, mode: Mode) {
		const s = await agentInWorkspace()
		const integration = await connectIntegration(s, 'slack', { accessToken: 'xoxb-test' }, level)
		await insertSendMode(db, {
			workspaceId: s.ws.id,
			agentId: s.agent.id,
			kind: 'slack_message',
			mode,
		})
		const access: AgentAccess = level
		const server = createSlackMcpServer(
			{
				botToken: 'xoxb-test-token',
				integrationId: integration.id,
				agentLabel: 'Agent · in ws',
				workspaceId: s.ws.id,
				actorId: s.agent.id,
				db,
			},
			(srv) =>
				gateMcpServer(srv, {
					db,
					workspaceId: s.ws.id,
					actorId: s.agent.id,
					integrationId: integration.id,
					provider: 'slack',
					providerLabel: 'Slack',
					access,
				}),
		)
		const tool = (
			server as unknown as {
				_registeredTools: Record<
					string,
					{ handler: (args: unknown, extra: unknown) => Promise<unknown> }
				>
			}
		)._registeredTools.slack_send_message
		const send = (args: Record<string, unknown>) =>
			tool.handler(args, {}) as Promise<{ isError?: boolean; content: Array<{ text: string }> }>
		return { s, send }
	}

	for (const c of CASES) {
		it(`refuses a post at ${c.name}`, async () => {
			const { send } = await slack(c.level, c.mode)
			const result = await send({ channel: 'C0123456789', text: 'hello' })
			expect(result.isError).toBe(true)
			expect(fetchMock).not.toHaveBeenCalled()
		})
	}

	it('Read & write, ask first: refuses the call, then posts the draft once a person approved it', async () => {
		const { s, send } = await slack('read_write', 'ask_first')
		const draft = await insertObject(db, s.ws.id, s.human, {
			type: 'task',
			content: 'Release 4.2 is out.',
			metadata: { kind: 'slack_message', channel: 'C0123456789' },
		})

		const direct = await send({ channel: 'C0123456789', text: 'hello' })
		const unapproved = await send({ object_id: draft.id })
		await approve(s.ws.id, s.human, draft)
		const approved = await send({ object_id: draft.id })

		expect(direct.isError).toBe(true)
		expect(unapproved.isError).toBe(true)
		expect(approved.isError).toBeUndefined()
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it('Read & write, always allow: posts the call as given', async () => {
		const { send } = await slack('read_write', 'always_allow')
		const result = await send({ channel: 'C0123456789', text: 'hello' })
		expect(result.isError).toBeUndefined()
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it('Read & write, deny: refuses everything', async () => {
		const { s, send } = await slack('read_write', 'deny')
		const draft = await insertObject(db, s.ws.id, s.human, {
			type: 'task',
			content: 'Release 4.2 is out.',
			metadata: { kind: 'slack_message', channel: 'C0123456789' },
		})
		await approve(s.ws.id, s.human, draft)
		expect((await send({ channel: 'C0123456789', text: 'hello' })).isError).toBe(true)
		expect((await send({ object_id: draft.id })).isError).toBe(true)
		expect(fetchMock).not.toHaveBeenCalled()
	})
})

// ── LinkedIn ────────────────────────────────────────────────────────────────────

describe('send level matrix: LinkedIn', () => {
	beforeAll(() => {
		process.env.INTEGRATION_ENCRYPTION_KEY = 'a'.repeat(64)
		process.env.UNIPILE_BASE_URL = 'http://ignored-by-test-stub'
		process.env.UNIPILE_API_KEY = 'ignored-by-test-stub'
	})
	afterAll(() => __setLinkedInClientForTests(null))

	function stubClient() {
		const sendMessage = vi.fn(async () => ({
			status: 200,
			body: { object: 'ChatStarted', message_id: 'msg-1', chat_id: 'chat-1' },
			headers: {},
		}))
		const publishPost = vi.fn(async () => ({
			status: 200,
			body: {
				object: 'PostPublished',
				post_id: 'urn:li:share:1',
				published_at: '2026-11-11T10:00:00.000Z',
			},
			headers: {},
		}))
		const client = { sendMessage, publishPost } as unknown as LinkedInClient
		__setLinkedInClientForTests(() => client)
		return { sendMessage, publishPost }
	}

	async function linkedin(level: Level, mode: Mode) {
		const s = await agentInWorkspace()
		const integration = await connectIntegration(
			s,
			'linkedin-unipile',
			{ account_id: 'acc-1', account_status: 'OK' },
			level,
		)
		await insertLinkedinSendModes(db, { workspaceId: s.ws.id, agentId: s.agent.id, mode })
		const cfg: LinkedInMcpInstanceConfig = {
			unipileAccSlug: 'test-acc',
			identityType: 'personal',
			identityUrn: 'urn:li:person:test',
			identitySlug: 'personal',
			displayName: 'Test User',
			mailboxId: null,
			messagingEnabled: true,
			workspaceId: s.ws.id,
			actorId: s.agent.id,
			integrationId: integration.id,
			unipileAccountId: 'acc-1',
		}
		const server = new McpServer({ name: 'test', version: '1.0.0' })
		gateMcpServer(server, {
			db,
			workspaceId: s.ws.id,
			actorId: s.agent.id,
			integrationId: integration.id,
			provider: 'linkedin-unipile',
			providerLabel: 'LinkedIn',
			access: level,
		})
		registerLinkedInMcpInstance(server, cfg, { db, actorId: s.agent.id, workspaceId: s.ws.id })
		const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
		await server.connect(serverSide)
		const mcp = new Client({ name: 'test-client', version: '1.0.0' })
		await mcp.connect(clientSide)
		const call = (tool: string, args: Record<string, unknown>) =>
			mcp.callTool({ name: toolName(cfg, tool), arguments: args })
		return { s, call }
	}

	const DIRECT_MESSAGE = { recipient_urn: 'ACoAAA1', body: 'Hej', idempotency_key: 'k-matrix' }

	for (const c of CASES) {
		it(`refuses a message and a post at ${c.name}`, async () => {
			const stubs = stubClient()
			const { call } = await linkedin(c.level, c.mode)
			expect((await call('send_message', DIRECT_MESSAGE)).isError).toBe(true)
			expect((await call('publish_post', { text: 'Hello' })).isError).toBe(true)
			expect(stubs.sendMessage).not.toHaveBeenCalled()
			expect(stubs.publishPost).not.toHaveBeenCalled()
		})
	}

	it('Read & write, ask first: refuses the call, then sends the draft once a person approved it', async () => {
		const stubs = stubClient()
		const { s, call } = await linkedin('read_write', 'ask_first')
		const draft = await insertObject(db, s.ws.id, s.human, {
			type: 'task',
			content: 'Hej Liz (matrix)',
			metadata: { kind: 'linkedin_message', to: 'Liz', recipient_provider_id: 'ACoAAA1' },
		})

		const direct = await call('send_message', DIRECT_MESSAGE)
		const unapproved = await call('send_message', { object_id: draft.id })
		await approve(s.ws.id, s.human, draft)
		const approved = await call('send_message', { object_id: draft.id })

		expect(direct.isError).toBe(true)
		expect(unapproved.isError).toBe(true)
		expect(approved.isError).toBeFalsy()
		expect(stubs.sendMessage).toHaveBeenCalledTimes(1)
		expect((await call('publish_post', { text: 'Hello' })).isError).toBe(true)
		expect(stubs.publishPost).not.toHaveBeenCalled()
	})

	it('Read & write, always allow: sends a message and publishes a post as given', async () => {
		const stubs = stubClient()
		const { call } = await linkedin('read_write', 'always_allow')

		const message = await call('send_message', DIRECT_MESSAGE)
		const post = await call('publish_post', { text: 'Hello from the matrix' })

		expect(message.isError).toBeFalsy()
		expect(post.isError).toBeFalsy()
		expect(stubs.sendMessage).toHaveBeenCalledTimes(1)
		expect(stubs.publishPost).toHaveBeenCalledTimes(1)
	})

	it('Read & write, always allow: still sends a draft nobody approved, once', async () => {
		const stubs = stubClient()
		const { s, call } = await linkedin('read_write', 'always_allow')
		const draft = await insertObject(db, s.ws.id, s.human, {
			type: 'task',
			content: 'Hej Liz (matrix, draft)',
			metadata: { kind: 'linkedin_message', to: 'Liz', recipient_provider_id: 'ACoAAA1' },
		})

		expect((await call('send_message', { object_id: draft.id })).isError).toBeFalsy()
		expect((await call('send_message', { object_id: draft.id })).isError).toBe(true)
		expect(stubs.sendMessage).toHaveBeenCalledTimes(1)
	})

	it('Read & write, deny: refuses everything, even an approved draft', async () => {
		const stubs = stubClient()
		const { s, call } = await linkedin('read_write', 'deny')
		const draft = await insertObject(db, s.ws.id, s.human, {
			type: 'task',
			content: 'Hej Liz (matrix, deny)',
			metadata: { kind: 'linkedin_message', to: 'Liz', recipient_provider_id: 'ACoAAA1' },
		})
		await approve(s.ws.id, s.human, draft)

		expect((await call('send_message', DIRECT_MESSAGE)).isError).toBe(true)
		expect((await call('send_message', { object_id: draft.id })).isError).toBe(true)
		expect(stubs.sendMessage).not.toHaveBeenCalled()
	})
})

// ── Resend, through the gateway ───────────────────────────────────────────────────

describe('send level matrix: Resend send tools through the gateway', () => {
	let fetchMock: ReturnType<typeof vi.fn>
	beforeEach(() => {
		clearGatewayAnnotationCache()
		fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						jsonrpc: '2.0',
						id: 1,
						result: { content: [{ type: 'text', text: 'sent' }] },
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				),
		)
		vi.stubGlobal('fetch', fetchMock)
	})
	afterEach(() => vi.unstubAllGlobals())

	function appFor(actorId: string) {
		const app = new Hono<{ Variables: { db: typeof db; actorId: string } }>()
		app.use('*', async (c, next) => {
			c.set('db', db)
			c.set('actorId', actorId)
			await next()
		})
		app.onError((_e, c) => c.json(createApiError('INTERNAL_ERROR', 'Internal server error'), 500))
		app.route('/api/integrations', integrationsGatewayRoutes)
		return app
	}

	async function callResend(level: Level, mode: Mode, tool = 'send-email') {
		const s = await agentInWorkspace()
		await connectIntegration(s, 'resend', { accessToken: 're_live_key' }, level)
		await insertSendMode(db, { workspaceId: s.ws.id, agentId: s.agent.id, kind: 'email', mode })
		const res = await appFor(s.agent.id).request('/api/integrations/resend/gateway', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				accept: 'application/json, text/event-stream',
				authorization: 'Bearer ank_agent_key',
				'x-workspace-id': s.ws.id,
			},
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'tools/call',
				params: { name: tool, arguments: { to: ['a@example.com'], subject: 'Hi', text: 'Hi' } },
			}),
		})
		return (await res.json()) as {
			result?: { isError?: boolean; content: Array<{ text: string }> }
		}
	}

	const textOf = (r: Awaited<ReturnType<typeof callResend>>) => r.result?.content[0]?.text ?? ''

	for (const c of CASES) {
		it(`refuses send-email at ${c.name}`, async () => {
			const out = await callResend(c.level, c.mode)
			expect(out.result?.isError).toBe(true)
			expect(fetchMock).not.toHaveBeenCalled()
		})
	}

	it('Read & write, ask first: refuses every send tool and points at resend_send_email', async () => {
		for (const tool of [
			'send-email',
			'send-batch-emails',
			'send-broadcast',
			'send-inbox-draft',
			'send-new-inbox-email',
			'reply-to-inbox-thread-email',
			'forward-inbox-thread-email',
		]) {
			const out = await callResend('read_write', 'ask_first', tool)
			expect(out.result?.isError).toBe(true)
			expect(textOf(out)).toContain('resend_send_email')
		}
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('Read & write, always allow: lets the send tools through to Resend', async () => {
		const out = await callResend('read_write', 'always_allow')
		expect(out.result?.isError).toBeFalsy()
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it('Read & write, deny: refuses the send tools', async () => {
		const out = await callResend('read_write', 'deny')
		expect(out.result?.isError).toBe(true)
		expect(textOf(out)).toContain('turned off')
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('Read & write, ask first: leaves the reading tools alone', async () => {
		const out = await callResend('read_write', 'ask_first', 'list-emails')
		expect(out.result?.isError).toBeFalsy()
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})
})

// ── Gmail ────────────────────────────────────────────────────────────────────────

describe('send level matrix: Gmail', () => {
	let fetchMock: ReturnType<typeof vi.fn>
	beforeEach(() => {
		fetchMock = vi.fn(
			async () =>
				new Response(JSON.stringify({ id: 'sent-1', threadId: 'thread-1' }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				}),
		)
		vi.stubGlobal('fetch', fetchMock)
	})
	afterEach(() => vi.unstubAllGlobals())

	function post(actorId: string, workspaceId: string, body: Record<string, unknown>) {
		const app = new OpenAPIHono<{ Variables: { db: typeof db; actorId: string } }>()
		app.use('*', async (c, next) => {
			c.set('db', db)
			c.set('actorId', actorId)
			await next()
		})
		app.route('/api/integrations/gmail', gmailRoutes as never)
		return app.request('/api/integrations/gmail/send', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'X-Workspace-Id': workspaceId },
			body: JSON.stringify(body),
		})
	}

	async function gmail(level: Level, mode: Mode) {
		const s = await agentInWorkspace()
		await connectIntegration(
			s,
			'gmail',
			{ accessToken: 'live-token', expiresAt: Date.now() + 60 * 60 * 1000 },
			level,
		)
		await insertSendMode(db, { workspaceId: s.ws.id, agentId: s.agent.id, kind: 'email', mode })
		return s
	}

	const DIRECT = { to: 'ada@example.com', subject: 'Intro', body: 'Hi Ada' }

	for (const c of CASES) {
		it(`refuses an email at ${c.name}`, async () => {
			const s = await gmail(c.level, c.mode)
			expect((await post(s.agent.id, s.ws.id, DIRECT)).status).toBe(403)
			expect(fetchMock).not.toHaveBeenCalled()
		})
	}

	it('Read & write, ask first: refuses the call, then sends the draft once a person approved it', async () => {
		const s = await gmail('read_write', 'ask_first')
		const draft = await insertObject(db, s.ws.id, s.human, {
			type: 'task',
			content: 'Hi Ada (matrix)',
			metadata: { kind: 'email', to: 'ada@example.com', subject: 'Intro' },
		})

		expect((await post(s.agent.id, s.ws.id, DIRECT)).status).toBe(403)
		expect((await post(s.agent.id, s.ws.id, { object_id: draft.id })).status).toBe(403)
		await approve(s.ws.id, s.human, draft)
		const approved = await post(s.agent.id, s.ws.id, { object_id: draft.id })

		expect(approved.status).toBe(200)
		expect(await approved.json()).toMatchObject({ mode: 'approved_draft' })
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it('Read & write, always allow: sends the email as given', async () => {
		const s = await gmail('read_write', 'always_allow')
		const res = await post(s.agent.id, s.ws.id, DIRECT)
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({ mode: 'direct' })
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it('Read & write, deny: refuses everything, even an approved draft', async () => {
		const s = await gmail('read_write', 'deny')
		const draft = await insertObject(db, s.ws.id, s.human, {
			type: 'task',
			content: 'Hi Ada (matrix, deny)',
			metadata: { kind: 'email', to: 'ada@example.com', subject: 'Intro' },
		})
		await approve(s.ws.id, s.human, draft)

		expect((await post(s.agent.id, s.ws.id, DIRECT)).status).toBe(403)
		expect((await post(s.agent.id, s.ws.id, { object_id: draft.id })).status).toBe(403)
		expect(fetchMock).not.toHaveBeenCalled()
	})
})
