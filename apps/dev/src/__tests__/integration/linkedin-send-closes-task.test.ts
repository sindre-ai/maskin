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
	return { client, sendConnectionRequest, sendMessage }
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

describe('LinkedIn send tools with object_id', () => {
	it('closes the task when a connection request is accepted', async () => {
		const { client, sendConnectionRequest } = stubClient()
		__setLinkedInClientForTests(() => client)
		const { cfg, mcp, workspaceId, actorId } = await connect()
		const task = await insertObject(db, workspaceId, actorId, { type: 'task', status: 'todo' })

		const result = await mcp.callTool({
			name: toolName(cfg, 'send_connection_request'),
			arguments: { user_id: 'user-1', message: 'Hej', object_id: task.id },
		})

		expect(result.isError).toBeFalsy()
		expect(sendConnectionRequest).toHaveBeenCalledTimes(1)
		expect(JSON.parse(textOf(result)).object).toEqual({
			id: task.id,
			delivered: true,
			task_closed: true,
		})
		expect(await statusOf(task.id)).toBe('done')
	})

	it('refuses to send the same task twice and does not call LinkedIn the second time', async () => {
		const { client, sendConnectionRequest } = stubClient()
		__setLinkedInClientForTests(() => client)
		const { cfg, mcp, workspaceId, actorId } = await connect()
		const task = await insertObject(db, workspaceId, actorId, { type: 'task', status: 'todo' })
		const args = { user_id: 'user-1', message: 'Hej', object_id: task.id }

		await mcp.callTool({ name: toolName(cfg, 'send_connection_request'), arguments: args })
		const second = await mcp.callTool({
			name: toolName(cfg, 'send_connection_request'),
			arguments: args,
		})

		expect(second.isError).toBe(true)
		expect(textOf(second)).toContain('INVALID_INPUT')
		expect(textOf(second)).toContain('already sent')
		expect(sendConnectionRequest).toHaveBeenCalledTimes(1)
	})

	it('sends nothing when object_id is not an object in the workspace', async () => {
		const { client, sendConnectionRequest } = stubClient()
		__setLinkedInClientForTests(() => client)
		const { cfg, mcp } = await connect()

		const result = await mcp.callTool({
			name: toolName(cfg, 'send_connection_request'),
			arguments: { user_id: 'user-1', object_id: '00000000-0000-4000-8000-000000000000' },
		})

		expect(result.isError).toBe(true)
		expect(textOf(result)).toContain('Nothing was sent')
		expect(sendConnectionRequest).not.toHaveBeenCalled()
	})

	it('behaves as before when object_id is left out', async () => {
		const { client, sendConnectionRequest } = stubClient()
		__setLinkedInClientForTests(() => client)
		const { cfg, mcp, workspaceId, actorId } = await connect()
		const task = await insertObject(db, workspaceId, actorId, { type: 'task', status: 'todo' })

		const result = await mcp.callTool({
			name: toolName(cfg, 'send_connection_request'),
			arguments: { user_id: 'user-1', message: 'Hej' },
		})

		expect(result.isError).toBeFalsy()
		expect(sendConnectionRequest).toHaveBeenCalledTimes(1)
		expect(JSON.parse(textOf(result)).object).toBeUndefined()
		expect(await statusOf(task.id)).toBe('todo')
	})

	it('closes the task when a direct message is accepted', async () => {
		const { client, sendMessage } = stubClient()
		__setLinkedInClientForTests(() => client)
		const { cfg, mcp, workspaceId, actorId } = await connect()
		const task = await insertObject(db, workspaceId, actorId, { type: 'task', status: 'todo' })

		const result = await mcp.callTool({
			name: toolName(cfg, 'send_message'),
			arguments: {
				recipient_urn: 'urn:li:person:other',
				body: 'Hej',
				idempotency_key: 'key-1',
				object_id: task.id,
			},
		})

		expect(result.isError).toBeFalsy()
		expect(sendMessage).toHaveBeenCalledTimes(1)
		expect(await statusOf(task.id)).toBe('done')
	})
})
