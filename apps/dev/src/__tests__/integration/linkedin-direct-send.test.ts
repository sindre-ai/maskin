import { INTEGRATION_STATUS_ACTIVE, integrations, linkedinActions } from '@maskin/db/schema'
import type { LinkedInMcpInstanceConfig } from '@maskin/mcp/linkedin'
import { toolName } from '@maskin/mcp/linkedin'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/analytics/posthog', () => ({ capturePosthogEvent: vi.fn(async () => {}) }))

import { encrypt } from '../../lib/crypto'
import { registerLinkedInMcpInstance } from '../../lib/integrations/providers/linkedin-unipile/mcp-server'
import { __setLinkedInClientForTests } from '../../lib/integrations/providers/linkedin-unipile/operations'
import type { LinkedInClient } from '../../lib/integrations/providers/linkedin-unipile/unipile-client'
import { insertLinkedinSendModes, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

/**
 * The LinkedIn send tools for an agent set to always allow (and for a workspace that never
 * saved a setting): the call goes out as given, with no draft and no card. Driven through a
 * real MCP client and server pair against real Postgres, because the send setting and the
 * action log are rows. The Unipile client is our own stub: this proves what we send and
 * record, not what LinkedIn does with it.
 */

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
})

const json = (body: unknown) => ({ status: 200, body, headers: {} })
const started = { object: 'ChatStarted', chat_id: 'chat-1', message_id: 'msg-1' }

function stubClient() {
	const sendMessage = vi.fn(async (_payload: Record<string, unknown>) => json(started))
	const reply = vi.fn(async (_payload: Record<string, unknown>) => json(started))
	const sendConnectionRequest = vi.fn(async () => json({ invitation_id: 'inv-1' }))
	const publishPost = vi.fn(async () =>
		json({
			object: 'PostPublished',
			post_id: 'urn:li:share:1',
			published_at: '2026-11-11T10:00:00.000Z',
		}),
	)
	const commentOnPost = vi.fn(async () =>
		json({ comment_id: 'cmt-1', commented_at: '2026-11-11T10:00:00.000Z' }),
	)
	const replyToComment = vi.fn(async () =>
		json({ comment_id: 'rep-1', commented_at: '2026-11-11T10:00:00.000Z' }),
	)
	const editPost = vi.fn(async () => json({ edited_at: '2026-11-11T10:00:00.000Z' }))
	const getProfile = vi.fn(async () =>
		json({
			id: 'ACoRecipient',
			display_name: 'Ada Lovelace',
			specifics: { network_distance: 'SECOND_DEGREE' },
		}),
	)
	const getInmailCredits = vi.fn(async () => json({ credits: { classic: 15 } }))
	const client = {
		sendMessage,
		reply,
		sendConnectionRequest,
		publishPost,
		commentOnPost,
		replyToComment,
		editPost,
		getProfile,
		getInmailCredits,
	} as unknown as LinkedInClient
	__setLinkedInClientForTests(() => client)
	return {
		sendMessage,
		reply,
		sendConnectionRequest,
		publishPost,
		commentOnPost,
		replyToComment,
		editPost,
	}
}

/** `mode` null saves no setting at all, the way a fresh workspace starts. */
async function connect(mode: 'always_allow' | 'ask_first' | 'deny' | null = 'always_allow') {
	const actorId = getTestActorId()
	const ws = await insertWorkspace(db, actorId)
	if (mode) await insertLinkedinSendModes(db, { workspaceId: ws.id, agentId: actorId, mode })
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
	if (!integration) throw new Error('integration was not inserted')
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
	registerLinkedInMcpInstance(server, cfg, { db, actorId, workspaceId: ws.id })
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
	await server.connect(serverSide)
	const mcp = new Client({ name: 'test-client', version: '1.0.0' })
	await mcp.connect(clientSide)
	const call = (tool: string, args: Record<string, unknown>) =>
		mcp.callTool({ name: toolName(cfg, tool), arguments: args })
	return { integrationId: integration.id, call }
}

const textOf = (result: unknown) =>
	((result as { content?: Array<{ text?: string }> }).content ?? [])
		.map((c) => c.text ?? '')
		.join('')

