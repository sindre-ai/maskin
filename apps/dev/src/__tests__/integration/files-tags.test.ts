import { OpenAPIHono } from '@hono/zod-openapi'
import { events, fileUploads, files } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { insertWorkspace } from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

const { default: filesRoutes } = await import('../../routes/files')

// Tags are a plain list on the file: set at upload or later, filtered "has all" or "has any",
// counted per workspace, and shown on every row of the list.
const LARGE_BYTES = 897 * 1024 * 1024

function createApp() {
	const bytes = new Map<string, Buffer>()
	const app = new OpenAPIHono()
	app.use('*', async (c, next) => {
		c.set('db' as never, db as never)
		c.set('actorId' as never, getTestActorId() as never)
		c.set('workspaceRole' as never, 'owner' as never)
		c.set(
			'storageProvider' as never,
			{
				put: async (key: string, data: Buffer) => void bytes.set(key, data),
				get: async (key: string) => bytes.get(key) ?? Buffer.alloc(0),
				createMultipartUpload: async () => 's3-upload-id',
				presignUploadPart: async (key: string, _id: string, part: number) =>
					`http://storage.test/${key}?part=${part}`,
				completeMultipartUpload: async () => {},
				headObject: async () => ({ size: LARGE_BYTES }),
				presignDownload: async (key: string) => `http://storage.test/${key}?download`,
			} as never,
		)
		await next()
	})
	app.route('/api/files', filesRoutes as never)
	return app
}

type Row = { id: string; name: string; tags: string[] }

