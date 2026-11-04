import { randomUUID } from 'node:crypto'
import { OpenAPIHono } from '@hono/zod-openapi'
import { files } from '@maskin/db/schema'
import type { PgNotifyBridge } from '@maskin/realtime'
import type { StorageProvider } from '@maskin/storage'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApiError, formatZodError } from '../../lib/errors'
import {
	FileSaveTimeoutError,
	FileVersionConflictError,
	saveFile,
	sha256Hex,
} from '../../lib/file-save'
import { fileStorageKey } from '../../lib/file-urls'
import { logger } from '../../lib/logger'
import { insertWorkspace } from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { db, getTestActorId, sql } from './global-setup'

const { default: filesRoutes } = await import('../../routes/files')

const OLD = Buffer.from('# Agent text\n')
const MINE = Buffer.from('# Human text\n')

/** Storage that keeps bytes in memory and lets a test slow down or break a call. */
function createMemoryStorage() {
	const objects = new Map<string, Buffer>()
	const hooks: {
		put?: (key: string, data: Buffer) => Promise<void> | void
	} = {}
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
	overrides: { name?: string; contentHash?: string | null; bytes?: Buffer } = {},
) {
	const id = randomUUID()
	const bytes = overrides.bytes ?? OLD
	const storageKey = fileStorageKey(workspaceId, id)
	storage.objects.set(storageKey, Buffer.from(bytes))
	const [row] = await db
		.insert(files)
		.values({
			id,
			workspaceId,
			name: overrides.name ?? 'notes.md',
			mimeType: 'text/markdown',
			sizeBytes: bytes.byteLength,
			storageKey,
			contentHash: overrides.contentHash === undefined ? sha256Hex(bytes) : overrides.contentHash,
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

describe('Safe file save (integration)', () => {
	let workspaceId: string
	let mem: ReturnType<typeof createMemoryStorage>

	beforeAll(async () => {
		// Fires at COMMIT, so the save has already uploaded and updated the row
		// when the transaction fails. Only rows named commit-fails.md are hit.
		await sql.unsafe(`
			CREATE OR REPLACE FUNCTION test_fail_at_commit() RETURNS trigger AS $$
			BEGIN RAISE EXCEPTION 'forced commit failure'; END;
			$$ LANGUAGE plpgsql
		`)
		await sql.unsafe(`
			CREATE CONSTRAINT TRIGGER test_fail_at_commit AFTER UPDATE ON files
			DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
			WHEN (NEW.name = 'commit-fails.md') EXECUTE FUNCTION test_fail_at_commit()
		`)
	})

	afterAll(async () => {
		await sql.unsafe('DROP TRIGGER IF EXISTS test_fail_at_commit ON files')
		await sql.unsafe('DROP FUNCTION IF EXISTS test_fail_at_commit()')
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

	describe('PATCH and GET over HTTP (surface 1)', () => {
		it('GET returns the hash; a PATCH then shows new content and a later updated_at', async () => {
			const app = createApp(mem.storage)
			const row = await insertFileRow(workspaceId, mem)

			const before = (await (await app.request(jsonGet(`/api/files/${row.id}`))).json()) as {
				contentHash: string
				updatedAt: string
			}
			expect(before.contentHash).toBe(sha256Hex(OLD))

			await new Promise((r) => setTimeout(r, 10))
			const patch = await app.request(
				jsonRequest('PATCH', `/api/files/${row.id}`, {
					content: MINE.toString('utf8'),
					if_match: before.contentHash,
				}),
			)
			expect(patch.status).toBe(200)

			const after = (await (await app.request(jsonGet(`/api/files/${row.id}`))).json()) as {
				content: string
				contentHash: string
				updatedAt: string
			}
			expect(after.content).toBe(MINE.toString('utf8'))
			expect(after.contentHash).toBe(sha256Hex(MINE))
			expect(new Date(after.updatedAt).getTime()).toBeGreaterThan(
				new Date(before.updatedAt).getTime(),
			)
		})

		it('refuses a save built on a stale copy and leaves the agent text in place', async () => {
			const app = createApp(mem.storage)
			const row = await insertFileRow(workspaceId, mem)
			const editorLoaded = sha256Hex(OLD)

			// An agent writes through the API without if_match while the editor is open.
			const agentText = '# Agent rewrote this\n'
			const agentWrite = await app.request(
				jsonRequest('PATCH', `/api/files/${row.id}`, { content: agentText }),
			)
			expect(agentWrite.status).toBe(200)

			const staleSave = await app.request(
				jsonRequest('PATCH', `/api/files/${row.id}`, {
					content: MINE.toString('utf8'),
					if_match: editorLoaded,
				}),
			)

			expect(staleSave.status).toBe(409)
			expect(((await staleSave.json()) as { currentHash: string }).currentHash).toBe(
				sha256Hex(Buffer.from(agentText)),
			)
			const get = (await (await app.request(jsonGet(`/api/files/${row.id}`))).json()) as {
				content: string
			}
			expect(get.content).toBe(agentText)
			expect((await readRow(row.id)).contentHash).toBe(sha256Hex(Buffer.from(agentText)))
		})

		it('hashes a row that has no stored hash, on read and on save', async () => {
			const app = createApp(mem.storage)
			const readOnly = await insertFileRow(workspaceId, mem, { contentHash: null })
			const saved = await insertFileRow(workspaceId, mem, { contentHash: null })

			const get = await app.request(jsonGet(`/api/files/${readOnly.id}`))
			expect(((await get.json()) as { contentHash: string }).contentHash).toBe(sha256Hex(OLD))
			expect((await readRow(readOnly.id)).contentHash).toBe(sha256Hex(OLD))

			const patch = await app.request(
				jsonRequest('PATCH', `/api/files/${saved.id}`, {
					content: MINE.toString('utf8'),
					if_match: sha256Hex(OLD),
				}),
			)
			expect(patch.status).toBe(200)
			expect((await readRow(saved.id)).contentHash).toBe(sha256Hex(MINE))
		})

		it('stores a hash on create', async () => {
			const app = createApp(mem.storage)

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/files',
					{ name: 'new.md', mime_type: 'text/markdown', content: '# New\n' },
					{ 'X-Workspace-Id': workspaceId },
				),
			)

			expect(res.status).toBe(201)
			const created = (await res.json()) as { id: string; contentHash: string }
			expect(created.contentHash).toBe(sha256Hex(Buffer.from('# New\n')))
			expect((await readRow(created.id)).contentHash).toBe(created.contentHash)
		})
	})

	describe('storage while the row lock is held (surface 8)', () => {
		it('reads the new bytes back inside the same save', async () => {
			const row = await insertFileRow(workspaceId, mem)
			let readBack: Buffer | undefined
			const original = mem.storage.put.bind(mem.storage)
			mem.storage.put = async (key, data, options) => {
				await original(key, data, options)
				readBack = await mem.storage.get(key)
			}

			await saveFile({ db, storage: mem.storage }, { fileId: row.id, newBytes: MINE })

			expect(readBack).toEqual(MINE)
		})

		it('leaves the old bytes in storage when the commit fails after the upload', async () => {
			const row = await insertFileRow(workspaceId, mem)
			let uploadedBytes: Buffer | undefined
			mem.hooks.put = (_key, data) => {
				uploadedBytes ??= data
			}

			await expect(
				saveFile(
					{ db, storage: mem.storage },
					{ fileId: row.id, newBytes: MINE, name: 'commit-fails.md' },
				),
			).rejects.toThrow()

			expect(uploadedBytes).toEqual(MINE) // the upload did happen
			expect(mem.objects.get(row.storageKey)).toEqual(OLD) // and was undone
			const after = await readRow(row.id)
			expect(after.name).toBe('notes.md')
			expect(after.contentHash).toBe(sha256Hex(OLD))
		})

		it('logs an error and returns it when the restore also fails, with no retry', async () => {
			const row = await insertFileRow(workspaceId, mem)
			const errorLog = vi.spyOn(logger, 'error').mockImplementation(() => {})
			let puts = 0
			mem.hooks.put = () => {
				puts++
				if (puts === 2) throw new Error('restore failed')
			}

			await expect(
				saveFile(
					{ db, storage: mem.storage },
					{ fileId: row.id, newBytes: MINE, name: 'commit-fails.md' },
				),
			).rejects.toThrow('forced commit failure')

			expect(puts).toBe(2) // upload and one restore attempt, no retry loop
			expect(errorLog).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({
					fileId: row.id,
					workspaceId,
					storedHash: sha256Hex(OLD),
				}),
			)
		})

		it('leaves the row and storage untouched when the upload fails', async () => {
			const row = await insertFileRow(workspaceId, mem)
			mem.hooks.put = () => {
				throw new Error('S3 down')
			}

			await expect(
				saveFile({ db, storage: mem.storage }, { fileId: row.id, newBytes: MINE, name: 'x.md' }),
			).rejects.toThrow('S3 down')

			expect(mem.objects.get(row.storageKey)).toEqual(OLD)
			const after = await readRow(row.id)
			expect(after.name).toBe('notes.md')
			expect(after.contentHash).toBe(sha256Hex(OLD))
		})

		it('refuses a stale if_match without writing anything', async () => {
			const row = await insertFileRow(workspaceId, mem)

			await expect(
				saveFile(
					{ db, storage: mem.storage },
					{ fileId: row.id, newBytes: MINE, ifMatch: sha256Hex(Buffer.from('stale')) },
				),
			).rejects.toBeInstanceOf(FileVersionConflictError)

			expect(mem.objects.get(row.storageKey)).toEqual(OLD)
		})
	})

	describe('timeouts (surface 10)', () => {
		it('returns a retryable error when the row lock cannot be taken in time', async () => {
			const row = await insertFileRow(workspaceId, mem)
			let release: () => void = () => {}
			const held = new Promise<void>((resolve) => {
				release = resolve
			})
			let locked: () => void = () => {}
			const lockTaken = new Promise<void>((resolve) => {
				locked = resolve
			})
			const holder = db.transaction(async (tx) => {
				await tx.select().from(files).where(eq(files.id, row.id)).for('update')
				locked()
				await held
			})
			await lockTaken

			const started = Date.now()
			const err = await saveFile(
				{ db, storage: mem.storage, lockTimeoutMs: 200 },
				{ fileId: row.id, newBytes: MINE },
			).catch((e) => e)
			const waited = Date.now() - started

			expect(err).toBeInstanceOf(FileSaveTimeoutError)
			expect((err as FileSaveTimeoutError).stage).toBe('lock')
			expect(waited).toBeLessThan(2_000)
			expect(mem.objects.get(row.storageKey)).toEqual(OLD)

			release()
			await holder

			// The timed-out save left nothing behind: the next one goes straight through.
			await saveFile({ db, storage: mem.storage }, { fileId: row.id, newBytes: MINE })
			expect(mem.objects.get(row.storageKey)).toEqual(MINE)
		})

		it('returns a retryable error within the upload timeout, no lock left behind', async () => {
			const row = await insertFileRow(workspaceId, mem)
			mem.hooks.put = () => new Promise(() => {}) // storage that never answers

			const started = Date.now()
			const err = await saveFile(
				{ db, storage: mem.storage, uploadTimeoutMs: 150 },
				{ fileId: row.id, newBytes: MINE },
			).catch((e) => e)

			expect(err).toBeInstanceOf(FileSaveTimeoutError)
			expect(Date.now() - started).toBeLessThan(2_000)

			// If the connection were still holding the row lock, NOWAIT would fail here.
			await db.transaction(async (tx) => {
				await tx.select().from(files).where(eq(files.id, row.id)).for('update', { noWait: true })
			})
			expect(mem.objects.get(row.storageKey)).toEqual(OLD)
		})
	})
})
