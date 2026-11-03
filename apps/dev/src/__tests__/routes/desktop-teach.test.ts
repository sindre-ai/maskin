import { OpenAPIHono } from '@hono/zod-openapi'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import desktopTeachRoutes from '../../routes/desktop-teach'

const WS = '11111111-1111-4111-8111-111111111111'
const AGENT = '22222222-2222-4222-8222-222222222222'
const ACTOR = 'test-actor-id'
const SESSION = '33333333-3333-4333-8333-333333333333'

// A tiny but real JPEG header + padding: decodeTeachFrames only checks magic bytes
// and size, which is what it should (it is not an image decoder).
const jpegBase64 = (extra = 200) =>
	Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(extra, 7)]).toString('base64')

const click = (over: Record<string, unknown> = {}) => ({
	type: 'click',
	t_ms: 1200,
	x: 640,
	y: 360,
	button: 'left',
	frame: 'f001',
	...over,
})

const body = (over: Record<string, unknown> = {}) => ({
	agent_id: AGENT,
	description: 'Export the weekly report to PDF',
	duration_ms: 20_000,
	events: [click(), { type: 'type', t_ms: 3000, text: 'hunter2', frame: 'f002' }],
	frames: [
		{ id: 'f001', t_ms: 1200, data_base64: jpegBase64() },
		{ id: 'f002', t_ms: 3000, data_base64: jpegBase64(300) },
	],
	...over,
})

function build(
	opts: {
		agent?: { id: string; name: string } | null
		records?: Array<{ path: string; updatedAt: Date; createdAt: Date }>
		failUploadAt?: number
		failSession?: boolean
	} = {},
) {
	const agent = opts.agent === undefined ? { id: AGENT, name: 'Chief of Staff' } : opts.agent
	const uploads: Array<{ path: string; bytes: number }> = []
	const deletes: string[] = []
	const events: unknown[] = []
	const storage = {
		uploadFile: vi.fn(async (_a: string, _w: string, _t: string, path: string, data: Buffer) => {
			if (opts.failUploadAt !== undefined && uploads.length === opts.failUploadAt) {
				throw new Error('s3 down')
			}
			uploads.push({ path, bytes: data.length })
			return `key/${path}`
		}),
		listFileRecords: vi.fn(async () => [
			...uploads.map((u) => ({
				path: `teach/${u.path}`,
				updatedAt: new Date(),
				createdAt: new Date(),
			})),
			...(opts.records ?? []),
		]),
		deleteFile: vi.fn(async (_a: string, _w: string, _t: string, path: string) => {
			deletes.push(path)
		}),
	}
	const createSession = vi.fn(async (_ws: string, params: Record<string, unknown>) => {
		if (opts.failSession) throw new Error('billing cap')
		return { id: SESSION, ...params }
	})
	// db.select().from().innerJoin().where().limit() -> [agent]
	const chain: Record<string, unknown> = {}
	for (const m of ['from', 'innerJoin', 'where']) chain[m] = () => chain
	chain.limit = async () => (agent ? [agent] : [])
	const db = {
		select: () => chain,
		insert: () => ({
			values: async (row: unknown) => {
				events.push(row)
			},
		}),
	}
	const app = new OpenAPIHono<{ Variables: Record<string, unknown> }>()
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', ACTOR)
		c.set('agentStorage', storage)
		c.set('sessionManager', { createSession })
		await next()
	})
	app.route('/api/desktop/teach', desktopTeachRoutes as never)
	return { app, storage, uploads, deletes, events, createSession }
}

type TestApp = ReturnType<typeof build>['app']

const post = (app: TestApp, payload: unknown) =>
	app.request('/api/desktop/teach', {
		method: 'POST',
		headers: { 'X-Workspace-Id': WS, 'Content-Type': 'application/json' },
		body: JSON.stringify(payload),
	})