describe('files.tags', () => {
	let workspaceId: string
	let app: ReturnType<typeof createApp>

	beforeEach(async () => {
		workspaceId = (await insertWorkspace(db, getTestActorId())).id
		app = createApp()
	})

	const headers = (ws = workspaceId) => ({ 'X-Workspace-Id': ws })
	const create = async (name: string, tags?: string[], ws = workspaceId) => {
		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/files',
				{
					name,
					mime_type: 'text/plain',
					content: 'x',
					...(tags ? { tags } : {}),
				},
				headers(ws),
			),
		)
		expect(res.status).toBe(201)
		return (await res.json()) as Row
	}
	const list = async (query = '', ws = workspaceId) => {
		const res = await app.request(jsonGet(`/api/files${query}`, headers(ws)))
		expect(res.status).toBe(200)
		return (await res.json()) as Row[]
	}
	const names = (rows: Row[]) => rows.map((r) => r.name).sort()

	it('stores tags on create, trimmed, lowercased and without repeats', async () => {
		const created = await create('a.txt', ['  B-Roll ', 'b-roll', 'Clip_Type:B_Roll'])
		expect(created.tags).toEqual(['b-roll', 'clip_type:b_roll'])

		const [row] = await db.select().from(files).where(eq(files.id, created.id))
		expect(row?.tags).toEqual(['b-roll', 'clip_type:b_roll'])
	})

	it('gives a file made without tags, and every existing file, an empty list', async () => {
		const created = await create('plain.txt')
		expect(created.tags).toEqual([])
		expect((await list()).every((r) => Array.isArray(r.tags) && r.tags.length === 0)).toBe(true)
	})

	it('rejects too many tags, a long tag, a blank tag and a tag with a comma', async () => {
		const post = (tags: string[]) =>
			app.request(
				jsonRequest(
					'POST',
					'/api/files',
					{ name: 'x.txt', mime_type: 'text/plain', content: 'x', tags },
					headers(),
				),
			)
		expect((await post(Array.from({ length: 21 }, (_, i) => `t${i}`))).status).toBe(400)
		expect((await post(['x'.repeat(61)])).status).toBe(400)
		expect((await post(['   '])).status).toBe(400)
		expect((await post(['a,b'])).status).toBe(400)
	})

	it('changes tags later, replaces the whole list, and clears it with []', async () => {
		const created = await create('later.txt', ['raw'])
		const patch = (tags: string[]) =>
			app.request(jsonRequest('PATCH', `/api/files/${created.id}`, { tags }, headers()))

		const replaced = (await (await patch(['Interview', 'b-roll'])).json()) as Row
		expect(replaced.tags).toEqual(['interview', 'b-roll'])

		const cleared = (await (await patch([])).json()) as Row
		expect(cleared.tags).toEqual([])
	})

	it('leaves the tags alone when an update does not mention them', async () => {
		const created = await create('keep.txt', ['raw'])
		const res = await app.request(
			jsonRequest('PATCH', `/api/files/${created.id}`, { description: 'notes' }, headers()),
		)
		expect(((await res.json()) as Row).tags).toEqual(['raw'])
	})

	it('filters by several tags: all by default, any on request', async () => {
		await create('both.txt', ['b-roll', 'raw'])
		await create('broll-only.txt', ['b-roll'])
		await create('raw-only.txt', ['raw'])
		await create('none.txt')

		expect(names(await list('?tags=b-roll,raw'))).toEqual(['both.txt'])
		expect(names(await list('?tags=b-roll,raw&tags_match=all'))).toEqual(['both.txt'])
		expect(names(await list('?tags=b-roll,raw&tags_match=any'))).toEqual([
			'both.txt',
			'broll-only.txt',
			'raw-only.txt',
		])
		expect(names(await list('?tags=b-roll'))).toEqual(['both.txt', 'broll-only.txt'])
		expect(await list('?tags=missing')).toEqual([])
	})

	it('reads the filter the way tags are written: B-Roll matches b-roll', async () => {
		await create('a.txt', ['b-roll'])
		expect(names(await list('?tags=%20B-ROLL%20'))).toEqual(['a.txt'])
	})

	it('shows each file’s tags in the list', async () => {
		await create('tagged.txt', ['raw', 'b-roll'])
		const [row] = await list()
		expect(row?.tags).toEqual(['raw', 'b-roll'])
	})

	it('combines the tag filter with the name search', async () => {
		await create('clip-1.txt', ['raw'])
		await create('clip-2.txt', ['final'])
		await create('notes.txt', ['raw'])
		expect(names(await list('?q=clip&tags=raw'))).toEqual(['clip-1.txt'])
	})

	it('counts the tags in use, most used first, and only in this workspace', async () => {
		await create('a.txt', ['b-roll', 'raw'])
		await create('b.txt', ['b-roll'])
		await create('c.txt', ['b-roll', 'interview'])
		const other = (await insertWorkspace(db, getTestActorId())).id
		await create('theirs.txt', ['b-roll', 'secret'], other)

		const res = await app.request(jsonGet('/api/files/tags', headers()))
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([
			{ tag: 'b-roll', count: 3 },
			{ tag: 'interview', count: 1 },
			{ tag: 'raw', count: 1 },
		])

		const empty = (await insertWorkspace(db, getTestActorId())).id
		expect(await (await app.request(jsonGet('/api/files/tags', headers(empty)))).json()).toEqual([])
	})

	it('does not list another workspace’s files when filtering by tag', async () => {
		await create('mine.txt', ['b-roll'])
		const other = (await insertWorkspace(db, getTestActorId())).id
		expect(await list('?tags=b-roll', other)).toEqual([])
	})

	it('takes tags at the start of a large upload and gives them to the finished file', async () => {
		const start = await app.request(
			jsonRequest(
				'POST',
				'/api/files/uploads',
				{
					name: 'IMG_9992.MOV',
					mime_type: 'video/quicktime',
					size_bytes: LARGE_BYTES,
					tags: ['Raw', 'phone'],
				},
				headers(),
			),
		)
		expect(start.status).toBe(201)
		const session = (await start.json()) as {
			upload_id: string
			file_id: string
			parts: Array<{ part_number: number }>
		}
		const [upload] = await db
			.select()
			.from(fileUploads)
			.where(eq(fileUploads.fileId, session.file_id))
		expect(upload?.tags).toEqual(['raw', 'phone'])

		const done = await app.request(
			jsonRequest(
				'POST',
				`/api/files/uploads/${session.upload_id}/complete`,
				{ parts: session.parts.map((p) => ({ part_number: p.part_number, etag: 'etag' })) },
				headers(),
			),
		)
		expect(done.status).toBe(201)
		expect(((await done.json()) as Row).tags).toEqual(['raw', 'phone'])
		expect(names(await list('?tags=raw,phone'))).toEqual(['IMG_9992.MOV'])
	})

	// A video attached to a chat is uploaded through the same routes and ends up as an ordinary
	// row in `files`, so the list, the tag filter and the tag count all reach it.
	it('lists, tags and finds a large file that arrived as a chat attachment', async () => {
		const [attachment] = await db
			.insert(files)
			.values({
				workspaceId,
				name: 'IMG_9992.MOV',
				mimeType: 'video/quicktime',
				sizeBytes: LARGE_BYTES,
				storageKey: `files/${workspaceId}/chat-attachment`,
				contentHash: null,
				createdBy: getTestActorId(),
			})
			.returning()
		// Newer files push it out of the first page of an unfiltered list.
		for (let i = 0; i < 3; i++) await create(`newer-${i}.txt`)

		expect(names(await list('?limit=3'))).not.toContain('IMG_9992.MOV')

		const tagged = await app.request(
			jsonRequest(
				'PATCH',
				`/api/files/${attachment?.id}`,
				{ tags: ['raw', 'clip_type:b_roll'] },
				headers(),
			),
		)
		expect(tagged.status).toBe(200)

		expect(names(await list('?limit=3&tags=raw'))).toEqual(['IMG_9992.MOV'])
		const counts = (await (
			await app.request(jsonGet('/api/files/tags', headers()))
		).json()) as Array<{
			tag: string
		}>
		expect(counts.map((c) => c.tag).sort()).toEqual(['clip_type:b_roll', 'raw'])
	})
})

