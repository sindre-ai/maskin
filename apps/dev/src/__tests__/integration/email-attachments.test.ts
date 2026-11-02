import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { files, integrations, objects, workspaceMembers } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encrypt } from '../../lib/crypto'
import { EMAIL_ATTACHMENT_MAX_BYTES } from '../../lib/email-attachments'
import { recordObjectApproval, withDeliveryState } from '../../lib/object-delivery'
import { buildObjectPreview } from '../../lib/object-preview'
import { insertActor, insertAgentGrant, insertObject, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

const { default: gmailRoutes } = await import('../../routes/integrations-gmail')
const { default: resendRoutes } = await import('../../routes/integrations-resend')

/**
 * Email drafts that carry files, through both send routes against real Postgres. Gmail and
 * Resend are stubbed at `fetch`; storage is an in-memory map.
 */

const fetchMock = vi.fn()
beforeEach(() => {
	vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
	fetchMock.mockReset()
	vi.unstubAllGlobals()
})

const json = (body: unknown) =>
	new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'Content-Type': 'application/json' },
	})

const blobs = new Map<string, Buffer>()
const storage = {
	get: async (key: string) => blobs.get(key) as Buffer,
	put: async (key: string, bytes: Buffer) => {
		blobs.set(key, bytes)
	},
} as unknown as StorageProvider
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(32, 7)])

function appFor(actorId: string) {
	const app = new OpenAPIHono<{
		Variables: { db: Database; actorId: string; storageProvider: StorageProvider }
	}>()
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('storageProvider', storage)
		await next()
	})
	app.route('/api/integrations/gmail', gmailRoutes as never)
	app.route('/api/integrations/resend', resendRoutes as never)
	return app
}

const post = (provider: 'gmail' | 'resend', s: Setup, objectId: string) =>
	appFor(s.agent.id).request(`/api/integrations/${provider}/send`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'X-Workspace-Id': s.workspace.id },
		body: JSON.stringify({ object_id: objectId }),
	})

async function setup(provider: 'gmail' | 'resend') {
	const human = getTestActorId()
	const workspace = await insertWorkspace(db, human)
	const mailbox = `${crypto.randomUUID()}-dev@example.com`
	const agent = await insertActor(db, {
		type: 'agent',
		...(provider === 'resend' ? { metadata: { mailbox } } : {}),
	})
	await db
		.insert(workspaceMembers)
		.values({ workspaceId: workspace.id, actorId: agent.id, role: 'member' })
	const [integration] = await db
		.insert(integrations)
		.values({
			workspaceId: workspace.id,
			provider,
			status: 'active',
			externalId: `${provider}-account`,
			credentials: encrypt(
				JSON.stringify({ accessToken: 'live-token', expiresAt: Date.now() + 3_600_000 }),
			),
			createdBy: human,
		})
		.returning()
	if (!integration) throw new Error('integration was not inserted')
	await insertAgentGrant(db, {
		workspaceId: workspace.id,
		integrationId: integration.id,
		actorId: agent.id,
		access: 'read_write',
	})
	return { human, workspace, agent, mailbox }
}
type Setup = Awaited<ReturnType<typeof setup>>

async function fileFor(
	s: Setup,
	opts: { name?: string; bytes?: Buffer; sizeBytes?: number; workspaceId?: string } = {},
) {
	const name = opts.name ?? 'receipt.pdf'
	const bytes = opts.bytes ?? PDF
	const [row] = await db
		.insert(files)
		.values({
			workspaceId: opts.workspaceId ?? s.workspace.id,
			name,
			mimeType: 'application/pdf',
			sizeBytes: opts.sizeBytes ?? bytes.length,
			storageKey: `test/${crypto.randomUUID()}`,
			createdBy: s.human,
		})
		.returning()
	if (!row) throw new Error('file was not inserted')
	blobs.set(row.storageKey, bytes)
	return row
}

async function emailWith(s: Setup, ids: unknown, opts: { approve?: boolean } = {}) {
	const object = await insertObject(db, s.workspace.id, s.agent.id, {
		type: 'task',
		status: 'todo',
		content: 'Hi Dinero,\n\nReceipt attached.',
		metadata: {
			kind: 'email',
			to: 'books@example.com',
			subject: 'Receipt',
			attachment_file_ids: ids,
		},
	})
	if (opts.approve !== false) await approve(s, object.id)
	return object
}

async function approve(s: Setup, objectId: string) {
	const [object] = await db.select().from(objects).where(eq(objects.id, objectId))
	const preview = object && buildObjectPreview(object)
	if (!object || !preview) throw new Error('not a draft')
	await recordObjectApproval(db, {
		workspaceId: s.workspace.id,
		actorId: s.human,
		objectId,
		objectType: object.type,
		preview,
		via: 'approval',
	})
}

const sentMime = () => {
	const init = fetchMock.mock.calls.at(-1)?.[1] as { body: string }
	return Buffer.from(JSON.parse(init.body).raw as string, 'base64url').toString('utf8')
}
const sentResend = () =>
	JSON.parse(String((fetchMock.mock.calls.at(-1)?.[1] as RequestInit).body)) as Record<
		string,
		unknown
	>

