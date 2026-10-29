import {
	events,
	INTEGRATION_STATUS_ACTIVE,
	files,
	idempotencyRecords,
	integrations,
	objects,
} from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { encrypt } from '../../lib/crypto'
import {
	__setLinkedInClientForTests,
	sendLinkedInMessage,
} from '../../lib/integrations/providers/linkedin-unipile/operations'
import { sendApprovedLinkedInObject } from '../../lib/integrations/providers/linkedin-unipile/send-object'
import type { LinkedInClient } from '../../lib/integrations/providers/linkedin-unipile/unipile-client'
import { DELIVERED_ACTION, recordObjectApproval } from '../../lib/object-delivery'
import { buildObjectPreview } from '../../lib/object-preview'
import { insertActor, insertObject, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

/**
 * `reply` and `send_message` with an object id send the text a person approved on the card,
 * and only that (one shared path, `sendApprovedLinkedInObject`).
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
	const reply = vi.fn(async (_payload: Record<string, unknown>) => ({
		status: 200,
		body: { object: 'MessageSent', message_id: 'msg-1', chat_id: 'chat-1' },
		headers: {},
	}))
	const sendMessage = vi.fn(async (_payload: Record<string, unknown>) => ({
		status: 200,
		body: { object: 'ChatStarted', message_id: 'msg-2', chat_id: 'chat-2' },
		headers: {},
	}))
	const client = {
		sendMessage,
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
	return Object.assign(reply, { sendMessage })
}

/** A workspace file store that lives in memory, keyed the way the files table points at it. */
function fakeStorage() {
	const blobs = new Map<string, Buffer>()
	const storage = { get: async (key: string) => blobs.get(key) as Buffer } as StorageProvider
	return { blobs, storage }
}

const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(64)])
const PNG = Buffer.concat([
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
	Buffer.alloc(64),
])
const EXE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64)])

