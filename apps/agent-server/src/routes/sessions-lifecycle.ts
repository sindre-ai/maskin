import { Hono } from 'hono'
import { logger } from '../lib/logger'
import type { SessionLifecycle } from '../services/session-lifecycle'

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

function isValidSessionId(value: unknown): value is string {
	return typeof value === 'string' && SESSION_ID_RE.test(value)
}

type Env = {
	Variables: {
		lifecycle: SessionLifecycle
	}
}

export function createSessionsLifecycleRoutes(lifecycle: SessionLifecycle): Hono<Env> {
	const app = new Hono<Env>()

	app.use('*', async (c, next) => {
		c.set('lifecycle', lifecycle)
		await next()
	})

	// POST /:id/stop — gracefully halt the running sandbox. Leaves the
	// session's `/agent` host directory in place for a subsequent snapshot.
	app.post('/:id/stop', async (c) => {
		const { id } = c.req.param()
		if (!isValidSessionId(id)) {
			return c.json({ error: 'Invalid session id' }, 400)
		}
		try {
			const result = await c.get('lifecycle').stop(id)
			return c.json(result)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			logger.error('session stop failed', { sessionId: id, error: message })
			return c.json({ error: message }, 500)
		}
	})

	// POST /:id/snapshot — pack the session's `/agent` host path into a new
	// disk-only snapshot tarball. Assumes the sandbox has already been stopped.
	app.post('/:id/snapshot', async (c) => {
		const { id } = c.req.param()
		if (!isValidSessionId(id)) {
			return c.json({ error: 'Invalid session id' }, 400)
		}
		try {
			const result = await c.get('lifecycle').snapshot(id)
			return c.json(result)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			logger.error('session snapshot failed', { sessionId: id, error: message })
			return c.json({ error: message }, 500)
		}
	})

	// POST /:id/restore — extract a snapshot tarball back into the session's
	// `/agent` host path and boot a fresh microVM bound to it. Preserves
	// sessionId so the restored agent process resumes with intact identity.
	app.post('/:id/restore', async (c) => {
		const { id } = c.req.param()
		if (!isValidSessionId(id)) {
			return c.json({ error: 'Invalid session id' }, 400)
		}

		let body: unknown
		try {
			body = await c.req.json()
		} catch {
			return c.json({ error: 'Invalid JSON body' }, 400)
		}
		if (!body || typeof body !== 'object') {
			return c.json({ error: 'Invalid JSON body' }, 400)
		}
		const raw = body as Record<string, unknown>
		const image = raw.image
		if (typeof image !== 'string' || image.length === 0) {
			return c.json({ error: 'Missing or invalid `image`' }, 400)
		}
		const envRaw = raw.env
		const env: Record<string, string> = {}
		if (envRaw !== undefined) {
			if (typeof envRaw !== 'object' || envRaw === null || Array.isArray(envRaw)) {
				return c.json({ error: '`env` must be an object of string values' }, 400)
			}
			for (const [k, v] of Object.entries(envRaw)) {
				if (typeof v !== 'string') {
					return c.json({ error: `\`env.${k}\` must be a string` }, 400)
				}
				env[k] = v
			}
		}
		const snapshotIdRaw = raw.snapshotId
		if (snapshotIdRaw !== undefined && typeof snapshotIdRaw !== 'string') {
			return c.json({ error: '`snapshotId` must be a string' }, 400)
		}
		const memoryRaw = raw.memoryMib
		const memoryMib = parseOptionalPositiveInt(memoryRaw, 'memoryMib')
		if (memoryMib instanceof Error) return c.json({ error: memoryMib.message }, 400)
		const cpusRaw = raw.cpus
		const cpus = parseOptionalPositiveInt(cpusRaw, 'cpus')
		if (cpus instanceof Error) return c.json({ error: cpus.message }, 400)
		const durationRaw = raw.maxDurationSecs
		const maxDurationSecs = parseOptionalPositiveInt(durationRaw, 'maxDurationSecs')
		if (maxDurationSecs instanceof Error) return c.json({ error: maxDurationSecs.message }, 400)

		try {
			const result = await c.get('lifecycle').restore(id, {
				image,
				env,
				...(typeof snapshotIdRaw === 'string' ? { snapshotId: snapshotIdRaw } : {}),
				...(typeof memoryMib === 'number' ? { memoryMib } : {}),
				...(typeof cpus === 'number' ? { cpus } : {}),
				...(typeof maxDurationSecs === 'number' ? { maxDurationSecs } : {}),
			})
			return c.json(result)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			logger.error('session restore failed', { sessionId: id, error: message })
			const status =
				message.includes('Snapshot not found') || message.includes('No snapshots') ? 404 : 500
			return c.json({ error: message }, status)
		}
	})

	return app
}

function parseOptionalPositiveInt(value: unknown, field: string): number | undefined | Error {
	if (value === undefined) return undefined
	if (
		typeof value !== 'number' ||
		!Number.isFinite(value) ||
		value <= 0 ||
		!Number.isInteger(value)
	) {
		return new Error(`\`${field}\` must be a positive integer`)
	}
	return value
}