describe('gmail_send_email: an approved email with a file', () => {
	it('sends a multipart message that carries the file', async () => {
		const s = await setup('gmail')
		const file = await fileFor(s)
		const email = await emailWith(s, [file.id])
		fetchMock.mockResolvedValueOnce(json({ id: 'sent-1', threadId: 't1' }))

		const res = await post('gmail', s, email.id)

		expect(res.status).toBe(200)
		const mime = sentMime()
		expect(mime).toContain('multipart/mixed')
		expect(mime).toContain('filename="receipt.pdf"')
		expect(mime).toContain(PDF.toString('base64'))
	})

	it('carries a file saved from a Gmail attachment, the two steps one after the other', async () => {
		const s = await setup('gmail')
		fetchMock
			.mockResolvedValueOnce(
				json({
					payload: {
						mimeType: 'multipart/mixed',
						parts: [
							{
								mimeType: 'application/pdf',
								filename: 'receipt.pdf',
								body: { attachmentId: 'ATT-1', size: PDF.length },
							},
						],
					},
				}),
			)
			.mockResolvedValueOnce(json({ size: PDF.length, data: PDF.toString('base64url') }))
		const saved = await appFor(s.agent.id).request('/api/integrations/gmail/save-attachment', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'X-Workspace-Id': s.workspace.id },
			body: JSON.stringify({ message_id: 'msg1', attachment_id: 'ATT-1' }),
		})
		expect(saved.status).toBe(201)
		const { file_id } = (await saved.json()) as { file_id: string }

		const email = await emailWith(s, [file_id])
		fetchMock.mockResolvedValueOnce(json({ id: 'sent-1', threadId: 't1' }))
		const res = await post('gmail', s, email.id)

		expect(res.status).toBe(200)
		const mime = sentMime()
		expect(mime).toContain('filename="receipt.pdf"')
		expect(mime).toContain(PDF.toString('base64'))
	})

	it('refuses, sends nothing and keeps the approval when the file changed after it', async () => {
		const s = await setup('gmail')
		const file = await fileFor(s)
		const email = await emailWith(s, [file.id])
		await db
			.update(files)
			.set({ updatedAt: new Date(Date.now() + 60_000) })
			.where(eq(files.id, file.id))

		const res = await post('gmail', s, email.id)

		expect(res.status).toBe(400)
		expect(JSON.stringify(await res.json())).toContain('changed after it was approved')
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('withdraws the approval when a file is swapped on the draft', async () => {
		const s = await setup('gmail')
		const a = await fileFor(s)
		const b = await fileFor(s, { name: 'other.pdf' })
		const email = await emailWith(s, [a.id])
		await db
			.update(objects)
			.set({
				metadata: {
					kind: 'email',
					to: 'books@example.com',
					subject: 'Receipt',
					attachment_file_ids: [b.id],
				},
			})
			.where(eq(objects.id, email.id))

		const res = await post('gmail', s, email.id)

		expect(res.status).toBe(403)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it.each([
		[
			'a file from another workspace',
			async (s: Setup) => {
				const other = await setup('gmail')
				return [(await fileFor(other)).id]
			},
			'not a file in this workspace',
		],
		[
			'a file id that does not exist',
			async () => [crypto.randomUUID()],
			'not a file in this workspace',
		],
		[
			'more than 5 files',
			async (s: Setup) => {
				const ids: string[] = []
				for (let i = 0; i < 6; i++) ids.push((await fileFor(s, { name: `f${i}.pdf` })).id)
				return ids
			},
			'at most 5 files',
		],
		[
			'over 20 MB in total',
			async (s: Setup) => [
				(await fileFor(s, { sizeBytes: EMAIL_ATTACHMENT_MAX_BYTES })).id,
				(await fileFor(s, { sizeBytes: 1 })).id,
			],
			'20 MB',
		],
	])('refuses %s and sends nothing', async (_name, ids, message) => {
		const s = await setup('gmail')
		const email = await emailWith(s, await ids(s))

		const res = await post('gmail', s, email.id)

		expect(res.status).toBe(400)
		expect(JSON.stringify(await res.json())).toContain(message)
		expect(fetchMock).not.toHaveBeenCalled()
	})
})

describe('resend_send_email: an approved email with a file', () => {
	it('passes the file in the Resend attachments field', async () => {
		const s = await setup('resend')
		const file = await fileFor(s)
		const email = await emailWith(s, [file.id])
		fetchMock.mockResolvedValueOnce(json({ id: 'em_1' }))

		const res = await post('resend', s, email.id)

		expect(res.status).toBe(200)
		expect(sentResend().attachments).toEqual([
			{ filename: 'receipt.pdf', content: PDF.toString('base64'), content_type: 'application/pdf' },
		])
	})

	it('sends no attachments field for an email without files', async () => {
		const s = await setup('resend')
		const email = await emailWith(s, [])
		fetchMock.mockResolvedValueOnce(json({ id: 'em_2' }))

		expect((await post('resend', s, email.id)).status).toBe(200)
		expect(sentResend()).not.toHaveProperty('attachments')
	})

	it('refuses a file from another workspace and sends nothing', async () => {
		const s = await setup('resend')
		const other = await setup('resend')
		const email = await emailWith(s, [(await fileFor(other)).id])

		const res = await post('resend', s, email.id)

		expect(res.status).toBe(400)
		expect(fetchMock).not.toHaveBeenCalled()
	})
})

describe('the approval card', () => {
	it('shows file names while the hash stays bound to the ids', async () => {
		const s = await setup('gmail')
		const file = await fileFor(s, { name: 'kvittering.pdf' })
		const email = await emailWith(s, [file.id], { approve: false })
		const [object] = await db.select().from(objects).where(eq(objects.id, email.id))
		const base = buildObjectPreview(object as never)
		if (!base) throw new Error('no preview')

		const shown = await withDeliveryState(db, s.workspace.id, email.id, base)

		expect(shown.details).toContainEqual({ label: 'Attachments', value: 'kvittering.pdf' })
		expect(shown.content_hash).toBe(base.content_hash)
	})
})