// Rename and merge change one tag on every file in the workspace in one transaction.
describe('files.tags rename and merge', () => {
	let workspaceId: string
	let app: ReturnType<typeof createApp>

	beforeEach(async () => {
		workspaceId = (await insertWorkspace(db, getTestActorId())).id
		app = createApp()
	})

	const headers = (ws = workspaceId) => ({ 'X-Workspace-Id': ws })
	const create = async (name: string, tags: string[], ws = workspaceId) => {
		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/files',
				{ name, mime_type: 'text/plain', content: 'x', tags },
				headers(ws),
			),
		)
		expect(res.status).toBe(201)
		return (await res.json()) as Row
	}
	const post = (path: 'rename' | 'merge', body: Record<string, string>, ws = workspaceId) =>
		app.request(jsonRequest('POST', `/api/files/tags/${path}`, body, headers(ws)))
	const tagsOf = async (id: string) => {
		const [row] = await db.select().from(files).where(eq(files.id, id))
		return row?.tags
	}
	const tagCounts = async (ws = workspaceId) => {
		const res = await app.request(jsonGet('/api/files/tags', headers(ws)))
		return (await res.json()) as Array<{ tag: string; count: number }>
	}
	const auditEvents = async () => {
		const rows = await db.select().from(events).where(eq(events.workspaceId, workspaceId))
		return rows.filter((e) => e.action.startsWith('file_tag'))
	}

	it('renames a tag on every file that carries it, keeping the other tags in order', async () => {
		const a = await create('a.txt', ['raw', 'broll', 'final'])
		const b = await create('b.txt', ['broll'])
		const c = await create('c.txt', ['raw'])

		const res = await post('rename', { from: ' BRoll ', to: 'B-Roll' })

		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ from: 'broll', to: 'b-roll', files_changed: 2 })
		expect(await tagsOf(a.id)).toEqual(['raw', 'b-roll', 'final'])
		expect(await tagsOf(b.id)).toEqual(['b-roll'])
		expect(await tagsOf(c.id)).toEqual(['raw'])
		expect(await tagCounts()).toEqual([
			{ tag: 'b-roll', count: 2 },
			{ tag: 'raw', count: 2 },
			{ tag: 'final', count: 1 },
		])
	})

	it('moves updated_at on the files it changes and leaves the others alone', async () => {
		const changed = await create('a.txt', ['broll'])
		const untouched = await create('b.txt', ['raw'])
		const updatedAtOf = async (id: string) =>
			(await db.select().from(files).where(eq(files.id, id)))[0]?.updatedAt?.getTime() ?? 0
		const [changedBefore, untouchedBefore] = [
			await updatedAtOf(changed.id),
			await updatedAtOf(untouched.id),
		]
		await new Promise((r) => setTimeout(r, 20))

		await post('rename', { from: 'broll', to: 'b-roll' })

		expect(await updatedAtOf(changed.id)).toBeGreaterThan(changedBefore)
		expect(await updatedAtOf(untouched.id)).toBe(untouchedBefore)
	})

	it('refuses to rename onto a tag that already exists and changes nothing', async () => {
		const a = await create('a.txt', ['broll'])
		await create('b.txt', ['b-roll'])

		const res = await post('rename', { from: 'broll', to: 'b-roll' })

		expect(res.status).toBe(409)
		expect(await tagsOf(a.id)).toEqual(['broll'])
		expect(await auditEvents()).toEqual([])
	})

	it('merges a tag into another: files with both keep one copy, the old tag is gone', async () => {
		const onlyOld = await create('a.txt', ['broll', 'raw'])
		const both = await create('b.txt', ['b-roll', 'broll'])
		const onlyNew = await create('c.txt', ['b-roll'])

		const res = await post('merge', { from: 'broll', into: 'b-roll' })

		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ from: 'broll', to: 'b-roll', files_changed: 2 })
		expect(await tagsOf(onlyOld.id)).toEqual(['b-roll', 'raw'])
		expect(await tagsOf(both.id)).toEqual(['b-roll'])
		expect(await tagsOf(onlyNew.id)).toEqual(['b-roll'])
		const counts = await tagCounts()
		expect(counts.find((t) => t.tag === 'broll')).toBeUndefined()
		expect(counts.find((t) => t.tag === 'b-roll')?.count).toBe(3)
	})

	it('never pushes a file over the 20 tag limit: a file with 20 tags merges fine', async () => {
		const full = Array.from({ length: 20 }, (_, i) => `t${String(i).padStart(2, '0')}`)
		const a = await create('full.txt', full)

		const res = await post('merge', { from: 't00', into: 't01' })

		expect(res.status).toBe(200)
		expect((await tagsOf(a.id))?.length).toBe(19)
		expect((await tagsOf(a.id))?.filter((t) => t === 't01')).toHaveLength(1)

		// Merging into a tag the file lacks swaps one for one, still 20.
		const c = await create('full2.txt', full)
		const swap = await post('merge', { from: 't05', into: 'fresh' })
		expect(swap.status).toBe(200)
		expect((await tagsOf(c.id))?.length).toBe(20)
		expect(await tagsOf(c.id)).toContain('fresh')
	})

	it('writes one audit event per change, naming the old tag, the new tag and the count', async () => {
		await create('a.txt', ['broll'])
		await create('b.txt', ['broll'])
		await create('c.txt', ['raw'])

		await post('rename', { from: 'broll', to: 'b-roll' })
		await post('merge', { from: 'raw', into: 'b-roll' })

		const logged = await auditEvents()
		expect(logged.map((e) => [e.action, e.data])).toEqual([
			['file_tag_renamed', { from: 'broll', to: 'b-roll', files_changed: 2 }],
			['file_tags_merged', { from: 'raw', to: 'b-roll', files_changed: 1 }],
		])
		expect(logged.every((e) => e.entityType === 'workspace' && e.entityId === workspaceId)).toBe(
			true,
		)
	})

	it('answers 404 and writes nothing when no file carries the tag', async () => {
		await create('a.txt', ['raw'])

		const res = await post('merge', { from: 'missing', into: 'raw' })

		expect(res.status).toBe(404)
		expect(await auditEvents()).toEqual([])
	})

	it('rejects the same tag on both sides, a blank tag and a comma', async () => {
		await create('a.txt', ['raw'])
		expect((await post('rename', { from: 'raw', to: ' RAW ' })).status).toBe(400)
		expect((await post('merge', { from: 'raw', into: 'raw' })).status).toBe(400)
		expect((await post('rename', { from: 'raw', to: '  ' })).status).toBe(400)
		expect((await post('rename', { from: 'raw', to: 'a,b' })).status).toBe(400)
	})

	it('also fixes the tag on a large upload that has not finished', async () => {
		const start = await app.request(
			jsonRequest(
				'POST',
				'/api/files/uploads',
				{
					name: 'IMG_1.MOV',
					mime_type: 'video/quicktime',
					size_bytes: LARGE_BYTES,
					tags: ['broll'],
				},
				headers(),
			),
		)
		expect(start.status).toBe(201)
		const session = (await start.json()) as { upload_id: string }
		await create('a.txt', ['broll'])

		await post('rename', { from: 'broll', to: 'b-roll' })

		const [upload] = await db
			.select()
			.from(fileUploads)
			.where(eq(fileUploads.id, session.upload_id))
		expect(upload?.tags).toEqual(['b-roll'])
	})

	it('never touches another workspace’s files or tags', async () => {
		const other = (await insertWorkspace(db, getTestActorId())).id
		const theirs = await create('theirs.txt', ['broll'], other)
		await create('mine.txt', ['broll'])

		await post('rename', { from: 'broll', to: 'b-roll' })
		expect(await tagsOf(theirs.id)).toEqual(['broll'])
		expect(await tagCounts(other)).toEqual([{ tag: 'broll', count: 1 }])

		await post('merge', { from: 'b-roll', into: 'final' })
		expect(await tagsOf(theirs.id)).toEqual(['broll'])

		// Their workspace has no "b-roll", so asking there is a plain not-found.
		expect((await post('rename', { from: 'b-roll', to: 'x' }, other)).status).toBe(404)
		expect(await tagsOf(theirs.id)).toEqual(['broll'])
	})
})
