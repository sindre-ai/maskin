import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, actors, agentFiles, workspaceMembers } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { and, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createApiError, formatZodError } from '../../lib/errors'
import { AgentStorageManager } from '../../services/agent-storage'
import { insertActor, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

const { default: desktopTeachRoutes } = await import('../../routes/desktop-teach')

type Env = {
	Variables: {
		db: Database
		actorId: string
		agentStorage: AgentStorageManager
		sessionManager: unknown
	}
}

function createMemoryStorage(): StorageProvider & { _store: Map<string, Buffer> } {
	const store = new Map<string, Buffer>()
	return {
		_store: store,
		async put(key, data) {
			if (Buffer.isBuffer(data)) store.set(key, data)
			else if (data instanceof Uint8Array) store.set(key, Buffer.from(data))
			else throw new Error('Streaming put not supported in memory storage')
		},
		async get(key) {
			const buf = store.get(key)
			if (!buf) throw new Error(`Not found: ${key}`)
			return buf
		},
		async list(prefix) {
			return [...store.keys()].filter((k) => k.startsWith(prefix))
		},
		async listWithMetadata(prefix) {
			return [...store.entries()]
				.filter(([k]) => k.startsWith(prefix))
				.map(([key, buf]) => ({ key, size: buf.length }))
		},
		async delete(key) {
			store.delete(key)
		},
		async exists(key) {
			return store.has(key)
		},
		async ensureBucket() {},
	}
}

const SESSION_ID = '33333333-3333-4333-8333-333333333333'

function createApp(opts: { storage: StorageProvider; failSession?: boolean }) {
	const app = new OpenAPIHono<Env>({
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
	const createSession = vi.fn(async (_workspaceId: string, params: Record<string, unknown>) => {
		if (opts.failSession) throw new Error('plan cap reached')
		return { id: SESSION_ID, ...params }
	})
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', getTestActorId())
		c.set('agentStorage', new AgentStorageManager(opts.storage, db))
		c.set('sessionManager', { createSession })
		await next()
	})
	app.route('/api/desktop/teach', desktopTeachRoutes as never)
	return { app, createSession }
}

const jpeg = (extra = 200) =>
	Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(extra, 7)]).toString('base64')

function recording(agentId: string) {
	return {
		agent_id: agentId,
		description: 'Export the weekly report to PDF',
		duration_ms: 20_000,
		events: [
			{ type: 'click', t_ms: 1000, x: 640, y: 360, button: 'left', double: false, frame: 'f001' },
			{ type: 'type', t_ms: 2000, text: 'hunter2', frame: 'f002' },
		],
		frames: [
			{ id: 'f001', t_ms: 1000, data_base64: jpeg() },
			{ id: 'f002', t_ms: 2000, data_base64: jpeg(400) },
		],
		final_frame: 'f002',
	}
}

