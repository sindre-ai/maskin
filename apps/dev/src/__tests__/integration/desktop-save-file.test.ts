import { OpenAPIHono } from '@hono/zod-openapi'
import { events, files } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

const { default: desktopRoutes } = await import('../../routes/desktop')

const MiB = 1024 * 1024
const HASH = 'a'.repeat(64)

// Stands in for S3: remembers which keys hold bytes and how many.
function createStorage() {
	const objects = new Map<string, number>()
	return {
		objects,
		/** What the "computer" uploaded, when set by a test. */
		async presignUpload(key: string) {
			return `https://storage.test/upload/${key}`
		},
		async headObject(key: string) {
			const size = objects.get(key)
			return size === undefined ? null : { size }
		},
		async delete(key: string) {
			objects.delete(key)
		},
	}
}

// Stands in for the computer: runs "the upload" by writing to the fake storage, then reports.
function createComputer(storage: ReturnType<typeof createStorage>) {
	const state = { reportedSize: 10 * MiB, storedSize: 10 * MiB, exitCode: 0, stdout: '' }
	const control = async (
		_ws: string,
		_agent: string,
		_action: string,
		body: { command: string },
	) => {
		if (state.exitCode !== 0) {
			return {
				status: 200,
				body: { exit_code: state.exitCode, stdout: state.stdout, stderr: '', timed_out: false },
			}
		}
		const url = /'(https:\/\/storage\.test\/upload\/[^']+)'/.exec(body.command)?.[1]
		const key = url?.replace('https://storage.test/upload/', '')
		if (key) storage.objects.set(key, state.storedSize)
		return {
			status: 200,
			body: {
				exit_code: 0,
				stdout: `/home/user/renders/clip.mp4\n${state.reportedSize}\n${HASH}\n${state.reportedSize}\n`,
				stderr: '',
				timed_out: false,
			},
		}
	}
	return { state, control }
}

function createApp(
	storage: ReturnType<typeof createStorage>,
	control: ReturnType<typeof createComputer>['control'],
) {
	const app = new OpenAPIHono()
	app.use('*', async (c, next) => {
		c.set('db' as never, db as never)
		// An agent reaches its own computer, so no membership row is needed for the gate.
		c.set('actorId' as never, getTestActorId() as never)
		c.set('actorType' as never, 'agent' as never)
		c.set('workspaceRole' as never, 'owner' as never)
		c.set('storageProvider' as never, storage as never)
		c.set('desktopService' as never, { control } as never)
		await next()
	})
	app.route('/api/desktop', desktopRoutes as never)
	return app
}

describe('POST /api/desktop/save-file', () => {
	let workspaceId: string

	beforeEach(async () => {
		workspaceId = (await insertWorkspace(db, getTestActorId())).id
	})

	const save = (
		app: ReturnType<typeof createApp>,
		body: unknown = { path: '~/renders/clip.mp4' },
	) =>
		app.request('/api/desktop/save-file', {
			method: 'POST',
			headers: { 'X-Workspace-Id': workspaceId, 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		})

	const filesIn = () => db.select().from(files).where(eq(files.workspaceId, workspaceId))

	it('round-trips a 10 MB file into a new file row and records the audit events', async () => {
		const storage = createStorage()
		const computer = createComputer(storage)
		const app = createApp(storage, computer.control)

		const res = await save(app)

		expect(res.status).toBe(201)
		const body = await res.json()
		const [row] = await filesIn()
		expect(row).toMatchObject({
			id: body.file_id,
			name: 'clip.mp4',
			mimeType: 'video/mp4',
			sizeBytes: 10 * MiB,
			contentHash: HASH,
			storageKey: `workspaces/${workspaceId}/files/${body.file_id}`,
			createdBy: getTestActorId(),
		})
		expect(storage.objects.get(row?.storageKey ?? '')).toBe(10 * MiB)
		const trail = await db.select().from(events).where(eq(events.workspaceId, workspaceId))
		expect(trail.map((e) => `${e.entityType}:${e.action}`).sort()).toEqual([
			'file:created',
			'workspace_desktop:updated',
		])
	})

	it('makes a new file every time and never overwrites the earlier one', async () => {
		const storage = createStorage()
		const app = createApp(storage, createComputer(storage).control)

		const first = await (await save(app)).json()
		const second = await (await save(app)).json()

		expect(second.file_id).not.toBe(first.file_id)
		expect(await filesIn()).toHaveLength(2)
		expect(storage.objects.size).toBe(2)
	})

	it('deletes the stored object and makes no file when the stored size differs from the reported one', async () => {
		const storage = createStorage()
		const computer = createComputer(storage)
		computer.state.storedSize = 10 * MiB - 1
		const app = createApp(storage, computer.control)

		const res = await save(app)

		expect(res.status).toBe(502)
		expect(await filesIn()).toHaveLength(0)
		expect(storage.objects.size).toBe(0)
		const trail = await db.select().from(events).where(eq(events.workspaceId, workspaceId))
		expect(trail).toHaveLength(0)
	})

	it('refuses a file over the cap with nothing stored and no file', async () => {
		const storage = createStorage()
		const computer = createComputer(storage)
		computer.state.exitCode = 44
		computer.state.stdout = `TOOBIG ${101 * MiB}\n`
		const app = createApp(storage, computer.control)

		const res = await save(app)

		expect(res.status).toBe(400)
		expect(await filesIn()).toHaveLength(0)
		expect(storage.objects.size).toBe(0)
	})

	it('refuses the 21st save within an hour, counted from the real audit rows', async () => {
		const storage = createStorage()
		const app = createApp(storage, createComputer(storage).control)

		for (let i = 0; i < 20; i++) expect((await save(app)).status).toBe(201)
		const res = await save(app)

		expect(res.status).toBe(429)
		expect(await filesIn()).toHaveLength(20)
	})

	it('does not count saves older than an hour, or saves by another computer', async () => {
		const storage = createStorage()
		const app = createApp(storage, createComputer(storage).control)
		const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
		const rows = Array.from({ length: 20 }, () => ({
			workspaceId,
			actorId: getTestActorId(),
			action: 'updated',
			entityType: 'workspace_desktop',
			entityId: workspaceId,
			data: { agent_id: getTestActorId(), control: 'save_file' },
			createdAt: old,
		}))
		await db.insert(events).values(rows)
		await db.insert(events).values(
			Array.from({ length: 20 }, () => ({
				workspaceId,
				actorId: getTestActorId(),
				action: 'updated',
				entityType: 'workspace_desktop',
				entityId: workspaceId,
				data: { agent_id: '00000000-0000-4000-8000-000000000001', control: 'save_file' },
			})),
		)

		expect((await save(app)).status).toBe(201)
		expect(
			await db
				.select()
				.from(events)
				.where(and(eq(events.workspaceId, workspaceId), eq(events.entityType, 'file'))),
		).toHaveLength(1)
	})
})