describe('LinkedIn send tools for an agent set to always allow', () => {
	it('sends a message and a reply as given', async () => {
		const stubs = stubClient()
		const { call } = await connect()

		const message = await call('send_message', {
			recipient_urn: 'ACoAAA1',
			body: 'Hej Liz',
			idempotency_key: 'k-direct-message',
		})
		const reply = await call('reply', {
			thread_id: 'thread-1',
			body: 'Tak',
			in_reply_to_message_id: 'm-direct-1',
		})

		expect(message.isError).toBeFalsy()
		expect(reply.isError).toBeFalsy()
		expect(stubs.sendMessage).toHaveBeenCalledTimes(1)
		expect(stubs.reply).toHaveBeenCalledTimes(1)
	})

	it('publishes a post, comments, replies to a comment and edits a post as given', async () => {
		const stubs = stubClient()
		const { call } = await connect()

		const post = await call('publish_post', { text: 'Direct post one' })
		const comment = await call('comment_on_post', {
			post_id: 'urn:li:activity:1',
			text: 'Well said, direct',
		})
		const answer = await call('reply_to_comment', {
			comment_id: 'urn:li:comment:(urn:li:activity:1,2)',
			text: 'Thank you, direct',
		})
		const edit = await call('edit_post', { post_id: 'urn:li:share:1', text: 'Edited, direct' })

		for (const result of [post, comment, answer, edit]) expect(result.isError).toBeFalsy()
		expect(stubs.publishPost).toHaveBeenCalledTimes(1)
		expect(stubs.commentOnPost).toHaveBeenCalledTimes(1)
		expect(stubs.replyToComment).toHaveBeenCalledTimes(1)
		expect(stubs.editPost).toHaveBeenCalledTimes(1)
	})

	it('sends a connection invitation as given', async () => {
		const stubs = stubClient()
		const { call } = await connect()

		const sent = await call('send_connection_request', { user_id: 'user-direct', message: 'Hej' })

		expect(sent.isError).toBeFalsy()
		expect(stubs.sendConnectionRequest).toHaveBeenCalledTimes(1)
	})

	it('sends an InMail as given, with the same credit rules, and needs an idempotency key', async () => {
		const stubs = stubClient()
		const { call } = await connect()

		const missingKey = await call('send_inmail', {
			recipient_provider_id: 'ACoRecipient',
			body: 'Hi Ada, a question about your work.',
		})
		const sent = await call('send_inmail', {
			recipient_provider_id: 'ACoRecipient',
			body: 'Hi Ada, a question about your work.',
			idempotency_key: 'k-direct-inmail',
		})

		expect(missingKey.isError).toBe(true)
		expect(textOf(missingKey)).toContain('idempotency_key')
		expect(sent.isError).toBeFalsy()
		expect(stubs.sendMessage).toHaveBeenCalledTimes(1)
		expect(stubs.sendMessage.mock.calls[0]?.[0]).toMatchObject({ inmail: true })
	})

	it('sends directly when no setting was ever saved, because a workspace starts by sending', async () => {
		const stubs = stubClient()
		const { call } = await connect(null)

		const post = await call('publish_post', { text: 'Direct post, no setting saved' })

		expect(post.isError).toBeFalsy()
		expect(stubs.publishPost).toHaveBeenCalledTimes(1)
	})

	it('logs a direct send once, with the kind and the outcome', async () => {
		stubClient()
		const { call, integrationId } = await connect()

		await call('send_message', {
			recipient_urn: 'ACoAAA1',
			body: 'Hej igen',
			idempotency_key: 'k-direct-log',
		})

		const rows = await db
			.select()
			.from(linkedinActions)
			.where(eq(linkedinActions.integrationId, integrationId))
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({ tool: 'send_message', kind: 'send', outcome: 'ok' })
	})

	it('still refuses the removed raw attachments on a post, by name', async () => {
		const stubs = stubClient()
		const { call } = await connect()

		const result = await call('publish_post', {
			text: 'With a file',
			attachments: [{ content: 'AAAA', content_type: 'image/png', filename: 'a.png' }],
		})

		expect(result.isError).toBe(true)
		expect(textOf(result)).toContain('does not take raw attachments')
		expect(stubs.publishPost).not.toHaveBeenCalled()
	})

	it('refuses every send when the setting is deny', async () => {
		const stubs = stubClient()
		const { call } = await connect('deny')

		const results = [
			await call('send_message', { recipient_urn: 'ACoAAA1', body: 'Hej', idempotency_key: 'k-d' }),
			await call('publish_post', { text: 'No' }),
			await call('send_connection_request', { user_id: 'user-1' }),
		]

		for (const result of results) {
			expect(result.isError).toBe(true)
			expect(textOf(result)).toContain('turned off')
		}
		expect(stubs.sendMessage).not.toHaveBeenCalled()
		expect(stubs.publishPost).not.toHaveBeenCalled()
		expect(stubs.sendConnectionRequest).not.toHaveBeenCalled()
	})
})
