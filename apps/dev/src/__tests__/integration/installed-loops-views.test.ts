import { randomUUID } from 'node:crypto'
import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import {
	files,
	installedLoops,
	marketplaceLoopItems,
	marketplaceLoops,
	objects,
} from '@maskin/db/schema'
import { readLoopViews } from '@maskin/shared'
import type { StorageProvider } from '@maskin/storage'
import { eq } from 'drizzle-orm'
import { createApiError, formatZodError } from '../../lib/errors'
import { sha256Hex } from '../../lib/file-save'
import { fileStorageKey } from '../../lib/file-urls'
import { LOOP_ID_TOKEN } from '../../lib/marketplace-loops/view-snapshot'
import { AgentStorageManager } from '../../services/agent-storage'
import { LoopVersionPusher } from '../../services/loop-version-pusher'
import { readInstalledViews } from '../../services/loop-views-provisioning'
import { insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { db, getTestActorId, sql as rawSql } from './global-setup'

const { default: installedLoopsRoutes } = await import('../../routes/installed-loops')

type Env = {
	Variables: {
		db: Database
		actorId: string
		agentStorage: AgentStorageManager
		storageProvider: StorageProvider
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
		async ensureBucket() {
			// no-op
		},
	} as StorageProvider & { _store: Map<string, Buffer> }
}

function createInstalledLoopsApp(storage: StorageProvider) {
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
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', getTestActorId())
		c.set('agentStorage', new AgentStorageManager(storage, db))
		c.set('storageProvider', storage)
		await next()
	})
	app.route('/api/installed-loops', installedLoopsRoutes)
	return app
}

const RADAR_SOURCE = randomUUID()
const PIPELINE_SOURCE = randomUUID()
const radarHtml = (text: string) => `<html><body><h1>${text}</h1></body></html>`
const pipelineHtml = (text: string) =>
	`<html><body><script id="maskin-sources" type="application/json">{"n":{"scope":"${LOOP_ID_TOKEN}","type":"insight","group_by":"status"}}</script><h1>${text}</h1></body></html>`

async function seedLoop(
	views: Array<{ source: string; name: string; position: number; html: string }>,
) {
	const [loop] = await db
		.insert(marketplaceLoops)
		.values({
			name: 'View Kit',
			slug: `view-kit-${randomUUID()}`,
			description: 'A loop with tabs',
			version: '1.0.0',
			useCase: 'development',
		})
		.returning()
	if (!loop) throw new Error('marketplace_loops insert returned no row')
	if (views.length > 0) {
		await db.insert(marketplaceLoopItems).values(
			views.map((v) => ({
				loopId: loop.id,
				itemType: 'view',
				sourceItemId: v.source,
				itemSnapshot: { name: v.name, position: v.position, html: v.html },
			})),
		)
	}
	return loop
}

async function install(
	app: ReturnType<typeof createInstalledLoopsApp>,
	loopId: string,
	workspaceId: string,
) {
	const res = await app.request(
		jsonRequest('POST', '/api/installed-loops', { loopId, workspaceId }),
	)
	expect(res.status).toBe(201)
	return (await res.json()) as { id: string; objectId: string }
}

async function loopObject(objectId: string) {
	const [row] = await db.select().from(objects).where(eq(objects.id, objectId))
	if (!row) throw new Error('loop object not found')
	return row
}

async function fileText(
	storage: ReturnType<typeof createMemoryStorage>,
	workspaceId: string,
	id: string,
) {
	return storage._store.get(fileStorageKey(workspaceId, id))?.toString('utf-8')
}

