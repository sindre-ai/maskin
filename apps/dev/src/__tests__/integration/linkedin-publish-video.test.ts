import { createHash } from 'node:crypto'
import { INTEGRATION_STATUS_ACTIVE, files, integrations } from '@maskin/db/schema'
import type { LinkedInMcpInstanceConfig } from '@maskin/mcp/linkedin'
import type { StorageProvider } from '@maskin/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { encrypt } from '../../lib/crypto'
import {
	LINKEDIN_VIDEO_MAX_BYTES,
	sniffAttachmentType,
} from '../../lib/integrations/providers/linkedin-unipile/attachment'
import {
	__setLinkedInClientForTests,
	publishLinkedInPost,
} from '../../lib/integrations/providers/linkedin-unipile/operations'
import type { LinkedInClient } from '../../lib/integrations/providers/linkedin-unipile/unipile-client'
import { insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

/**
 * A post names its video by workspace file id; the server reads the bytes. Real Postgres
 * because the file lookup is workspace-scoped and the dedup ledger is a primary key. The
 * Unipile client is our own stub (see `.claude/rules/live-verification.md`): it proves what
 * we send, not what LinkedIn does with it. Nothing here reaches Unipile or LinkedIn.
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

const IDENTITY = {
	identityType: 'personal',
	displayName: 'Test Person',
	identitySlug: 'test-person',
} as LinkedInMcpInstanceConfig

/** The size of the video Unipile was proven to take: 51,236,272 bytes. */
const PROVEN_VIDEO_BYTES = 51_236_272

function box(brand: string, size: number): Buffer {
	const bytes = Buffer.alloc(size, 0x2a)
	bytes.writeUInt32BE(0x20, 0)
	bytes.write('ftyp', 4, 'latin1')
	bytes.write(brand, 8, 'latin1')
	return bytes
}

const PNG = Buffer.concat([
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
	Buffer.alloc(64),
])

type Attachment = { content: string; content_type: string; filename: string }

function okResponse(id: string) {
	return {
		status: 200,
		body: {
			object: 'PostPublished',
			post_id: `urn:li:share:${id}`,
			post_url: `https://www.linkedin.com/feed/update/urn:li:share:${id}`,
			published_at: '2026-11-20T10:00:00.000Z',
		},
		headers: {},
	}
}

function stubbedClient(
	impl: (payload: Record<string, unknown>) => Promise<unknown> = async () => okResponse('1'),
) {
	const publishPost = vi.fn(impl)
	__setLinkedInClientForTests(() => ({ publishPost }) as unknown as LinkedInClient)
	return publishPost
}

function fakeStorage() {
	const blobs = new Map<string, Buffer>()
	const get = vi.fn(async (key: string) => blobs.get(key) as Buffer)
	const storage = { get } as unknown as StorageProvider
	return { blobs, storage, get }
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
	const identity = {
		...IDENTITY,
		integrationId: integration.id,
		unipileAccountId: 'mock-account-id',
	} as LinkedInMcpInstanceConfig
	const store = fakeStorage()
	return {
		actorId,
		ws,
		identity,
		store,
		ctx: { db, actorId, workspaceId: ws.id, storage: store.storage, identity },
	}
}

async function fileIn(
	wsId: string,
	actorId: string,
	store: ReturnType<typeof fakeStorage>,
	name: string,
	bytes: Buffer,
	row: { sizeBytes?: number } = {},
) {
	const [created] = await db
		.insert(files)
		.values({
			workspaceId: wsId,
			name,
			mimeType: 'application/octet-stream',
			sizeBytes: row.sizeBytes ?? bytes.length,
			storageKey: `test/${wsId}/${name}-${store.blobs.size}`,
			createdBy: actorId,
		})
		.returning()
	store.blobs.set(created.storageKey, bytes)
	return created
}

const sha = (buf: Buffer) => createHash('sha256').update(buf).digest('hex')

describe('linkedin publish_post with a video file id', () => {
	it('sends a 51 MB MP4 from its file id as one video, with the bytes intact', async () => {
		const { ctx, actorId, ws, store } = await setup()
		const publishPost = stubbedClient()
		const bytes = box('isom', PROVEN_VIDEO_BYTES)
		const video = await fileIn(ws.id, actorId, store, 'launch.mp4', bytes)

		const result = await publishLinkedInPost(ctx, {
			text: 'Launch day',
			attachment_file_ids: [video.id],
		})

		expect(result.post_url).toBe('https://www.linkedin.com/feed/update/urn:li:share:1')
		expect(result.replayed).toBe(false)
		expect(publishPost).toHaveBeenCalledTimes(1)
		const payload = publishPost.mock.calls[0][0]
		const attachments = payload.attachments as Attachment[]
		expect(attachments).toHaveLength(1)
		expect(attachments[0].content_type).toBe('video/mp4')
		expect(attachments[0].filename).toBe('launch.mp4')
		// Compare a hash, not the 68 MB string, so a failure stays readable.
		expect(sha(Buffer.from(attachments[0].content, 'base64'))).toBe(sha(bytes))
		expect(payload).not.toHaveProperty('attachment_file_ids')
	})

	it('sends a MOV as QuickTime, read from its bytes and not its name', async () => {
		const { ctx, actorId, ws, store } = await setup()
		const publishPost = stubbedClient()
		const video = await fileIn(ws.id, actorId, store, 'clip.bin', box('qt  ', 4096))

		await publishLinkedInPost(ctx, { text: 'x', attachment_file_ids: [video.id] })

		const attachments = publishPost.mock.calls[0][0].attachments as Attachment[]
		expect(attachments[0].content_type).toBe('video/quicktime')
	})

	it('refuses a video over 64 MB from the file row, before reading it', async () => {
		const { ctx, actorId, ws, store } = await setup()
		const publishPost = stubbedClient()
		const video = await fileIn(ws.id, actorId, store, 'huge.mp4', box('isom', 64), {
			sizeBytes: LINKEDIN_VIDEO_MAX_BYTES + 1,
		})

		await expect(
			publishLinkedInPost(ctx, { text: 'x', attachment_file_ids: [video.id] }),
		).rejects.toThrow(/video is over the 64 MB limit/)
		expect(store.get).not.toHaveBeenCalled()
		expect(publishPost).not.toHaveBeenCalled()
	})

	it('checks the stored bytes too, not only the size on the file row', async () => {
		const { ctx, actorId, ws, store } = await setup()
		const publishPost = stubbedClient()
		const video = await fileIn(
			ws.id,
			actorId,
			store,
			'liar.mp4',
			box('isom', LINKEDIN_VIDEO_MAX_BYTES + 1),
			{ sizeBytes: 100 },
		)

		await expect(
			publishLinkedInPost(ctx, { text: 'x', attachment_file_ids: [video.id] }),
		).rejects.toThrow(/video is over the 64 MB limit/)
		expect(publishPost).not.toHaveBeenCalled()
	})

	it('keeps images at 10 MB and refuses a photo or document dressed as a video', async () => {
		const { ctx, actorId, ws, store } = await setup()
		const publishPost = stubbedClient()
		const bigImage = await fileIn(
			ws.id,
			actorId,
			store,
			'big.png',
			Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)]),
		)
		const heic = await fileIn(ws.id, actorId, store, 'photo.mp4', box('heic', 4096))
		const text = await fileIn(ws.id, actorId, store, 'notes.mp4', Buffer.from('just some text'))

		await expect(
			publishLinkedInPost(ctx, { text: 'x', attachment_file_ids: [bigImage.id] }),
		).rejects.toThrow(/image is over the 10 MB limit/)
		for (const file of [heic, text]) {
			await expect(
				publishLinkedInPost(ctx, { text: 'x', attachment_file_ids: [file.id] }),
			).rejects.toThrow(/not a PNG or JPEG image or an MP4 or MOV video/)
		}
		expect(publishPost).not.toHaveBeenCalled()
	})

	it('refuses a video mixed with images and two videos, posting nothing', async () => {
		const { ctx, actorId, ws, store } = await setup()
		const publishPost = stubbedClient()
		const video = await fileIn(ws.id, actorId, store, 'a.mp4', box('mp42', 4096))
		const video2 = await fileIn(ws.id, actorId, store, 'b.mp4', box('mp42', 4096))
		const image = await fileIn(ws.id, actorId, store, 'c.png', PNG)

		for (const ids of [
			[video.id, image.id],
			[image.id, video.id],
			[video.id, video2.id],
		]) {
			await expect(
				publishLinkedInPost(ctx, { text: 'x', attachment_file_ids: ids }),
			).rejects.toThrow(/one video, or up to 9 images, never both/)
		}
		expect(publishPost).not.toHaveBeenCalled()
	})

	it('still posts images exactly as before', async () => {
		const { ctx, actorId, ws, store } = await setup()
		const publishPost = stubbedClient()
		const image = await fileIn(ws.id, actorId, store, 'sun.png', PNG)

		await publishLinkedInPost(ctx, { text: 'Sun', attachment_file_ids: [image.id] })

		expect(publishPost.mock.calls[0][0].attachments).toEqual([
			{ content: PNG.toString('base64'), content_type: 'image/png', filename: 'sun.png' },
		])
		expect(sniffAttachmentType(PNG)).toBe('image/png')
	})
})

