import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSessionsLifecycleRoutes } from '../../routes/sessions-lifecycle'
import type { MsbCli, MsbCreateOptions, MsbListEntry } from '../../services/msb-cli'
import { SessionLifecycle } from '../../services/session-lifecycle'
import { SnapshotStore } from '../../services/snapshot-store'

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
	storeRoot = await mkdtemp(join(tmpdir(), 'maskin-routes-store-'))
	sessionDirRoot = await mkdtemp(join(tmpdir(), 'maskin-routes-sessions-'))
})

afterEach(async () => {
	await rm(storeRoot, { recursive: true, force: true })
	await rm(sessionDirRoot, { recursive: true, force: true })
})

function buildApp(msb: MsbCli = new FakeMsb()): {
	app: Hono
	msb: MsbCli
	lifecycle: SessionLifecycle
} {
	const snapshots = new SnapshotStore(storeRoot)
	const lifecycle = new SessionLifecycle(msb, snapshots, {
		sessionDirRoot,
		defaultMemoryMib: 1024,
		defaultCpus: 2,
	})
	const app = new Hono()
	app.route('/sessions', createSessionsLifecycleRoutes(lifecycle))
	return { app, msb, lifecycle }
}

describe('POST /sessions/:id/stop', () => {
	it('returns 200 with the stop result', async () => {
		const msb = new FakeMsb()
		const { app } = buildApp(msb)
		const res = await app.request('/sessions/sess-1/stop', { method: 'POST' })
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ sessionId: 'sess-1', stopped: true })
		expect(msb.removeCalls).toEqual(['sess-1'])
	})

	it('returns 400 on invalid session id', async () => {
		const { app } = buildApp()
		const res = await app.request('/sessions/..bad/stop', { method: 'POST' })
		expect(res.status).toBe(400)
	})
})

describe('POST /sessions/:id/snapshot', () => {
	it('snapshots and returns the new record', async () => {
		const sessionDir = join(sessionDirRoot, 'sess-1')
		await mkdir(join(sessionDir, 'workspace'), { recursive: true })
		await writeFile(join(sessionDir, 'workspace/note.md'), 'hello')
		const { app } = buildApp()
		const res = await app.request('/sessions/sess-1/snapshot', { method: 'POST' })
		expect(res.status).toBe(200)
		const body = (await res.json()) as { sessionId: string; snapshot: { snapshotId: string } }
		expect(body.sessionId).toBe('sess-1')
		expect(body.snapshot.snapshotId).toMatch(/^snap-/)
	})

	it('returns 500 when there is no session dir to snapshot', async () => {
		const { app } = buildApp()
		const res = await app.request('/sessions/sess-missing/snapshot', { method: 'POST' })
		expect(res.status).toBe(500)
	})
})

describe('POST /sessions/:id/restore', () => {
	async function seedSnapshot(): Promise<void> {
		const sessionDir = join(sessionDirRoot, 'sess-1')
		await mkdir(join(sessionDir, 'workspace'), { recursive: true })
		await writeFile(join(sessionDir, 'workspace/state.json'), '{"k":"v"}')
	}

	it('restores latest snapshot and boots a sandbox with same sessionId', async () => {
		await seedSnapshot()
		const msb = new FakeMsb()
		const { app } = buildApp(msb)
		await app.request('/sessions/sess-1/snapshot', { method: 'POST' })

		const res = await app.request('/sessions/sess-1/restore', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ image: 'maskin/agent-base:latest', env: { SAFE: 'ok' } }),
		})

		expect(res.status).toBe(200)
		const body = (await res.json()) as { sandboxName: string; sessionDir: string }
		expect(body.sandboxName).toBe('sess-1')
		expect(body.sessionDir).toBe(join(sessionDirRoot, 'sess-1'))
		expect(msb.createCalls).toHaveLength(1)
		expect(msb.createCalls[0]?.name).toBe('sess-1')
	})

	it('returns 400 when image is missing', async () => {
		await seedSnapshot()
		const { app } = buildApp()
		await app.request('/sessions/sess-1/snapshot', { method: 'POST' })
		const res = await app.request('/sessions/sess-1/restore', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ env: {} }),
		})
		expect(res.status).toBe(400)
	})

	it('returns 400 when env contains a non-string value', async () => {
		await seedSnapshot()
		const { app } = buildApp()
		await app.request('/sessions/sess-1/snapshot', { method: 'POST' })
		const res = await app.request('/sessions/sess-1/restore', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ image: 'maskin/agent-base:latest', env: { BAD: 42 } }),
		})
		expect(res.status).toBe(400)
	})

	it('returns 400 when body is not valid JSON', async () => {
		const { app } = buildApp()
		const res = await app.request('/sessions/sess-1/restore', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: 'not-json',
		})
		expect(res.status).toBe(400)
	})

	it('returns 404 when no snapshot exists for the session', async () => {
		const { app } = buildApp()
		const res = await app.request('/sessions/sess-missing/restore', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ image: 'maskin/agent-base:latest', env: {} }),
		})
		expect(res.status).toBe(404)
	})

	it('honours optional memoryMib / cpus / maxDurationSecs', async () => {
		await seedSnapshot()
		const msb = new FakeMsb()
		const { app } = buildApp(msb)
		await app.request('/sessions/sess-1/snapshot', { method: 'POST' })

		const res = await app.request('/sessions/sess-1/restore', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				image: 'maskin/agent-base:latest',
				env: {},
				memoryMib: 2048,
				cpus: 4,
				maxDurationSecs: 3600,
			}),
		})

		expect(res.status).toBe(200)
		expect(msb.createCalls[0]?.memoryMib).toBe(2048)
		expect(msb.createCalls[0]?.cpus).toBe(4)
		expect(msb.createCalls[0]?.maxDurationSecs).toBe(3600)
	})
})