const post = (app: OpenAPIHono<Env>, workspaceId: string, body: unknown) =>
	app.request('/api/desktop/teach', {
		method: 'POST',
		headers: { 'X-Workspace-Id': workspaceId, 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	})

describe('Desktop teach integration', () => {
	let workspaceId: string
	let agentId: string
	let storage: ReturnType<typeof createMemoryStorage>

	beforeEach(async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		workspaceId = ws.id
		const agent = await insertActor(db, { type: 'agent', name: 'Chief of Staff' })
		agentId = agent.id
		await db.insert(workspaceMembers).values({ workspaceId, actorId: agentId, role: 'member' })
		storage = createMemoryStorage()
	})

	const teachRows = () =>
		db
			.select()
			.from(agentFiles)
			.where(
				and(
					eq(agentFiles.actorId, agentId),
					eq(agentFiles.workspaceId, workspaceId),
					eq(agentFiles.fileType, 'teach'),
				),
			)

	it("stores the recording as the agent's files, in the database and in storage", async () => {
		const { app, createSession } = createApp({ storage })

		const res = await post(app, workspaceId, recording(agentId))
		const out = (await res.json()) as { recording_id: string; session_id: string }

		expect(res.status).toBe(201)
		expect(out.session_id).toBe(SESSION_ID)
		const rows = await teachRows()
		expect(rows.map((r) => r.path).sort()).toEqual([
			`teach/${out.recording_id}/README.md`,
			`teach/${out.recording_id}/frames/f001.jpg`,
			`teach/${out.recording_id}/frames/f002.jpg`,
			`teach/${out.recording_id}/log.json`,
		])
		// Every row points at a real stored object of the recorded size.
		for (const row of rows) {
			expect(storage._store.get(row.storageKey)?.length).toBe(row.sizeBytes)
			expect(row.storageKey).toBe(`agents/${workspaceId}/${agentId}/${row.path}`)
		}
		const log = JSON.parse(
			storage._store
				.get(`agents/${workspaceId}/${agentId}/teach/${out.recording_id}/log.json`)
				?.toString('utf8') ?? '{}',
		)
		expect(log.actions[1]).toMatchObject({ action: 'type', text: 'hunter2' })
		expect(createSession).toHaveBeenCalledTimes(1)
	})

	it('writes an audit event with counts only', async () => {
		const { app } = createApp({ storage })

		await post(app, workspaceId, recording(agentId))

		const rows = await db
			.select()
			.from(events)
			.where(and(eq(events.workspaceId, workspaceId), eq(events.entityType, 'workspace_desktop')))
		expect(rows).toHaveLength(1)
		expect(rows[0]?.data).toMatchObject({ teach: true, agent_id: agentId, frames: 2, events: 2 })
		const stored = JSON.stringify(rows[0]?.data)
		expect(stored).not.toContain('hunter2')
		expect(stored).not.toContain('weekly report')
	})

	it('removes only that recording on DELETE, from the database and storage', async () => {
		const { app } = createApp({ storage })
		const a = (await (await post(app, workspaceId, recording(agentId))).json()) as {
			recording_id: string
		}
		const b = (await (await post(app, workspaceId, recording(agentId))).json()) as {
			recording_id: string
		}

		const res = await app.request(`/api/desktop/teach/${a.recording_id}?agent_id=${agentId}`, {
			method: 'DELETE',
			headers: { 'X-Workspace-Id': workspaceId },
		})

		expect(await res.json()).toEqual({ deleted: 4 })
		const left = (await teachRows()).map((r) => r.path)
		expect(left.every((p) => p.startsWith(`teach/${b.recording_id}/`))).toBe(true)
		expect(left).toHaveLength(4)
		expect([...storage._store.keys()].some((k) => k.includes(a.recording_id))).toBe(false)
		expect([...storage._store.keys()].filter((k) => k.includes(b.recording_id))).toHaveLength(4)
	})

	it('is idempotent: deleting an already-deleted recording is a no-op', async () => {
		const { app } = createApp({ storage })
		const r = (await (await post(app, workspaceId, recording(agentId))).json()) as {
			recording_id: string
		}
		const del = () =>
			app.request(`/api/desktop/teach/${r.recording_id}?agent_id=${agentId}`, {
				method: 'DELETE',
				headers: { 'X-Workspace-Id': workspaceId },
			})

		expect(await (await del()).json()).toEqual({ deleted: 4 })
		expect(await (await del()).json()).toEqual({ deleted: 0 })
	})

	it("sweeps this agent's expired recordings on the next teach, keeping recent ones", async () => {
		const mgr = new AgentStorageManager(storage, db)
		await mgr.uploadFile(agentId, workspaceId, 'teach', 'aaaaaaaaaaaa/log.json', Buffer.from('{}'))
		await mgr.uploadFile(agentId, workspaceId, 'teach', 'bbbbbbbbbbbb/log.json', Buffer.from('{}'))
		// Age the first one past the retention window.
		await db
			.update(agentFiles)
			.set({ updatedAt: new Date(Date.now() - 7 * 60 * 60 * 1000) })
			.where(
				and(eq(agentFiles.actorId, agentId), eq(agentFiles.path, 'teach/aaaaaaaaaaaa/log.json')),
			)
		const { app } = createApp({ storage })

		await post(app, workspaceId, recording(agentId))

		const paths = (await teachRows()).map((r) => r.path)
		expect(paths).not.toContain('teach/aaaaaaaaaaaa/log.json')
		expect(paths).toContain('teach/bbbbbbbbbbbb/log.json')
		expect(storage._store.has(`agents/${workspaceId}/${agentId}/teach/aaaaaaaaaaaa/log.json`)).toBe(
			false,
		)
	})

	it("does not sweep another agent's recordings", async () => {
		const other = await insertActor(db, { type: 'agent', name: 'Researcher' })
		await db.insert(workspaceMembers).values({ workspaceId, actorId: other.id, role: 'member' })
		const mgr = new AgentStorageManager(storage, db)
		await mgr.uploadFile(other.id, workspaceId, 'teach', 'cccccccccccc/log.json', Buffer.from('{}'))
		await db
			.update(agentFiles)
			.set({ updatedAt: new Date(Date.now() - 7 * 60 * 60 * 1000) })
			.where(eq(agentFiles.actorId, other.id))
		const { app } = createApp({ storage })

		await post(app, workspaceId, recording(agentId))

		const rows = await db.select().from(agentFiles).where(eq(agentFiles.actorId, other.id))
		expect(rows).toHaveLength(1)
	})

	it('rolls the stored files back when the session cannot start', async () => {
		const { app } = createApp({ storage, failSession: true })

		const res = await post(app, workspaceId, recording(agentId))

		expect(res.status).toBe(502)
		expect(await teachRows()).toHaveLength(0)
		expect(storage._store.size).toBe(0)
		const audit = await db
			.select()
			.from(events)
			.where(and(eq(events.workspaceId, workspaceId), eq(events.entityType, 'workspace_desktop')))
		expect(audit).toHaveLength(0)
	})

	it('404s for a human, and for an agent that belongs to another workspace', async () => {
		const { app } = createApp({ storage })
		const human = await insertActor(db, { type: 'human', name: 'A Human' })
		await db.insert(workspaceMembers).values({ workspaceId, actorId: human.id, role: 'member' })
		const outsider = await insertActor(db, { type: 'agent', name: 'Elsewhere' })

		expect((await post(app, workspaceId, recording(human.id))).status).toBe(404)
		expect((await post(app, workspaceId, recording(outsider.id))).status).toBe(404)
		expect(storage._store.size).toBe(0)
	})

	it('keeps the agent unchanged: teaching writes files, never actor rows', async () => {
		const { app } = createApp({ storage })
		const before = (await db.select().from(actors).where(eq(actors.id, agentId)))[0]

		await post(app, workspaceId, recording(agentId))

		const after = (await db.select().from(actors).where(eq(actors.id, agentId)))[0]
		expect(after).toEqual(before)
	})
})
