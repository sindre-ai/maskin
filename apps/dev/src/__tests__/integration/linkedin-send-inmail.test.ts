import {
	INTEGRATION_STATUS_ACTIVE,
	integrations,
	linkedinActions,
	objects,
} from '@maskin/db/schema'
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
import { registerLinkedInMcpInstance } from '../../lib/integrations/providers/linkedin-unipile/mcp-server'
import {
	__setLinkedInClientForTests,
	sendLinkedInMessage,
} from '../../lib/integrations/providers/linkedin-unipile/operations'
import type { LinkedInClient } from '../../lib/integrations/providers/linkedin-unipile/unipile-client'
import { recordObjectApproval } from '../../lib/object-delivery'
import { buildObjectPreview } from '../../lib/object-preview'
import { insertObject, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

/**
 * send_inmail against real Postgres: the approval, the once-only rule, the cap and the log
 * rows only exist in the database. The LinkedIn client is our own stub, so this proves our
 * rules and what was (not) sent, never what Unipile does with the InMail key: that needs the
 * live check on a real account (credits must drop by exactly one).
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
	captureMock.mockClear()
})

const json = (status: number, body: unknown) => ({ status, body, headers: {} })

/**
 * `credits` is the classic balance on each read, in order; the last value repeats. `distance` is
 * what the recipient's profile says. `start` can be replaced to make the start-chat call fail.
 */
function stubClient(
	opts: {
		distance?: string
		credits?: Array<number | null>
		start?: () => ReturnType<typeof json>
	} = {},
) {
	const credits = [...(opts.credits ?? [15, 14])]
	const getInmailCredits = vi.fn(async () => {
		const classic = credits.length > 1 ? credits.shift() : credits[0]
		return json(200, { credits: classic === null ? {} : { classic } })
	})
	const getProfile = vi.fn(async () =>
		json(200, {
			id: 'ACoRecipient',
			display_name: 'Ada Lovelace',
			specifics: { network_distance: opts.distance ?? 'SECOND_DEGREE' },
		}),
	)
	const started = { object: 'ChatStarted', chat_id: 'chat-9', message_id: 'msg-9' }
	const sendMessage = vi.fn(
		async (_payload: Record<string, unknown>) => opts.start?.() ?? json(200, started),
	)
	const client = { getInmailCredits, getProfile, sendMessage } as unknown as LinkedInClient
	__setLinkedInClientForTests(() => client)
	return { getInmailCredits, getProfile, sendMessage }
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

async function inmailDraft(c: Connected, metadata: Record<string, unknown> = {}) {
	return insertObject(db, c.workspaceId, c.actorId, {
		type: 'task',
		content: 'Hi Ada, I read your piece on analytical engines and would value your view.',
		metadata: {
			kind: 'linkedin_inmail',
			to: 'Ada Lovelace',
			recipient_provider_id: 'ACoRecipient',
			...metadata,
		},
	})
}

async function approve(c: Connected, object: typeof objects.$inferSelect) {
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
}

const rowsFor = (integrationId: string) =>
	db.select().from(linkedinActions).where(eq(linkedinActions.integrationId, integrationId))

function sendInmail(c: Connected, objectId: string) {
	return c.mcp.callTool({
		name: toolName(c.cfg, 'send_inmail'),
		arguments: { object_id: objectId },
	})
}

function text(result: Awaited<ReturnType<typeof sendInmail>>): string {
	return (result.content as { text: string }[])[0]?.text ?? ''
}

describe('send_inmail', () => {
	it('sends the approved text as an InMail, once, and logs the credits before and after', async () => {
		const stub = stubClient({ credits: [15, 14] })
		const c = await connect()
		const object = await inmailDraft(c)
		await approve(c, object)

		const result = await sendInmail(c, object.id)

		expect(result.isError).toBeFalsy()
		expect(JSON.parse(text(result))).toMatchObject({
			message_id: 'msg-9',
			chat_id: 'chat-9',
			credits_before: 15,
			credits_after: 14,
			object: { id: object.id },
		})
		expect(stub.sendMessage).toHaveBeenCalledTimes(1)
		expect(stub.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				recipient_urn: 'ACoRecipient',
				body: object.content,
				inmail: true,
			}),
		)
		const [row] = await rowsFor(c.integrationId)
		expect(row).toMatchObject({
			tool: 'send_inmail',
			kind: 'send',
			targetProviderId: 'ACoRecipient',
			refId: 'msg-9',
			objectId: object.id,
			outcome: 'ok',
			data: { credits_before: 15, credits_after: 14 },
		})
		expect(row.approvalId).toBeTruthy()
		expect(JSON.stringify(row)).not.toContain('analytical engines')
	})

	it('refuses an InMail nobody approved, and sends nothing', async () => {
		const stub = stubClient()
		const c = await connect()
		const object = await inmailDraft(c)

		const result = await sendInmail(c, object.id)

		expect(result.isError).toBe(true)
		expect(text(result)).toContain('No person has approved')
		expect(stub.sendMessage).not.toHaveBeenCalled()
		expect(stub.getProfile).not.toHaveBeenCalled()
		expect(stub.getInmailCredits).not.toHaveBeenCalled()
	})

	it('refuses after the text is edited, until a person approves again', async () => {
		const stub = stubClient()
		const c = await connect()
		const object = await inmailDraft(c)
		await approve(c, object)
		await db
			.update(objects)
			.set({ content: 'Hi Ada, different text now.' })
			.where(eq(objects.id, object.id))

		const result = await sendInmail(c, object.id)

		expect(result.isError).toBe(true)
		expect(text(result)).toContain('No person has approved')
		expect(stub.sendMessage).not.toHaveBeenCalled()
	})

	it('refuses when the recipient is edited after approval', async () => {
		const stub = stubClient()
		const c = await connect()
		const object = await inmailDraft(c)
		await approve(c, object)
		const metadata = { ...(object.metadata as object), recipient_provider_id: 'ACoSomeoneElse' }
		await db.update(objects).set({ metadata }).where(eq(objects.id, object.id))

		const result = await sendInmail(c, object.id)

		expect(result.isError).toBe(true)
		expect(stub.sendMessage).not.toHaveBeenCalled()
	})

	it('refuses a 1st-degree connection with INVALID_INPUT and spends no credit', async () => {
		const stub = stubClient({ distance: 'FIRST_DEGREE' })
		const c = await connect()
		const object = await inmailDraft(c)
		await approve(c, object)

		const result = await sendInmail(c, object.id)

		expect(result.isError).toBe(true)
		expect(text(result)).toContain('INVALID_INPUT')
		expect(text(result)).toContain('already connected, use send_message')
		expect(stub.sendMessage).not.toHaveBeenCalled()
		const [row] = await rowsFor(c.integrationId)
		expect(row).toMatchObject({ outcome: 'refused_rule', errorCode: 'INVALID_INPUT' })
	})

	it('refuses when classic credits are at the floor of 2', async () => {
		const stub = stubClient({ credits: [2] })
		const c = await connect()
		const object = await inmailDraft(c)
		await approve(c, object)

		const result = await sendInmail(c, object.id)

		expect(result.isError).toBe(true)
		expect(text(result)).toContain('LINKEDIN_INMAIL_UNAVAILABLE')
		expect(stub.sendMessage).not.toHaveBeenCalled()
		const [row] = await rowsFor(c.integrationId)
		expect(row).toMatchObject({ outcome: 'refused_rule', errorCode: 'LINKEDIN_INMAIL_UNAVAILABLE' })
	})

	it('sends at 3 credits, the first count above the floor', async () => {
		const stub = stubClient({ credits: [3, 2] })
		const c = await connect()
		const object = await inmailDraft(c)
		await approve(c, object)

		const result = await sendInmail(c, object.id)

		expect(result.isError).toBeFalsy()
		expect(stub.sendMessage).toHaveBeenCalledTimes(1)
	})

	it('refuses when the account has no classic credits at all', async () => {
		const stub = stubClient({ credits: [null] })
		const c = await connect()
		const object = await inmailDraft(c)
		await approve(c, object)

		const result = await sendInmail(c, object.id)

		expect(result.isError).toBe(true)
		expect(text(result)).toContain('LINKEDIN_INMAIL_UNAVAILABLE')
		expect(stub.sendMessage).not.toHaveBeenCalled()
	})

	it('refuses the 6th InMail of the day with nothing sent', async () => {
		const stub = stubClient()
		const c = await connect()
		await db.insert(linkedinActions).values(
			Array.from({ length: 5 }, (_, i) => ({
				workspaceId: c.workspaceId,
				integrationId: c.integrationId,
				actorId: c.actorId,
				tool: 'send_inmail',
				kind: 'send',
				targetProviderId: `seed-${i}`,
				outcome: 'ok',
			})),
		)
		const object = await inmailDraft(c)
		await approve(c, object)

		const result = await sendInmail(c, object.id)

		expect(result.isError).toBe(true)
		expect(text(result)).toContain('RATE_LIMITED_LINKEDIN')
		expect(stub.sendMessage).not.toHaveBeenCalled()
		expect(stub.getProfile).not.toHaveBeenCalled()
	})

	it('does not send the same approval twice when the caller retries', async () => {
		const stub = stubClient({ credits: [15, 14] })
		const c = await connect()
		const object = await inmailDraft(c)
		await approve(c, object)

		const first = await sendInmail(c, object.id)
		const retry = await sendInmail(c, object.id)

		expect(first.isError).toBeFalsy()
		expect(retry.isError).toBe(true)
		expect(text(retry)).toContain('already been sent')
		expect(stub.sendMessage).toHaveBeenCalledTimes(1)
	})

	it('claims the start under one key, so a replayed start does not send twice', async () => {
		const stub = stubClient()
		const c = await connect()
		const ctx = { db, actorId: c.actorId, workspaceId: c.workspaceId }
		const input = { recipient_urn: 'ACoRecipient', body: 'Hi', idempotency_key: 'inmail-x-1' }

		const first = await sendLinkedInMessage(ctx, input, { inmail: true })
		const second = await sendLinkedInMessage(ctx, input, { inmail: true })

		expect(stub.sendMessage).toHaveBeenCalledTimes(1)
		expect(first.replayed).toBe(false)
		expect(second.replayed).toBe(true)
	})

	it('maps a 4xx on the start to LINKEDIN_INMAIL_UNAVAILABLE only when a fresh read shows the floor', async () => {
		const stub = stubClient({
			credits: [3, 2],
			start: () => json(422, { type: 'errors/invalid_parameters', detail: 'No credits' }),
		})
		const c = await connect()
		const object = await inmailDraft(c)
		await approve(c, object)

		const result = await sendInmail(c, object.id)

		expect(result.isError).toBe(true)
		expect(text(result)).toContain('LINKEDIN_INMAIL_UNAVAILABLE')
		expect(stub.sendMessage).toHaveBeenCalledTimes(1)
	})

	it('keeps the original error for a 4xx when credits are still above the floor', async () => {
		stubClient({
			credits: [15],
			start: () => json(422, { type: 'errors/invalid_parameters', detail: 'Bad recipient' }),
		})
		const c = await connect()
		const object = await inmailDraft(c)
		await approve(c, object)

		const result = await sendInmail(c, object.id)

		expect(result.isError).toBe(true)
		expect(text(result)).not.toContain('LINKEDIN_INMAIL_UNAVAILABLE')
	})

	it('only sends InMail drafts, and send_message refuses an InMail draft', async () => {
		const stub = stubClient()
		const c = await connect()
		const message = await insertObject(db, c.workspaceId, c.actorId, {
			type: 'task',
			content: 'Plain message',
			metadata: { kind: 'linkedin_message', to: 'Ada', recipient_provider_id: 'ACoRecipient' },
		})
		await approve(c, message)
		const inmail = await inmailDraft(c)
		await approve(c, inmail)

		const wrongKind = await sendInmail(c, message.id)
		const viaSendMessage = await c.mcp.callTool({
			name: toolName(c.cfg, 'send_message'),
			arguments: { object_id: inmail.id },
		})

		expect(wrongKind.isError).toBe(true)
		expect(text(wrongKind)).toContain('not an InMail draft')
		expect(viaSendMessage.isError).toBe(true)
		expect(text(viaSendMessage as never)).toContain('send_inmail')
		expect(stub.sendMessage).not.toHaveBeenCalled()
	})
})
