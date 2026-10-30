import { randomUUID } from 'node:crypto'
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
import {
	FIRST_SEEN_TOOL,
	WITHDRAW_DAILY_CAP,
} from '../../lib/integrations/providers/linkedin-unipile/invitation-withdrawal'
import { registerLinkedInMcpInstance } from '../../lib/integrations/providers/linkedin-unipile/mcp-server'
import {
	type LinkedInOperationContext,
	__setLinkedInClientForTests,
	withdrawLinkedInInvitation,
} from '../../lib/integrations/providers/linkedin-unipile/operations'
import type { LinkedInClient } from '../../lib/integrations/providers/linkedin-unipile/unipile-client'
import { insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

/**
 * withdraw_invitation, the first-seen age fallback and the re-invite guard, against real
 * Postgres: the cap, the one-ok-row-per-invitation index and the 21-day lookup only exist in the
 * database. The Unipile client is our own stub fed with the documented list shape (created
 * date optional), so this proves our rules, not LinkedIn's behaviour.
 */

const DAY = 24 * 60 * 60 * 1000
const HOUR = 60 * 60 * 1000

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

type Row = Record<string, unknown>

/** One row of the documented sent-list shape. `createdAt` undefined leaves the date out. */
function sentRow(id: string, createdAt: Date | undefined, personId = `ACoAA-${id}`): Row {
	return {
		object: 'RelationRequest',
		id,
		type: 'sent',
		...(createdAt === undefined ? {} : { created_at: createdAt.toISOString() }),
		message: 'Hi, would like to connect',
		user: { id: personId, public_identifier: `person-${id}`, display_name: `Person ${id}` },
	}
}

function stubClient(rows: Row[]) {
	const listRelationRequests = vi.fn(async (q: { offset?: number; limit?: number }) => {
		const offset = q.offset ?? 0
		const limit = q.limit ?? 50
		return {
			status: 200,
			body: { data: rows.slice(offset, offset + limit), total_count: rows.length },
			headers: {},
		}
	})
	const cancelRelationRequest = vi.fn(async () => ({
		status: 200,
		body: { object: 'RelationRequestCanceled' },
		headers: {},
	}))
	const sendConnectionRequest = vi.fn(async () => ({
		status: 200,
		body: { invitation_id: 'inv-new' },
		headers: {},
	}))
	const client = {
		listRelationRequests,
		cancelRelationRequest,
		sendConnectionRequest,
	} as unknown as LinkedInClient
	return { client, listRelationRequests, cancelRelationRequest, sendConnectionRequest }
}

async function connect() {
	const actorId = getTestActorId()
	const ws = await insertWorkspace(db, actorId)
	// The sent-list cache is per account and per process, so each connection gets its own
	// account id; otherwise a test would read the list an earlier test left in the cache.
	const accountId = `acc-${randomUUID()}`
	const [integration] = await db
		.insert(integrations)
		.values({
			workspaceId: ws.id,
			provider: 'linkedin-unipile',
			status: INTEGRATION_STATUS_ACTIVE,
			credentials: encrypt(JSON.stringify({ account_id: accountId, account_status: 'OK' })),
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
		unipileAccountId: accountId,
	}
	const server = new McpServer({ name: 'test', version: '1.0.0' })
	registerLinkedInMcpInstance(server, cfg, { db, actorId, workspaceId: ws.id })
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
	}
	const opCtx: LinkedInOperationContext = { db, actorId, workspaceId: ws.id, identity: cfg }
	return {
		cfg,
		mcp,
		accountId,
		workspaceId: ws.id,
		actorId,
		integrationId: integration.id,
		logCtx,
		opCtx,
	}
}

type Harness = Awaited<ReturnType<typeof connect>>

/** Runs the operation the way the tool does: under the action log, with the daily cap. */
function withdraw(h: Harness, invitationId: string, now: Date) {
	return withActionLog(
		h.logCtx,
		{ tool: 'withdraw_invitation', kind: 'write', cap: WITHDRAW_DAILY_CAP },
		(recorder) =>
			withdrawLinkedInInvitation(
				h.opCtx,
				{ invitation_id: invitationId },
				{ integrationId: h.integrationId, recorder, now: () => now, caches: new Map() },
			),
	)
}

async function rowsFor(integrationId: string, tool?: string) {
	const rows = await db
		.select()
		.from(linkedinActions)
		.where(eq(linkedinActions.integrationId, integrationId))
	return tool ? rows.filter((r) => r.tool === tool) : rows
}

function textOf(result: unknown): string {
	const content = (result as { content?: Array<{ text?: string }> }).content ?? []
	return content.map((c) => c.text ?? '').join('')
}

async function expectRefused(promise: Promise<unknown>, message: RegExp) {
	const err = await promise.then(
		() => null,
		(e: unknown) => e,
	)
	expect(err).toBeInstanceOf(LinkedInActionRefusal)
	expect((err as LinkedInActionRefusal).outcome).toBe('refused_rule')
	expect((err as LinkedInActionRefusal).code).toBe('INVALID_INPUT')
	expect((err as LinkedInActionRefusal).message).toMatch(message)
}

describe('withdraw_invitation: what may be withdrawn', () => {
	it('refuses an id that is not in the sent list and never calls cancel', async () => {
		const now = new Date()
		const { client, cancelRelationRequest } = stubClient([
			sentRow('sent-1', new Date(+now - 30 * DAY)),
		])
		__setLinkedInClientForTests(() => client)
		const h = await connect()

		await expectRefused(
			withdraw(h, 'received-from-someone-else', now),
			/not a sent invitation; this tool never refuses received invites/,
		)

		expect(cancelRelationRequest).not.toHaveBeenCalled()
		const [row] = await rowsFor(h.integrationId, 'withdraw_invitation')
		expect(row).toMatchObject({ outcome: 'refused_rule', errorCode: 'INVALID_INPUT' })
	})

	it('refuses at 13 days 23 hours and withdraws at exactly 14 days (clock injected)', async () => {
		const now = new Date()
		const { client, cancelRelationRequest } = stubClient([
			sentRow('young', new Date(+now - 14 * DAY + HOUR)),
			sentRow('ripe', new Date(+now - 14 * DAY)),
		])
		__setLinkedInClientForTests(() => client)
		const h = await connect()

		await expectRefused(withdraw(h, 'young', now), /13 days old/)
		expect(cancelRelationRequest).not.toHaveBeenCalled()

		const result = await withdraw(h, 'ripe', now)
		expect(result).toMatchObject({
			invitation_id: 'ripe',
			recipient_provider_id: 'ACoAA-ripe',
			withdrawn: true,
			already_withdrawn: false,
			can_reinvite_after: new Date(+now + 21 * DAY).toISOString(),
		})
		expect(cancelRelationRequest).toHaveBeenCalledTimes(1)
		expect(cancelRelationRequest).toHaveBeenCalledWith({
			account_id: h.accountId,
			request_id: 'ripe',
		})
	})

	it('refuses an invitation with no date when the list never showed it before, and notes it', async () => {
		const now = new Date()
		const { client, cancelRelationRequest } = stubClient([sentRow('undated', undefined)])
		__setLinkedInClientForTests(() => client)
		const h = await connect()

		await expectRefused(withdraw(h, 'undated', now), /no send date/)

		expect(cancelRelationRequest).not.toHaveBeenCalled()
		const seen = await rowsFor(h.integrationId, FIRST_SEEN_TOOL)
		expect(seen).toHaveLength(1)
		expect(seen[0]).toMatchObject({ refId: 'undated', outcome: 'ok' })
	})

	it('counts the age of an undated invitation from the first time our list showed it', async () => {
		const now = new Date()
		const { client, cancelRelationRequest } = stubClient([sentRow('undated', undefined)])
		__setLinkedInClientForTests(() => client)
		const h = await connect()
		await db.insert(linkedinActions).values({
			workspaceId: h.workspaceId,
			integrationId: h.integrationId,
			actorId: h.actorId,
			tool: FIRST_SEEN_TOOL,
			kind: 'read',
			targetProviderId: 'ACoAA-undated',
			refId: 'undated',
			outcome: 'ok',
			createdAt: new Date(+now - 15 * DAY),
		})

		const result = await withdraw(h, 'undated', now)

		expect(result).toMatchObject({ withdrawn: true, already_withdrawn: false })
		expect(cancelRelationRequest).toHaveBeenCalledTimes(1)
	})

	it('keeps the first-seen time when later lists show the same invitation again', async () => {
		const now = new Date()
		const { client } = stubClient([sentRow('undated', undefined)])
		__setLinkedInClientForTests(() => client)
		const h = await connect()

		for (let i = 0; i < 2; i++) {
			await h.mcp.callTool({ name: toolName(h.cfg, 'list_sent_invitations'), arguments: {} })
		}

		expect(await rowsFor(h.integrationId, FIRST_SEEN_TOOL)).toHaveLength(1)
		expect(await rowsFor(h.integrationId, 'list_sent_invitations')).toHaveLength(2)
		await expectRefused(withdraw(h, 'undated', now), /days old/)
	})

	it('writes no first-seen row for an invitation that has a date', async () => {
		const { client } = stubClient([sentRow('dated', new Date(Date.now() - 20 * DAY))])
		__setLinkedInClientForTests(() => client)
		const h = await connect()

		await h.mcp.callTool({ name: toolName(h.cfg, 'list_sent_invitations'), arguments: {} })

		expect(await rowsFor(h.integrationId, FIRST_SEEN_TOOL)).toHaveLength(0)
	})
})

describe('withdraw_invitation: dedupe and the daily cap', () => {
	it('returns already_withdrawn without calling Unipile the second time, and logs it as noop', async () => {
		const now = new Date()
		const { client, cancelRelationRequest, listRelationRequests } = stubClient([
			sentRow('inv-1', new Date(+now - 20 * DAY)),
		])
		__setLinkedInClientForTests(() => client)
		const h = await connect()

		await withdraw(h, 'inv-1', now)
		cancelRelationRequest.mockClear()
		listRelationRequests.mockClear()
		const second = await withdraw(h, 'inv-1', now)

		expect(second).toMatchObject({
			invitation_id: 'inv-1',
			recipient_provider_id: 'ACoAA-inv-1',
			withdrawn: true,
			already_withdrawn: true,
		})
		expect(cancelRelationRequest).not.toHaveBeenCalled()
		expect(listRelationRequests).not.toHaveBeenCalled()
		const outcomes = (await rowsFor(h.integrationId, 'withdraw_invitation')).map((r) => r.outcome)
		expect(outcomes.sort()).toEqual(['noop', 'ok'])
	})

	it('treats a 404 from cancel as already withdrawn, logged as noop', async () => {
		const now = new Date()
		const { client, cancelRelationRequest } = stubClient([
			sentRow('gone', new Date(+now - 20 * DAY)),
		])
		cancelRelationRequest.mockResolvedValueOnce({ status: 404, body: {}, headers: {} })
		__setLinkedInClientForTests(() => client)
		const h = await connect()

		const result = await withdraw(h, 'gone', now)

		expect(result).toMatchObject({ withdrawn: true, already_withdrawn: true })
		const [row] = await rowsFor(h.integrationId, 'withdraw_invitation')
		expect(row?.outcome).toBe('noop')
	})

	it('refuses the 31st withdrawal in a day with nothing sent', async () => {
		const now = new Date()
		const { client, cancelRelationRequest, listRelationRequests } = stubClient([
			sentRow('inv-31', new Date(+now - 20 * DAY)),
		])
		__setLinkedInClientForTests(() => client)
		const h = await connect()
		await db.insert(linkedinActions).values(
			Array.from({ length: 30 }, (_, i) => ({
				workspaceId: h.workspaceId,
				integrationId: h.integrationId,
				actorId: h.actorId,
				tool: 'withdraw_invitation',
				kind: 'write',
				refId: `earlier-${i}`,
				outcome: 'ok',
			})),
		)

		const err = await withdraw(h, 'inv-31', now).then(
			() => null,
			(e: unknown) => e,
		)

		expect(err).toBeInstanceOf(LinkedInActionRefusal)
		expect((err as LinkedInActionRefusal).code).toBe('RATE_LIMITED_LINKEDIN')
		expect(cancelRelationRequest).not.toHaveBeenCalled()
		expect(listRelationRequests).not.toHaveBeenCalled()
	})

	it('does not count an already-withdrawn call against the cap', async () => {
		const now = new Date()
		const { client } = stubClient([sentRow('inv-1', new Date(+now - 20 * DAY))])
		__setLinkedInClientForTests(() => client)
		const h = await connect()

		await withdraw(h, 'inv-1', now)
		await withdraw(h, 'inv-1', now)
		await withdraw(h, 'inv-1', now)

		const counted = (await rowsFor(h.integrationId, 'withdraw_invitation')).filter(
			(r) => r.outcome === 'ok' || r.outcome === 'pending',
		)
		expect(counted).toHaveLength(1)
	})
})

describe('withdraw_invitation: the tool', () => {
	it('withdraws through the tool and logs one ok row with the person and the invitation', async () => {
		const { client, cancelRelationRequest } = stubClient([
			sentRow('inv-tool', new Date(Date.now() - 30 * DAY)),
		])
		__setLinkedInClientForTests(() => client)
		const h = await connect()

		const { tools } = await h.mcp.listTools()
		expect(tools.map((t) => t.name)).toContain(toolName(h.cfg, 'withdraw_invitation'))
		const result = await h.mcp.callTool({
			name: toolName(h.cfg, 'withdraw_invitation'),
			arguments: { invitation_id: 'inv-tool' },
		})

		expect(result.isError).toBeFalsy()
		expect(JSON.parse(textOf(result))).toMatchObject({
			invitation_id: 'inv-tool',
			recipient_provider_id: 'ACoAA-inv-tool',
			withdrawn: true,
			already_withdrawn: false,
		})
		expect(cancelRelationRequest).toHaveBeenCalledTimes(1)
		const [row] = await rowsFor(h.integrationId, 'withdraw_invitation')
		expect(row).toMatchObject({
			kind: 'write',
			outcome: 'ok',
			refId: 'inv-tool',
			targetProviderId: 'ACoAA-inv-tool',
		})
	})

	it('tells the agent why a refused call was refused, and logs it as refused_rule, not error', async () => {
		const { client, cancelRelationRequest } = stubClient([
			sentRow('fresh', new Date(Date.now() - 2 * DAY)),
		])
		__setLinkedInClientForTests(() => client)
		const h = await connect()

		const result = await h.mcp.callTool({
			name: toolName(h.cfg, 'withdraw_invitation'),
			arguments: { invitation_id: 'fresh' },
		})

		expect(result.isError).toBe(true)
		expect(textOf(result)).toContain('INVALID_INPUT')
		expect(textOf(result)).toContain('at least 14 days old')
		expect(cancelRelationRequest).not.toHaveBeenCalled()
		const [row] = await rowsFor(h.integrationId, 'withdraw_invitation')
		expect(row?.outcome).toBe('refused_rule')
	})
})

describe('send_connection_request after a withdrawal', () => {
	async function withdrawnPerson(h: Harness, createdAt: Date) {
		await db.insert(linkedinActions).values({
			workspaceId: h.workspaceId,
			integrationId: h.integrationId,
			actorId: h.actorId,
			tool: 'withdraw_invitation',
			kind: 'write',
			targetProviderId: 'ACoAA-withdrawn',
			refId: 'inv-old',
			outcome: 'ok',
			createdAt,
		})
	}

	it('refuses a person whose invitation was withdrawn 20 days ago, with nothing sent', async () => {
		const { client, sendConnectionRequest } = stubClient([])
		__setLinkedInClientForTests(() => client)
		const h = await connect()
		await withdrawnPerson(h, new Date(Date.now() - 20 * DAY))

		const result = await h.mcp.callTool({
			name: toolName(h.cfg, 'send_connection_request'),
			arguments: { user_id: 'ACoAA-withdrawn', message: 'Hej' },
		})

		expect(result.isError).toBe(true)
		expect(textOf(result)).toContain('INVALID_INPUT')
		expect(textOf(result)).toContain('withdrew its invitation to this person')
		expect(sendConnectionRequest).not.toHaveBeenCalled()
		const [row] = await rowsFor(h.integrationId, 'send_connection_request')
		expect(row).toMatchObject({ outcome: 'refused_rule', targetProviderId: 'ACoAA-withdrawn' })
	})

	it('lets the invitation through once 21 days have passed', async () => {
		const { client, sendConnectionRequest } = stubClient([])
		__setLinkedInClientForTests(() => client)
		const h = await connect()
		await withdrawnPerson(h, new Date(Date.now() - 22 * DAY))

		const result = await h.mcp.callTool({
			name: toolName(h.cfg, 'send_connection_request'),
			arguments: { user_id: 'ACoAA-withdrawn', message: 'Hej' },
		})

		expect(result.isError).toBeFalsy()
		expect(sendConnectionRequest).toHaveBeenCalledTimes(1)
	})

	it('does not block a different person', async () => {
		const { client, sendConnectionRequest } = stubClient([])
		__setLinkedInClientForTests(() => client)
		const h = await connect()
		await withdrawnPerson(h, new Date(Date.now() - 2 * DAY))

		const result = await h.mcp.callTool({
			name: toolName(h.cfg, 'send_connection_request'),
			arguments: { user_id: 'ACoAA-someone-else' },
		})

		expect(result.isError).toBeFalsy()
		expect(sendConnectionRequest).toHaveBeenCalledTimes(1)
	})

	it('does not block when the withdrawal was on another LinkedIn account', async () => {
		const { client, sendConnectionRequest } = stubClient([])
		__setLinkedInClientForTests(() => client)
		const h = await connect()
		const other = await connect()
		await withdrawnPerson(other, new Date(Date.now() - 2 * DAY))

		const result = await h.mcp.callTool({
			name: toolName(h.cfg, 'send_connection_request'),
			arguments: { user_id: 'ACoAA-withdrawn' },
		})

		expect(result.isError).toBeFalsy()
		expect(sendConnectionRequest).toHaveBeenCalledTimes(1)
	})
})
