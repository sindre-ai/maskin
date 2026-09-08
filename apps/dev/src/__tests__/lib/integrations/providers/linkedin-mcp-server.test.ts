import type { Database } from '@maskin/db'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
	sendMock,
	replyMock,
	listMock,
	connectMock,
	publishPostMock,
	publishPageMock,
	commentMock,
	replyToCommentMock,
	readCommentsMock,
	engagementMock,
} = vi.hoisted(() => ({
	sendMock: vi.fn(),
	replyMock: vi.fn(),
	listMock: vi.fn(),
	connectMock: vi.fn(),
	publishPostMock: vi.fn(),
	publishPageMock: vi.fn(),
	commentMock: vi.fn(),
	replyToCommentMock: vi.fn(),
	readCommentsMock: vi.fn(),
	engagementMock: vi.fn(),
}))

vi.mock('../../../../lib/integrations/providers/linkedin-unipile/operations', () => ({
	sendLinkedInMessage: sendMock,
	replyToLinkedInThread: replyMock,
	listLinkedInConversations: listMock,
	listLinkedInMessages: vi.fn(),
	listLinkedInConnections: vi.fn(),
	searchLinkedInPeople: vi.fn(),
	getLinkedInProfile: vi.fn(),
	sendLinkedInConnectionRequest: connectMock,
	publishLinkedInPost: publishPostMock,
	publishLinkedInBusinessPagePost: publishPageMock,
	commentOnLinkedInPost: commentMock,
	replyToLinkedInComment: replyToCommentMock,
	readLinkedInPostComments: readCommentsMock,
	getLinkedInPostEngagement: engagementMock,
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
	connectMock.mockReset()
	publishPostMock.mockReset()
	publishPageMock.mockReset()
	commentMock.mockReset()
	replyToCommentMock.mockReset()
	readCommentsMock.mockReset()
	engagementMock.mockReset()
})

afterEach(() => {
	vi.restoreAllMocks()
})

describe('createLinkedInMcpServer', () => {
	it('registers exactly the LinkedIn tool surface', () => {
		expect(Object.keys(tools(createLinkedInMcpServer(ctx))).sort()).toEqual([
			'linkedin_comment_on_post',
			'linkedin_get_post_engagement',
			'linkedin_get_profile',
			'linkedin_list_connections',
			'linkedin_list_conversations',
			'linkedin_list_messages',
			'linkedin_publish_business_page_post',
			'linkedin_publish_post',
			'linkedin_read_post_comments',
			'linkedin_reply',
			'linkedin_reply_to_comment',
			'linkedin_search_people',
			'linkedin_send_connection_request',
			'linkedin_send_message',
		])
	})

	// The write tools that carry real-world side effects on LinkedIn.
	// Adding a read tool that turns into a write is a silent expansion of
	// agent authority — this test would flip if that happened.
	it('keeps every non-write tool read-only', () => {
		const writeTools = [
			'linkedin_send_message',
			'linkedin_reply',
			'linkedin_send_connection_request',
			'linkedin_publish_post',
			'linkedin_publish_business_page_post',
			'linkedin_comment_on_post',
			'linkedin_reply_to_comment',
		]
		const registered = Object.keys(tools(createLinkedInMcpServer(ctx)))
		const reads = registered.filter((t) => !writeTools.includes(t))
		expect(reads.sort()).toEqual([
			'linkedin_get_post_engagement',
			'linkedin_get_profile',
			'linkedin_list_connections',
			'linkedin_list_conversations',
			'linkedin_list_messages',
			'linkedin_read_post_comments',
			'linkedin_search_people',
		])
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
		// this test pass while checking no fields at all. 39 fields after the
		// Task 7b content/community tools + 2 fields (user_id, message) on
		// linkedin_send_connection_request = 41.
		expect(seen.length).toBe(41)
	})

	it('passes the calling actor through to publish_post', async () => {
		publishPostMock.mockResolvedValue({
			post_id: 'p1',
			published_at: '2026-09-01T10:00:00Z',
			replayed: false,
		})
		const res = await callTool('linkedin_publish_post', { text: 'hello world' })
		expect(res.isError).toBeUndefined()
		expect(publishPostMock).toHaveBeenCalledWith(
			expect.objectContaining({ actorId: 'actor-1', workspaceId: 'ws-1' }),
			expect.objectContaining({ text: 'hello world' }),
		)
	})

	it('surfaces LINKEDIN_POST_TOO_LONG from a publish call as a wire-code tool error', async () => {
		publishPostMock.mockRejectedValue(
			new LinkedInIntegrationError('LINKEDIN_POST_TOO_LONG', 'Post exceeds 3000 chars'),
		)
		const res = await callTool('linkedin_publish_post', { text: 'x' })
		expect(res.isError).toBe(true)
		expect(res.content[0].text).toBe('LINKEDIN_POST_TOO_LONG: Post exceeds 3000 chars')
	})

	it('returns partial engagement envelopes verbatim from the operation', async () => {
		engagementMock.mockResolvedValue({
			post_id: 'p1',
			reactions: { total: 3, sample: [] },
			comments: { total: 0 },
			partial_errors: {
				reactions: null,
				comments: { code: 'LINKEDIN_UNAVAILABLE', message: 'timeout' },
			},
			is_partial: true,
		})
		const res = await callTool('linkedin_get_post_engagement', { post_id: 'p1' })
		expect(res.isError).toBeUndefined()
		expect(JSON.parse(res.content[0].text)).toMatchObject({
			is_partial: true,
			comments: { total: 0 },
			partial_errors: expect.objectContaining({
				comments: { code: 'LINKEDIN_UNAVAILABLE', message: 'timeout' },
			}),
		})
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
		['RATE_LIMITED_LINKEDIN', 'Try again in ~1 minute.'],
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

	it('maps an unexpected non-taxonomy throw to LINKEDIN_UNAVAILABLE rather than leaking it', async () => {
		replyMock.mockRejectedValue(new Error('socket hang up'))
		const res = await callTool('linkedin_reply', {
			thread_id: 't1',
			body: 'hi',
			idempotency_key: 'k2',
		})
		expect(res.isError).toBe(true)
		expect(res.content[0].text).toContain('LINKEDIN_UNAVAILABLE')
		expect(res.content[0].text).not.toContain('socket hang up')
	})

	it('routes linkedin_send_connection_request to the connection-request operation', async () => {
		connectMock.mockResolvedValue({
			status: 'sent',
			sent_at: '2026-09-07T10:00:00Z',
			invitation_id: 'inv-1',
		})
		const res = await callTool('linkedin_send_connection_request', {
			user_id: 'ACoAAAxxxxxBxxxxxxxxxxxxxxxxxxxxxxxxxxx',
			message: "Hey — enjoyed your talk at LinkedIn's dev conf. Would love to connect.",
		})
		expect(res.isError).toBeUndefined()
		expect(JSON.parse(res.content[0].text)).toEqual({
			status: 'sent',
			sent_at: '2026-09-07T10:00:00Z',
			invitation_id: 'inv-1',
		})
		expect(connectMock).toHaveBeenCalledWith(
			expect.objectContaining({ actorId: 'actor-1', workspaceId: 'ws-1' }),
			expect.objectContaining({
				user_id: 'ACoAAAxxxxxBxxxxxxxxxxxxxxxxxxxxxxxxxxx',
				message: expect.stringContaining('enjoyed your talk'),
			}),
		)
	})

	// The two connect-request-specific error codes drive very different agent
	// behaviour — quota-exceeded stops sending invites for the week; already-
	// connected pivots straight into linkedin_send_message. Both must carry the
	// wire code so the agent can branch on it.
	it.each([
		['LINKEDIN_INVITE_QUOTA_EXCEEDED', 'Weekly quota reached for this LinkedIn account.'],
		['LINKEDIN_ALREADY_CONNECTED', 'Target member is already a connection.'],
	] as const)(
		'surfaces %s from the connect-request tool as a tool error',
		async (code, message) => {
			connectMock.mockRejectedValue(new LinkedInIntegrationError(code, message))
			const res = await callTool('linkedin_send_connection_request', {
				user_id: 'ACoAAAxxxxxBxxxxxxxxxxxxxxxxxxxxxxxxxxx',
			})
			expect(res.isError).toBe(true)
			expect(res.content[0].text).toBe(`${code}: ${message}`)
		},
	)
})
