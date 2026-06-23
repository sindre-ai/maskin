import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { StorageProvider } from '@maskin/storage'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
	SESSION_SKELETON_DIRS,
	pullSessionWorkspace,
	pushSessionWorkspace,
	sessionWorkspaceKey,
	sweepSessionWorkspaces,
} from '../services/session-workspace'

class InMemoryStorage implements StorageProvider {
	private objects = new Map<string, Buffer>()

	async put(key: string, data: Buffer | Uint8Array | Readable): Promise<void> {
		if (data instanceof Readable) {
			throw new Error('Readable not exercised by this test')
		}
		this.objects.set(key, Buffer.from(data))
	}

	async get(key: string): Promise<Buffer> {
		const value = this.objects.get(key)
		if (!value) throw new Error(`Missing key: ${key}`)
		return value
	}

	async list(prefix: string): Promise<string[]> {
		return Array.from(this.objects.keys()).filter((k) => k.startsWith(prefix))
	}

	async delete(key: string): Promise<void> {
		this.objects.delete(key)
	}

	async exists(key: string): Promise<boolean> {
		return this.objects.has(key)
	}

	async ensureBucket(): Promise<void> {}

	keys(): string[] {
		return Array.from(this.objects.keys())
	}
}

let tmpRoot: string

beforeEach(async () => {
	tmpRoot = await mkdtemp(join(tmpdir(), 'maskin-agent-test-'))
})

afterEach(async () => {
	await rm(tmpRoot, { recursive: true, force: true })
})

async function fileExists(path: string): Promise<boolean> {
	try {
		await readFile(path)
		return true
	} catch {
		return false
	}
}

describe('sessionWorkspaceKey', () => {
	it('produces a stable tar.gz key per session id', () => {
		expect(sessionWorkspaceKey('abc-123')).toBe('session-workspaces/abc-123.tar.gz')
	})

	it('rejects path-traversal-shaped session ids', () => {
		expect(() => sessionWorkspaceKey('../etc/passwd')).toThrow(/Invalid session id/)
		expect(() => sessionWorkspaceKey('a/b')).toThrow(/Invalid session id/)
		expect(() => sessionWorkspaceKey('')).toThrow(/Invalid session id/)
	})

	it('rejects shell-metacharacter session ids', () => {
		expect(() => sessionWorkspaceKey('foo;rm -rf /')).toThrow(/Invalid session id/)
		expect(() => sessionWorkspaceKey('$(whoami)')).toThrow(/Invalid session id/)
	})
})

describe('pullSessionWorkspace — first boot (no archive in S3)', () => {
	it('creates the skeleton dirs and reports restored=false', async () => {
		const storage = new InMemoryStorage()
		const sessionDir = join(tmpRoot, 'session-fresh')

		const result = await pullSessionWorkspace(storage, 'session-fresh', sessionDir)

		expect(result.restored).toBe(false)
		expect(result.archiveBytes).toBe(0)
		for (const sub of SESSION_SKELETON_DIRS) {
			expect(await fileExists(join(sessionDir, sub, '.placeholder')).catch(() => false)).toBe(false)
			// The directory itself must exist for the bind-mount to land cleanly.
			const stat = await import('node:fs/promises').then((fs) => fs.stat(join(sessionDir, sub)))
			expect(stat.isDirectory()).toBe(true)
		}
	})
})

describe('pull → push → pull round-trip', () => {
	it('restores byte-identical file contents into a fresh sessionDir', async () => {
		const storage = new InMemoryStorage()
		const sessionId = 'round-trip-1'

		// First boot.
		const original = join(tmpRoot, 'original')
		await pullSessionWorkspace(storage, sessionId, original)

		// Agent writes files into the workspace and memory.
		await writeFile(join(original, 'workspace', 'plan.md'), '# the plan\n\nstep 1')
		await mkdir(join(original, 'memory', 'sub'), { recursive: true })
		await writeFile(join(original, 'memory', 'sub', 'note.txt'), 'remember this')
		await writeFile(join(original, 'learnings', 'session.md'), 'learned: tar trumps zip')

		// Session pauses — push.
		const push = await pushSessionWorkspace(storage, sessionId, original)
		expect(push.archiveBytes).toBeGreaterThan(0)
		expect(storage.keys()).toContain(`session-workspaces/${sessionId}.tar.gz`)

		// Session resumes on a fresh host path — pull into a new dir.
		const restored = join(tmpRoot, 'restored')
		const pullResult = await pullSessionWorkspace(storage, sessionId, restored)
		expect(pullResult.restored).toBe(true)
		expect(pullResult.archiveBytes).toBe(push.archiveBytes)

		expect((await readFile(join(restored, 'workspace', 'plan.md'))).toString()).toBe(
			'# the plan\n\nstep 1',
		)
		expect((await readFile(join(restored, 'memory', 'sub', 'note.txt'))).toString()).toBe(
			'remember this',
		)
		expect((await readFile(join(restored, 'learnings', 'session.md'))).toString()).toBe(
			'learned: tar trumps zip',
		)
	})

	it('reconstructs the skeleton dirs even if the prior archive omitted them', async () => {
		const storage = new InMemoryStorage()
		const sessionId = 'skeleton-rebuild'

		// Build an archive that only has `workspace/` populated — no skills/
		// learnings/memory dirs.
		const sparse = join(tmpRoot, 'sparse')
		await mkdir(join(sparse, 'workspace'), { recursive: true })
		await writeFile(join(sparse, 'workspace', 'only.txt'), 'just workspace')
		await pushSessionWorkspace(storage, sessionId, sparse)

		// Pull into a fresh dir — ensureSkeleton MUST re-create the missing dirs.
		const fresh = join(tmpRoot, 'fresh')
		await pullSessionWorkspace(storage, sessionId, fresh)

		for (const sub of SESSION_SKELETON_DIRS) {
			const stat = await import('node:fs/promises').then((fs) => fs.stat(join(fresh, sub)))
			expect(stat.isDirectory()).toBe(true)
		}
		expect((await readFile(join(fresh, 'workspace', 'only.txt'))).toString()).toBe('just workspace')
	})
})

