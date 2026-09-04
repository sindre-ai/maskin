import type { Database } from '@maskin/db'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { sendMock, replyMock, listMock } = vi.hoisted(() => ({
	sendMock: vi.fn(),
	replyMock: vi.fn(),
	listMock: vi.fn(),
}))

vi.mock('../../../../lib/integrations/providers/linkedin-unipile/operations', () => ({
	sendLinkedInMessage: sendMock,
	replyToLinkedInThread: replyMock,
	listLinkedInConversations: listMock,
	listLinkedInMessages: vi.fn(),
	listLinkedInConnections: vi.fn(),
	searchLinkedInPeople: vi.fn(),
	getLinkedInProfile: vi.fn(),
}))

import { LinkedInIntegrationError } from '../../../../lib/integrations/providers/linkedin-unipile/errors'
import { createLinkedInMcpServer } from '../../../../lib/integrations/providers/linkedin-unipile/mcp-server'

const ctx = {
	db: {} as Database,
	actorId: 'actor-1',
	workspaceId: 'ws-1',
}

function tools(server: ReturnType<typeof createLinkedInMcpServer>) {
	return (
		server as unknown as {
			_registeredTools: Record<
				string,
				{ handler: (args: unknown, extra: unknown) => Promise<unknown> }
			>
		}
	)._registeredTools
}

async function callTool(name: string, args: Record<string, unknown>) {
	const server = createLinkedInMcpServer(ctx)
	return (await tools(server)[name].handler(args, {})) as {
		content: Array<{ text: string }>
		isError?: boolean
	}
}

beforeEach(() => {
	sendMock.mockReset()
	replyMock.mockReset()
	listMock.mockReset()
})

afterEach(() => {
	vi.restoreAllMocks()
})

describe('createLinkedInMcpServer', () => {
	it('registers exactly the LinkedIn tool surface', () => {
		expect(Object.keys(tools(createLinkedInMcpServer(ctx))).sort()).toEqual([
			'linkedin_get_profile',
			'linkedin_list_connections',
			'linkedin_list_conversations',
			'linkedin_list_messages',
			'linkedin_reply',
			'linkedin_search_people',
			'linkedin_send_message',
		])
	})

	// Only send/reply may contact anyone. A read tool gaining a write path
	// would be a silent expansion of what an agent can do to a real person.
	it('keeps every tool but send and reply read-only', () => {
		const writeTools = ['linkedin_send_message', 'linkedin_reply']
		const registered = Object.keys(tools(createLinkedInMcpServer(ctx)))
		const reads = registered.filter((t) => !writeTools.includes(t))
		expect(reads).toHaveLength(5)
	})

	// Carried over from the deleted packages/mcp schema test: an agent picks its
	// call args from the field descriptions, so a bare field is a bug the first
	// caller hits. Constraints are the parent-bet spec §1 values.
	it('describes every input field on every tool', () => {
		const registered = tools(createLinkedInMcpServer(ctx)) as unknown as Record<
			string,
			{ inputSchema?: { shape?: Record<string, { description?: string }> } }
		>
		const seen: string[] = []
		for (const [name, def] of Object.entries(registered)) {
			for (const [field, schema] of Object.entries(def.inputSchema?.shape ?? {})) {
				seen.push(`${name}.${field}`)
				expect(schema.description, `${name}.${field} is missing .describe()`).toBeTruthy()
			}
		}
		// Guard the guard: a shape read that silently yields nothing would make
		// this test pass while checking no fields at all.
		expect(seen.length).toBe(18)
	})

	it('passes the calling actor and workspace through to the operation', async () => {
		sendMock.mockResolvedValue({ message_id: 'm1', chat_id: 'c1', sent_at: '2026-09-04T10:00:00Z' })
		await callTool('linkedin_send_message', {
			recipient_urn: 'urn:li:person:AbC123',
			body: 'hello',
			idempotency_key: 'k1',
		})
		// The identity that sends is the caller's own — an agent must not be
		// able to send as another workspace member's connected LinkedIn.
		expect(sendMock).toHaveBeenCalledWith(
			expect.objectContaining({ actorId: 'actor-1', workspaceId: 'ws-1' }),
			expect.objectContaining({ recipient_urn: 'urn:li:person:AbC123' }),
		)
	})

	it('returns the operation result as JSON text', async () => {
		listMock.mockResolvedValue({ conversations: [{ id: 'c1' }], next_cursor: 'cur' })
		const res = await callTool('linkedin_list_conversations', { limit: 10 })
		expect(res.isError).toBeUndefined()
		expect(JSON.parse(res.content[0].text)).toEqual({
			conversations: [{ id: 'c1' }],
			next_cursor: 'cur',
		})
	})

	// The six-class code drives what the agent does next — retry, escalate to a
	// human, or stop sending for 24h. If it collapsed into an opaque failure the
	// agent would have nothing to branch on.
	it.each([
		['CREDENTIAL_NOT_CONNECTED', 'Reconnect at Settings > Integrations.'],
		['LINKEDIN_ACCOUNT_RESTRICTED', 'LinkedIn has restricted this account.'],
		['RATE_LIMITED_UNIPILE', 'Try again in ~1 minute.'],
	] as const)('surfaces %s as a tool error carrying the wire code', async (code, message) => {
		sendMock.mockRejectedValue(new LinkedInIntegrationError(code, message))
		const res = await callTool('linkedin_send_message', {
			recipient_urn: 'urn:li:person:AbC123',
			body: 'hello',
			idempotency_key: 'k1',
		})
		expect(res.isError).toBe(true)
		expect(res.content[0].text).toBe(`${code}: ${message}`)
	})

	it('maps an unexpected non-taxonomy throw to UNIPILE_UNAVAILABLE rather than leaking it', async () => {
		replyMock.mockRejectedValue(new Error('socket hang up'))
		const res = await callTool('linkedin_reply', {
			thread_id: 't1',
			body: 'hi',
			idempotency_key: 'k2',
		})
		expect(res.isError).toBe(true)
		expect(res.content[0].text).toContain('UNIPILE_UNAVAILABLE')
		expect(res.content[0].text).not.toContain('socket hang up')
	})
})
