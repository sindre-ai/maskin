import { OpenAPIHono } from '@hono/zod-openapi'
import { fileUploads, files, workspaces } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

const { default: filesRoutes } = await import('../../routes/files')

const MiB = 1024 * 1024
const GiB = 1024 * MiB

// Stands in for S3: tracks multipart state so the route's real DB writes can be
// exercised end to end without a bucket.
function createStorage() {
	const objects = new Map<string, number>()
	const open = new Map<string, { key: string; parts: number }>()
	let declared = 0
	return {
		objects,
		open,
		/** What the "browser" uploaded, when it differs from what was declared. */
		setUploadedSize(size: number) {
			declared = size
		},
		async createMultipartUpload(key: string) {
			const id = `mpu-${open.size + 1}`
			open.set(id, { key, parts: 0 })
			return id
		},
		async presignUploadPart(_key: string, _id: string, part: number) {
			return `https://storage.test/part/${part}`
		},
		async completeMultipartUpload(key: string, id: string) {
			if (!open.has(id)) throw new Error('NoSuchUpload')
			open.delete(id)
			objects.set(key, declared)
		},
		async abortMultipartUpload(_key: string, id: string) {
			open.delete(id)
		},
		async headObject(key: string) {
			const size = objects.get(key)
			return size === undefined ? null : { size }
		},
		async presignDownload(key: string) {
			return `https://storage.test/download/${key}`
		},
		async delete(key: string) {
			objects.delete(key)
		},
	}
}

function createApp(storage: ReturnType<typeof createStorage>) {
	const app = new OpenAPIHono()
	app.use('*', async (c, next) => {
		c.set('db' as never, db as never)
		c.set('actorId' as never, getTestActorId() as never)
		c.set('workspaceRole' as never, 'owner' as never)
		c.set('storageProvider' as never, storage as never)
		await next()
	})
	app.route('/api/files', filesRoutes as never)
	return app
}

describe('large file uploads', () => {
	let workspaceId: string

	beforeEach(async () => {
		workspaceId = (await insertWorkspace(db, getTestActorId())).id
	})

	const headers = () => ({ 'X-Workspace-Id': workspaceId })
	const start = (app: ReturnType<typeof createApp>, size: number) =>
		app.request(
			jsonRequest(
				'POST',
				'/api/files/uploads',
				{ name: 'clip.mp4', mime_type: 'video/mp4', size_bytes: size },
				headers(),
			),
		)
	const complete = (app: ReturnType<typeof createApp>, uploadId: string, parts: number) =>
		app.request(
			jsonRequest(
				'POST',
				`/api/files/uploads/${uploadId}/complete`,
				{
					parts: Array.from({ length: parts }, (_, i) => ({
						part_number: i + 1,
						etag: `"e${i + 1}"`,
					})),
				},
				headers(),
			),
		)

	it('turns a finished upload into a file with the stored size and no hash', async () => {
		const storage = createStorage()
		const app = createApp(storage)
		storage.setUploadedSize(100 * MiB)
		const started = await (await start(app, 100 * MiB)).json()

		const res = await complete(app, started.upload_id, started.parts.length)

		expect(res.status).toBe(201)
		const [row] = await db.select().from(files).where(eq(files.id, started.file_id))
		expect(row?.sizeBytes).toBe(100 * MiB)
		expect(row?.contentHash).toBeNull()
		const [upload] = await db
			.select()
			.from(fileUploads)
			.where(eq(fileUploads.id, started.upload_id))
		expect(upload?.status).toBe('completed')
	})

	it('creates no file when the stored size differs from the declared size', async () => {
		const storage = createStorage()
		const app = createApp(storage)
		storage.setUploadedSize(100 * MiB - 1)
		const started = await (await start(app, 100 * MiB)).json()

		const res = await complete(app, started.upload_id, started.parts.length)

		expect(res.status).toBe(400)
		expect(await db.select().from(files).where(eq(files.id, started.file_id))).toHaveLength(0)
		const [upload] = await db
			.select()
			.from(fileUploads)
			.where(eq(fileUploads.id, started.upload_id))
		expect(upload?.status).toBe('aborted')
		expect(storage.objects.size).toBe(0)
	})

	it('lets only one of two concurrent completes win the claim', async () => {
		const storage = createStorage()
		const app = createApp(storage)
		storage.setUploadedSize(100 * MiB)
		const started = await (await start(app, 100 * MiB)).json()

		const results = await Promise.all([
			complete(app, started.upload_id, started.parts.length),
			complete(app, started.upload_id, started.parts.length),
		])

		const statuses = results.map((r) => r.status).sort()
		// One creates the file; the other is either refused while the first runs
		// (409) or, if it arrives after, handed the file that already exists (201).
		expect(statuses).toContain(201)
		expect(await db.select().from(files).where(eq(files.id, started.file_id))).toHaveLength(1)
	})

	it('stores sizes beyond the 2 GiB an integer column holds', async () => {
		const [row] = await db
			.insert(files)
			.values({
				workspaceId,
				name: 'big.bin',
				mimeType: 'application/octet-stream',
				sizeBytes: 5 * GiB,
				storageKey: `workspaces/${workspaceId}/files/big`,
				createdBy: getTestActorId(),
			})
			.returning()

		expect(row?.sizeBytes).toBe(5 * GiB)
	})

	it('refuses a second upload row for the same file id', async () => {
		const storage = createStorage()
		const started = await (await start(createApp(storage), 100 * MiB)).json()
		const [existing] = await db
			.select()
			.from(fileUploads)
			.where(eq(fileUploads.id, started.upload_id))
		if (!existing) throw new Error('upload row missing')
		const { id: _id, ...copy } = existing

		await expect(db.insert(fileUploads).values(copy)).rejects.toThrow()
	})

	it('refuses an unknown upload status', async () => {
		const storage = createStorage()
		const started = await (await start(createApp(storage), 100 * MiB)).json()

		await expect(
			db
				.update(fileUploads)
				.set({ status: 'half-done' })
				.where(eq(fileUploads.id, started.upload_id)),
		).rejects.toThrow()
	})

	it('removes upload rows with their workspace', async () => {
		const storage = createStorage()
		const started = await (await start(createApp(storage), 100 * MiB)).json()

		await db.delete(workspaces).where(eq(workspaces.id, workspaceId))

		expect(
			await db.select().from(fileUploads).where(eq(fileUploads.id, started.upload_id)),
		).toHaveLength(0)
	})
})
