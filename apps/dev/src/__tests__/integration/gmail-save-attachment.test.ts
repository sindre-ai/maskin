import { createHash } from 'node:crypto'
import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, files, integrations, workspaceMembers } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encrypt } from '../../lib/crypto'
import { GMAIL_ATTACHMENT_MAX_BYTES } from '../../lib/integrations/providers/gmail/attachment'
import { insertActor, insertAgentGrant, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

const { default: gmailRoutes } = await import('../../routes/integrations-gmail')

/**
 * The Gmail save-attachment route against real Postgres. Gmail is stubbed at `fetch`, storage
 * is an in-memory map: this proves our rules (who may read, what is stored and under whose
 * name, what is refused), not that Gmail behaves as assumed, which needs a live account.
 */

const fetchMock = vi.fn()

beforeEach(() => {
	vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
	fetchMock.mockReset()
	vi.unstubAllGlobals()
})

const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	})

const PDF = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0xff, 0x00])

const messageWithReceipt = (size = PDF.length) => ({
	payload: {
		mimeType: 'multipart/mixed',
		parts: [
			{ mimeType: 'text/plain', filename: '', body: { size: 3 } },
			{
				mimeType: 'application/pdf',
				filename: '../receipt 4711.pdf',
				body: { attachmentId: 'ATT-1', size },
			},
		],
	},
})

function appFor(actorId: string, blobs: Map<string, Buffer>) {
	const storage = {
		put: async (key: string, bytes: Buffer) => {
			blobs.set(key, bytes)
		},
	} as unknown as StorageProvider
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
	return app
}

async function setup(access: 'read' | 'read_write' | null = 'read') {
	const human = getTestActorId()
	const workspace = await insertWorkspace(db, human)
	const agent = await insertActor(db, { type: 'agent' })
	await db
		.insert(workspaceMembers)
		.values({ workspaceId: workspace.id, actorId: agent.id, role: 'member' })
	const [gmail] = await db
		.insert(integrations)
		.values({
			workspaceId: workspace.id,
			provider: 'gmail',
			status: 'active',
			externalId: 'sender@example.com',
			credentials: encrypt(
				JSON.stringify({ accessToken: 'live-token', expiresAt: Date.now() + 60 * 60 * 1000 }),
			),
			createdBy: human,
			// An agent with no grant falls back to the integration's default, so "no access" needs both.
			...(access ? {} : { defaultAgentAccess: 'none' as const }),
		})
		.returning()
	if (!gmail) throw new Error('gmail integration was not inserted')
	if (access) {
		await insertAgentGrant(db, {
			workspaceId: workspace.id,
			integrationId: gmail.id,
			actorId: agent.id,
			access,
		})
	}
	const blobs = new Map<string, Buffer>()
	const save = (body: Record<string, unknown>) =>
		appFor(agent.id, blobs).request('/api/integrations/gmail/save-attachment', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'X-Workspace-Id': workspace.id },
			body: JSON.stringify(body),
		})
	return { workspace, agent, blobs, save }
}

const REQUEST = { message_id: 'msg1', attachment_id: 'ATT-1' }

const filesOf = (workspaceId: string) =>
	db.select().from(files).where(eq(files.workspaceId, workspaceId))

describe('POST /api/integrations/gmail/save-attachment', () => {
	it('stores the attachment as a workspace file named and typed by the message part', async () => {
		const { workspace, agent, blobs, save } = await setup('read')
		fetchMock
			.mockResolvedValueOnce(json(200, messageWithReceipt()))
			.mockResolvedValueOnce(json(200, { size: PDF.length, data: PDF.toString('base64url') }))

		const res = await save(REQUEST)

		expect(res.status).toBe(201)
		const body = (await res.json()) as {
			file_id: string
			name: string
			mime_type: string
			size_bytes: number
			url: string
		}
		expect(body).toMatchObject({
			name: 'receipt 4711.pdf',
			mime_type: 'application/pdf',
			size_bytes: PDF.length,
		})
		expect(body.url).toContain(`/${workspace.id}/files/${body.file_id}`)

		// The id is a real file of this workspace, with the bytes behind it: what an email
		// draft's attachment_file_ids entry is resolved against.
		const [row] = await filesOf(workspace.id)
		expect(row).toMatchObject({
			id: body.file_id,
			name: 'receipt 4711.pdf',
			mimeType: 'application/pdf',
			sizeBytes: PDF.length,
			createdBy: agent.id,
			contentHash: createHash('sha256').update(PDF).digest('hex'),
		})
		expect(blobs.get(row?.storageKey ?? '')?.equals(PDF)).toBe(true)

		const [created] = await db
			.select()
			.from(events)
			.where(
				and(
					eq(events.workspaceId, workspace.id),
					eq(events.entityId, body.file_id),
					eq(events.action, 'created'),
				),
			)
		expect((created?.data as { source?: string } | undefined)?.source).toBe('gmail-attachment')
	})

	it('refuses an agent with no Gmail access, reading nothing from Gmail', async () => {
		const { workspace, save } = await setup(null)

		const res = await save(REQUEST)

		expect(res.status).toBe(403)
		expect(fetchMock).not.toHaveBeenCalled()
		expect(await filesOf(workspace.id)).toHaveLength(0)
	})

	it('stores nothing for a message or attachment Gmail does not have', async () => {
		const { workspace, save } = await setup('read_write')
		fetchMock.mockResolvedValueOnce(
			json(404, { error: { message: 'Requested entity was not found.' } }),
		)
		expect((await save(REQUEST)).status).toBe(404)

		const twoFiles = messageWithReceipt()
		twoFiles.payload.parts.push({
			mimeType: 'application/pdf',
			filename: 'invoice.pdf',
			body: { attachmentId: 'ATT-2', size: PDF.length },
		})
		fetchMock.mockResolvedValueOnce(json(200, twoFiles))
		expect((await save({ ...REQUEST, attachment_id: 'OTHER' })).status).toBe(404)

		expect(await filesOf(workspace.id)).toHaveLength(0)
	})

	it('refuses an attachment over 20 MB and stores nothing', async () => {
		const { workspace, blobs, save } = await setup('read')
		fetchMock.mockResolvedValueOnce(json(200, messageWithReceipt(GMAIL_ATTACHMENT_MAX_BYTES + 1)))

		const res = await save(REQUEST)

		expect(res.status).toBe(413)
		expect(await filesOf(workspace.id)).toHaveLength(0)
		expect(blobs.size).toBe(0)
	})

	it('refuses ids that could change the Gmail URL', async () => {
		const { save } = await setup('read')

		const res = await save({ message_id: '../drafts', attachment_id: 'ATT-1' })

		expect(res.status).toBe(400)
		expect(fetchMock).not.toHaveBeenCalled()
	})
})
