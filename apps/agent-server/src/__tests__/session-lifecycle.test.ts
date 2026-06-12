import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { MsbCli, MsbCreateOptions, MsbListEntry } from '../services/msb-cli'
import { SessionLifecycle } from '../services/session-lifecycle'
import { SnapshotStore } from '../services/snapshot-store'

class FakeMsb implements MsbCli {
	createCalls: MsbCreateOptions[] = []
	removeCalls: string[] = []
	async create(options: MsbCreateOptions): Promise<void> {
		this.createCalls.push(options)
	}
	async remove(name: string): Promise<void> {
		this.removeCalls.push(name)
	}
	async list(): Promise<MsbListEntry[]> {
		return []
	}
}

let storeRoot: string
let sessionDirRoot: string

beforeEach(async () => {
	storeRoot = await mkdtemp(join(tmpdir(), 'maskin-lifecycle-store-'))
	sessionDirRoot = await mkdtemp(join(tmpdir(), 'maskin-lifecycle-sessions-'))
})

afterEach(async () => {
	await rm(storeRoot, { recursive: true, force: true })
	await rm(sessionDirRoot, { recursive: true, force: true })
})

function buildLifecycle(msb: MsbCli = new FakeMsb()): {
	lifecycle: SessionLifecycle
	msb: MsbCli
	snapshots: SnapshotStore
} {
	const snapshots = new SnapshotStore(storeRoot)
	const lifecycle = new SessionLifecycle(msb, snapshots, {
		sessionDirRoot,
		defaultMemoryMib: 1024,
		defaultCpus: 2,
	})
	return { lifecycle, msb, snapshots }
}

describe('SessionLifecycle.stop', () => {
	it('removes the sandbox by name and reports stopped=true', async () => {
		const msb = new FakeMsb()
		const { lifecycle } = buildLifecycle(msb)
		const result = await lifecycle.stop('sess-1')
		expect(result).toEqual({ sessionId: 'sess-1', stopped: true })
		expect(msb.removeCalls).toEqual(['sess-1'])
	})
})

describe('SessionLifecycle.snapshot', () => {
	it('tars the session dir into the snapshot store', async () => {
		const sessionDir = join(sessionDirRoot, 'sess-1')
		await mkdir(join(sessionDir, 'workspace'), { recursive: true })
		await writeFile(join(sessionDir, 'workspace/note.md'), 'hello')
		const { lifecycle, snapshots } = buildLifecycle()

		const result = await lifecycle.snapshot('sess-1')

		expect(result.sessionId).toBe('sess-1')
		expect(result.snapshot.archiveBytes).toBeGreaterThan(0)
		const list = await snapshots.listSnapshots('sess-1')
		expect(list).toHaveLength(1)
		expect(list[0]?.snapshotId).toBe(result.snapshot.snapshotId)
	})
})

