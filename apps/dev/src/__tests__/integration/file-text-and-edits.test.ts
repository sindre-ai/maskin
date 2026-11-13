import { randomUUID } from 'node:crypto'
import { OpenAPIHono } from '@hono/zod-openapi'
import { events, files, relationships } from '@maskin/db/schema'
import type { PgNotifyBridge } from '@maskin/realtime'
import type { StorageProvider } from '@maskin/storage'
import { and, eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApiError, formatZodError } from '../../lib/errors'
import { saveFile, sha256Hex } from '../../lib/file-save'
import { fileStorageKey } from '../../lib/file-urls'
import { insertObject, insertWorkspace } from '../factories'
import { buildBriefingDeck } from '../fixtures/briefing-deck'
import { jsonGet, jsonRequest } from '../helpers'
import { db, getTestActorId, sql } from './global-setup'

const { default: filesRoutes } = await import('../../routes/files')

const DOC = Buffer.from('# Title\n\nalpha beta\n\nalpha gamma\n\nunique line\n')

/** Storage that keeps bytes in memory and lets a test break a write. */
function createMemoryStorage() {
	const objects = new Map<string, Buffer>()
	const hooks: { put?: (key: string, data: Buffer) => Promise<void> | void } = {}
	const storage = {
		put: async (key: string, data: Buffer) => {
			await hooks.put?.(key, data)
			objects.set(key, Buffer.from(data))
		},
		get: async (key: string) => {
			const bytes = objects.get(key)
			if (!bytes) throw new Error(`missing ${key}`)
			return bytes
		},
		delete: async (key: string) => {
			objects.delete(key)
		},
		exists: async (key: string) => objects.has(key),
		list: async () => [],
		listWithMetadata: async () => [],
		ensureBucket: async () => undefined,
	} as unknown as StorageProvider
	return { storage, objects, hooks }
}

function createApp(storage: StorageProvider) {
	const app = new OpenAPIHono({
		defaultHook: (result, c) => {
			if (!result.success) {
				return c.json(
					createApiError(
						'VALIDATION_ERROR',
						'Request validation failed',
						formatZodError(result.error),
					),
					400,
				)
			}
			return undefined
		},
	})
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', getTestActorId())
		c.set('actorType', 'human')
		c.set('notifyBridge', {} as PgNotifyBridge)
		c.set('storageProvider', storage)
		await next()
	})
	app.route('/api/files', filesRoutes)
	return app
}

async function insertFileRow(
	workspaceId: string,
	storage: ReturnType<typeof createMemoryStorage>,
	overrides: { name?: string; mimeType?: string; bytes?: Buffer } = {},
) {
	const id = randomUUID()
	const bytes = overrides.bytes ?? DOC
	const storageKey = fileStorageKey(workspaceId, id)
	storage.objects.set(storageKey, Buffer.from(bytes))
	const [row] = await db
		.insert(files)
		.values({
			id,
			workspaceId,
			name: overrides.name ?? 'notes.md',
			mimeType: overrides.mimeType ?? 'text/markdown',
			sizeBytes: bytes.byteLength,
			storageKey,
			contentHash: sha256Hex(bytes),
			createdBy: getTestActorId(),
		})
		.returning()
	if (!row) throw new Error('file insert failed')
	return row
}

async function readRow(id: string) {
	const [row] = await db.select().from(files).where(eq(files.id, id))
	if (!row) throw new Error('row missing')
	return row
}