describe('Installed Loops — views', () => {
	let workspaceId: string
	let storage: ReturnType<typeof createMemoryStorage>

	beforeEach(async () => {
		await rawSql`TRUNCATE marketplace_loops, marketplace_loop_items CASCADE`
		const ws = await insertWorkspace(db, getTestActorId())
		if (!ws) throw new Error('workspace insert returned no row')
		workspaceId = ws.id
		storage = createMemoryStorage()
	})

	const twoViews = () => [
		{ source: PIPELINE_SOURCE, name: 'Pipeline', position: 1, html: pipelineHtml('v1') },
		{ source: RADAR_SOURCE, name: 'Radar', position: 0, html: radarHtml('v1') },
	]

	it('gives the new loop its tabs in order, each a new page in the installer workspace', async () => {
		const loop = await seedLoop(twoViews())
		const app = createInstalledLoopsApp(storage)

		const installed = await install(app, loop.id, workspaceId)
		const object = await loopObject(installed.objectId)
		const views = readLoopViews(object.metadata as Record<string, unknown>)
		expect(views.map((v) => v.name)).toEqual(['Radar', 'Pipeline'])

		const rows = await db.select().from(files).where(eq(files.workspaceId, workspaceId))
		expect(rows).toHaveLength(2)
		for (const view of views) {
			const row = rows.find((r) => r.id === view.fileId)
			expect(row?.mimeType).toBe('text/html')
			expect(row?.createdBy).toBe(getTestActorId())
		}

		// The loop id token became this install's loop object id.
		const pipeline = views.find((v) => v.name === 'Pipeline')
		const html = await fileText(storage, workspaceId, pipeline?.fileId ?? '')
		expect(html).toContain(`"scope":"${installed.objectId}"`)
		expect(html).not.toContain(LOOP_ID_TOKEN)
	})

	it('gives a second install in another workspace its own files', async () => {
		const loop = await seedLoop(twoViews())
		const other = await insertWorkspace(db, getTestActorId())
		if (!other) throw new Error('workspace insert returned no row')
		const app = createInstalledLoopsApp(storage)

		const first = await install(app, loop.id, workspaceId)
		const second = await install(app, loop.id, other.id)

		const firstIds = readLoopViews((await loopObject(first.objectId)).metadata as never).map(
			(v) => v.fileId,
		)
		const secondIds = readLoopViews((await loopObject(second.objectId)).metadata as never).map(
			(v) => v.fileId,
		)
		expect(secondIds).toHaveLength(2)
		for (const id of secondIds) expect(firstIds).not.toContain(id)

		const secondRows = await db.select().from(files).where(eq(files.workspaceId, other.id))
		expect(secondRows.map((r) => r.id).sort()).toEqual([...secondIds].sort())
		const html = await fileText(storage, other.id, secondIds[1] ?? '')
		expect(html).toContain(second.objectId)
		expect(html).not.toContain(first.objectId)
	})

	it('leaves a loop with no views as it was', async () => {
		const loop = await seedLoop([])
		const app = createInstalledLoopsApp(storage)

		const installed = await install(app, loop.id, workspaceId)
		const object = await loopObject(installed.objectId)
		expect(readLoopViews(object.metadata as never)).toEqual([])
		expect(readInstalledViews(object.metadata)).toEqual([])
		expect(await db.select().from(files).where(eq(files.workspaceId, workspaceId))).toHaveLength(0)
	})

	describe('version push', () => {
		async function publishNextVersion(loopId: string) {
			await db
				.update(marketplaceLoops)
				.set({ version: '1.1.0' })
				.where(eq(marketplaceLoops.id, loopId))
			await new LoopVersionPusher(
				db,
				new AgentStorageManager(storage, db),
				undefined,
				storage,
			).tick()
		}

		async function setPage(loopId: string, source: string, snapshot: Record<string, unknown>) {
			const items = await db
				.select()
				.from(marketplaceLoopItems)
				.where(eq(marketplaceLoopItems.loopId, loopId))
			const item = items.find((i) => i.sourceItemId === source)
			if (!item) throw new Error('view item not found')
			await db
				.update(marketplaceLoopItems)
				.set({ itemSnapshot: { ...(item.itemSnapshot as object), ...snapshot } })
				.where(eq(marketplaceLoopItems.id, item.id))
		}

		it('writes the changed page into the installed copy and keeps the file and tab', async () => {
			const loop = await seedLoop(twoViews())
			const installed = await install(createInstalledLoopsApp(storage), loop.id, workspaceId)
			const before = readLoopViews((await loopObject(installed.objectId)).metadata as never)

			await setPage(loop.id, RADAR_SOURCE, { html: radarHtml('v2') })
			await publishNextVersion(loop.id)

			const after = readLoopViews((await loopObject(installed.objectId)).metadata as never)
			expect(after).toEqual(before)
			const radar = after.find((v) => v.name === 'Radar')
			expect(await fileText(storage, workspaceId, radar?.fileId ?? '')).toBe(radarHtml('v2'))
			const [row] = await db
				.select()
				.from(files)
				.where(eq(files.id, radar?.fileId ?? ''))
			expect(row?.contentHash).toBe(sha256Hex(Buffer.from(radarHtml('v2'))))
			const [install_] = await db
				.select()
				.from(installedLoops)
				.where(eq(installedLoops.id, installed.id))
			expect(install_?.installedVersion).toBe('1.1.0')
		})

		it('leaves a page the workspace has edited alone', async () => {
			const loop = await seedLoop(twoViews())
			const installed = await install(createInstalledLoopsApp(storage), loop.id, workspaceId)
			const radar = readLoopViews((await loopObject(installed.objectId)).metadata as never).find(
				(v) => v.name === 'Radar',
			)
			const edited = radarHtml('written by the loop agents')
			await db
				.update(files)
				.set({ contentHash: sha256Hex(Buffer.from(edited)) })
				.where(eq(files.id, radar?.fileId ?? ''))
			storage._store.set(fileStorageKey(workspaceId, radar?.fileId ?? ''), Buffer.from(edited))

			await setPage(loop.id, RADAR_SOURCE, { html: radarHtml('v2') })
			await publishNextVersion(loop.id)

			expect(await fileText(storage, workspaceId, radar?.fileId ?? '')).toBe(edited)
		})

		it('adds a new view and removes one the loop no longer publishes', async () => {
			const loop = await seedLoop(twoViews())
			const installed = await install(createInstalledLoopsApp(storage), loop.id, workspaceId)
			const before = readLoopViews((await loopObject(installed.objectId)).metadata as never)
			const pipeline = before.find((v) => v.name === 'Pipeline')

			await db.insert(marketplaceLoopItems).values({
				loopId: loop.id,
				itemType: 'view',
				sourceItemId: randomUUID(),
				itemSnapshot: { name: 'Briefing', position: 2, html: radarHtml('new') },
			})
			await db
				.delete(marketplaceLoopItems)
				.where(eq(marketplaceLoopItems.sourceItemId, PIPELINE_SOURCE))
			await publishNextVersion(loop.id)

			const after = readLoopViews((await loopObject(installed.objectId)).metadata as never)
			expect(after.map((v) => v.name)).toEqual(['Radar', 'Briefing'])
			expect(
				await db
					.select()
					.from(files)
					.where(eq(files.id, pipeline?.fileId ?? '')),
			).toHaveLength(0)
			expect(await fileText(storage, workspaceId, pipeline?.fileId ?? '')).toBeUndefined()
		})

		it('keeps a tab a person added', async () => {
			const loop = await seedLoop(twoViews())
			const installed = await install(createInstalledLoopsApp(storage), loop.id, workspaceId)
			const object = await loopObject(installed.objectId)
			const own = { name: 'My tab', file_id: randomUUID() }
			await db
				.update(objects)
				.set({
					metadata: {
						...(object.metadata as object),
						views: [...((object.metadata as { views: unknown[] }).views ?? []), own],
					},
				})
				.where(eq(objects.id, installed.objectId))

			await db
				.delete(marketplaceLoopItems)
				.where(eq(marketplaceLoopItems.sourceItemId, RADAR_SOURCE))
			await publishNextVersion(loop.id)

			const after = readLoopViews((await loopObject(installed.objectId)).metadata as never)
			expect(after.map((v) => v.name)).toEqual(['Pipeline', 'My tab'])
		})
	})

	describe('uninstall', () => {
		it('removes the pages the install created', async () => {
			const loop = await seedLoop(twoViews())
			const app = createInstalledLoopsApp(storage)
			const installed = await install(app, loop.id, workspaceId)
			const fileIds = readLoopViews((await loopObject(installed.objectId)).metadata as never).map(
				(v) => v.fileId,
			)
			// A page someone else made in the workspace is not the install's.
			const [unrelated] = await db
				.insert(files)
				.values({
					workspaceId,
					name: 'notes.html',
					mimeType: 'text/html',
					sizeBytes: 1,
					storageKey: fileStorageKey(workspaceId, randomUUID()),
					createdBy: getTestActorId(),
				})
				.returning()

			const res = await app.request(
				jsonRequest('DELETE', `/api/installed-loops/${installed.id}`, {
					keepProvisionedItems: false,
				}),
			)
			expect(res.status).toBe(200)

			const remaining = await db.select().from(files).where(eq(files.workspaceId, workspaceId))
			expect(remaining.map((r) => r.id)).toEqual([unrelated?.id])
			for (const id of fileIds) {
				expect(await fileText(storage, workspaceId, id)).toBeUndefined()
			}
		})
	})
})