describe('POST /api/desktop/teach', () => {
	beforeEach(() => {})

	it('404s when the agent is not an agent in this workspace', async () => {
		const t = build({ agent: null })

		expect((await post(t.app, body())).status).toBe(404)
		expect(t.storage.uploadFile).not.toHaveBeenCalled()
	})

	it("stores the recording as the agent's files and starts a session for that agent", async () => {
		const t = build()

		const res = await post(t.app, body())
		const out = (await res.json()) as {
			recording_id: string
			session_id: string
			frames_stored: number
			events_stored: number
		}

		expect(res.status).toBe(201)
		expect(out).toMatchObject({ session_id: SESSION, frames_stored: 2, events_stored: 2 })
		expect(out.recording_id).toMatch(/^[0-9a-f]{12}$/)
		const id = out.recording_id
		expect(t.uploads.map((u) => u.path).sort()).toEqual([
			`${id}/README.md`,
			`${id}/frames/f001.jpg`,
			`${id}/frames/f002.jpg`,
			`${id}/log.json`,
		])
		// Written for the chosen agent, under the 'teach' file type.
		expect(t.storage.uploadFile).toHaveBeenCalledWith(
			AGENT,
			WS,
			'teach',
			expect.any(String),
			expect.any(Buffer),
		)
		const [wsArg, params] = t.createSession.mock.calls[0] as [string, Record<string, unknown>]
		expect(wsArg).toBe(WS)
		expect(params).toMatchObject({ actorId: AGENT, createdBy: ACTOR })
		const prompt = String(params.actionPrompt)
		expect(prompt).toContain(`/agent/teach/${id}/`)
		expect(prompt).toContain('Export the weekly report to PDF')
		expect(prompt).toContain('attach_skill_ids')
		expect(prompt).toContain(AGENT)
	})

	it('writes the action log with steps in order, pointing at their screenshots', async () => {
		const t = build()
		await post(t.app, body())

		const logCall = (t.storage.uploadFile.mock.calls as unknown[][]).find((c) =>
			String(c[3]).endsWith('/log.json'),
		) as unknown[]
		const log = JSON.parse((logCall[4] as Buffer).toString('utf8'))
		expect(log.task).toBe('Export the weekly report to PDF')
		expect(log.screen).toEqual({ width: 1280, height: 720 })
		expect(log.actions[0]).toMatchObject({
			step: 1,
			action: 'click',
			x: 640,
			y: 360,
			screenshot: 'frames/f001.jpg',
		})
		expect(log.actions[1]).toMatchObject({ step: 2, action: 'type', text: 'hunter2' })
	})

	it('audits counts only, never the description or the typed text', async () => {
		const t = build()
		await post(t.app, body())

		expect(t.events).toHaveLength(1)
		expect(t.events[0]).toMatchObject({
			entityType: 'workspace_desktop',
			data: { teach: true, agent_id: AGENT, session_id: SESSION, frames: 2, events: 2 },
		})
		const audit = JSON.stringify(t.events[0])
		expect(audit).not.toContain('hunter2')
		expect(audit).not.toContain('weekly report')
	})

	it.each([
		[
			'a frame that is not a JPEG',
			() =>
				body({
					frames: [{ id: 'f001', t_ms: 1, data_base64: Buffer.alloc(300, 1).toString('base64') }],
					events: [click()],
				}),
		],
		[
			'invalid base64',
			() =>
				body({
					frames: [{ id: 'f001', t_ms: 1, data_base64: `${'!'.repeat(200)}` }],
					events: [click()],
				}),
		],
		['an event pointing at a missing frame', () => body({ events: [click({ frame: 'f009' })] })],
		[
			'duplicate frame ids',
			() =>
				body({
					frames: [
						{ id: 'f001', t_ms: 1, data_base64: jpegBase64() },
						{ id: 'f001', t_ms: 2, data_base64: jpegBase64() },
					],
					events: [click()],
				}),
		],
	])('rejects %s with 400 and stores nothing', async (_name, make) => {
		const t = build()

		expect((await post(t.app, make())).status).toBe(400)
		expect(t.storage.uploadFile).not.toHaveBeenCalled()
		expect(t.createSession).not.toHaveBeenCalled()
	})

	it.each([
		['no events', { events: [] }],
		['an out-of-range click', { events: [click({ x: 9999 })] }],
		['a short description', { description: 'x' }],
		[
			'too many frames',
			{
				frames: Array.from({ length: 61 }, (_, i) => ({
					id: `f${String(i + 1).padStart(3, '0')}`,
					t_ms: 1,
					data_base64: jpegBase64(),
				})),
				events: [click({ frame: undefined })],
			},
		],
		[
			'a key name with shell characters',
			{ events: [{ type: 'key', t_ms: 1, keys: 'ctrl+l; rm -rf /', frame: 'f001' }] },
		],
	])('rejects %s at the schema', async (_name, over) => {
		const t = build()

		expect((await post(t.app, body(over))).status).toBe(400)
		expect(t.storage.uploadFile).not.toHaveBeenCalled()
	})

	it('cleans up and 502s, with no session, when storage fails mid-upload', async () => {
		const t = build({ failUploadAt: 2 })

		expect((await post(t.app, body())).status).toBe(502)
		expect(t.createSession).not.toHaveBeenCalled()
		expect(t.deletes.length).toBe(2) // the two files that did land
	})

	it('cleans up and 502s when the session cannot start (e.g. a billing cap)', async () => {
		const t = build({ failSession: true })

		expect((await post(t.app, body())).status).toBe(502)
		expect(t.deletes.length).toBe(4)
		expect(t.events).toHaveLength(0)
	})

	it("sweeps this agent's expired recordings but keeps recent ones", async () => {
		const old = new Date(Date.now() - 7 * 60 * 60 * 1000)
		const t = build({
			records: [
				{ path: 'teach/aaaaaaaaaaaa/log.json', updatedAt: old, createdAt: old },
				{ path: 'teach/bbbbbbbbbbbb/log.json', updatedAt: new Date(), createdAt: new Date() },
			],
		})

		await post(t.app, body())

		expect(t.deletes).toContain('aaaaaaaaaaaa/log.json')
		expect(t.deletes).not.toContain('bbbbbbbbbbbb/log.json')
	})
})

describe('DELETE /api/desktop/teach/:recordingId', () => {
	beforeEach(() => {})

	const del = (app: TestApp, id: string) =>
		app.request(`/api/desktop/teach/${id}?agent_id=${AGENT}`, {
			method: 'DELETE',
			headers: { 'X-Workspace-Id': WS },
		})

	it("deletes only that recording's files", async () => {
		const now = new Date()
		const t = build({
			records: [
				{ path: 'teach/aaaaaaaaaaaa/log.json', updatedAt: now, createdAt: now },
				{ path: 'teach/aaaaaaaaaaaa/frames/f001.jpg', updatedAt: now, createdAt: now },
				{ path: 'teach/bbbbbbbbbbbb/log.json', updatedAt: now, createdAt: now },
			],
		})

		const res = await del(t.app, 'aaaaaaaaaaaa')

		expect(await res.json()).toEqual({ deleted: 2 })
		expect(t.deletes.sort()).toEqual(['aaaaaaaaaaaa/frames/f001.jpg', 'aaaaaaaaaaaa/log.json'])
	})

	it('rejects a recording id that is not a plain hex id', async () => {
		const t = build()

		expect((await del(t.app, '..%2F..%2Fetc')).status).toBe(400)
		expect(t.deletes).toHaveLength(0)
	})
})
