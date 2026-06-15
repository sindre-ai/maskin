import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SnapshotStore, mintSnapshotId } from '../services/snapshot-store'

let storeRoot: string
let scratch: string

beforeEach(async () => {
	storeRoot = await mkdtemp(join(tmpdir(), 'maskin-snapshot-store-'))
	scratch = await mkdtemp(join(tmpdir(), 'maskin-snapshot-src-'))
})

afterEach(async () => {
	await rm(storeRoot, { recursive: true, force: true })
	await rm(scratch, { recursive: true, force: true })
})

async function writeTree(dir: string, files: Record<string, string>): Promise<void> {
	for (const [path, content] of Object.entries(files)) {
		const full = join(dir, path)
		await mkdir(join(full, '..'), { recursive: true })
		await writeFile(full, content)
	}
}

describe('SnapshotStore.createSnapshot', () => {
	it('packs sourceDir contents and records archive size', async () => {
		await writeTree(scratch, {
			'workspace/file.txt': 'hello',
			'memory/notes/seen.json': '{}',
		})
		const store = new SnapshotStore(storeRoot)

		const record = await store.createSnapshot('sess-1', 'snap-A', scratch)

		expect(record.sessionId).toBe('sess-1')
		expect(record.snapshotId).toBe('snap-A')
		expect(record.path).toBe(join(storeRoot, 'sess-1', 'snap-A.tar.gz'))
		expect(record.archiveBytes).toBeGreaterThan(0)
	})

	it('rejects invalid session ids before touching the filesystem', async () => {
		const store = new SnapshotStore(storeRoot)
		await expect(store.createSnapshot('../etc', 'snap-A', scratch)).rejects.toThrow(
			/Invalid session id/,
		)
	})

	it('rejects invalid snapshot ids', async () => {
		const store = new SnapshotStore(storeRoot)
		await expect(store.createSnapshot('sess-1', '..bad', scratch)).rejects.toThrow(
			/Invalid snapshot id/,
		)
	})

	it('throws when sourceDir is missing', async () => {
		const store = new SnapshotStore(storeRoot)
		await expect(
			store.createSnapshot('sess-1', 'snap-A', join(scratch, 'does-not-exist')),
		).rejects.toThrow(/not a directory/)
	})
})

describe('SnapshotStore.listSnapshots + getLatestSnapshot', () => {
	it('returns snapshots in sortable order, picks the last for latest', async () => {
		await writeTree(scratch, { 'a.txt': '1' })
		const store = new SnapshotStore(storeRoot)
		await store.createSnapshot('sess-1', 'snap-2026-01-01', scratch)
		await store.createSnapshot('sess-1', 'snap-2026-02-02', scratch)
		await store.createSnapshot('sess-1', 'snap-2026-03-03', scratch)

		const list = await store.listSnapshots('sess-1')
		expect(list.map((s) => s.snapshotId)).toEqual([
			'snap-2026-01-01',
			'snap-2026-02-02',
			'snap-2026-03-03',
		])
		const latest = await store.getLatestSnapshot('sess-1')
		expect(latest?.snapshotId).toBe('snap-2026-03-03')
	})

	it('returns empty list (and null latest) when no snapshots exist', async () => {
		const store = new SnapshotStore(storeRoot)
		expect(await store.listSnapshots('sess-empty')).toEqual([])
		expect(await store.getLatestSnapshot('sess-empty')).toBeNull()
	})
})

describe('SnapshotStore.restoreSnapshot', () => {
	it('round-trips byte-identical contents', async () => {
		await writeTree(scratch, {
			'workspace/notes.md': '# hello world',
			'memory/saved/state.json': '{"k":"v"}',
			'skills/skill-a/SKILL.md': '---\nname: skill-a\n---',
		})
		const store = new SnapshotStore(storeRoot)
		const created = await store.createSnapshot('sess-1', 'snap-A', scratch)

		const dest = await mkdtemp(join(tmpdir(), 'maskin-snapshot-dest-'))
		try {
			const restored = await store.restoreSnapshot('sess-1', 'snap-A', dest)
			expect(restored.snapshotId).toBe(created.snapshotId)
			expect(await readFile(join(dest, 'workspace/notes.md'), 'utf8')).toBe('# hello world')
			expect(await readFile(join(dest, 'memory/saved/state.json'), 'utf8')).toBe('{"k":"v"}')
			expect(await readFile(join(dest, 'skills/skill-a/SKILL.md'), 'utf8')).toBe(
				'---\nname: skill-a\n---',
			)
		} finally {
			await rm(dest, { recursive: true, force: true })
		}
	})

	it('wipes destDir before extracting (no stale files survive)', async () => {
		await writeTree(scratch, { 'workspace/keep.txt': 'kept' })
		const store = new SnapshotStore(storeRoot)
		await store.createSnapshot('sess-1', 'snap-A', scratch)

		const dest = await mkdtemp(join(tmpdir(), 'maskin-snapshot-dest-'))
		await writeFile(join(dest, 'leftover.txt'), 'should be wiped')
		try {
			await store.restoreSnapshot('sess-1', 'snap-A', dest)
			await expect(readFile(join(dest, 'leftover.txt'))).rejects.toThrow()
			expect(await readFile(join(dest, 'workspace/keep.txt'), 'utf8')).toBe('kept')
		} finally {
			await rm(dest, { recursive: true, force: true })
		}
	})

	it('throws a recognisable error when the snapshot is missing', async () => {
		const store = new SnapshotStore(storeRoot)
		await expect(store.restoreSnapshot('sess-1', 'snap-missing', scratch)).rejects.toThrow(
			/Snapshot not found/,
		)
	})
})

describe('mintSnapshotId', () => {
	it('produces a validator-passing, sortable id', () => {
		const now = new Date('2026-06-12T08:30:45.123Z')
		const id = mintSnapshotId(now)
		expect(id).toMatch(/^snap-/)
		// Must pass the snapshot id whitelist used at the store boundary.
		expect(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)).toBe(true)
		const id2 = mintSnapshotId(new Date('2026-06-12T08:30:46.000Z'))
		expect(id < id2).toBe(true)
	})
})
