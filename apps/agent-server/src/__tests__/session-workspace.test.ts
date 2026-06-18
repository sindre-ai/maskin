import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
		expect(sessionWorkspaceKey('abc-123')).toBe('agent-workspaces/abc-123.tar.gz')
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
		expect(storage.keys()).toContain(`agent-workspaces/${sessionId}.tar.gz`)

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
