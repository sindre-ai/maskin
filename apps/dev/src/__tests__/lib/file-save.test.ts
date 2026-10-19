import type { Database } from '@maskin/db'
import type { StorageProvider } from '@maskin/storage'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
	FileSaveTimeoutError,
	FileVersionConflictError,
	ensureContentHash,
	saveFile,
	sha256Hex,
} from '../../lib/file-save'
import { logger } from '../../lib/logger'
import { buildFile } from '../factories'

vi.mock('../../lib/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

type FileRow = ReturnType<typeof buildFile> & { contentHash: string | null }

const OLD = Buffer.from('# Old text\n')
const NEW = Buffer.from('# New text\n')

function buildRow(overrides: Record<string, unknown> = {}): FileRow {
	return {
		...buildFile({ mimeType: 'text/markdown', sizeBytes: OLD.byteLength }),
		contentHash: sha256Hex(OLD),
		...overrides,
	} as FileRow
}

/** Fake db whose transaction records how it ended, so tests can see a leaked connection. */
function createFakeDb(
	row: FileRow | undefined,
	opts: { failCommit?: Error; lockError?: unknown } = {},
) {
	const state = { open: 0, committed: false, rolledBack: false, sets: [] as unknown[] }
	const selectChain = {
		from: () => selectChain,
		where: () => selectChain,
		for: () => selectChain,
		limit: async () => {
			if (opts.lockError) throw opts.lockError
			return row ? [row] : []
		},
	}
	const tx = {
		execute: vi.fn(async () => []),
		select: () => selectChain,
		update: () => ({
			set: (values: Record<string, unknown>) => {
				state.sets.push(values)
				return { where: () => ({ returning: async () => [{ ...row, ...values }] }) }
			},
		}),
	}
	const db = {
		transaction: async (fn: (t: typeof tx) => Promise<unknown>) => {
			state.open++
			try {
				const result = await fn(tx)
				if (opts.failCommit) throw opts.failCommit
				state.committed = true
				return result
			} catch (err) {
				state.rolledBack = true
				throw err
			} finally {
				state.open--
			}
		},
		update: () => ({
			set: (values: Record<string, unknown>) => {
				state.sets.push(values)
				return { where: async () => [] }
			},
		}),
	} as unknown as Database
	return { db, tx, state }
}

/** In-memory storage that behaves like the real one: put then get returns the new bytes. */
function createMemoryStorage(row: FileRow, initial: Buffer = OLD) {
	const objects = new Map<string, Buffer>([[row.storageKey, initial]])
	const calls: string[] = []
	const storage = {
		get: vi.fn(async (key: string) => {
			calls.push('get')
			const bytes = objects.get(key)
			if (!bytes) throw new Error('missing')
			return bytes
		}),
		put: vi.fn(async (key: string, data: Buffer) => {
			calls.push('put')
			objects.set(key, Buffer.from(data))
		}),
	} as unknown as StorageProvider
	return { storage, objects, calls }
}

describe('saveFile', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('uploads under the lock, writes the new hash and size, and reports a change', async () => {
		const row = buildRow()
		const { db, tx, state } = createFakeDb(row)
		const { storage, objects } = createMemoryStorage(row)

		const result = await saveFile({ db, storage }, { fileId: row.id, newBytes: NEW })

		expect(objects.get(row.storageKey)).toEqual(NEW)
		expect(state.committed).toBe(true)
		expect(tx.execute).toHaveBeenCalledTimes(1) // lock_timeout set before the lock is taken
		expect(state.sets[0]).toMatchObject({ contentHash: sha256Hex(NEW), sizeBytes: NEW.byteLength })
		expect(result?.contentChanged).toBe(true)
		expect(result?.row.contentHash).toBe(sha256Hex(NEW))
	})

	it('reads the old bytes from storage before the upload starts', async () => {
		const row = buildRow()
		const { db } = createFakeDb(row)
		const { storage, calls } = createMemoryStorage(row)

		await saveFile({ db, storage }, { fileId: row.id, newBytes: NEW })

		expect(calls).toEqual(['get', 'put'])
	})

	it('saves when if_match equals the stored hash', async () => {
		const row = buildRow()
		const { db } = createFakeDb(row)
		const { storage, objects } = createMemoryStorage(row)

		const result = await saveFile(
			{ db, storage },
			{ fileId: row.id, newBytes: NEW, ifMatch: sha256Hex(OLD) },
		)

		expect(result?.contentChanged).toBe(true)
		expect(objects.get(row.storageKey)).toEqual(NEW)
	})

	it('saves without if_match (last write wins)', async () => {
		const row = buildRow()
		const { db } = createFakeDb(row)
		const { storage, objects } = createMemoryStorage(row)

		await saveFile({ db, storage }, { fileId: row.id, newBytes: NEW })

		expect(objects.get(row.storageKey)).toEqual(NEW)
	})

	it('refuses a stale if_match, carries the current hash, and writes nothing', async () => {
		const row = buildRow()
		const { db, state } = createFakeDb(row)
		const { storage, objects } = createMemoryStorage(row)
		const stale = sha256Hex(Buffer.from('what the editor loaded'))

		const err = await saveFile(
			{ db, storage },
			{ fileId: row.id, newBytes: NEW, ifMatch: stale },
		).catch((e) => e)

		expect(err).toBeInstanceOf(FileVersionConflictError)
		expect(err.currentHash).toBe(sha256Hex(OLD))
		expect(storage.put).not.toHaveBeenCalled()
		expect(objects.get(row.storageKey)).toEqual(OLD)
		expect(state.sets).toHaveLength(0)
		expect(state.rolledBack).toBe(true)
	})

	it('reports no change when the new bytes are identical to the stored bytes', async () => {
		const row = buildRow()
		const { db } = createFakeDb(row)
		const { storage } = createMemoryStorage(row)

		const result = await saveFile({ db, storage }, { fileId: row.id, newBytes: OLD })

		expect(result?.contentChanged).toBe(false)
	})

	it('hashes a row that predates the column from its stored bytes', async () => {
		const row = buildRow({ contentHash: null })
		const { db, state } = createFakeDb(row)
		const { storage } = createMemoryStorage(row)

		const result = await saveFile(
			{ db, storage },
			{ fileId: row.id, newBytes: NEW, ifMatch: sha256Hex(OLD) },
		)

		expect(result?.contentChanged).toBe(true)
		expect(state.sets[0]).toMatchObject({ contentHash: sha256Hex(NEW) })
	})

	it('writes the computed hash back on a metadata-only save with if_match', async () => {
		const row = buildRow({ contentHash: null })
		const { db, state } = createFakeDb(row)
		const { storage } = createMemoryStorage(row)

		const result = await saveFile(
			{ db, storage },
			{ fileId: row.id, newBytes: null, ifMatch: sha256Hex(OLD), name: 'renamed.md' },
		)

		expect(storage.put).not.toHaveBeenCalled()
		expect(state.sets[0]).toMatchObject({ name: 'renamed.md', contentHash: sha256Hex(OLD) })
		expect(result?.contentChanged).toBe(false)
	})

	it('does not read storage for a metadata-only save without if_match', async () => {
		const row = buildRow({ contentHash: null })
		const { db } = createFakeDb(row)
		const { storage } = createMemoryStorage(row)

		await saveFile({ db, storage }, { fileId: row.id, newBytes: null, name: 'renamed.md' })

		expect(storage.get).not.toHaveBeenCalled()
	})

	it('returns null when the file does not exist', async () => {
		const { db } = createFakeDb(undefined)
		const { storage } = createMemoryStorage(buildRow())

		const result = await saveFile({ db, storage }, { fileId: 'missing', newBytes: NEW })

		expect(result).toBeNull()
		expect(storage.put).not.toHaveBeenCalled()
	})

	it('rolls back and leaves storage alone when the upload fails', async () => {
		const row = buildRow()
		const { db, state } = createFakeDb(row)
		const { storage, objects } = createMemoryStorage(row)
		vi.mocked(storage.put).mockRejectedValueOnce(new Error('S3 down'))

		await expect(saveFile({ db, storage }, { fileId: row.id, newBytes: NEW })).rejects.toThrow(
			'S3 down',
		)

		expect(state.rolledBack).toBe(true)
		expect(state.sets).toHaveLength(0)
		expect(storage.put).toHaveBeenCalledTimes(1) // no restore: nothing was uploaded
		expect(objects.get(row.storageKey)).toEqual(OLD)
	})

	it('restores the old bytes when the commit fails after a successful upload', async () => {
		const row = buildRow()
		const { db } = createFakeDb(row, { failCommit: new Error('commit failed') })
		const { storage, objects } = createMemoryStorage(row)

		await expect(saveFile({ db, storage }, { fileId: row.id, newBytes: NEW })).rejects.toThrow(
			'commit failed',
		)

		expect(storage.put).toHaveBeenCalledTimes(2) // upload, then restore
		expect(objects.get(row.storageKey)).toEqual(OLD)
		expect(logger.error).not.toHaveBeenCalled()
	})

	it('logs an error and returns it when the restore fails, without retrying', async () => {
		const row = buildRow()
		const { db } = createFakeDb(row, { failCommit: new Error('commit failed') })
		const { storage } = createMemoryStorage(row)
		vi.mocked(storage.put)
			.mockResolvedValueOnce(undefined) // the upload
			.mockRejectedValueOnce(new Error('restore failed'))

		await expect(saveFile({ db, storage }, { fileId: row.id, newBytes: NEW })).rejects.toThrow(
			'commit failed',
		)

		expect(storage.put).toHaveBeenCalledTimes(2) // exactly one restore attempt
		expect(logger.error).toHaveBeenCalledTimes(1)
		expect(logger.error).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({
				fileId: row.id,
				workspaceId: row.workspaceId,
				storedHash: sha256Hex(OLD),
			}),
		)
	})

	it('maps a lock wait timeout to a retryable timeout error and writes nothing', async () => {
		const row = buildRow()
		const lockError = Object.assign(new Error('canceling statement due to lock timeout'), {
			code: '55P03',
		})
		const { db, state } = createFakeDb(row, { lockError })
		const { storage } = createMemoryStorage(row)

		const err = await saveFile({ db, storage }, { fileId: row.id, newBytes: NEW }).catch((e) => e)

		expect(err).toBeInstanceOf(FileSaveTimeoutError)
		expect(err.stage).toBe('lock')
		expect(storage.put).not.toHaveBeenCalled()
		expect(state.open).toBe(0)
	})

	it('maps a lock timeout wrapped as an error cause', async () => {
		const row = buildRow()
		const wrapped = new Error('Failed query', { cause: { code: '55P03' } })
		const { db } = createFakeDb(row, { lockError: wrapped })
		const { storage } = createMemoryStorage(row)

		await expect(
			saveFile({ db, storage }, { fileId: row.id, newBytes: NEW }),
		).rejects.toBeInstanceOf(FileSaveTimeoutError)
	})

	it('returns a retryable error within the upload timeout and frees the connection', async () => {
		const row = buildRow()
		const { db, state } = createFakeDb(row)
		const { storage } = createMemoryStorage(row)
		let signal: AbortSignal | undefined
		vi.mocked(storage.put).mockImplementationOnce(
			(_key, _data, options) =>
				new Promise<void>(() => {
					signal = options?.signal // never settles: a storage call that hangs
				}),
		)

		const started = Date.now()
		const err = await saveFile(
			{ db, storage, uploadTimeoutMs: 30 },
			{ fileId: row.id, newBytes: NEW },
		).catch((e) => e)

		expect(err).toBeInstanceOf(FileSaveTimeoutError)
		expect(err.stage).toBe('storage')
		expect(Date.now() - started).toBeLessThan(1_000)
		expect(signal?.aborted).toBe(true)
		expect(state.rolledBack).toBe(true)
		expect(state.open).toBe(0) // no connection left holding the lock
	})

	it('times out a slow read of the old bytes the same way', async () => {
		const row = buildRow()
		const { db, state } = createFakeDb(row)
		const { storage } = createMemoryStorage(row)
		vi.mocked(storage.get).mockImplementationOnce(() => new Promise<Buffer>(() => {}))

		await expect(
			saveFile({ db, storage, uploadTimeoutMs: 30 }, { fileId: row.id, newBytes: NEW }),
		).rejects.toBeInstanceOf(FileSaveTimeoutError)

		expect(storage.put).not.toHaveBeenCalled()
		expect(state.open).toBe(0)
	})
})

describe('ensureContentHash', () => {
	it('returns the stored hash without touching the database', async () => {
		const row = buildRow()
		const { db, state } = createFakeDb(row)

		const hash = await ensureContentHash(db, row as never, OLD)

		expect(hash).toBe(sha256Hex(OLD))
		expect(state.sets).toHaveLength(0)
	})

	it('computes the hash from the bytes and writes it back for a legacy row', async () => {
		const row = buildRow({ contentHash: null })
		const { db, state } = createFakeDb(row)

		const hash = await ensureContentHash(db, row as never, OLD)

		expect(hash).toBe(sha256Hex(OLD))
		expect(state.sets).toEqual([{ contentHash: sha256Hex(OLD) }])
	})

	it('still returns the hash when the write-back fails', async () => {
		const row = buildRow({ contentHash: null })
		const db = {
			update: () => ({
				set: () => ({
					where: async () => {
						throw new Error('db down')
					},
				}),
			}),
		} as unknown as Database

		const hash = await ensureContentHash(db, row as never, OLD)

		expect(hash).toBe(sha256Hex(OLD))
		expect(logger.warn).toHaveBeenCalled()
	})
})