async function fileIn(
	wsId: string,
	actorId: string,
	store: ReturnType<typeof fakeStorage>,
	opts: { name: string; bytes: Buffer; sizeBytes?: number },
) {
	const [row] = await db
		.insert(files)
		.values({
			workspaceId: wsId,
			name: opts.name,
			mimeType: 'application/pdf',
			sizeBytes: opts.sizeBytes ?? opts.bytes.length,
			storageKey: `test/${wsId}/${opts.name}-${store.blobs.size}`,
			createdBy: actorId,
		})
		.returning()
	store.blobs.set(row.storageKey, opts.bytes)
	return row
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

describe('sendApprovedLinkedInObject', () => {
	it('refuses to send a draft nobody approved, and sends nothing', async () => {
		const reply = stubbedClient()
		const { ctx, object } = await setup()
		await expect(sendApprovedLinkedInObject(ctx, { object_id: object.id })).rejects.toThrow(
			/No person has approved/,
		)
		expect(reply).not.toHaveBeenCalled()
	})

	it('sends the approved text into the filed conversation and records the delivery', async () => {
		const reply = stubbedClient()
		const { ctx, ws, actorId, object } = await setup()
		await approve(ws.id, actorId, object)

		const sent = await sendApprovedLinkedInObject(ctx, { object_id: object.id })

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
		await sendApprovedLinkedInObject(ctx, { object_id: object.id })
		await expect(sendApprovedLinkedInObject(ctx, { object_id: object.id })).rejects.toThrow(
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
		await expect(sendApprovedLinkedInObject(ctx, { object_id: object.id })).rejects.toThrow(
			/No person has approved/,
		)
		expect(reply).not.toHaveBeenCalled()
	})

	it('does not count an agent saying yes', async () => {
		const reply = stubbedClient()
		const { ctx, ws, object } = await setup()
		const agent = await insertActor(db, { type: 'agent', email: null })
		await approve(ws.id, agent.id, object)
		await expect(sendApprovedLinkedInObject(ctx, { object_id: object.id })).rejects.toThrow(
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
		await expect(sendApprovedLinkedInObject(ctx, { object_id: object.id })).rejects.toThrow(
			/A conversation or a recipient is required/,
		)
		await sendApprovedLinkedInObject(ctx, { object_id: object.id, thread_id: 'thread-9' })
		expect(reply).toHaveBeenCalledWith(expect.objectContaining({ thread_id: 'thread-9' }))
	})

	it('refuses an object that is not a LinkedIn message', async () => {
		const reply = stubbedClient()
		const { ctx, object } = await setup({ metadata: { channel: 'carrier_pigeon' } })
		await expect(sendApprovedLinkedInObject(ctx, { object_id: object.id })).rejects.toThrow(
			/not a LinkedIn message/,
		)
		expect(reply).not.toHaveBeenCalled()
	})

	it('starts a chat with the filed recipient when the object has no conversation', async () => {
		const stub = stubbedClient()
		const { ctx, ws, actorId, object } = await setup({
			metadata: { kind: 'linkedin_message', to: 'Liz Benison', recipient_provider_id: 'ACoAAA1' },
		})
		await approve(ws.id, actorId, object)

		const sent = await sendApprovedLinkedInObject(ctx, { object_id: object.id })

		expect(sent.chat_id).toBe('chat-2')
		expect(stub.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ recipient_urn: 'ACoAAA1', body: object.content }),
		)
		expect(stub).not.toHaveBeenCalled()
	})

	it('claims the send under the unchanged object-{id}-{approval} key', async () => {
		stubbedClient()
		const { ctx, ws, actorId, object } = await setup()
		await approve(ws.id, actorId, object)
		await sendApprovedLinkedInObject(ctx, { object_id: object.id })
		const rows = await db.select().from(idempotencyRecords)
		expect(rows.some((r) => r.key.includes(`:object-${object.id}-`))).toBe(true)
	})
})

describe('sendApprovedLinkedInObject with a file', () => {
	async function withFile(opts: { name?: string; bytes?: Buffer; sizeBytes?: number } = {}) {
		const store = fakeStorage()
		const base = await setup()
		const file = await fileIn(base.ws.id, base.actorId, store, {
			name: opts.name ?? 'deck.pdf',
			bytes: opts.bytes ?? PDF,
			sizeBytes: opts.sizeBytes,
		})
		const object = await insertObject(db, base.ws.id, base.actorId, {
			type: 'task',
			content: 'Here is the deck we talked about.',
			metadata: {
				channel: 'linkedin_dm',
				thread_id: 'thread-42',
				to: 'Liz Benison',
				attachment_file_id: file.id,
			},
		})
		return { ...base, store, file, object, ctx: { ...base.ctx, storage: store.storage } }
	}

	it('sends exactly one file with the approved message', async () => {
		const reply = stubbedClient()
		const { ctx, ws, actorId, object } = await withFile()
		await approve(ws.id, actorId, object)

		await sendApprovedLinkedInObject(ctx, { object_id: object.id })

		expect(reply).toHaveBeenCalledTimes(1)
		const payload = reply.mock.calls[0]?.[0] as { attachments: Array<Record<string, string>> }
		expect(payload.attachments).toEqual([
			{ content: PDF.toString('base64'), content_type: 'application/pdf', filename: 'deck.pdf' },
		])
	})

	it('refuses a file nobody approved, and sends nothing', async () => {
		const reply = stubbedClient()
		const { ctx, object } = await withFile()
		await expect(sendApprovedLinkedInObject(ctx, { object_id: object.id })).rejects.toThrow(
			/No person has approved/,
		)
		expect(reply).not.toHaveBeenCalled()
	})

	it('withdraws the approval when the file is swapped for another', async () => {
		const reply = stubbedClient()
		const { ctx, ws, actorId, object, store } = await withFile()
		await approve(ws.id, actorId, object)
		const other = await fileIn(ws.id, actorId, store, { name: 'other.pdf', bytes: PDF })
		await db
			.update(objects)
			.set({ metadata: { ...(object.metadata as object), attachment_file_id: other.id } })
			.where(eq(objects.id, object.id))
		await expect(sendApprovedLinkedInObject(ctx, { object_id: object.id })).rejects.toThrow(
			/No person has approved/,
		)
		expect(reply).not.toHaveBeenCalled()
	})

	it('refuses a file that changed after the approval', async () => {
		const reply = stubbedClient()
		const { ctx, ws, actorId, object, file } = await withFile()
		await approve(ws.id, actorId, object)
		await db
			.update(files)
			.set({ updatedAt: new Date(Date.now() + 60_000) })
			.where(eq(files.id, file.id))
		await expect(sendApprovedLinkedInObject(ctx, { object_id: object.id })).rejects.toThrow(
			/changed after it was approved/,
		)
		expect(reply).not.toHaveBeenCalled()
	})

	it('types a file by its bytes: a .pdf name holding PNG bytes goes as a PNG', async () => {
		const reply = stubbedClient()
		const { ctx, ws, actorId, object } = await withFile({ name: 'report.pdf', bytes: PNG })
		await approve(ws.id, actorId, object)
		await sendApprovedLinkedInObject(ctx, { object_id: object.id })
		const payload = reply.mock.calls[0]?.[0] as { attachments: Array<Record<string, string>> }
		expect(payload.attachments[0]?.content_type).toBe('image/png')
	})

	it('refuses an .exe renamed .pdf', async () => {
		const reply = stubbedClient()
		const { ctx, ws, actorId, object } = await withFile({ name: 'invoice.pdf', bytes: EXE })
		await approve(ws.id, actorId, object)
		await expect(sendApprovedLinkedInObject(ctx, { object_id: object.id })).rejects.toThrow(
			/not a PDF, PNG or JPEG/,
		)
		expect(reply).not.toHaveBeenCalled()
	})

	it('allows 10 MB and refuses one byte more', async () => {
		const reply = stubbedClient()
		const tenMb = 10 * 1024 * 1024
		const atLimit = await withFile({
			bytes: Buffer.concat([PDF, Buffer.alloc(tenMb - PDF.length)]),
		})
		await approve(atLimit.ws.id, atLimit.actorId, atLimit.object)
		await sendApprovedLinkedInObject(atLimit.ctx, { object_id: atLimit.object.id })
		expect(reply).toHaveBeenCalledTimes(1)

		const over = await withFile({
			bytes: Buffer.concat([PDF, Buffer.alloc(tenMb + 1 - PDF.length)]),
		})
		await approve(over.ws.id, over.actorId, over.object)
		await expect(
			sendApprovedLinkedInObject(over.ctx, { object_id: over.object.id }),
		).rejects.toThrow(/over the 10 MB limit/)
		expect(reply).toHaveBeenCalledTimes(1)
	})

	it('checks the stored bytes too, not only the size on the file row', async () => {
		const reply = stubbedClient()
		const tenMb = 10 * 1024 * 1024
		const { ctx, ws, actorId, object } = await withFile({
			bytes: Buffer.concat([PDF, Buffer.alloc(tenMb + 1 - PDF.length)]),
			sizeBytes: 100,
		})
		await approve(ws.id, actorId, object)
		await expect(sendApprovedLinkedInObject(ctx, { object_id: object.id })).rejects.toThrow(
			/over the 10 MB limit/,
		)
		expect(reply).not.toHaveBeenCalled()
	})

	it('refuses a file that belongs to another workspace', async () => {
		const reply = stubbedClient()
		const { ctx, ws, actorId, object, store } = await withFile()
		const elsewhere = await insertWorkspace(db, actorId)
		const foreign = await fileIn(elsewhere.id, actorId, store, { name: 'x.pdf', bytes: PDF })
		await db
			.update(objects)
			.set({ metadata: { ...(object.metadata as object), attachment_file_id: foreign.id } })
			.where(eq(objects.id, object.id))
		const [edited] = await db.select().from(objects).where(eq(objects.id, object.id))
		await approve(ws.id, actorId, edited)
		await expect(sendApprovedLinkedInObject(ctx, { object_id: object.id })).rejects.toThrow(
			/not a file in this workspace/,
		)
		expect(reply).not.toHaveBeenCalled()
	})

	it('refuses raw attachments on the plain send, whoever calls it', async () => {
		const stub = stubbedClient()
		const { ctx } = await setup()
		await expect(
			sendLinkedInMessage(ctx, {
				recipient_urn: 'ACoAAA1',
				body: 'hi',
				idempotency_key: 'k-1',
				attachments: [{ content: 'AAAA', content_type: 'application/pdf', filename: 'a.pdf' }],
			}),
		).rejects.toThrow(/attachment_file_id/)
		expect(stub.sendMessage).not.toHaveBeenCalled()
	})
})