describe('pullSessionWorkspace — sourceSessionId continuation', () => {
	it('restores from source session workspace when sourceSessionId is given', async () => {
		const storage = new InMemoryStorage()
		const sourceId = 'source-session-1'
		const newId = 'new-session-1'

		// Push a workspace as the "source" session.
		const sourceDir = join(tmpRoot, 'source')
		await pullSessionWorkspace(storage, sourceId, sourceDir)
		await writeFile(join(sourceDir, 'workspace', 'work.txt'), 'source work')
		await pushSessionWorkspace(storage, sourceId, sourceDir)

		// Pull as the new session with sourceSessionId pointing to the source.
		const newDir = join(tmpRoot, 'new')
		const result = await pullSessionWorkspace(storage, newId, newDir, sourceId)

		expect(result.restored).toBe(true)
		expect((await readFile(join(newDir, 'workspace', 'work.txt'))).toString()).toBe('source work')
	})

	it('falls back to own session key when source session has no snapshot', async () => {
		const storage = new InMemoryStorage()
		const sourceId = 'source-missing'
		const ownId = 'own-session-1'

		// Push a workspace under the own session key.
		const ownDir = join(tmpRoot, 'own')
		await pullSessionWorkspace(storage, ownId, ownDir)
		await writeFile(join(ownDir, 'workspace', 'own.txt'), 'own work')
		await pushSessionWorkspace(storage, ownId, ownDir)

		// Pull with a sourceSessionId that doesn't exist — should fall back to own.
		const restored = join(tmpRoot, 'restored')
		const result = await pullSessionWorkspace(storage, ownId, restored, sourceId)

		expect(result.restored).toBe(true)
		expect((await readFile(join(restored, 'workspace', 'own.txt'))).toString()).toBe('own work')
	})

	it('falls back to legacy agent-workspaces key', async () => {
		const storage = new InMemoryStorage()
		const sessionId = 'legacy-session-1'

		// Manually put under the legacy prefix (simulating an old deployment).
		const legacyDir = join(tmpRoot, 'legacy')
		await pullSessionWorkspace(storage, sessionId, legacyDir)
		await writeFile(join(legacyDir, 'workspace', 'legacy.txt'), 'legacy work')
		// Push normally (now goes to session-workspaces/) then rename key to simulate legacy.
		await pushSessionWorkspace(storage, sessionId, legacyDir)
		const newKey = `session-workspaces/${sessionId}.tar.gz`
		const legacyKey = `agent-workspaces/${sessionId}.tar.gz`
		const buf = await storage.get(newKey)
		await storage.delete(newKey)
		await storage.put(legacyKey, buf)

		const restored = join(tmpRoot, 'restored-legacy')
		const result = await pullSessionWorkspace(storage, sessionId, restored)

		expect(result.restored).toBe(true)
		expect((await readFile(join(restored, 'workspace', 'legacy.txt'))).toString()).toBe(
			'legacy work',
		)
	})
})

