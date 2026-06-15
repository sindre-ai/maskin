import { join } from 'node:path'
import { serve } from '@hono/node-server'
import type { StorageProvider } from '@maskin/storage'
import { Hono } from 'hono'
import { z } from 'zod'
import { bearerAuth } from './lib/auth'
import { type AgentServerEnv, parseEnv } from './lib/env'
import { logger } from './lib/logger'
import { ImageWarmer } from './services/image-warmer'
import {
	type MicrosandboxDeps,
	type PullPolicy,
	readMsbVersion,
	spawnSession,
} from './services/microsandbox'
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
	warmer?: ImageWarmer | null
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

		// If the warmer has this image in libkrun's local cache we can skip the
		// network pull (`--pull missing`). Otherwise fall back to the cold
		// `--pull always` path, which self-corrects by pulling if absent.
		const warmHit = deps.warmer?.isWarm(body.image) ?? false
		const pullPolicy: PullPolicy = warmHit ? 'missing' : 'always'

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
					pullPolicy,
				},
				deps.msb,
			)
			logger.info('session spawned', {
				sessionId: body.sessionId,
				image: body.image,
				warmHit,
				pullPolicy,
				envOverflowSpilled: result.envOverflowSpilled,
				envSanitized: result.envSanitized,
			})
			return c.json(
				{
					sessionId: body.sessionId,
					sandboxName: result.sandboxName,
					connection: result.connection,
					warm_hit: warmHit,
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
	const msb: MicrosandboxDeps = { msbBin: env.MSB_BIN }

	let warmer: ImageWarmer | null = null
	if (env.WARM_POOL_IMAGE) {
		warmer = new ImageWarmer({
			image: env.WARM_POOL_IMAGE,
			hostPort: env.PORT,
			msb,
			refreshMs: env.WARM_POOL_REFRESH_MINUTES * 60_000,
		})
		try {
			await warmer.start()
		} catch (err) {
			// A warmer that can't start is degraded but not fatal — sessions still
			// fall back to the cold path. Surface and continue.
			logger.error('image warmer failed to start', { error: String(err) })
		}
	} else {
		logger.info('image warmer disabled', { reason: 'no_image' })
	}

	const app = buildApp({ env, storage, msb, warmer })

	const server = serve({ fetch: app.fetch, port: env.PORT, hostname: '0.0.0.0' }, ({ port }) => {
		logger.info('agent-server listening', { port })
	})

	let shuttingDown = false
	const shutdown = async (signal: string): Promise<void> => {
		if (shuttingDown) return
		shuttingDown = true
		logger.info('agent-server shutting down', { signal })
		if (warmer) {
			await warmer.shutdown().catch((err) => {
				logger.error('image warmer shutdown failed', { error: String(err) })
			})
		}
		server.close(() => process.exit(0))
		// Hard-stop after 10s if the server doesn't close cleanly (libkrun hangs
		// have shown up here in the past).
		setTimeout(() => process.exit(0), 10_000).unref()
	}
	process.on('SIGTERM', () => void shutdown('SIGTERM'))
	process.on('SIGINT', () => void shutdown('SIGINT'))
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
