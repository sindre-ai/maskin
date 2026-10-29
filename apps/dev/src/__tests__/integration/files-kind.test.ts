import { OpenAPIHono } from '@hono/zod-openapi'
import { files } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { insertWorkspace } from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

const { default: filesRoutes } = await import('../../routes/files')

// `kind` marks a file as a For you briefing; the list endpoint filters on it so the
// app shows only briefings and not every HTML file a loop happens to produce.
function createApp() {
	const bytes = new Map<string, Buffer>()
	const app = new OpenAPIHono()
	app.use('*', async (c, next) => {
		c.set('db' as never, db as never)
		c.set('actorId' as never, getTestActorId() as never)
		c.set('workspaceRole' as never, 'owner' as never)
		c.set(
			'storageProvider' as never,
			{
				put: async (key: string, data: Buffer) => void bytes.set(key, data),
				get: async (key: string) => bytes.get(key) ?? Buffer.alloc(0),
			} as never,
		)
		await next()
	})
	app.route('/api/files', filesRoutes as never)
	return app
}

describe('files.kind', () => {
	let workspaceId: string

	beforeEach(async () => {
		workspaceId = (await insertWorkspace(db, getTestActorId())).id
	})

	const headers = () => ({ 'X-Workspace-Id': workspaceId })
	const html = (name: string, kind?: 'briefing') => ({
		name,
		mime_type: 'text/html',
		content: '<h1>Today</h1>',
		...(kind ? { kind } : {}),
	})

	it('stores the kind on create and returns it', async () => {
		const res = await createApp().request(
			jsonRequest('POST', '/api/files', html('briefing.html', 'briefing'), headers()),
		)
		expect(res.status).toBe(201)
		const created = (await res.json()) as { id: string; kind: string | null }
		expect(created.kind).toBe('briefing')

		const [row] = await db.select().from(files).where(eq(files.id, created.id))
		expect(row?.kind).toBe('briefing')
	})

	it('leaves kind null for an ordinary file', async () => {
		const res = await createApp().request(
			jsonRequest('POST', '/api/files', html('notes.html'), headers()),
		)
		expect(((await res.json()) as { kind: string | null }).kind).toBeNull()
	})

	it('lists only briefings when filtered by kind', async () => {
		const app = createApp()
		for (const body of [
			html('b1.html', 'briefing'),
			html('plain.html'),
			html('b2.html', 'briefing'),
		]) {
			await app.request(jsonRequest('POST', '/api/files', body, headers()))
		}

		const res = await app.request(jsonGet('/api/files?kind=briefing', headers()))
		expect(res.status).toBe(200)
		const rows = (await res.json()) as Array<{ name: string; kind: string }>
		expect(rows.map((r) => r.name).sort()).toEqual(['b1.html', 'b2.html'])
		expect(rows.every((r) => r.kind === 'briefing')).toBe(true)

		const all = (await (await app.request(jsonGet('/api/files', headers()))).json()) as unknown[]
		expect(all).toHaveLength(3)
	})

	it('sets and clears kind on update', async () => {
		const app = createApp()
		const created = (await (
			await app.request(jsonRequest('POST', '/api/files', html('later.html'), headers()))
		).json()) as { id: string }

		const set = await app.request(
			jsonRequest('PATCH', `/api/files/${created.id}`, { kind: 'briefing' }, headers()),
		)
		expect(((await set.json()) as { kind: string | null }).kind).toBe('briefing')

		const cleared = await app.request(
			jsonRequest('PATCH', `/api/files/${created.id}`, { kind: null }, headers()),
		)
		expect(((await cleared.json()) as { kind: string | null }).kind).toBeNull()
	})

	it('rejects an unknown kind', async () => {
		const res = await createApp().request(
			jsonRequest('POST', '/api/files', { ...html('x.html'), kind: 'newsletter' }, headers()),
		)
		expect(res.status).toBe(400)
	})

	it('does not list another workspace’s briefings', async () => {
		const app = createApp()
		await app.request(jsonRequest('POST', '/api/files', html('mine.html', 'briefing'), headers()))
		const other = (await insertWorkspace(db, getTestActorId())).id
		const res = await app.request(jsonGet('/api/files?kind=briefing', { 'X-Workspace-Id': other }))
		expect(await res.json()).toEqual([])
	})
})
