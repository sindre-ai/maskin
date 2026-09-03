import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BriefCacheCleaner } from '../../services/brief-cache-cleaner'

const WS_A = 'aaaaaaaa-2222-4333-8444-555555555555'
const WS_B = 'bbbbbbbb-2222-4333-8444-555555555555'

function fakeStorage(keys: string[] = []) {
	const files = new Set(keys)
	return {
		files,
		list: vi.fn(async (prefix: string) => [...files].filter((k) => k.startsWith(prefix))),
		delete: vi.fn(async (key: string) => {
			files.delete(key)
		}),
		put: vi.fn(),
		get: vi.fn(),
		exists: vi.fn(),
		listWithMetadata: vi.fn(),
		ensureBucket: vi.fn(),
	}
}

// biome-ignore lint/suspicious/noExplicitAny: structural stand-in for StorageProvider
type AnyStorage = any

const TODAY = new Date('2026-08-19T09:00:00Z')

describe('BriefCacheCleaner', () => {
	beforeEach(() => vi.clearAllMocks())

	it("deletes yesterday's briefs and keeps today's", async () => {
		const storage = fakeStorage([
			`briefs/${WS_A}/2026-08-18.json`,
			`briefs/${WS_A}/2026-08-19.json`,
			`briefs/${WS_B}/2026-08-17.json`,
		])
		await new BriefCacheCleaner(storage as AnyStorage).tick(TODAY)

		expect([...storage.files]).toEqual([`briefs/${WS_A}/2026-08-19.json`])
	})

	it('only lists under the briefs prefix, never the whole bucket', async () => {
		const storage = fakeStorage()
		await new BriefCacheCleaner(storage as AnyStorage).tick(TODAY)
		expect(storage.list).toHaveBeenCalledWith('briefs/')
	})

	it('leaves anything that is not a dated brief file alone', async () => {
		// A stray object under the prefix is not ours to delete.
		const storage = fakeStorage([`briefs/${WS_A}/notes.txt`, `briefs/${WS_A}/2026-08-18.json`])
		await new BriefCacheCleaner(storage as AnyStorage).tick(TODAY)
		expect([...storage.files]).toEqual([`briefs/${WS_A}/notes.txt`])
	})

	it('honours a wider retention window', async () => {
		const storage = fakeStorage([
			`briefs/${WS_A}/2026-08-17.json`,
			`briefs/${WS_A}/2026-08-18.json`,
			`briefs/${WS_A}/2026-08-19.json`,
		])
		await new BriefCacheCleaner(storage as AnyStorage, 2).tick(TODAY)
		expect([...storage.files]).toEqual([
			`briefs/${WS_A}/2026-08-18.json`,
			`briefs/${WS_A}/2026-08-19.json`,
		])
	})

	it('keeps sweeping after one delete fails', async () => {
		const storage = fakeStorage([
			`briefs/${WS_A}/2026-08-18.json`,
			`briefs/${WS_B}/2026-08-18.json`,
		])
		storage.delete.mockRejectedValueOnce(new Error('S3 down'))
		await new BriefCacheCleaner(storage as AnyStorage).tick(TODAY)
		expect(storage.delete).toHaveBeenCalledTimes(2)
	})

	it('never throws out of a tick, whatever storage does', async () => {
		const storage = fakeStorage()
		storage.list.mockRejectedValue(new Error('S3 down'))
		await expect(new BriefCacheCleaner(storage as AnyStorage).tick(TODAY)).resolves.toBeUndefined()
	})

	it('does not overlap two ticks', async () => {
		const storage = fakeStorage()
		let release: (() => void) | undefined
		storage.list.mockImplementation(
			() =>
				new Promise((resolve) => {
					release = () => resolve([])
				}),
		)
		const cleaner = new BriefCacheCleaner(storage as AnyStorage)
		const first = cleaner.tick(TODAY)
		await cleaner.tick(TODAY)
		expect(storage.list).toHaveBeenCalledTimes(1)
		release?.()
		await first
	})

	it('stops cleanly when it was never started', () => {
		expect(() => new BriefCacheCleaner(fakeStorage() as AnyStorage).stop()).not.toThrow()
	})
})
