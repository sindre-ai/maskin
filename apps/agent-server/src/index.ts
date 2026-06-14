import { join } from 'node:path'
import { serve } from '@hono/node-server'
import type { StorageProvider } from '@maskin/storage'
import { Hono } from 'hono'
import { z } from 'zod'
import { bearerAuth } from './lib/auth'
import { type AgentServerEnv, parseEnv } from './lib/env'
import { logger } from './lib/logger'
import { type MicrosandboxDeps, readMsbVersion, spawnSession } from './services/microsandbox'
import { pullSessionWorkspace } from './services/session-workspace'

const SESSION_REQUEST_SCHEMA = z.object({
	sessionId: z
		.string()
		.regex(
			/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/,
			'sessionId must match ^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$',
		),
	image: z.string().min(1),
	env: z
		.record(
			z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'env key must be a valid shell identifier'),
			z.string(),
		)
		.default({}),
	memoryMib: z.number().int().positive().optional(),
	cpus: z.number().int().positive().optional(),
})

export type AppDeps = {
	env: AgentServerEnv
	storage: StorageProvider | null
	msb: MicrosandboxDeps
}

export function buildApp(deps: AppDeps): Hono {
	const app = new Hono()

	app.get('/health', async (c) => {
		// `ok` must track msb liveness — a box whose `msb` is missing or broken
		// is not healthy, even though the process is up. readMsbVersion returns
		// null on any failure, so a null version is an unhealthy box (503).
		const msbVersion = await readMsbVersion({ msbBin: deps.msb.msbBin, run: deps.msb.run })
		const ok = msbVersion !== null
		return c.json(
			{
				ok,
				backend: 'microsandbox',
				msb_version: msbVersion,
			},
			ok ? 200 : 503,
		)
	})

	// `/health` is the only unauthenticated route — HOST_SETUP.md §9 probes it
	// without a secret. Every other route under `/sessions` requires the shared
	// bearer token. Mount the middleware on both the collection path and the
	// sub-paths so future per-session routes (T3 stop/snapshot/restore) inherit
	// the gate at the mount point without re-implementing the check.
	const requireBearer = bearerAuth({ expectedSecret: deps.env.AGENT_SERVER_SECRET })
	app.use('/sessions', requireBearer)
	app.use('/sessions/*', requireBearer)

	app.post('/sessions', async (c) => {
		let raw: unknown
		try {
			raw = await c.req.json()
		} catch {
			return c.json({ error: 'invalid_json' }, 400)
		}

		const parsed = SESSION_REQUEST_SCHEMA.safeParse(raw)
		if (!parsed.success) {
			return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400)
		}
		const body = parsed.data

		const sessionDir = join(deps.env.AGENT_SESSION_ROOT, body.sessionId)

		if (deps.storage) {
			try {
				const { restored, archiveBytes } = await pullSessionWorkspace(
					deps.storage,
					body.sessionId,
					sessionDir,
				)
				logger.info('session workspace pulled', {
					sessionId: body.sessionId,
					restored,
					archiveBytes,
				})
			} catch (err) {
				logger.error('session workspace pull failed', {
					sessionId: body.sessionId,
					error: String(err),
				})
				return c.json({ error: 'workspace_pull_failed' }, 502)
			}
		}

		try {
			const result = await spawnSession(
				{
					sessionId: body.sessionId,
					image: body.image,
					env: body.env,
					...(body.memoryMib !== undefined && { memoryMib: body.memoryMib }),
					...(body.cpus !== undefined && { cpus: body.cpus }),
					hostPort: deps.env.PORT,
					...(deps.env.MASKIN_AGENT_SERVER_PUBLIC_HOST !== undefined && {
						publicHost: deps.env.MASKIN_AGENT_SERVER_PUBLIC_HOST,
					}),
					sessionDir,
				},
				deps.msb,
			)
			logger.info('session spawned', {
				sessionId: body.sessionId,
				image: body.image,
				envOverflowSpilled: result.envOverflowSpilled,
				envSanitized: result.envSanitized,
			})
			return c.json(
				{
					sessionId: body.sessionId,
					sandboxName: result.sandboxName,
					connection: result.connection,
					env_overflow_spilled: result.envOverflowSpilled,
					env_sanitized: result.envSanitized,
				},
				201,
			)
		} catch (err) {
			logger.error('session spawn failed', { sessionId: body.sessionId, error: String(err) })
			return c.json({ error: 'spawn_failed', message: String(err) }, 500)
		}
	})

	return app
}

async function buildStorage(env: AgentServerEnv): Promise<StorageProvider | null> {
	if (!env.S3_ENDPOINT || !env.S3_BUCKET || !env.S3_ACCESS_KEY || !env.S3_SECRET_KEY) {
		logger.warn('S3 credentials not fully configured — session workspace persistence disabled')
		return null
	}
	const { S3StorageProvider } = await import('@maskin/storage')
	return new S3StorageProvider({
		endpoint: env.S3_ENDPOINT,
		bucket: env.S3_BUCKET,
		accessKeyId: env.S3_ACCESS_KEY,
		secretAccessKey: env.S3_SECRET_KEY,
		region: env.S3_REGION,
	})
}

async function main(): Promise<void> {
	const env = parseEnv()
	const storage = await buildStorage(env)

	const app = buildApp({
		env,
		storage,
		msb: { msbBin: env.MSB_BIN },
	})

	serve({ fetch: app.fetch, port: env.PORT, hostname: '0.0.0.0' }, ({ port }) => {
		logger.info('agent-server listening', { port })
	})
}

// Bundled entrypoint runs main; tests import buildApp directly without booting.
const isEntry =
	import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('/dist/index.js')
if (isEntry) {
	main().catch((err) => {
		logger.error('agent-server startup failed', { error: String(err) })
		process.exit(1)
	})
}