describe('File text reads and partial edits (integration)', () => {
	let workspaceId: string
	let mem: ReturnType<typeof createMemoryStorage>

	beforeAll(async () => {
		// Fires at COMMIT, after the save has uploaded and updated the row.
		await sql.unsafe(`
			CREATE OR REPLACE FUNCTION test_fail_at_commit_edits() RETURNS trigger AS $$
			BEGIN RAISE EXCEPTION 'forced commit failure'; END;
			$$ LANGUAGE plpgsql
		`)
		await sql.unsafe(`
			CREATE CONSTRAINT TRIGGER test_fail_at_commit_edits AFTER UPDATE ON files
			DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
			WHEN (NEW.name = 'commit-fails.md') EXECUTE FUNCTION test_fail_at_commit_edits()
		`)
	})

	afterAll(async () => {
		await sql.unsafe('DROP TRIGGER IF EXISTS test_fail_at_commit_edits ON files')
		await sql.unsafe('DROP FUNCTION IF EXISTS test_fail_at_commit_edits()')
	})

	beforeEach(async () => {
		vi.stubEnv('FRONTEND_URL', 'http://localhost:5173')
		const ws = await insertWorkspace(db, getTestActorId())
		workspaceId = ws.id
		mem = createMemoryStorage()
	})

	afterEach(() => {
		vi.restoreAllMocks()
		vi.unstubAllEnvs()
	})

	describe('GET ?format=text', () => {
		it('returns the readable text of a font-heavy deck, with its hash and source object', async () => {
			const app = createApp(mem.storage)
			const html = Buffer.from(buildBriefingDeck({ fontChars: 300_000 }))
			const row = await insertFileRow(workspaceId, mem, {
				name: 'deck.html',
				mimeType: 'text/html',
				bytes: html,
			})
			const source = await insertObject(db, workspaceId, getTestActorId())
			await db.insert(relationships).values({
				sourceType: 'file',
				sourceId: row.id,
				targetType: 'object',
				targetId: source.id,
				type: 'derived_from',
				createdBy: getTestActorId(),
			})

			const res = await app.request(jsonGet(`/api/files/${row.id}?format=text`))

			expect(res.status).toBe(200)
			const json = (await res.json()) as Record<string, unknown>
			expect(json.extracted).toBe(true)
			expect(json.contentHash).toBe(sha256Hex(html))
			expect(json.source_object_id).toBe(source.id)
			expect(json.title).toBe('Weekly readout, 27 Oct')
			expect(String(json.content_text)).toContain('## Plumbing is no moat')
			expect(JSON.stringify(json).length).toBeLessThan(5_000)
			expect(html.byteLength).toBeGreaterThan(300_000)
		})

		it('leaves source_object_id out when no edge exists', async () => {
			const app = createApp(mem.storage)
			const row = await insertFileRow(workspaceId, mem, {
				mimeType: 'text/html',
				bytes: Buffer.from(buildBriefingDeck()),
			})

			const json = (await (
				await app.request(jsonGet(`/api/files/${row.id}?format=text`))
			).json()) as {
				source_object_id?: string
			}

			expect(json.source_object_id).toBeUndefined()
		})

		it('returns a markdown file unchanged', async () => {
			const app = createApp(mem.storage)
			const row = await insertFileRow(workspaceId, mem)

			const json = (await (
				await app.request(jsonGet(`/api/files/${row.id}?format=text`))
			).json()) as {
				content_text: string
				extracted: boolean
			}

			expect(json.content_text).toBe(DOC.toString('utf8'))
			expect(json.extracted).toBe(false)
		})

		it('puts readable_with ahead of content on a raw read of a font-heavy deck', async () => {
			const app = createApp(mem.storage)
			const row = await insertFileRow(workspaceId, mem, {
				mimeType: 'text/html',
				bytes: Buffer.from(buildBriefingDeck({ fontChars: 300_000 })),
			})

			const raw = await (await app.request(jsonGet(`/api/files/${row.id}`))).text()

			expect(raw.indexOf('"readable_with"')).toBeGreaterThan(-1)
			expect(raw.indexOf('"readable_with"')).toBeLessThan(raw.indexOf('"content"'))
			expect(JSON.parse(raw).readable_with).toContain('get_file format=text')
		})
	})

	describe('PATCH edits', () => {
		async function patch(app: OpenAPIHono, id: string, body: Record<string, unknown>) {
			return app.request(jsonRequest('PATCH', `/api/files/${id}`, body))
		}

		it('applies an edit that matches exactly once and updates bytes, size, hash and event', async () => {
			const app = createApp(mem.storage)
			const row = await insertFileRow(workspaceId, mem)

			const res = await patch(app, row.id, {
				edits: [{ old: 'unique line', new: 'changed line' }],
				if_match: sha256Hex(DOC),
			})

			expect(res.status).toBe(200)
			const expected = Buffer.from(DOC.toString('utf8').replace('unique line', 'changed line'))
			expect(mem.objects.get(row.storageKey)).toEqual(expected)
			const after = await readRow(row.id)
			expect(after.contentHash).toBe(sha256Hex(expected))
			expect(after.sizeBytes).toBe(expected.byteLength)
			const body = (await res.json()) as { content: string; contentHash: string }
			expect(body.content).toBe(expected.toString('utf8'))
			expect(body.contentHash).toBe(sha256Hex(expected))

			const [event] = await db
				.select()
				.from(events)
				.where(and(eq(events.entityId, row.id), eq(events.action, 'updated')))
			expect(event?.entityType).toBe('file')
			expect((event?.data as { editCount?: number }).editCount).toBe(1)
		})

		it('refuses an edit that matches nothing and writes nothing', async () => {
			const app = createApp(mem.storage)
			const row = await insertFileRow(workspaceId, mem)

			const res = await patch(app, row.id, { edits: [{ old: 'not in the file', new: 'x' }] })

			expect(res.status).toBe(400)
			const json = (await res.json()) as { error: { message: string } }
			expect(json.error.message).toContain('not found')
			expect(mem.objects.get(row.storageKey)).toEqual(DOC)
			expect((await readRow(row.id)).contentHash).toBe(sha256Hex(DOC))
		})

		it('refuses an edit that matches more than once and writes nothing', async () => {
			const app = createApp(mem.storage)
			const row = await insertFileRow(workspaceId, mem)

			const res = await patch(app, row.id, { edits: [{ old: 'alpha', new: 'omega' }] })

			expect(res.status).toBe(400)
			const json = (await res.json()) as { error: { message: string } }
			expect(json.error.message).toContain('2 times')
			expect(mem.objects.get(row.storageKey)).toEqual(DOC)
		})

		it('replaces every occurrence with replace_all', async () => {
			const app = createApp(mem.storage)
			const row = await insertFileRow(workspaceId, mem)

			const res = await patch(app, row.id, {
				edits: [{ old: 'alpha', new: 'omega', replace_all: true }],
			})

			expect(res.status).toBe(200)
			expect(mem.objects.get(row.storageKey)?.toString('utf8')).toBe(
				DOC.toString('utf8').replaceAll('alpha', 'omega'),
			)
		})

		it('writes nothing when a later edit in the list fails', async () => {
			const app = createApp(mem.storage)
			const row = await insertFileRow(workspaceId, mem)

			const res = await patch(app, row.id, {
				edits: [
					{ old: 'unique line', new: 'changed' },
					{ old: 'missing', new: 'x' },
				],
			})

			expect(res.status).toBe(400)
			expect(mem.objects.get(row.storageKey)).toEqual(DOC)
			expect((await readRow(row.id)).contentHash).toBe(sha256Hex(DOC))
		})

		it('refuses a stale if_match with 409 and writes nothing', async () => {
			const app = createApp(mem.storage)
			const row = await insertFileRow(workspaceId, mem)

			const res = await patch(app, row.id, {
				edits: [{ old: 'unique line', new: 'changed' }],
				if_match: sha256Hex(Buffer.from('an older version')),
			})

			expect(res.status).toBe(409)
			expect(((await res.json()) as { currentHash: string }).currentHash).toBe(sha256Hex(DOC))
			expect(mem.objects.get(row.storageKey)).toEqual(DOC)
		})

		it('refuses edits on a file that is not text', async () => {
			const app = createApp(mem.storage)
			const png = Buffer.from([0x89, 0x50, 0x4e, 0x47])
			const row = await insertFileRow(workspaceId, mem, {
				name: 'pic.png',
				mimeType: 'image/png',
				bytes: png,
			})

			const res = await patch(app, row.id, { edits: [{ old: 'a', new: 'b' }] })

			expect(res.status).toBe(400)
			expect(mem.objects.get(row.storageKey)).toEqual(png)
		})

		it('does not lose either change when two edits to different lines arrive together', async () => {
			const app = createApp(mem.storage)
			const row = await insertFileRow(workspaceId, mem)

			const [a, b] = await Promise.all([
				patch(app, row.id, { edits: [{ old: 'unique line', new: 'first change' }] }),
				patch(app, row.id, { edits: [{ old: '# Title', new: '# New title' }] }),
			])

			expect([a.status, b.status]).toEqual([200, 200])
			const text = mem.objects.get(row.storageKey)?.toString('utf8')
			expect(text).toContain('first change')
			expect(text).toContain('# New title')
		})

		it('leaves the row and storage untouched when the upload fails', async () => {
			const app = createApp(mem.storage)
			const row = await insertFileRow(workspaceId, mem)
			mem.hooks.put = () => {
				throw new Error('S3 down')
			}
			vi.spyOn(console, 'error').mockImplementation(() => {})

			const res = await patch(app, row.id, { edits: [{ old: 'unique line', new: 'changed' }] })

			expect(res.status).toBe(500)
			expect(mem.objects.get(row.storageKey)).toEqual(DOC)
			expect((await readRow(row.id)).contentHash).toBe(sha256Hex(DOC))
		})

		it('puts the old bytes back when the commit fails after the upload', async () => {
			const row = await insertFileRow(workspaceId, mem)
			let uploaded: Buffer | undefined
			mem.hooks.put = (_key, data) => {
				uploaded ??= data
			}

			await expect(
				saveFile(
					{ db, storage: mem.storage },
					{
						fileId: row.id,
						newBytes: null,
						edits: [{ old: 'unique line', new: 'changed' }],
						name: 'commit-fails.md',
					},
				),
			).rejects.toThrow('forced commit failure')

			expect(uploaded?.toString('utf8')).toContain('changed')
			expect(mem.objects.get(row.storageKey)).toEqual(DOC)
			const after = await readRow(row.id)
			expect(after.name).toBe('notes.md')
			expect(after.contentHash).toBe(sha256Hex(DOC))
		})
	})
})
