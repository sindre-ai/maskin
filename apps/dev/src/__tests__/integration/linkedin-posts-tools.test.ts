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
import { _resetFeatureFlagConfig } from '../../lib/feature-flags'
import {
	POSTS_READS_AUTHOR_ID,
	POSTS_READS_FIRST_POST_ID,
	POSTS_READS_SECOND_POST_ID,
} from '../../lib/integrations/providers/linkedin-unipile/__mocks__/handlers/posts-reads'
import {
	type LinkedInMockServer,
	startLinkedInMock,
} from '../../lib/integrations/providers/linkedin-unipile/__mocks__/unipile-server'
import { registerLinkedInMcpInstance } from '../../lib/integrations/providers/linkedin-unipile/mcp-server'
import { insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

/**
 * The posts, company and like tools with their budget and rules, against real Postgres: the
 * counts, the advisory lock and the log rows only exist in the database. Unipile is our own
 * mock server, so this proves our bookkeeping and what was (not) sent, not LinkedIn's behaviour.
 */

let mock: LinkedInMockServer

beforeAll(async () => {
	process.env.INTEGRATION_ENCRYPTION_KEY = 'a'.repeat(64)
	process.env.UNIPILE_API_KEY = 'test-api-key'
	mock = await startLinkedInMock()
	process.env.UNIPILE_BASE_URL = mock.baseUrl
})

afterAll(async () => {
	await mock.close()
	process.env.FF_WORKSPACE_FEATURES = undefined
	_resetFeatureFlagConfig()
})

beforeEach(() => {
	mock.resetInbox()
	captureMock.mockClear()
	process.env.FF_WORKSPACE_FEATURES = undefined
	_resetFeatureFlagConfig()
})

async function connect(opts: { flag?: boolean } = {}) {
	const actorId = getTestActorId()
	const ws = await insertWorkspace(db, actorId)
	if (opts.flag !== false) {
		process.env.FF_WORKSPACE_FEATURES = `${ws.id}:linkedin-outreach-actions`
		_resetFeatureFlagConfig()
	}
	const [integration] = await db
		.insert(integrations)
		.values({
			workspaceId: ws.id,
			provider: 'linkedin-unipile',
			status: INTEGRATION_STATUS_ACTIVE,
			credentials: encrypt(JSON.stringify({ account_id: 'acc_1', account_status: 'OK' })),
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
		unipileAccountId: 'acc_1',
	}
	const server = new McpServer({ name: 'test', version: '1.0.0' })
	registerLinkedInMcpInstance(server, cfg, { db, actorId, workspaceId: ws.id })
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
	await server.connect(serverSide)
	const mcp = new Client({ name: 'test-client', version: '1.0.0' })
	await mcp.connect(clientSide)
	return { cfg, mcp, workspaceId: ws.id, actorId, integrationId: integration.id }
}

type Connected = Awaited<ReturnType<typeof connect>>

const rowsFor = (integrationId: string) =>
	db.select().from(linkedinActions).where(eq(linkedinActions.integrationId, integrationId))

/** Seed `count` finished rows, as if the tool had been called that often just now. */
async function seed(
	c: Connected,
	tool: string,
	count: number,
	extra: { targetProviderId?: string; refId?: string; outcome?: string } = {},
) {
	await db.insert(linkedinActions).values(
		Array.from({ length: count }, (_, i) => ({
			workspaceId: c.workspaceId,
			integrationId: c.integrationId,
			actorId: c.actorId,
			tool,
			kind: tool === 'react_to_post' ? 'write' : 'read',
			targetProviderId: extra.targetProviderId ?? `seed-${tool}-${i}`,
			refId: extra.refId ?? (tool === 'react_to_post' ? `seed-post-${i}` : null),
			outcome: extra.outcome ?? 'ok',
		})),
	)
}

function call(c: Connected, verb: string, args: Record<string, unknown>) {
	return c.mcp.callTool({ name: toolName(c.cfg, verb), arguments: args })
}

function text(result: Awaited<ReturnType<typeof call>>): string {
	return (result.content as { text: string }[])[0]?.text ?? ''
}

describe('profile-view budget', () => {
	it('shares 100 a day across get_profile, list_user_posts and get_company, and the 101st sends nothing', async () => {
		const c = await connect()
		await seed(c, 'get_profile', 40)
		await seed(c, 'list_user_posts', 40)
		await seed(c, 'get_company', 20)

		for (const [verb, args] of [
			['get_company', { company: 'analytical-engines' }],
			['list_user_posts', { person: POSTS_READS_AUTHOR_ID }],
			['get_profile', { identifier: 'gracehopper' }],
		] as const) {
			const result = await call(c, verb, args)
			expect(result.isError, verb).toBe(true)
			expect(text(result), verb).toContain('RATE_LIMITED_LINKEDIN')
		}
		expect(mock.inbox()).toHaveLength(0)
		const refused = (await rowsFor(c.integrationId)).filter((r) => r.outcome === 'refused_cap')
		expect(refused.map((r) => r.tool).sort()).toEqual([
			'get_company',
			'get_profile',
			'list_user_posts',
		])
	})

	it('counts the lookup inside list_user_posts as a view of its own', async () => {
		const c = await connect()
		await seed(c, 'get_profile', 98)

		const result = await call(c, 'list_user_posts', { person: 'gracehopper' })
		expect(result.isError).toBeFalsy()
		const rows = await rowsFor(c.integrationId)
		// 98 seeded + the list call + its get_profile lookup = 100 ok rows.
		expect(rows.filter((r) => r.outcome === 'ok')).toHaveLength(100)
		expect(
			rows.filter((r) => r.tool === 'get_profile' && r.targetProviderId === 'mock-user-2'),
		).toHaveLength(1)
		expect(mock.inbox().map((r) => `${r.method} ${r.path}`)).toEqual([
			'GET /v2/acc_1/users/gracehopper',
			'GET /v2/acc_1/users/mock-user-2/posts?limit=10',
		])
	})

	it('sends nothing when a handle can afford the list call but not the lookup', async () => {
		const c = await connect()
		await seed(c, 'get_profile', 99)

		const result = await call(c, 'list_user_posts', { person: 'gracehopper' })
		expect(result.isError).toBe(true)
		expect(text(result)).toContain('RATE_LIMITED_LINKEDIN')
		expect(mock.inbox()).toHaveLength(0)
		const rows = await rowsFor(c.integrationId)
		expect(rows.filter((r) => r.outcome === 'ok')).toHaveLength(99)
		expect(
			rows
				.filter((r) => r.outcome === 'refused_cap')
				.map((r) => r.tool)
				.sort(),
		).toEqual(['get_profile', 'list_user_posts'])
	})

	it('logs the posts read against the author, with no post text', async () => {
		const c = await connect()
		const result = await call(c, 'list_user_posts', { person: POSTS_READS_AUTHOR_ID })
		expect(result.isError).toBeFalsy()
		const [row] = await rowsFor(c.integrationId)
		expect(row).toMatchObject({
			tool: 'list_user_posts',
			kind: 'read',
			targetProviderId: POSTS_READS_AUTHOR_ID,
			outcome: 'ok',
		})
		expect(JSON.stringify(row)).not.toContain('Ada Lovelace')
	})
})

describe('react_to_post', () => {
	const like = (postId = POSTS_READS_FIRST_POST_ID, author = POSTS_READS_AUTHOR_ID) => ({
		post_id: postId,
		author_provider_id: author,
	})

	it('is not registered while the flag is off', async () => {
		const c = await connect({ flag: false })
		const tools = (await c.mcp.listTools()).tools.map((t) => t.name)
		expect(tools).toContain(toolName(c.cfg, 'list_user_posts'))
		expect(tools).toContain(toolName(c.cfg, 'get_company'))
		expect(tools).not.toContain(toolName(c.cfg, 'react_to_post'))
	})

	it('likes with the listed post id and logs the post and its author', async () => {
		const c = await connect()
		const result = await call(c, 'react_to_post', like())
		expect(result.isError).toBeFalsy()
		expect(JSON.parse(text(result))).toEqual({
			post_id: POSTS_READS_FIRST_POST_ID,
			reaction: 'like',
			already_liked: false,
		})
		expect(mock.inbox().map((r) => `${r.method} ${r.path}`)).toEqual([
			`POST /v2/acc_1/posts/${POSTS_READS_FIRST_POST_ID}/reactions`,
		])
		const [row] = await rowsFor(c.integrationId)
		expect(row).toMatchObject({
			tool: 'react_to_post',
			kind: 'write',
			targetProviderId: POSTS_READS_AUTHOR_ID,
			refId: POSTS_READS_FIRST_POST_ID,
			outcome: 'ok',
		})
	})

	it('returns already_liked with no call when this account already liked the post', async () => {
		const c = await connect()
		await call(c, 'react_to_post', like())
		mock.resetInbox()

		const again = await call(c, 'react_to_post', like())
		expect(JSON.parse(text(again))).toMatchObject({ already_liked: true })
		expect(mock.inbox()).toHaveLength(0)
		const outcomes = (await rowsFor(c.integrationId)).map((r) => r.outcome).sort()
		expect(outcomes).toEqual(['noop', 'ok'])
	})

	it('refuses a second like on the same author inside 7 days, logged as refused_rule', async () => {
		const c = await connect()
		await call(c, 'react_to_post', like(POSTS_READS_FIRST_POST_ID))
		mock.resetInbox()

		const second = await call(c, 'react_to_post', like(POSTS_READS_SECOND_POST_ID))
		expect(second.isError).toBe(true)
		expect(text(second)).toContain('one like per author per 7 days')
		expect(mock.inbox()).toHaveLength(0)
		const refused = (await rowsFor(c.integrationId)).filter((r) => r.outcome !== 'ok')
		expect(refused).toHaveLength(1)
		expect(refused[0]).toMatchObject({ outcome: 'refused_rule', errorCode: 'INVALID_INPUT' })
	})

	it('allows another like on the same author once the first is older than 7 days', async () => {
		const c = await connect()
		await call(c, 'react_to_post', like(POSTS_READS_FIRST_POST_ID))
		await db
			.update(linkedinActions)
			.set({ createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) })
			.where(eq(linkedinActions.integrationId, c.integrationId))

		const second = await call(c, 'react_to_post', like(POSTS_READS_SECOND_POST_ID))
		expect(second.isError).toBeFalsy()
	})

	it('refuses the 16th like of the day with nothing sent', async () => {
		const c = await connect()
		await seed(c, 'react_to_post', 15)

		const result = await call(c, 'react_to_post', like('fresh-post', 'ACoFreshAuthor'))
		expect(result.isError).toBe(true)
		expect(text(result)).toContain('RATE_LIMITED_LINKEDIN')
		expect(mock.inbox()).toHaveLength(0)
		const refused = (await rowsFor(c.integrationId)).filter((r) => r.outcome === 'refused_cap')
		expect(refused).toHaveLength(1)
	})

	it('lets only one of two parallel likes on the same author go out', async () => {
		const c = await connect()
		const [a, b] = await Promise.all([
			call(c, 'react_to_post', like(POSTS_READS_FIRST_POST_ID)),
			call(c, 'react_to_post', like(POSTS_READS_SECOND_POST_ID)),
		])
		expect([a.isError, b.isError].filter(Boolean).length).toBeGreaterThanOrEqual(1)
		const sent = mock.inbox().filter((r) => r.method === 'POST')
		expect(sent.length).toBeLessThanOrEqual(1)
	})
})
