import { INTEGRATION_STATUS_ACTIVE, integrations, linkedinActions } from '@maskin/db/schema'
import type { LinkedInMcpInstanceConfig } from '@maskin/mcp/linkedin'
import { toolName } from '@maskin/mcp/linkedin'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const { captureMock } = vi.hoisted(() => ({ captureMock: vi.fn(async () => {}) }))
vi.mock('../../lib/analytics/posthog', () => ({ capturePosthogEvent: captureMock }))

import { encrypt } from '../../lib/crypto'
import {
	type ActionLogContext,
	LinkedInActionRefusal,
	withActionLog,
} from '../../lib/integrations/providers/linkedin-unipile/action-log'
import { CAP_WINDOW_MS } from '../../lib/integrations/providers/linkedin-unipile/caps'
import { registerLinkedInMcpInstance } from '../../lib/integrations/providers/linkedin-unipile/mcp-server'
import { __setLinkedInClientForTests } from '../../lib/integrations/providers/linkedin-unipile/operations'
import type { LinkedInClient } from '../../lib/integrations/providers/linkedin-unipile/unipile-client'
import { recordObjectApproval } from '../../lib/object-delivery'
import { buildObjectPreview } from '../../lib/object-preview'
import { insertObject, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

/**
 * The LinkedIn action log and its caps, against real Postgres: the pieces that matter (the
 * advisory lock, the one-ok-row-per-ref index, what a row may hold) only exist in the database.
 * The Unipile client is our own stub, so this proves our bookkeeping, not LinkedIn's behaviour.
 */

const SESSION_ID = '11111111-1111-4111-8111-111111111111'

beforeAll(() => {
	process.env.INTEGRATION_ENCRYPTION_KEY = 'a'.repeat(64)
	process.env.UNIPILE_BASE_URL = 'http://ignored-by-test-stub'
	process.env.UNIPILE_API_KEY = 'ignored-by-test-stub'
})

afterAll(() => {
	__setLinkedInClientForTests(null)
})

beforeEach(() => {
	__setLinkedInClientForTests(null)
	captureMock.mockClear()
})

function stubClient() {
	const sendMessage = vi.fn(async () => ({
		status: 200,
		body: { object: 'ChatStarted', message_id: 'msg-1', chat_id: 'chat-1' },
		headers: {},
	}))
	const sendConnectionRequest = vi.fn(async () => ({
		status: 200,
		body: { invitation_id: 'inv-1' },
		headers: {},
	}))
	const getProfile = vi.fn(async () => ({
		status: 200,
		body: { id: 'ACoAAA-provider-id', display_name: 'Liz Benison', headline: 'CTO at Secret Co' },
		headers: {},
	}))
	const client = {
		sendMessage,
		sendConnectionRequest,
		getProfile,
		reply: vi.fn(),
		listConversations: vi.fn(),
		listMessages: vi.fn(),
		listRelations: vi.fn(),
		searchPeople: vi.fn(),
		getManagedCompanyPages: vi.fn(),
		publishPost: vi.fn(),
		commentOnPost: vi.fn(),
		replyToComment: vi.fn(),
		readPostComments: vi.fn(),
		retrievePost: vi.fn(),
		listReactions: vi.fn(),
		countComments: vi.fn(),
		editPost: vi.fn(),
		deletePost: vi.fn(),
	} as unknown as LinkedInClient
	return { client, sendMessage, sendConnectionRequest, getProfile }
}

async function connect() {
	const actorId = getTestActorId()
	const ws = await insertWorkspace(db, actorId)
	const [integration] = await db
		.insert(integrations)
		.values({
			workspaceId: ws.id,
			provider: 'linkedin-unipile',
			status: INTEGRATION_STATUS_ACTIVE,
			credentials: encrypt(JSON.stringify({ account_id: 'acc-1', account_status: 'OK' })),
			actorId,
			createdBy: actorId,
		})
		.returning()
	const cfg: LinkedInMcpInstanceConfig = {
		unipileAccSlug: 'test-acc',
		identityType: 'personal',
		identityUrn: 'urn:li:person:test',
		identitySlug: 'personal',
		displayName: 'Test User',
		mailboxId: null,
		messagingEnabled: true,
		workspaceId: ws.id,
		actorId,
		integrationId: integration.id,
		unipileAccountId: 'acc-1',
	}
	const server = new McpServer({ name: 'test', version: '1.0.0' })
	registerLinkedInMcpInstance(server, cfg, {
		db,
		actorId,
		workspaceId: ws.id,
		sessionId: SESSION_ID,
	})
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
	await server.connect(serverSide)
	const mcp = new Client({ name: 'test-client', version: '1.0.0' })
	await mcp.connect(clientSide)
	const logCtx: ActionLogContext = {
		db,
		workspaceId: ws.id,
		actorId,
		integrationId: integration.id,
		identityType: 'personal',
		sessionId: SESSION_ID,
	}
	return { cfg, mcp, workspaceId: ws.id, actorId, integrationId: integration.id, logCtx }
}

/** A draft a person approved, the only way a send goes out. */
async function approvedDraft(
	c: Pick<Awaited<ReturnType<typeof connect>>, 'workspaceId' | 'actorId'>,
	content: string,
	metadata: Record<string, unknown>,
) {
	const object = await insertObject(db, c.workspaceId, c.actorId, {
		type: 'task',
		status: 'todo',
		content,
		metadata,
	})
	const preview = buildObjectPreview(object)
	if (!preview) throw new Error('not a draft')
	await recordObjectApproval(db, {
		workspaceId: c.workspaceId,
		actorId: c.actorId,
		objectId: object.id,
		objectType: object.type,
		preview,
		via: 'approval',
	})
	return object
}

const messageDraft = (
	c: Parameters<typeof approvedDraft>[0],
	text = 'Hi Liz, loved your talk on governance.',
) =>
	approvedDraft(c, text, {
		kind: 'linkedin_message',
		to: 'Liz Benison',
		recipient_provider_id: 'ACoBBB-recipient',
	})

const inviteDraft = (c: Parameters<typeof approvedDraft>[0]) =>
	approvedDraft(c, 'Hej from the secret pipeline', {
		kind: 'linkedin_connection_request',
		to: 'Someone',
		recipient_provider_id: 'ACoCCC-invitee',
	})

async function rowsFor(integrationId: string) {
	return db.select().from(linkedinActions).where(eq(linkedinActions.integrationId, integrationId))
}

describe('every LinkedIn tool call is logged once', () => {
	it('writes one row per call with the right kind, target, ref and outcome', async () => {
		const { client } = stubClient()
		__setLinkedInClientForTests(() => client)
		const c = await connect()
		const { cfg, mcp, integrationId } = c
		const message = await messageDraft(c)
		const invite = await inviteDraft(c)

		await mcp.callTool({
			name: toolName(cfg, 'get_profile'),
			arguments: { identifier: 'liz-benison' },
		})
		await mcp.callTool({
			name: toolName(cfg, 'send_message'),
			arguments: { object_id: message.id },
		})
		await mcp.callTool({
			name: toolName(cfg, 'send_connection_request'),
			arguments: { object_id: invite.id },
		})

		const rows = await rowsFor(integrationId)
		const byTool = Object.fromEntries(rows.map((r) => [r.tool, r]))
		expect(rows).toHaveLength(3)
		expect(byTool.get_profile).toMatchObject({
			kind: 'read',
			targetProviderId: 'ACoAAA-provider-id',
			refId: null,
			outcome: 'ok',
		})
		expect(byTool.send_message).toMatchObject({
			kind: 'send',
			targetProviderId: 'ACoBBB-recipient',
			refId: 'msg-1',
			outcome: 'ok',
		})
		expect(byTool.send_connection_request).toMatchObject({
			kind: 'send',
			targetProviderId: 'ACoCCC-invitee',
			refId: 'inv-1',
			outcome: 'ok',
		})
	})

	it('never stores message text, post text, names or headlines', async () => {
		const { client } = stubClient()
		__setLinkedInClientForTests(() => client)
		const c = await connect()
		const { cfg, mcp, integrationId } = c
		const message = await messageDraft(c)
		const invite = await inviteDraft(c)

		await mcp.callTool({
			name: toolName(cfg, 'get_profile'),
			arguments: { identifier: 'liz-benison' },
		})
		await mcp.callTool({
			name: toolName(cfg, 'send_message'),
			arguments: { object_id: message.id },
		})
		await mcp.callTool({
			name: toolName(cfg, 'send_connection_request'),
			arguments: { object_id: invite.id },
		})

		const stored = JSON.stringify(await rowsFor(integrationId))
		for (const secret of [
			'loved your talk',
			'governance',
			'secret pipeline',
			'Liz Benison',
			'CTO at Secret Co',
		]) {
			expect(stored).not.toContain(secret)
		}
	})

	it('records a failed call as error with LinkedIn code, and still throws it to the caller', async () => {
		const { client, sendMessage } = stubClient()
		sendMessage.mockResolvedValueOnce({ status: 400, body: {}, headers: {} })
		__setLinkedInClientForTests(() => client)
		const c = await connect()
		const { cfg, mcp, integrationId } = c
		const message = await messageDraft(c, 'x')

		const result = await mcp.callTool({
			name: toolName(cfg, 'send_message'),
			arguments: { object_id: message.id },
		})

		expect(result.isError).toBe(true)
		const [row] = await rowsFor(integrationId)
		expect(row).toMatchObject({
			tool: 'send_message',
			outcome: 'error',
			errorCode: 'INVALID_INPUT',
		})
		expect(row?.refId).toBeNull()
	})

	it('logs a repeated send of the same draft as an error, never a second ok row', async () => {
		const { client, sendMessage } = stubClient()
		__setLinkedInClientForTests(() => client)
		const c = await connect()
		const { cfg, mcp, integrationId } = c
		const message = await messageDraft(c, 'Hi')
		const args = { object_id: message.id }

		await mcp.callTool({ name: toolName(cfg, 'send_message'), arguments: args })
		await mcp.callTool({ name: toolName(cfg, 'send_message'), arguments: args })

		const rows = await rowsFor(integrationId)
		expect(rows.map((r) => r.outcome).sort()).toEqual(['error', 'ok'])
		expect(sendMessage).toHaveBeenCalledTimes(1)
	})

	it('logs a send with no draft as refused by rule, with nothing sent', async () => {
		const { client, sendMessage } = stubClient()
		__setLinkedInClientForTests(() => client)
		const { cfg, mcp, integrationId } = await connect()

		const result = await mcp.callTool({
			name: toolName(cfg, 'send_message'),
			arguments: { recipient_urn: 'ACoBBB-recipient', body: 'Hi', idempotency_key: 'k-direct' },
		})

		expect(result.isError).toBe(true)
		const [row] = await rowsFor(integrationId)
		expect(row).toMatchObject({ tool: 'send_message', outcome: 'refused_rule' })
		expect(sendMessage).not.toHaveBeenCalled()
	})

	it.each(['comment_on_post', 'reply_to_comment', 'edit_post'])(
		'logs %s with no draft as refused by rule, with nothing sent',
		async (tool) => {
			const { client } = stubClient()
			__setLinkedInClientForTests(() => client)
			const { cfg, mcp, integrationId } = await connect()

			const result = await mcp.callTool({
				name: toolName(cfg, tool),
				arguments: { post_id: 'urn:li:activity:1', comment_id: 'c-1', text: 'Nice' },
			})

			expect(result.isError).toBe(true)
			const [row] = await rowsFor(integrationId)
			expect(row).toMatchObject({ tool, outcome: 'refused_rule', errorCode: 'INVALID_INPUT' })
		},
	)

	it('fires one linkedin_tool_called event per call with exactly the allowed properties', async () => {
		const { client } = stubClient()
		__setLinkedInClientForTests(() => client)
		const c = await connect()
		const { cfg, mcp, actorId } = c
		const message = await messageDraft(c)

		await mcp.callTool({
			name: toolName(cfg, 'send_message'),
			arguments: { object_id: message.id },
		})

		// Other code paths (the credential read) capture their own events through the same mock.
		const toolCalls = (captureMock.mock.calls as unknown as unknown[][]).filter(
			(call) => call[0] === 'linkedin_tool_called',
		)
		expect(toolCalls).toHaveLength(1)
		const [event, distinctId, props] = toolCalls[0] as unknown as [
			string,
			string,
			Record<string, unknown>,
		]
		expect(event).toBe('linkedin_tool_called')
		expect(distinctId).toBe(actorId)
		expect(props).toEqual({
			tool: 'send_message',
			kind: 'send',
			outcome: 'ok',
			error_code: null,
			actor_id: actorId,
			session_id: SESSION_ID,
			identity_type: 'personal',
		})
		const serialised = JSON.stringify(props)
		expect(serialised).not.toContain('ACoBBB-recipient')
		expect(serialised).not.toContain('loved your talk')
	})
})

describe('daily caps', () => {
	const cap = { name: 'test_cap', limit: 3, tools: ['tool_a', 'tool_b'] }

	async function seed(
		ctx: ActionLogContext,
		rows: Array<{ tool: string; outcome: string; ageMs: number; ref?: string }>,
	) {
		await db.insert(linkedinActions).values(
			rows.map((r) => ({
				workspaceId: ctx.workspaceId,
				integrationId: ctx.integrationId,
				actorId: ctx.actorId,
				tool: r.tool,
				kind: 'write',
				outcome: r.outcome,
				refId: r.ref ?? null,
				createdAt: new Date(Date.now() - r.ageMs),
			})),
		)
	}

	it('refuses over the cap, runs nothing, logs refused_cap and names when a slot frees up', async () => {
		const { logCtx, integrationId } = await connect()
		const HOUR = 60 * 60 * 1000
		await seed(logCtx, [
			{ tool: 'tool_a', outcome: 'ok', ageMs: 5 * HOUR, ref: 'r1' },
			{ tool: 'tool_b', outcome: 'ok', ageMs: 3 * HOUR, ref: 'r2' },
			{ tool: 'tool_a', outcome: 'ok', ageMs: 1 * HOUR, ref: 'r3' },
		])
		const run = vi.fn(async () => 'sent')

		const err = await withActionLog(logCtx, { tool: 'tool_a', kind: 'write', cap }, run).catch(
			(e) => e,
		)

		expect(err).toBeInstanceOf(LinkedInActionRefusal)
		expect(err.code).toBe('RATE_LIMITED_LINKEDIN')
		// The oldest counted row is 5h old, so it leaves the 24h window in 19h.
		const resetAt = new Date(Date.now() - 5 * HOUR + CAP_WINDOW_MS)
		expect(err.message).toContain('Nothing was sent')
		expect(
			Math.abs(Date.parse(/at (\S+)\.$/.exec(err.message)?.[1] ?? '') - resetAt.getTime()),
		).toBeLessThan(60_000)
		expect(run).not.toHaveBeenCalled()
		const refused = (await rowsFor(integrationId)).filter((r) => r.outcome === 'refused_cap')
		expect(refused).toHaveLength(1)
		expect(refused[0]).toMatchObject({ errorCode: 'RATE_LIMITED_LINKEDIN', tool: 'tool_a' })
	})

	it('counts only ok rows and pending rows from the last two minutes, inside the window', async () => {
		const { logCtx } = await connect()
		const HOUR = 60 * 60 * 1000
		await seed(logCtx, [
			{ tool: 'tool_a', outcome: 'ok', ageMs: 25 * HOUR, ref: 'old' }, // outside the window
			{ tool: 'tool_a', outcome: 'pending', ageMs: 10 * 60 * 1000 }, // stale pending
			{ tool: 'tool_a', outcome: 'noop', ageMs: 1000 },
			{ tool: 'tool_a', outcome: 'error', ageMs: 1000 },
			{ tool: 'tool_a', outcome: 'refused_rule', ageMs: 1000 },
			{ tool: 'other_tool', outcome: 'ok', ageMs: 1000, ref: 'x' }, // not in this cap
			{ tool: 'tool_a', outcome: 'ok', ageMs: 1000, ref: 'a' },
			{ tool: 'tool_b', outcome: 'pending', ageMs: 1000 }, // fresh pending holds a slot
		])

		// 2 of 3 slots used, so one more fits.
		await expect(
			withActionLog(logCtx, { tool: 'tool_a', kind: 'write', cap }, async () => 'ok'),
		).resolves.toBe('ok')
		// Now 3 of 3.
		await expect(
			withActionLog(logCtx, { tool: 'tool_b', kind: 'write', cap }, async () => 'ok'),
		).rejects.toBeInstanceOf(LinkedInActionRefusal)
	})

	it('does not let two parallel calls both take the last slot', async () => {
		const { logCtx, integrationId } = await connect()
		await seed(logCtx, [
			{ tool: 'tool_a', outcome: 'ok', ageMs: 1000, ref: 'a' },
			{ tool: 'tool_a', outcome: 'ok', ageMs: 2000, ref: 'b' },
		])
		const run = vi.fn(async () => {
			// Hold the slot long enough that the other call must wait on the lock, not race past it.
			await new Promise((r) => setTimeout(r, 150))
			return 'sent'
		})

		const results = await Promise.allSettled([
			withActionLog(logCtx, { tool: 'tool_a', kind: 'write', cap }, run),
			withActionLog(logCtx, { tool: 'tool_a', kind: 'write', cap }, run),
		])

		expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
		const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[]
		expect(rejected).toHaveLength(1)
		expect(rejected[0]?.reason).toBeInstanceOf(LinkedInActionRefusal)
		expect(run).toHaveBeenCalledTimes(1)
		const outcomes = (await rowsFor(integrationId)).map((r) => r.outcome)
		expect(outcomes.filter((o) => o === 'ok')).toHaveLength(3)
		expect(outcomes.filter((o) => o === 'refused_cap')).toHaveLength(1)
	})

	it('keeps caps per connected account', async () => {
		const first = await connect()
		const second = await connect()
		await seed(first.logCtx, [
			{ tool: 'tool_a', outcome: 'ok', ageMs: 1000, ref: 'a' },
			{ tool: 'tool_a', outcome: 'ok', ageMs: 2000, ref: 'b' },
			{ tool: 'tool_a', outcome: 'ok', ageMs: 3000, ref: 'c' },
		])

		await expect(
			withActionLog(second.logCtx, { tool: 'tool_a', kind: 'write', cap }, async () => 'ok'),
		).resolves.toBe('ok')
	})

	it('records a rule refusal thrown by the handler as refused_rule', async () => {
		const { logCtx, integrationId } = await connect()

		await expect(
			withActionLog(logCtx, { tool: 'tool_a', kind: 'write' }, async () => {
				throw new LinkedInActionRefusal('refused_rule', 'INVALID_INPUT', 'too young')
			}),
		).rejects.toBeInstanceOf(LinkedInActionRefusal)

		const [row] = await rowsFor(integrationId)
		expect(row).toMatchObject({ outcome: 'refused_rule', errorCode: 'INVALID_INPUT' })
	})
})