describe('sweepSessionWorkspaces', () => {
	// Materialise a session dir on disk with controllable mtime and payload size.
	async function makeSessionDir(
		root: string,
		sessionId: string,
		opts: { sizeBytes: number; ageMs: number; now: number },
	): Promise<void> {
		const dir = join(root, sessionId)
		await mkdir(dir, { recursive: true })
		await writeFile(join(dir, 'payload.bin'), Buffer.alloc(opts.sizeBytes, 0))
		const mtimeSec = (opts.now - opts.ageMs) / 1000
		await utimes(dir, mtimeSec, mtimeSec)
	}

	it('no-ops when total size is under threshold', async () => {
		const root = join(tmpRoot, 'sweep-under')
		await mkdir(root, { recursive: true })
		const now = 10_000_000_000
		await makeSessionDir(root, 's1', { sizeBytes: 100, ageMs: 7_200_000, now })
		await makeSessionDir(root, 's2', { sizeBytes: 200, ageMs: 7_200_000, now })

		const result = await sweepSessionWorkspaces(root, {
			thresholdBytes: 10_000,
			minAgeMs: 60_000,
			now: () => now,
		})

		expect(result.evicted).toHaveLength(0)
		expect(result.totalBytesBefore).toBeGreaterThanOrEqual(300)
		expect(result.totalBytesAfter).toBe(result.totalBytesBefore)
		expect((await stat(join(root, 's1'))).isDirectory()).toBe(true)
		expect((await stat(join(root, 's2'))).isDirectory()).toBe(true)
	})

	it('evicts oldest-first until under threshold when over (AC-T8)', async () => {
		const root = join(tmpRoot, 'sweep-over')
		await mkdir(root, { recursive: true })
		const now = 10_000_000_000
		// Each dir ~600 bytes payload; threshold 800 means we must evict until ≤800.
		await makeSessionDir(root, 'old-1', { sizeBytes: 600, ageMs: 9_000_000, now })
		await makeSessionDir(root, 'old-2', { sizeBytes: 600, ageMs: 8_000_000, now })
		await makeSessionDir(root, 'newer', { sizeBytes: 600, ageMs: 7_000_000, now })

		const result = await sweepSessionWorkspaces(root, {
			thresholdBytes: 800,
			minAgeMs: 60_000,
			now: () => now,
		})

		expect(result.evicted.length).toBeGreaterThan(0)
		expect(result.totalBytesAfter).toBeLessThanOrEqual(800)
		// Oldest goes first.
		expect(result.evicted[0]?.sessionId).toBe('old-1')
		await expect(stat(join(root, 'old-1'))).rejects.toThrow()
		// Newer of the candidates survives if eviction stops below threshold.
		expect((await stat(join(root, 'newer'))).isDirectory()).toBe(true)
	})

	it('never evicts dirs younger than minAgeMs even when over threshold', async () => {
		const root = join(tmpRoot, 'sweep-min-age')
		await mkdir(root, { recursive: true })
		const now = 10_000_000_000
		// Two large, fresh dirs — both protected by minAgeMs (presumed live).
		await makeSessionDir(root, 'fresh-1', { sizeBytes: 500, ageMs: 1_000, now })
		await makeSessionDir(root, 'fresh-2', { sizeBytes: 500, ageMs: 2_000, now })

		const result = await sweepSessionWorkspaces(root, {
			thresholdBytes: 100,
			minAgeMs: 60_000,
			now: () => now,
		})

		expect(result.evicted).toHaveLength(0)
		expect(result.skippedActive).toBe(2)
		expect((await stat(join(root, 'fresh-1'))).isDirectory()).toBe(true)
		expect((await stat(join(root, 'fresh-2'))).isDirectory()).toBe(true)
	})

	it('never evicts session ids in keepSessionIds even when old and over threshold', async () => {
		const root = join(tmpRoot, 'sweep-keep')
		await mkdir(root, { recursive: true })
		const now = 10_000_000_000
		await makeSessionDir(root, 'keep-me', { sizeBytes: 600, ageMs: 9_000_000, now })
		await makeSessionDir(root, 'evict-me', { sizeBytes: 600, ageMs: 8_000_000, now })

		const result = await sweepSessionWorkspaces(root, {
			thresholdBytes: 800,
			minAgeMs: 60_000,
			keepSessionIds: ['keep-me'],
			now: () => now,
		})

		expect(result.evicted.map((e) => e.sessionId)).toEqual(['evict-me'])
		expect((await stat(join(root, 'keep-me'))).isDirectory()).toBe(true)
		await expect(stat(join(root, 'evict-me'))).rejects.toThrow()
	})

	it('treats a missing root as a no-op (empty result)', async () => {
		const result = await sweepSessionWorkspaces(join(tmpRoot, 'does-not-exist'), {
			thresholdBytes: 100,
			minAgeMs: 60_000,
		})
		expect(result.evicted).toHaveLength(0)
		expect(result.candidates).toBe(0)
		expect(result.totalBytesBefore).toBe(0)
	})
})

describe('pushSessionWorkspace — error cases', () => {
	it('throws when sessionDir does not exist', async () => {
		const storage = new InMemoryStorage()
		await expect(
			pushSessionWorkspace(storage, 'missing', join(tmpRoot, 'does-not-exist')),
		).rejects.toThrow(/not a directory/)
	})

	it('rejects invalid session ids before touching the filesystem', async () => {
		const storage = new InMemoryStorage()
		const sessionDir = join(tmpRoot, 'whatever')
		await mkdir(sessionDir, { recursive: true })
		await expect(pushSessionWorkspace(storage, '../escape', sessionDir)).rejects.toThrow(
			/Invalid session id/,
		)
	})
})
