import { OpenAPIHono } from '@hono/zod-openapi'
import { describe, expect, it, vi } from 'vitest'

import {
	DESKTOP_SETTINGS_VERSION,
	buildApplySettingsCommand,
	buildReadSettingsCommand,
} from '../../lib/desktop-settings'
import desktopRoutes from '../../routes/desktop'

const WS = '11111111-1111-4111-8111-111111111111'
const ACTOR = 'test-actor-id'
const AGENT = '44444444-4444-4444-8444-444444444444'
const OTHER_AGENT = '55555555-5555-4555-8555-555555555555'

type Exec = { status: number; body: unknown } | null

const execOk = (stdout: string): Exec => ({
	status: 200,
	body: { exit_code: 0, stdout, stderr: '', timed_out: false },
})

function build(
	opts: {
		control?: ReturnType<typeof vi.fn>
		locate?: ReturnType<typeof vi.fn>
		role?: string
		actorType?: string
		actorId?: string
		agentRows?: unknown[]
	} = {},
) {
	const inserts: unknown[] = []
	const db = {
		insert: () => ({
			values: async (row: unknown) => {
				inserts.push(row)
			},
		}),
		select: () => {
			const q = {
				from: () => q,
				innerJoin: () => q,
				where: () => q,
				limit: async () => opts.agentRows ?? [{ id: AGENT }],
			}
			return q
		},
	}
	const control = opts.control ?? vi.fn()
	const locate = opts.locate ?? vi.fn()
	const app = new OpenAPIHono<{ Variables: Record<string, unknown> }>()
	app.onError((err, c) => {
		const status = (err as { status?: number }).status
		return c.json({ error: String(err) }, (status ?? 500) as 403 | 500)
	})
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', opts.actorId ?? ACTOR)
		c.set('actorType', opts.actorType ?? 'human')
		if (opts.role) c.set('workspaceRole', opts.role)
		c.set('desktopService', { control, locate })
		await next()
	})
	app.route('/api/desktop', desktopRoutes as never)
	return { app, inserts, control, locate }
}

const call = (
	app: ReturnType<typeof build>['app'],
	method: 'GET' | 'POST',
	path: string,
	agent: string | null = AGENT,
) =>
	app.request(`/api/desktop/${path}${agent ? `?agent_id=${agent}` : ''}`, {
		method,
		headers: { 'X-Workspace-Id': WS },
	})

const applyOutput = (keyfile: string, marker: string) =>
	`keyfile_changed=${keyfile}\nmarker_changed=${marker}\nsettings_version=${DESKTOP_SETTINGS_VERSION}\n`

describe('POST /api/desktop/apply-settings', () => {
	it('sends the server-built command and reports a change', async () => {
		const { app, control, inserts } = build({
			control: vi.fn(async () => execOk(applyOutput('1', '1'))),
		})

		const res = await call(app, 'POST', 'apply-settings')

		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({
			settings_version: DESKTOP_SETTINGS_VERSION,
			changed: true,
			chromium_restart_needed: false,
		})
		expect(control).toHaveBeenCalledWith(WS, AGENT, 'exec', {
			command: buildApplySettingsCommand(),
			timeout_s: 30,
		})
		// Each run leaves an audit record naming what ran and whether it changed anything.
		expect(inserts).toHaveLength(1)
		expect(inserts[0]).toMatchObject({
			entityType: 'workspace_desktop',
			data: {
				agent_id: AGENT,
				control: 'apply_settings',
				settings_version: DESKTOP_SETTINGS_VERSION,
				changed: true,
			},
		})
	})

	it('says nothing changed on a second run, and still records the run', async () => {
		const { app, inserts } = build({
			control: vi.fn(async () => execOk(applyOutput('0', '0'))),
		})

		const res = await call(app, 'POST', 'apply-settings')

		expect(await res.json()).toMatchObject({ changed: false })
		expect(inserts[0]).toMatchObject({ data: { changed: false } })
	})

	it('lets an agent run it on its own computer', async () => {
		const { app, control } = build({
			actorType: 'agent',
			actorId: AGENT,
			control: vi.fn(async () => execOk(applyOutput('0', '0'))),
		})

		expect((await call(app, 'POST', 'apply-settings', null)).status).toBe(200)
		expect(control.mock.calls[0]?.[1]).toBe(AGENT)
	})

	it('403s an agent naming another agent, without touching any computer', async () => {
		const { app, control } = build({ actorType: 'agent', actorId: AGENT, control: vi.fn() })

		expect((await call(app, 'POST', 'apply-settings', OTHER_AGENT)).status).toBe(403)
		expect(control).not.toHaveBeenCalled()
	})

	it('403s a read-only viewer', async () => {
		const { app, control } = build({ role: 'viewer', control: vi.fn() })

		expect((await call(app, 'POST', 'apply-settings')).status).toBe(403)
		expect(control).not.toHaveBeenCalled()
	})

	it('400s a malformed agent id and a person who names none', async () => {
		const { app, control } = build({ control: vi.fn() })

		expect((await call(app, 'POST', 'apply-settings', 'not-a-uuid')).status).toBe(400)
		expect((await call(app, 'POST', 'apply-settings', null)).status).toBe(400)
		expect(control).not.toHaveBeenCalled()
	})

	it('404s an agent that is not in this workspace', async () => {
		const { app, control } = build({ agentRows: [], control: vi.fn() })

		expect((await call(app, 'POST', 'apply-settings')).status).toBe(404)
		expect(control).not.toHaveBeenCalled()
	})

	it('404s when no computer could be started', async () => {
		const { app, inserts } = build({ control: vi.fn(async () => null) })

		expect((await call(app, 'POST', 'apply-settings')).status).toBe(404)
		expect(inserts).toEqual([])
	})

	it('502s with the reason when the command fails, and records nothing', async () => {
		const { app, inserts } = build({
			control: vi.fn(async () => ({
				status: 200,
				body: { exit_code: 1, stdout: '', stderr: 'python3: not found', timed_out: false },
			})),
		})

		const res = await call(app, 'POST', 'apply-settings')

		expect(res.status).toBe(502)
		expect(JSON.stringify(await res.json())).toContain('python3: not found')
		expect(inserts).toEqual([])
	})

	it('502s an answer that does not carry the expected version', async () => {
		const { app } = build({ control: vi.fn(async () => execOk('settings_version=99\n')) })

		expect((await call(app, 'POST', 'apply-settings')).status).toBe(502)
	})
})

