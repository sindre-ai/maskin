import { OpenAPIHono } from '@hono/zod-openapi'
import { describe, expect, it, vi } from 'vitest'

import desktopRoutes from '../../routes/desktop'

const WS = '11111111-1111-4111-8111-111111111111'
const ACTOR = 'test-actor-id'
const AGENT = '44444444-4444-4444-8444-444444444444'
const URL_WITH_SIGNATURE = 'https://storage.example/bucket/key?X-Amz-Signature=abc'
const HASH = 'a'.repeat(64)

type Control = ReturnType<typeof vi.fn>

// First select is the access rule (agent in workspace), second is the saves-in-the-last-hour count.
function build(
	opts: {
		control?: Control
		storedSize?: number | null
		savesInLastHour?: number
		role?: string
		insertFails?: boolean
	} = {},
) {
	const inserts: Record<string, unknown>[] = []
	const results = [[{ id: AGENT }], [{ n: opts.savesInLastHour ?? 0 }]]
	let call = 0
	const db = {
		insert: () => ({
			// recordEvent awaits values() directly; the file insert chains .returning().
			values: (row: Record<string, unknown>) => {
				inserts.push(row)
				return Object.assign(Promise.resolve(undefined), {
					returning: async () => {
						if (opts.insertFails) throw new Error('boom')
						return [{ ...row, createdAt: new Date() }]
					},
				})
			},
		}),
		select: () => {
			const rows = results[call++] ?? []
			// The count query awaits where(); the access rule chains .limit().
			const q = {
				from: () => q,
				innerJoin: () => q,
				where: () => Object.assign(Promise.resolve(rows), { limit: async () => rows }),
			}
			return q
		},
	}
	const presignUpload = vi.fn(async () => URL_WITH_SIGNATURE)
	const headObject = vi.fn(async () =>
		opts.storedSize === null
			? null
			: opts.storedSize === undefined
				? { size: 2048 }
				: { size: opts.storedSize },
	)
	const del = vi.fn(async () => undefined)
	const control = opts.control ?? vi.fn()
	const app = new OpenAPIHono<{ Variables: Record<string, unknown> }>()
	app.onError((err, c) => {
		const status = (err as { status?: number }).status
		return c.json({ error: String(err) }, (status ?? 500) as 403 | 500)
	})
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', ACTOR)
		c.set('actorType', 'human')
		if (opts.role) c.set('workspaceRole', opts.role)
		c.set('storageProvider', { presignUpload, headObject, delete: del })
		c.set('desktopService', { control })
		await next()
	})
	app.route('/api/desktop', desktopRoutes as never)
	return { app, inserts, presignUpload, headObject, del, control: control as Control }
}

