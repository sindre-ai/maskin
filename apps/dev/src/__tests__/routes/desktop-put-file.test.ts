import { OpenAPIHono } from '@hono/zod-openapi'
import { describe, expect, it, vi } from 'vitest'

import desktopRoutes from '../../routes/desktop'

const WS = '11111111-1111-4111-8111-111111111111'
const ACTOR = 'test-actor-id'
const AGENT = '44444444-4444-4444-8444-444444444444'
const FILE_ID = '66666666-6666-4666-8666-666666666666'
const URL_WITH_SIGNATURE = 'https://storage.example/bucket/key?X-Amz-Signature=abc'
const HASH = 'a'.repeat(64)

const file = {
	id: FILE_ID,
	name: 'my photo (1).png',
	mimeType: 'image/png',
	sizeBytes: 2048,
	storageKey: 'ws/key',
	contentHash: HASH,
}

// First select is the access rule (agent in workspace), second is the file lookup.
function build(opts: { fileRows?: unknown[]; control?: unknown; role?: string } = {}) {
	const inserts: unknown[] = []
	const results = [[{ id: AGENT }], opts.fileRows ?? [file]]
	let call = 0
	const db = {
		insert: () => ({
			values: async (row: unknown) => {
				inserts.push(row)
			},
		}),
		select: () => {
			const rows = results[call++] ?? []
			const q = { from: () => q, innerJoin: () => q, where: () => q, limit: async () => rows }
			return q
		},
	}
	const presignDownload = vi.fn(async () => URL_WITH_SIGNATURE)
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
		c.set('storageProvider', { presignDownload })
		c.set('desktopService', { control })
		await next()
	})
	app.route('/api/desktop', desktopRoutes as never)
	return { app, inserts, presignDownload, control: control as ReturnType<typeof vi.fn> }
}

const put = (app: ReturnType<typeof build>['app'], body: unknown) =>
	app.request(`/api/desktop/put-file?agent_id=${AGENT}`, {
		method: 'POST',
		headers: { 'X-Workspace-Id': WS, 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	})

const landed = (over: Partial<{ stdout: string; exit_code: number; stderr: string }> = {}) => ({
	status: 200,
	body: {
		exit_code: 0,
		stdout: `/home/user/Downloads/my photo _1_.png\n${HASH}\n2048\n`,
		stderr: '',
		timed_out: false,
		...over,
	},
})

describe('POST /api/desktop/put-file', () => {
	it('downloads from a signed URL on the computer and reports path, size and hash', async () => {
		const { app, control, presignDownload, inserts } = build({
			control: vi.fn(async () => landed()),
		})

		const res = await put(app, { file_id: FILE_ID })

		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({
			path: '/home/user/Downloads/my photo _1_.png',
			size_bytes: 2048,
			sha256: HASH,
			hash_verified: true,
		})
		expect(presignDownload).toHaveBeenCalledWith('ws/key', {
			expiresInSeconds: 600,
			contentType: 'image/png',
		})
		const [workspaceId, agentId, action, body] = control.mock.calls[0] as [
			string,
			string,
			string,
			{ command: string; timeout_s: number },
		]
		expect([workspaceId, agentId, action, body.timeout_s]).toEqual([WS, AGENT, 'exec', 120])
		// Default folder, safe file name, signed URL quoted as one argument.
		expect(body.command).toContain(`d="$HOME"/'Downloads'`)
		expect(body.command).toContain(`'my photo _1_.png'`)
		expect(body.command).toContain(`'${URL_WITH_SIGNATURE}'`)
		// The event names the file and path, never the download URL.
		expect(inserts[0]).toMatchObject({
			data: { agent_id: AGENT, control: 'put_file', file_id: FILE_ID },
		})
		expect(JSON.stringify(inserts[0])).not.toContain('Signature')
	})

	it('uses an absolute folder as given, quoted', async () => {
		const { app, control } = build({ control: vi.fn(async () => landed()) })

		await put(app, { file_id: FILE_ID, folder: "/tmp/it's here" })

		const { command } = control.mock.calls[0]?.[3] as { command: string }
		expect(command).toContain(`d='/tmp/it'\\''s here'`)
	})

	it.each([
		['a relative folder', 'Downloads'],
		['a newline in the folder', '/tmp/a\nrm -rf /'],
	])('rejects %s without touching the computer', async (_name, folder) => {
		const { app, control } = build({ control: vi.fn() })

		expect((await put(app, { file_id: FILE_ID, folder })).status).toBe(400)
		expect(control).not.toHaveBeenCalled()
	})

	it('404s a file that is not in this workspace', async () => {
		const { app, control, presignDownload } = build({ fileRows: [], control: vi.fn() })

		expect((await put(app, { file_id: FILE_ID })).status).toBe(404)
		expect(presignDownload).not.toHaveBeenCalled()
		expect(control).not.toHaveBeenCalled()
	})

	it('403s a read-only viewer without touching the computer', async () => {
		const { app, control } = build({ role: 'viewer', control: vi.fn() })

		expect((await put(app, { file_id: FILE_ID })).status).toBe(403)
		expect(control).not.toHaveBeenCalled()
	})

	it('refuses a file whose hash differs from the stored one', async () => {
		const { app, inserts } = build({
			control: vi.fn(async () =>
				landed({ stdout: `/home/user/Downloads/x.png\n${'b'.repeat(64)}\n2048\n` }),
			),
		})

		const res = await put(app, { file_id: FILE_ID })

		expect(res.status).toBe(502)
		expect(inserts).toHaveLength(0)
	})

	it('refuses a file whose size differs from the stored one', async () => {
		const { app } = build({
			control: vi.fn(async () => landed({ stdout: `/home/user/Downloads/x.png\n${HASH}\n10\n` })),
		})

		expect((await put(app, { file_id: FILE_ID })).status).toBe(502)
	})

	it('checks only the size of a large file that has no stored hash', async () => {
		const { app } = build({
			fileRows: [{ ...file, contentHash: null }],
			control: vi.fn(async () =>
				landed({ stdout: `/home/user/Downloads/x.png\n${'c'.repeat(64)}\n2048\n` }),
			),
		})

		const res = await put(app, { file_id: FILE_ID })

		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({ hash_verified: false })
	})

	it('never returns the signed URL when the download fails', async () => {
		const { app } = build({
			control: vi.fn(async () =>
				landed({
					exit_code: 8,
					stdout: '',
					stderr: `wget: ${URL_WITH_SIGNATURE}: server returned 403`,
				}),
			),
		})

		const res = await put(app, { file_id: FILE_ID })
		const text = await res.text()

		expect(res.status).toBe(502)
		expect(text).not.toContain('Signature')
		expect(text).toContain('<url>')
	})
})
