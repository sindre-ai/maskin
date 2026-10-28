import { INTEGRATION_STATUS_ACTIVE, files, integrations } from '@maskin/db/schema'
import type { LinkedInMcpInstanceConfig } from '@maskin/mcp/linkedin'
import { toolName } from '@maskin/mcp/linkedin'
import type { StorageProvider } from '@maskin/storage'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { encrypt } from '../../lib/crypto'
import { registerLinkedInMcpInstance } from '../../lib/integrations/providers/linkedin-unipile/mcp-server'
import {
	__setLinkedInClientForTests,
	publishLinkedInPost,
} from '../../lib/integrations/providers/linkedin-unipile/operations'
import type { LinkedInClient } from '../../lib/integrations/providers/linkedin-unipile/unipile-client'
import { insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

/**
 * A post names its images by workspace file id; the server reads the bytes. Real Postgres
 * because the file lookup is workspace-scoped and the dedup ledger is a primary key. The
 * LinkedIn client is our own stub (see `.claude/rules/live-verification.md`): it proves what
 * we send, not what LinkedIn does with it.
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

const PNG = Buffer.concat([
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
	Buffer.alloc(64),
])
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(64)])

const IDENTITY = {
	identityType: 'personal',
	displayName: 'Sebastian Krumhausen',
	identitySlug: 'sebastian-krumhausen',
} as LinkedInMcpInstanceConfig

function stubbedClient() {
	const publishPost = vi.fn(async (_payload: Record<string, unknown>) => ({
		status: 200,
		body: {
			object: 'PostPublished',
			post_id: 'urn:li:share:1',
			post_url: 'https://www.linkedin.com/feed/update/urn:li:share:1',
			published_at: '2026-10-28T10:00:00.000Z',
		},
		headers: {},
	}))
	__setLinkedInClientForTests(() => ({ publishPost }) as unknown as LinkedInClient)
	return publishPost
}

function fakeStorage() {
	const blobs = new Map<string, Buffer>()
	const storage = { get: async (key: string) => blobs.get(key) as Buffer } as StorageProvider
	return { blobs, storage }
}

async function setup() {
	const actorId = getTestActorId()
	const ws = await insertWorkspace(db, actorId)
	const [integration] = await db
		.insert(integrations)
		.values({
			workspaceId: ws.id,
			provider: 'linkedin-unipile',
			status: INTEGRATION_STATUS_ACTIVE,
			credentials: encrypt(JSON.stringify({ account_id: 'mock-account-id', account_status: 'OK' })),
			actorId,
			createdBy: actorId,
		})
		.returning()
	return { actorId, ws, integration, store: fakeStorage() }
}

async function fileIn(
	wsId: string,
	actorId: string,
	store: ReturnType<typeof fakeStorage>,
	name: string,
	bytes: Buffer,
) {
	const [row] = await db
		.insert(files)
		.values({
			workspaceId: wsId,
			name,
			mimeType: 'image/png',
			sizeBytes: bytes.length,
			storageKey: `test/${wsId}/${name}-${store.blobs.size}`,
			createdBy: actorId,
		})
		.returning()
	store.blobs.set(row.storageKey, bytes)
	return row
}

describe('linkedin publish_post with workspace file ids', () => {
	it('uploads one image from its file id and returns the post url and the posting identity', async () => {
		const { actorId, ws, store } = await setup()
		const publishPost = stubbedClient()
		const image = await fileIn(ws.id, actorId, store, 'sun.png', PNG)

		const result = await publishLinkedInPost(
			{ db, actorId, workspaceId: ws.id, storage: store.storage, identity: IDENTITY },
			{ text: 'Sun is out', attachment_file_ids: [image.id] },
		)

		expect(result.post_url).toBe('https://www.linkedin.com/feed/update/urn:li:share:1')
		expect(result.posted_as).toEqual({
			name: 'Sebastian Krumhausen',
			public_identifier: 'sebastian-krumhausen',
		})
		expect(publishPost).toHaveBeenCalledTimes(1)
		expect(publishPost.mock.calls[0][0].attachments).toEqual([
			{ content: PNG.toString('base64'), content_type: 'image/png', filename: 'sun.png' },
		])
		expect(publishPost.mock.calls[0][0]).not.toHaveProperty('attachment_file_ids')
	})

	it('refuses a file of another workspace, a PDF and a missing storage, posting nothing', async () => {
		const { actorId, ws, store } = await setup()
		const other = await insertWorkspace(db, actorId)
		const publishPost = stubbedClient()
		const foreign = await fileIn(other.id, actorId, store, 'theirs.png', PNG)
		const pdf = await fileIn(ws.id, actorId, store, 'deck.pdf', PDF)
		const ctx = { db, actorId, workspaceId: ws.id, storage: store.storage }

		await expect(
			publishLinkedInPost(ctx, { text: 'x', attachment_file_ids: [foreign.id] }),
		).rejects.toThrow(/not a file in this workspace/)
		await expect(
			publishLinkedInPost(ctx, { text: 'x', attachment_file_ids: [pdf.id] }),
		).rejects.toThrow(/not a PNG or JPEG/)
		await expect(
			publishLinkedInPost(
				{ ...ctx, storage: undefined },
				{ text: 'x', attachment_file_ids: [pdf.id] },
			),
		).rejects.toThrow(/storage is not available/)
		expect(publishPost).not.toHaveBeenCalled()
	})

	it('refuses an image over 10 MB before reading it', async () => {
		const { actorId, ws, store } = await setup()
		const publishPost = stubbedClient()
		const [big] = await db
			.insert(files)
			.values({
				workspaceId: ws.id,
				name: 'big.png',
				mimeType: 'image/png',
				sizeBytes: 11 * 1024 * 1024,
				storageKey: `test/${ws.id}/big`,
				createdBy: actorId,
			})
			.returning()

		await expect(
			publishLinkedInPost(
				{ db, actorId, workspaceId: ws.id, storage: store.storage },
				{ text: 'x', attachment_file_ids: [big.id] },
			),
		).rejects.toThrow(/over the 10 MB limit/)
		expect(publishPost).not.toHaveBeenCalled()
	})

	it('treats the same text with a different image as a different post, and a retry as a replay', async () => {
		const { actorId, ws, store } = await setup()
		const publishPost = stubbedClient()
		const a = await fileIn(ws.id, actorId, store, 'a.png', PNG)
		const b = await fileIn(ws.id, actorId, store, 'b.png', PNG)
		const ctx = { db, actorId, workspaceId: ws.id, storage: store.storage }

		const first = await publishLinkedInPost(ctx, { text: 'Same text', attachment_file_ids: [a.id] })
		const retry = await publishLinkedInPost(ctx, { text: 'Same text', attachment_file_ids: [a.id] })
		const other = await publishLinkedInPost(ctx, { text: 'Same text', attachment_file_ids: [b.id] })

		expect(first.replayed).toBe(false)
		expect(retry.replayed).toBe(true)
		expect(other.replayed).toBe(false)
		expect(publishPost).toHaveBeenCalledTimes(2)
	})
})

describe('linkedin publish_post tool with the removed raw attachments field', () => {
	it('refuses a call that still sends attachments and posts nothing', async () => {
		const { actorId, ws, integration } = await setup()
		const publishPost = stubbedClient()
		const cfg = {
			...IDENTITY,
			unipileAccSlug: 'test-acc',
			identityUrn: 'urn:li:person:test',
			workspaceId: ws.id,
			actorId,
			integrationId: integration.id,
			unipileAccountId: 'mock-account-id',
		} as LinkedInMcpInstanceConfig
		const server = new McpServer({ name: 'test', version: '1.0.0' })
		registerLinkedInMcpInstance(server, cfg, { db, actorId, workspaceId: ws.id })
		const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
		await server.connect(serverSide)
		const mcp = new Client({ name: 'test-client', version: '1.0.0' })
		await mcp.connect(clientSide)

		const result = await mcp.callTool({
			name: toolName(cfg, 'publish_post'),
			arguments: {
				text: 'Sun is out',
				attachments: [{ content: 'AAAA', content_type: 'image/png', filename: 'sun.png' }],
			},
		})

		const text = (result.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('')
		expect(result.isError).toBe(true)
		expect(text).toContain('INVALID_INPUT')
		expect(text).toContain('attachment_file_ids')
		expect(publishPost).not.toHaveBeenCalled()
	})
})