const save = (app: ReturnType<typeof build>['app'], body: unknown) =>
	app.request(`/api/desktop/save-file?agent_id=${AGENT}`, {
		method: 'POST',
		headers: { 'X-Workspace-Id': WS, 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	})

const sent = (
	over: Partial<{ stdout: string; exit_code: number; stderr: string; timed_out: boolean }> = {},
) => ({
	status: 200,
	body: {
		exit_code: 0,
		stdout: `/home/user/renders/My Clip.mp4\n2048\n${HASH}\n2048\n`,
		stderr: '',
		timed_out: false,
		...over,
	},
})

describe('POST /api/desktop/save-file', () => {
	it('has the computer PUT the file to a signed URL for a key the server made, then saves a new file', async () => {
		const { app, control, presignUpload, headObject, del, inserts } = build({
			control: vi.fn(async () => sent()),
		})

		const res = await save(app, { path: '~/renders/My Clip.mp4' })

		expect(res.status).toBe(201)
		const body = await res.json()
		expect(body).toMatchObject({ name: 'My Clip.mp4', size_bytes: 2048, sha256: HASH })
		expect(body.url).toContain(`/${WS}/files/${body.file_id}`)
		// Key is the server's, under the workspace, for the new file id; the link lasts 10 minutes.
		expect(presignUpload).toHaveBeenCalledWith(`workspaces/${WS}/files/${body.file_id}`, 600)
		const [workspaceId, agentId, action, exec] = control.mock.calls[0] as [
			string,
			string,
			string,
			{ command: string; timeout_s: number },
		]
		expect([workspaceId, agentId, action, exec.timeout_s]).toEqual([WS, AGENT, 'exec', 120])
		expect(exec.command).toContain('--method=PUT')
		expect(exec.command).toContain(`'${URL_WITH_SIGNATURE}'`)
		expect(headObject).toHaveBeenCalledWith(`workspaces/${WS}/files/${body.file_id}`)
		expect(del).not.toHaveBeenCalled()
		// The new file row, then its created event, then the audit row the hourly limit counts.
		expect(inserts[0]).toMatchObject({
			id: body.file_id,
			workspaceId: WS,
			name: 'My Clip.mp4',
			mimeType: 'video/mp4',
			sizeBytes: 2048,
			contentHash: HASH,
			storageKey: `workspaces/${WS}/files/${body.file_id}`,
			createdBy: ACTOR,
		})
		expect(inserts[1]).toMatchObject({ action: 'created', entityType: 'file' })
		expect(inserts[2]).toMatchObject({
			action: 'updated',
			entityType: 'workspace_desktop',
			data: { agent_id: AGENT, control: 'save_file', file_id: body.file_id },
		})
		expect(JSON.stringify(inserts)).not.toContain('Signature')
	})

	it('uses the name the caller gave, made safe', async () => {
		const { app, inserts } = build({ control: vi.fn(async () => sent()) })

		await save(app, { path: '/home/user/renders/My Clip.mp4', name: '../final cut?.mp4' })

		expect(inserts[0]).toMatchObject({ name: 'final cut_.mp4' })
	})

	it('ignores a storage key sent by the caller', async () => {
		const { app, presignUpload } = build({ control: vi.fn(async () => sent()) })

		await save(app, { path: '~/a.mp4', storage_key: 'workspaces/other/files/x', key: 'x' })

		const [key] = presignUpload.mock.calls[0] as unknown as [string]
		expect(key.startsWith(`workspaces/${WS}/files/`)).toBe(true)
	})

	it.each([
		['a relative path', 'renders/a.mp4'],
		['a newline in the path', '/home/user/a\nrm -rf /'],
	])('rejects %s without touching the computer', async (_name, path) => {
		const { app, control, presignUpload } = build({ control: vi.fn() })

		expect((await save(app, { path })).status).toBe(400)
		expect(presignUpload).not.toHaveBeenCalled()
		expect(control).not.toHaveBeenCalled()
	})

	it('403s a read-only viewer without touching the computer', async () => {
		const { app, control } = build({ role: 'viewer', control: vi.fn() })

		expect((await save(app, { path: '~/a.mp4' })).status).toBe(403)
		expect(control).not.toHaveBeenCalled()
	})

	it('refuses a file over the cap, says the cap and that it stays re-fetchable, and saves nothing', async () => {
		const { app, del, inserts } = build({
			control: vi.fn(async () => sent({ exit_code: 44, stdout: `TOOBIG ${200 * 1024 * 1024}\n` })),
		})

		const res = await save(app, { path: '~/raw.mov' })

		expect(res.status).toBe(400)
		const { error } = await res.json()
		expect(error.message).toContain('200 MB')
		expect(error.message).toContain('100 MB')
		expect(error.message).toContain('Nothing was uploaded')
		expect(error.message).toContain('fetch it again')
		expect(del).toHaveBeenCalledTimes(1)
		expect(inserts).toHaveLength(0)
	})

	it.each([
		['a path outside the home folder or in a hidden folder', 43, 400],
		['a missing file', 45, 404],
		['an empty file', 46, 400],
	])('answers %s with %i/%i and saves nothing', async (_name, exit_code, status) => {
		const { app, inserts } = build({ control: vi.fn(async () => sent({ exit_code, stdout: '' })) })

		expect((await save(app, { path: '~/x.bin' })).status).toBe(status)
		expect(inserts).toHaveLength(0)
	})

	it('deletes the stored object and never returns the signed URL when the upload fails', async () => {
		const { app, del, inserts } = build({
			control: vi.fn(async () =>
				sent({
					exit_code: 8,
					stdout: '',
					stderr: `wget: ${URL_WITH_SIGNATURE}: server returned 403`,
				}),
			),
		})

		const res = await save(app, { path: '~/a.mp4' })
		const text = await res.text()

		expect(res.status).toBe(502)
		expect(text).toContain('<url>')
		expect(text).not.toContain('Signature')
		expect(del).toHaveBeenCalledTimes(1)
		expect(inserts).toHaveLength(0)
	})

	it('deletes the stored object when the upload times out', async () => {
		const { app, del } = build({
			control: vi.fn(async () => sent({ exit_code: -1, timed_out: true })),
		})

		const res = await save(app, { path: '~/a.mp4' })

		expect(res.status).toBe(502)
		expect(await res.text()).toContain('two minutes')
		expect(del).toHaveBeenCalledTimes(1)
	})

	it('deletes the stored object and saves nothing when the stored size differs from the reported one', async () => {
		const { app, del, inserts } = build({
			control: vi.fn(async () => sent()),
			storedSize: 2047,
		})

		expect((await save(app, { path: '~/a.mp4' })).status).toBe(502)
		expect(del).toHaveBeenCalledTimes(1)
		expect(inserts).toHaveLength(0)
	})

	it('deletes the stored object and saves nothing when nothing was stored', async () => {
		const { app, del, inserts } = build({ control: vi.fn(async () => sent()), storedSize: null })

		expect((await save(app, { path: '~/a.mp4' })).status).toBe(502)
		expect(del).toHaveBeenCalledTimes(1)
		expect(inserts).toHaveLength(0)
	})

	it('deletes the stored object when the file changed while it was being sent', async () => {
		const { app, del, inserts } = build({
			control: vi.fn(async () => sent({ stdout: `/home/user/a.mp4\n2048\n${HASH}\n4096\n` })),
		})

		expect((await save(app, { path: '~/a.mp4' })).status).toBe(502)
		expect(del).toHaveBeenCalledTimes(1)
		expect(inserts).toHaveLength(0)
	})

	it('deletes the stored object when the file row cannot be created', async () => {
		const { app, del } = build({ control: vi.fn(async () => sent()), insertFails: true })

		expect((await save(app, { path: '~/a.mp4' })).status).toBe(500)
		expect(del).toHaveBeenCalledTimes(1)
	})

	it('refuses the 21st save in an hour before signing anything', async () => {
		const { app, control, presignUpload } = build({ control: vi.fn(), savesInLastHour: 20 })

		const res = await save(app, { path: '~/a.mp4' })

		expect(res.status).toBe(429)
		expect(presignUpload).not.toHaveBeenCalled()
		expect(control).not.toHaveBeenCalled()
	})

	it('allows the 20th save in an hour', async () => {
		const { app } = build({ control: vi.fn(async () => sent()), savesInLastHour: 19 })

		expect((await save(app, { path: '~/a.mp4' })).status).toBe(201)
	})
})
