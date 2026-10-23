import { events, INTEGRATION_STATUS_ACTIVE, integrations, objects } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { encrypt } from '../../lib/crypto'
import { __setLinkedInClientForTests } from '../../lib/integrations/providers/linkedin-unipile/operations'
import { replyWithApprovedObject } from '../../lib/integrations/providers/linkedin-unipile/send-object'
import type { LinkedInClient } from '../../lib/integrations/providers/linkedin-unipile/unipile-client'
import { DELIVERED_ACTION, recordObjectApproval } from '../../lib/object-delivery'
import { buildObjectPreview } from '../../lib/object-preview'
import { insertActor, insertObject, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

/**
 * `reply` with an object id sends the text a person approved on the card, and only that.
 * The rules it enforces live in events (an approval is bound to a content hash, a delivery
 * closes it), so they can only be proven against real Postgres. See
 * `.claude/rules/verification.md` and `.claude/rules/live-verification.md`: the LinkedIn
 * client here is our own stub, which says nothing about what Unipile does with the call.
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

function stubbedClient() {
	const reply = vi.fn(async () => ({
		status: 200,
		body: { object: 'MessageSent', message_id: 'msg-1', chat_id: 'chat-1' },
		headers: {},
	}))
	const client = {
		sendMessage: vi.fn(),
		reply,
		listConversations: vi.fn(),
		listMessages: vi.fn(),
		listRelations: vi.fn(),
		searchPeople: vi.fn(),
		getProfile: vi.fn(),
		publishPost: vi.fn(),
		commentOnPost: vi.fn(),
		replyToComment: vi.fn(),
		readPostComments: vi.fn(),
		retrievePost: vi.fn(),
		listReactions: vi.fn(),
		countComments: vi.fn(),
	} as unknown as LinkedInClient
	__setLinkedInClientForTests(() => client)
	return reply
}

async function setup(overrides: Record<string, unknown> = {}) {
	const actorId = getTestActorId()
	const ws = await insertWorkspace(db, actorId)
	await db.insert(integrations).values({
		workspaceId: ws.id,
		provider: 'linkedin-unipile',
		status: INTEGRATION_STATUS_ACTIVE,
		credentials: encrypt(JSON.stringify({ account_id: 'mock-account-id', account_status: 'OK' })),
		actorId,
		createdBy: actorId,
	})
	// How the sales loop files a reply: no `kind`, just the channel, plus the conversation.
	const object = await insertObject(db, ws.id, actorId, {
		type: 'task',
		content: 'Thanks Liz, that is a fair answer.',
		metadata: {
			source: 'sales_conversation',
			channel: 'linkedin_dm',
			thread_id: 'thread-42',
			to: 'Liz Benison',
			reply_to: 'We have governance and culture, nobody sees everything.',
		},
		...overrides,
	})
	return { actorId, ws, object, ctx: { db, actorId, workspaceId: ws.id } }
}

async function approve(wsId: string, actorId: string, object: typeof objects.$inferSelect) {
	const preview = buildObjectPreview(object)
	if (!preview) throw new Error('not a draft')
	await recordObjectApproval(db, {
		workspaceId: wsId,
		actorId,
		objectId: object.id,
		objectType: object.type,
		preview,
		via: 'approval',
	})
}

describe('replyWithApprovedObject', () => {
	it('refuses to send a draft nobody approved, and sends nothing', async () => {
		const reply = stubbedClient()
		const { ctx, object } = await setup()
		await expect(replyWithApprovedObject(ctx, { object_id: object.id })).rejects.toThrow(
			/No person has approved/,
		)
		expect(reply).not.toHaveBeenCalled()
	})

	it('sends the approved text into the filed conversation and records the delivery', async () => {
		const reply = stubbedClient()
		const { ctx, ws, actorId, object } = await setup()
		await approve(ws.id, actorId, object)

		const sent = await replyWithApprovedObject(ctx, { object_id: object.id })

		expect(sent.message_id).toBe('msg-1')
		expect(reply).toHaveBeenCalledTimes(1)
		expect(reply).toHaveBeenCalledWith(
			expect.objectContaining({
				thread_id: 'thread-42',
				body: 'Thanks Liz, that is a fair answer.',
			}),
		)
		const delivered = await db
			.select()
			.from(events)
			.where(
				and(
					eq(events.entityId, object.id),
					eq(events.action, DELIVERED_ACTION),
					eq(events.workspaceId, ws.id),
				),
			)
		expect(delivered).toHaveLength(1)
		expect(delivered[0].data).toMatchObject({
			provider: 'linkedin-unipile',
			content_hash: buildObjectPreview(object)?.content_hash,
			thread_id: 'thread-42',
		})
	})

	it('does not send the same approval twice', async () => {
		const reply = stubbedClient()
		const { ctx, ws, actorId, object } = await setup()
		await approve(ws.id, actorId, object)
		await replyWithApprovedObject(ctx, { object_id: object.id })
		await expect(replyWithApprovedObject(ctx, { object_id: object.id })).rejects.toThrow(
			/already been sent/,
		)
		expect(reply).toHaveBeenCalledTimes(1)
	})

	it('withdraws the approval when the text is edited afterwards', async () => {
		const reply = stubbedClient()
		const { ctx, ws, actorId, object } = await setup()
		await approve(ws.id, actorId, object)
		await db
			.update(objects)
			.set({ content: 'Thanks Liz, different text now.' })
			.where(eq(objects.id, object.id))
		await expect(replyWithApprovedObject(ctx, { object_id: object.id })).rejects.toThrow(
			/No person has approved/,
		)
		expect(reply).not.toHaveBeenCalled()
	})

	it('does not count an agent saying yes', async () => {
		const reply = stubbedClient()
		const { ctx, ws, object } = await setup()
		const agent = await insertActor(db, { type: 'agent', email: null })
		await approve(ws.id, agent.id, object)
		await expect(replyWithApprovedObject(ctx, { object_id: object.id })).rejects.toThrow(
			/No person has approved/,
		)
		expect(reply).not.toHaveBeenCalled()
	})

	it('needs a conversation, from the object or the caller', async () => {
		const reply = stubbedClient()
		const { ctx, ws, actorId, object } = await setup({
			metadata: { channel: 'linkedin_dm', to: 'Liz Benison' },
		})
		await approve(ws.id, actorId, object)
		await expect(replyWithApprovedObject(ctx, { object_id: object.id })).rejects.toThrow(
			/thread_id is required/,
		)
		await replyWithApprovedObject(ctx, { object_id: object.id, thread_id: 'thread-9' })
		expect(reply).toHaveBeenCalledWith(expect.objectContaining({ thread_id: 'thread-9' }))
	})

	it('refuses an object that is not a LinkedIn message', async () => {
		const reply = stubbedClient()
		const { ctx, object } = await setup({ metadata: { channel: 'carrier_pigeon' } })
		await expect(replyWithApprovedObject(ctx, { object_id: object.id })).rejects.toThrow(
			/not a LinkedIn message/,
		)
		expect(reply).not.toHaveBeenCalled()
	})
})