describe('GET /api/desktop/settings', () => {
	const readOutput =
		'settings_version=1\nimage_tag=sha-abc1234\nchooser_size=(800, 480)\nchooser_position=(400, 20)\ndisk_total_mb=3960\ndisk_free_mb=2900\n'

	it('reports the computer and its host, and writes nothing', async () => {
		const { app, control, locate, inserts } = build({
			locate: vi.fn(async () => ({
				status: 'running',
				host: {
					snapshots: { enabled: true, idleMinutes: 10 },
					newComputerImage: 'org/desktop:latest',
				},
			})),
			control: vi.fn(async () => execOk(readOutput)),
		})

		const res = await call(app, 'GET', 'settings')

		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({
			status: 'running',
			current_settings_version: DESKTOP_SETTINGS_VERSION,
			settings_version: 1,
			image_tag: 'sha-abc1234',
			chooser_size: '(800, 480)',
			chooser_position: '(400, 20)',
			disk_total_mb: 3960,
			disk_free_mb: 2900,
			snapshots: { enabled: true, idle_minutes: 10 },
			new_computer_image: 'org/desktop:latest',
		})
		expect(locate).toHaveBeenCalledWith(WS, AGENT)
		expect(control).toHaveBeenCalledWith(WS, AGENT, 'exec', {
			command: buildReadSettingsCommand(),
			timeout_s: 30,
		})
		expect(inserts).toEqual([])
	})

	it('reads an old computer: no version, no image tag, and a host that did not say', async () => {
		const { app } = build({
			locate: vi.fn(async () => ({ status: 'running' })),
			control: vi.fn(async () =>
				execOk('settings_version=\nimage_tag=\nchooser_size=(1124, 822)\ndisk_total_mb=3960\n'),
			),
		})

		expect(await (await call(app, 'GET', 'settings')).json()).toMatchObject({
			settings_version: null,
			image_tag: null,
			chooser_size: '(1124, 822)',
			disk_free_mb: null,
			snapshots: null,
			new_computer_image: null,
		})
	})

	it('does not wake a computer that is asleep', async () => {
		const { app, control } = build({
			locate: vi.fn(async () => ({
				status: 'suspended',
				host: { snapshots: { enabled: true, idleMinutes: 10 } },
			})),
			control: vi.fn(),
		})

		const res = await call(app, 'GET', 'settings')

		expect(await res.json()).toMatchObject({
			status: 'suspended',
			settings_version: null,
			disk_free_mb: null,
			snapshots: { enabled: true, idle_minutes: 10 },
		})
		expect(control).not.toHaveBeenCalled()
	})

	it('404s an agent with no computer, without creating one', async () => {
		const { app, control } = build({ locate: vi.fn(async () => null), control: vi.fn() })

		expect((await call(app, 'GET', 'settings')).status).toBe(404)
		expect(control).not.toHaveBeenCalled()
	})

	it('403s an agent naming another agent and a read-only viewer', async () => {
		const locate = vi.fn()
		const agent = build({ actorType: 'agent', actorId: AGENT, locate })
		const viewer = build({ role: 'viewer', locate })

		expect((await call(agent.app, 'GET', 'settings', OTHER_AGENT)).status).toBe(403)
		expect((await call(viewer.app, 'GET', 'settings')).status).toBe(403)
		expect(locate).not.toHaveBeenCalled()
	})
})