describe('SessionLifecycle.restore', () => {
	it('restores latest snapshot, boots sandbox with same sessionId, and mounts the session dir', async () => {
		const sessionDir = join(sessionDirRoot, 'sess-1')
		await mkdir(join(sessionDir, 'workspace'), { recursive: true })
		await writeFile(join(sessionDir, 'workspace/state.json'), '{"step":3}')
		const msb = new FakeMsb()
		const { lifecycle } = buildLifecycle(msb)
		await lifecycle.snapshot('sess-1')
		// Pre-restore: someone wrote a stray file we expect to be wiped.
		await writeFile(join(sessionDir, 'leftover.txt'), 'wipe me')

		const result = await lifecycle.restore('sess-1', {
			image: 'maskin/agent-base:latest',
			env: { OPENAI_API_KEY: 'sk-test', LANG: 'en_US' },
		})

		expect(result.sandboxName).toBe('sess-1')
		expect(result.sessionDir).toBe(sessionDir)
		// Restored sandbox identity is preserved.
		expect(msb.createCalls).toHaveLength(1)
		const create = msb.createCalls[0]
		expect(create?.name).toBe('sess-1')
		expect(create?.image).toBe('maskin/agent-base:latest')
		expect(create?.env.OPENAI_API_KEY).toBe('sk-test')
		expect(create?.volumes).toEqual([{ host: sessionDir, guest: '/agent' }])
		// And `/agent` host-side reflects the snapshot, not the post-snapshot stray.
		expect(await readFile(join(sessionDir, 'workspace/state.json'), 'utf8')).toBe('{"step":3}')
		await expect(readFile(join(sessionDir, 'leftover.txt'))).rejects.toThrow()
	})

	it('uses defaults for memory/cpus when not supplied', async () => {
		const sessionDir = join(sessionDirRoot, 'sess-1')
		await mkdir(join(sessionDir, 'workspace'), { recursive: true })
		const msb = new FakeMsb()
		const { lifecycle } = buildLifecycle(msb)
		await lifecycle.snapshot('sess-1')

		await lifecycle.restore('sess-1', { image: 'maskin/agent-base:latest', env: {} })

		expect(msb.createCalls[0]?.memoryMib).toBe(1024)
		expect(msb.createCalls[0]?.cpus).toBe(2)
	})

	it('strips non-ASCII env values silently (bet constraint #1)', async () => {
		const sessionDir = join(sessionDirRoot, 'sess-1')
		await mkdir(join(sessionDir, 'workspace'), { recursive: true })
		const msb = new FakeMsb()
		const { lifecycle } = buildLifecycle(msb)
		await lifecycle.snapshot('sess-1')

		await lifecycle.restore('sess-1', {
			image: 'maskin/agent-base:latest',
			env: { NAME: 'tøsen', SAFE: 'ok' },
		})

		expect(msb.createCalls[0]?.env.NAME).toBe('tsen')
		expect(msb.createCalls[0]?.env.SAFE).toBe('ok')
	})

	it('spills oversized env values into /agent/.env-overflow.sh (bet constraint #2)', async () => {
		const sessionDir = join(sessionDirRoot, 'sess-1')
		await mkdir(join(sessionDir, 'workspace'), { recursive: true })
		const msb = new FakeMsb()
		const { lifecycle } = buildLifecycle(msb)
		await lifecycle.snapshot('sess-1')

		const huge = 'A'.repeat(1700)
		await lifecycle.restore('sess-1', {
			image: 'maskin/agent-base:latest',
			env: { CLAUDE_OAUTH: huge, SMALL: 'k' },
		})

		expect(msb.createCalls[0]?.env).toEqual({ SMALL: 'k' })
		const overflow = await readFile(join(sessionDir, '.env-overflow.sh'), 'utf8')
		expect(overflow).toContain(`export CLAUDE_OAUTH='${huge}'`)
	})

	it('targets a specific snapshotId when requested', async () => {
		const sessionDir = join(sessionDirRoot, 'sess-1')
		await mkdir(join(sessionDir, 'workspace'), { recursive: true })
		await writeFile(join(sessionDir, 'workspace/v.txt'), 'v1')
		const msb = new FakeMsb()
		const { lifecycle } = buildLifecycle(msb)
		const first = await lifecycle.snapshot('sess-1')
		await writeFile(join(sessionDir, 'workspace/v.txt'), 'v2')
		const second = await lifecycle.snapshot('sess-1')
		expect(first.snapshot.snapshotId).not.toBe(second.snapshot.snapshotId)

		await lifecycle.restore('sess-1', {
			image: 'maskin/agent-base:latest',
			env: {},
			snapshotId: first.snapshot.snapshotId,
		})

		expect(await readFile(join(sessionDir, 'workspace/v.txt'), 'utf8')).toBe('v1')
	})

	it('throws when no snapshot exists', async () => {
		const { lifecycle } = buildLifecycle()
		await expect(
			lifecycle.restore('sess-empty', { image: 'maskin/agent-base:latest', env: {} }),
		).rejects.toThrow(/No snapshots found/)
	})

	it('throws when the named snapshotId does not exist', async () => {
		const sessionDir = join(sessionDirRoot, 'sess-1')
		await mkdir(join(sessionDir, 'workspace'), { recursive: true })
		const { lifecycle } = buildLifecycle()
		await lifecycle.snapshot('sess-1')

		await expect(
			lifecycle.restore('sess-1', {
				image: 'maskin/agent-base:latest',
				env: {},
				snapshotId: 'snap-does-not-exist',
			}),
		).rejects.toThrow(/Snapshot not found/)
	})
})