describe('linkedin video post duplicate guard', () => {
	it('does not post a second time when the caller asks again while the first is still running, or after it finished', async () => {
		const { ctx, actorId, ws, store } = await setup()
		let finish: () => void = () => {}
		const publishPost = stubbedClient(
			() =>
				new Promise((resolve) => {
					finish = () => resolve(okResponse('slow'))
				}),
		)
		const video = await fileIn(ws.id, actorId, store, 'slow.mp4', box('isom', 4096))
		const call = () => publishLinkedInPost(ctx, { text: 'Same', attachment_file_ids: [video.id] })

		// The agent's call is still waiting on Unipile when it asks again.
		const first = call()
		await vi.waitFor(() => expect(publishPost).toHaveBeenCalledTimes(1))
		await expect(call()).rejects.toThrow(/already in flight/)
		expect(publishPost).toHaveBeenCalledTimes(1)

		finish()
		const done = await first
		expect(done.replayed).toBe(false)

		// Asking again after it finished replays the stored post.
		const again = await call()
		expect(again.replayed).toBe(true)
		expect(again.post_id).toBe(done.post_id)
		expect(publishPost).toHaveBeenCalledTimes(1)
	})

	it('treats a different video with the same text as a different post', async () => {
		const { ctx, actorId, ws, store } = await setup()
		const publishPost = stubbedClient(async () => okResponse(String(Math.random())))
		const a = await fileIn(ws.id, actorId, store, 'a.mp4', box('isom', 4096))
		const b = await fileIn(ws.id, actorId, store, 'b.mp4', box('isom', 4096))

		const first = await publishLinkedInPost(ctx, { text: 'Same', attachment_file_ids: [a.id] })
		const other = await publishLinkedInPost(ctx, { text: 'Same', attachment_file_ids: [b.id] })

		expect(first.replayed).toBe(false)
		expect(other.replayed).toBe(false)
		expect(other.post_id).not.toBe(first.post_id)
		expect(publishPost).toHaveBeenCalledTimes(2)
	})

	it('does not retry a video post that fails on the way back', async () => {
		const { ctx, actorId, ws, store } = await setup()
		const publishPost = stubbedClient(async () => ({
			status: 504,
			body: { message: 'gateway timeout' },
			headers: {},
		}))
		const video = await fileIn(ws.id, actorId, store, 'v.mp4', box('isom', 4096))

		await expect(
			publishLinkedInPost(ctx, { text: 'x', attachment_file_ids: [video.id] }),
		).rejects.toThrow()
		expect(publishPost).toHaveBeenCalledTimes(1)
	})
})
