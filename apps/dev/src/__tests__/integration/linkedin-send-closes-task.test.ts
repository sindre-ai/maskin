import { INTEGRATION_STATUS_ACTIVE, integrations, objects } from '@maskin/db/schema'
import type { LinkedInMcpInstanceConfig } from '@maskin/mcp/linkedin'
import { toolName } from '@maskin/mcp/linkedin'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { encrypt } from '../../lib/crypto'
import { registerLinkedInMcpInstance } from '../../lib/integrations/providers/linkedin-unipile/mcp-server'
import { __setLinkedInClientForTests } from '../../lib/integrations/providers/linkedin-unipile/operations'
import type { LinkedInClient } from '../../lib/integrations/providers/linkedin-unipile/unipile-client'
import { recordObjectApproval } from '../../lib/object-delivery'
import { buildObjectPreview } from '../../lib/object-preview'
import { insertObject, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

/**
 * The LinkedIn send tools end the task they carry out. Driven through a real MCP client and
 * server pair against real Postgres, because the thing under test is the wiring: `object_id`
 * reaching the handler, the object being checked before the send, and the task being closed
 * after it. A stubbed Unipile client stands in for LinkedIn, which is fine here: this tests
 * our bookkeeping, not what LinkedIn does.
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

function stubClient() {
	const sendConnectionRequest = vi.fn(async () => ({
		status: 200,
		body: { invitation_id: 'inv-1' },
		headers: {},
	}))
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
			published_at: '2026-10-30T10:00:00.000Z',
		},
		headers: {},
	}))
	const client = {
		sendConnectionRequest,
		sendMessage,
		reply: vi.fn(),
		listConversations: vi.fn(),
		listMessages: vi.fn(),
		listRelations: vi.fn(),
		searchPeople: vi.fn(),
		getProfile: vi.fn(),
		getManagedCompanyPages: vi.fn(),
		publishPost,
		commentOnPost: vi.fn(),
		replyToComment: vi.fn(),
		readPostComments: vi.fn(),
		retrievePost: vi.fn(),
		listReactions: vi.fn(),
		countComments: vi.fn(),
		editPost: vi.fn(),
		deletePost: vi.fn(),
	} as unknown as LinkedInClient
	return { client, sendConnectionRequest, sendMessage, publishPost }
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
	registerLinkedInMcpInstance(server, cfg, { db, actorId, workspaceId: ws.id })
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
	await server.connect(serverSide)
	const mcp = new Client({ name: 'test-client', version: '1.0.0' })
	await mcp.connect(clientSide)
	return { cfg, mcp, workspaceId: ws.id, actorId }
}

function textOf(result: unknown): string {
	const content = (result as { content?: Array<{ text?: string }> }).content ?? []
	return content.map((c) => c.text ?? '').join('')
}

async function statusOf(id: string) {
	const [row] = await db.select({ status: objects.status }).from(objects).where(eq(objects.id, id))
	return row?.status
}

/** A first message to Liz, filed the way an agent drafts one: no conversation yet, a recipient id. */
async function draft(workspaceId: string, actorId: string) {
	return insertObject(db, workspaceId, actorId, {
		type: 'task',
		status: 'todo',
		content: 'Hej Liz',
		metadata: { kind: 'linkedin_message', to: 'Liz Benison', recipient_provider_id: 'ACoAAA1' },
	})
}

/** A connection invitation to Liz, filed the way an agent drafts one: the note is the text. */
async function invite(workspaceId: string, actorId: string) {
	return insertObject(db, workspaceId, actorId, {
		type: 'task',
		status: 'todo',
		content: 'Hej Liz',
		metadata: {
			kind: 'linkedin_connection_request',
			to: 'Liz Benison',
			recipient_provider_id: 'user-1',
		},
	})
}

/** A post draft: the text sits between the post markers, the way the Copywriter files it. */
async function postDraft(workspaceId: string, actorId: string) {
	return insertObject(db, workspaceId, actorId, {
		type: 'task',
		status: 'todo',
		content: 'Header\n--- POST ---\nSun is out\n--- MEDIA ---\nnone',
		metadata: { kind: 'linkedin_post' },
	})
}

async function approve(workspaceId: string, actorId: string, objectId: string) {
	const [object] = await db.select().from(objects).where(eq(objects.id, objectId))
	const preview = object && buildObjectPreview(object)
	if (!object || !preview) throw new Error('not a draft')
	await recordObjectApproval(db, {
		workspaceId,
		actorId,
		objectId,
		objectType: object.type,
		preview,
		via: 'approval',
	})
}

describe('LinkedIn send tools with object_id', () => {
	it('closes the task when an approved connection request is sent', async () => {
		const { client, sendConnectionRequest } = stubClient()
		__setLinkedInClientForTests(() => client)
		const { cfg, mcp, workspaceId, actorId } = await connect()
		const task = await invite(workspaceId, actorId)
		await approve(workspaceId, actorId, task.id)

		const result = await mcp.callTool({
			name: toolName(cfg, 'send_connection_request'),
			arguments: { object_id: task.id },
		})

		expect(result.isError).toBeFalsy()
		expect(sendConnectionRequest).toHaveBeenCalledTimes(1)
		expect(sendConnectionRequest).toHaveBeenCalledWith(
			expect.objectContaining({ user_id: 'user-1', message: 'Hej Liz' }),
		)
		expect(JSON.parse(textOf(result)).object).toEqual({
			id: task.id,
			delivered: true,
			task_closed: true,
		})
		expect(await statusOf(task.id)).toBe('done')
	})

	it('refuses to send the same connection request twice and does not call LinkedIn again', async () => {
		const { client, sendConnectionRequest } = stubClient()
		__setLinkedInClientForTests(() => client)
		const { cfg, mcp, workspaceId, actorId } = await connect()
		const task = await invite(workspaceId, actorId)
		await approve(workspaceId, actorId, task.id)
		const args = { object_id: task.id }

		await mcp.callTool({ name: toolName(cfg, 'send_connection_request'), arguments: args })
		const second = await mcp.callTool({
			name: toolName(cfg, 'send_connection_request'),
			arguments: args,
		})

		expect(second.isError).toBe(true)
		expect(textOf(second)).toContain('INVALID_INPUT')
		expect(textOf(second)).toContain('already been sent')
		expect(sendConnectionRequest).toHaveBeenCalledTimes(1)
	})

	it('will not send a connection request nobody approved, or one edited after approval', async () => {
		const { client, sendConnectionRequest } = stubClient()
		__setLinkedInClientForTests(() => client)
		const { cfg, mcp, workspaceId, actorId } = await connect()
		const task = await invite(workspaceId, actorId)
		const send = () =>
			mcp.callTool({
				name: toolName(cfg, 'send_connection_request'),
				arguments: { object_id: task.id },
			})

		const unapproved = await send()
		await approve(workspaceId, actorId, task.id)
		await db.update(objects).set({ content: 'Hej Liz, edited' }).where(eq(objects.id, task.id))
		const afterEdit = await send()

		for (const result of [unapproved, afterEdit]) {
			expect(result.isError).toBe(true)
			expect(textOf(result)).toContain('No person has approved')
		}
		expect(sendConnectionRequest).not.toHaveBeenCalled()
		expect(await statusOf(task.id)).toBe('todo')
	})

	it('refuses a connection request with no object_id, and one that is not a connection request', async () => {
		const { client, sendConnectionRequest } = stubClient()
		__setLinkedInClientForTests(() => client)
		const { cfg, mcp, workspaceId, actorId } = await connect()
		const message = await draft(workspaceId, actorId)
		await approve(workspaceId, actorId, message.id)

		const direct = await mcp.callTool({
			name: toolName(cfg, 'send_connection_request'),
			arguments: { user_id: 'user-1', message: 'Hej' },
		})
		const wrongKind = await mcp.callTool({
			name: toolName(cfg, 'send_connection_request'),
			arguments: { object_id: message.id },
		})
		const missing = await mcp.callTool({
			name: toolName(cfg, 'send_connection_request'),
			arguments: { object_id: '00000000-0000-4000-8000-000000000000' },
		})

		expect(textOf(direct)).toContain('held for a person')
		expect(textOf(wrongKind)).toContain('not a LinkedIn connection request')
		expect(textOf(missing)).toContain('does not exist')
		for (const result of [direct, wrongKind, missing]) expect(result.isError).toBe(true)
		expect(sendConnectionRequest).not.toHaveBeenCalled()
	})

	it('refuses user_id and message next to object_id', async () => {
		const { client, sendConnectionRequest } = stubClient()
		__setLinkedInClientForTests(() => client)
		const { cfg, mcp, workspaceId, actorId } = await connect()
		const task = await invite(workspaceId, actorId)
		await approve(workspaceId, actorId, task.id)

		const result = await mcp.callTool({
			name: toolName(cfg, 'send_connection_request'),
			arguments: { object_id: task.id, user_id: 'user-2', message: 'Something else' },
		})

		expect(result.isError).toBe(true)
		expect(textOf(result)).toContain('INVALID_INPUT')
		expect(sendConnectionRequest).not.toHaveBeenCalled()
	})

	it('publishes an approved post once, with the approved text, and closes the task', async () => {
		const { client, publishPost } = stubClient()
		__setLinkedInClientForTests(() => client)
		const { cfg, mcp, workspaceId, actorId } = await connect()
		const task = await postDraft(workspaceId, actorId)
		await approve(workspaceId, actorId, task.id)
		const publish = () =>
			mcp.callTool({ name: toolName(cfg, 'publish_post'), arguments: { object_id: task.id } })

		const first = await publish()
		const again = await publish()

		expect(first.isError).toBeFalsy()
		expect(publishPost).toHaveBeenCalledTimes(1)
		expect(publishPost).toHaveBeenCalledWith(expect.objectContaining({ text: 'Sun is out' }))
		expect(JSON.parse(textOf(first)).object).toEqual({
			id: task.id,
			delivered: true,
			task_closed: true,
		})
		expect(again.isError).toBe(true)
		expect(textOf(again)).toContain('already been sent')
		expect(await statusOf(task.id)).toBe('done')
	})

	it('will not publish a post nobody approved, or one edited after approval', async () => {
		const { client, publishPost } = stubClient()
		__setLinkedInClientForTests(() => client)
		const { cfg, mcp, workspaceId, actorId } = await connect()
		const task = await postDraft(workspaceId, actorId)
		const publish = () =>
			mcp.callTool({ name: toolName(cfg, 'publish_post'), arguments: { object_id: task.id } })

		const unapproved = await publish()
		await approve(workspaceId, actorId, task.id)
		await db
			.update(objects)
			.set({ content: 'Header\n--- POST ---\nSun is out, edited\n--- MEDIA ---\nnone' })
			.where(eq(objects.id, task.id))
		const afterEdit = await publish()

		for (const result of [unapproved, afterEdit]) {
			expect(result.isError).toBe(true)
			expect(textOf(result)).toContain('No person has approved')
		}
		expect(publishPost).not.toHaveBeenCalled()
	})

	it('refuses a post with no object_id, text next to object_id, and an object that is not a post', async () => {
		const { client, publishPost } = stubClient()
		__setLinkedInClientForTests(() => client)
		const { cfg, mcp, workspaceId, actorId } = await connect()
		const task = await postDraft(workspaceId, actorId)
		await approve(workspaceId, actorId, task.id)
		const message = await draft(workspaceId, actorId)
		await approve(workspaceId, actorId, message.id)
		const call = (args: Record<string, unknown>) =>
			mcp.callTool({ name: toolName(cfg, 'publish_post'), arguments: args })

		const direct = await call({ text: 'Sun is out' })
		const withText = await call({ object_id: task.id, text: 'Something else' })
		const wrongKind = await call({ object_id: message.id })

		expect(textOf(direct)).toContain('held for a person')
		expect(textOf(withText)).toContain('Do not pass text')
		expect(textOf(wrongKind)).toContain('not a LinkedIn post')
		for (const result of [direct, withText, wrongKind]) expect(result.isError).toBe(true)
		expect(publishPost).not.toHaveBeenCalled()
	})

	it('closes the task when an approved direct message is sent', async () => {
		const { client, sendMessage } = stubClient()
		__setLinkedInClientForTests(() => client)
		const { cfg, mcp, workspaceId, actorId } = await connect()
		const task = await draft(workspaceId, actorId)
		await approve(workspaceId, actorId, task.id)

		const result = await mcp.callTool({
			name: toolName(cfg, 'send_message'),
			arguments: { object_id: task.id },
		})

		expect(result.isError).toBeFalsy()
		expect(sendMessage).toHaveBeenCalledTimes(1)
		expect(sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ recipient_urn: 'ACoAAA1', body: 'Hej Liz' }),
		)
		expect(await statusOf(task.id)).toBe('done')
	})

	it('will not send a direct message nobody approved', async () => {
		const { client, sendMessage } = stubClient()
		__setLinkedInClientForTests(() => client)
		const { cfg, mcp, workspaceId, actorId } = await connect()
		const task = await draft(workspaceId, actorId)

		const result = await mcp.callTool({
			name: toolName(cfg, 'send_message'),
			arguments: { object_id: task.id },
		})

		expect(result.isError).toBe(true)
		expect(textOf(result)).toContain('No person has approved')
		expect(sendMessage).not.toHaveBeenCalled()
		expect(await statusOf(task.id)).toBe('todo')
	})

	it('holds the approval line: edit withdraws it, re-approve sends once, a second send is refused', async () => {
		const { client, sendMessage } = stubClient()
		__setLinkedInClientForTests(() => client)
		const { cfg, mcp, workspaceId, actorId } = await connect()
		const task = await draft(workspaceId, actorId)
		const send = () =>
			mcp.callTool({ name: toolName(cfg, 'send_message'), arguments: { object_id: task.id } })

		await approve(workspaceId, actorId, task.id)
		await db.update(objects).set({ content: 'Hej Liz, edited' }).where(eq(objects.id, task.id))
		const afterEdit = await send()
		expect(afterEdit.isError).toBe(true)
		expect(textOf(afterEdit)).toContain('No person has approved')
		expect(sendMessage).not.toHaveBeenCalled()

		await approve(workspaceId, actorId, task.id)
		const sent = await send()
		expect(sent.isError).toBeFalsy()
		expect(sendMessage).toHaveBeenCalledTimes(1)

		const again = await send()
		expect(again.isError).toBe(true)
		expect(sendMessage).toHaveBeenCalledTimes(1)
	})

	it('refuses raw attachments on send_message and names the object path', async () => {
		const { client, sendMessage } = stubClient()
		__setLinkedInClientForTests(() => client)
		const { cfg, mcp } = await connect()

		const result = await mcp.callTool({
			name: toolName(cfg, 'send_message'),
			arguments: {
				recipient_urn: 'ACoAAA1',
				body: 'Hej',
				idempotency_key: 'key-att',
				attachments: [{ content: 'AAAA', content_type: 'application/pdf', filename: 'a.pdf' }],
			},
		})

		expect(result.isError).toBe(true)
		expect(textOf(result)).toContain('INVALID_INPUT')
		expect(textOf(result)).toContain('attachment_file_id')
		expect(sendMessage).not.toHaveBeenCalled()
	})

	it('refuses body and recipient_urn next to object_id', async () => {
		const { client, sendMessage } = stubClient()
		__setLinkedInClientForTests(() => client)
		const { cfg, mcp, workspaceId, actorId } = await connect()
		const task = await draft(workspaceId, actorId)
		await approve(workspaceId, actorId, task.id)

		const result = await mcp.callTool({
			name: toolName(cfg, 'send_message'),
			arguments: { object_id: task.id, body: 'Something else', recipient_urn: 'ACoAAA2' },
		})

		expect(result.isError).toBe(true)
		expect(textOf(result)).toContain('INVALID_INPUT')
		expect(sendMessage).not.toHaveBeenCalled()
	})

	it('refuses a plain send_message and a plain reply with no object_id', async () => {
		const { client, sendMessage } = stubClient()
		const reply = client.reply as unknown as ReturnType<typeof vi.fn>
		__setLinkedInClientForTests(() => client)
		const { cfg, mcp } = await connect()

		const direct = await mcp.callTool({
			name: toolName(cfg, 'send_message'),
			arguments: { recipient_urn: 'ACoAAA1', body: 'Hej', idempotency_key: 'key-plain' },
		})
		const directReply = await mcp.callTool({
			name: toolName(cfg, 'reply'),
			arguments: { thread_id: 'thread-1', body: 'Hej', in_reply_to_message_id: 'm-1' },
		})

		for (const result of [direct, directReply]) {
			expect(result.isError).toBe(true)
			expect(textOf(result)).toContain('INVALID_INPUT')
			expect(textOf(result)).toContain('held for a person')
		}
		expect(sendMessage).not.toHaveBeenCalled()
		expect(reply).not.toHaveBeenCalled()
	})
})
