import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { serve } from '@hono/node-server'
import type { StorageProvider } from '@maskin/storage'
import { Hono } from 'hono'
import { stream } from 'hono/streaming'
import { z } from 'zod'
import { bearerAuth } from './lib/auth'
import { type AgentServerEnv, parseEnv } from './lib/env'
import { logger } from './lib/logger'
import { ImageWarmer } from './services/image-warmer'
import { InputQueue } from './services/input-queue'
import {
	type BrowserSidecar,
	type MicrosandboxDeps,
	type PullPolicy,
	cleanupBrowserSidecar,
	defaultRunner,
	launchSessionExec,
	provisionBrowserSidecar,
	readMsbVersion,
	removeSandbox,
	spawnSession,
	stopSandbox,
	waitForCompletion,
} from './services/microsandbox'
import {
	deleteSessionDir,
	pullSessionWorkspace,
	pushSessionWorkspace,
} from './services/session-workspace'

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

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
	// When true, provision a Chromium CDP sidecar microVM alongside the session
	// and inject `BROWSER_CDP_URL` so `@playwright/mcp` can attach. Absent or
	// false → no sidecar, no env var, no MCP entry.
	browserRequired: z.boolean().optional(),
	sourceSessionId: z.string().regex(SESSION_ID_RE).optional(),
})

export type AppDeps = {
	env: AgentServerEnv
	storage: StorageProvider | null
	msb: MicrosandboxDeps
	warmer?: ImageWarmer | null
}

const LOG_FLUSH_INTERVAL_MS = 2_000
const LOG_FLUSH_MAX_LINES = 100

// Delay before stopping a microVM after it signals completion. `msb stop` tears
// down the VM's (smoltcp) network, so we must let the {ok:true} response flush
// back to agent-run.sh's report_complete curl FIRST. Stopping synchronously
// strands that curl (it never receives the response, and curl's --max-time is
// not honored once msb destroys the socket), which wedges the VM's EXIT trap and
// leaves the session "running" until the max-duration backstop fires (hours).
const COMPLETE_STOP_DELAY_MS = 2_000

/**
 * Background task that runs after a session's microVM is confirmed Running.
 * Streams logs back to the Maskin backend (when MASKIN_BASE_URL is set),
 * waits for the sandbox to exit, pushes the workspace to S3, reports
 * completion to the backend, then cleans up the host-side session dir.
 *
 * Log lines arrive via the /sessions/:id/logs/ingest HTTP endpoint that
 * agent-run.sh pipes into via curl. The `sessionLogRouters` map connects
 * that endpoint to this function's log buffer.
 */
async function monitorSession(
	sessionId: string,
	sessionDir: string,
	storage: StorageProvider | null,
	msb: MicrosandboxDeps,
	maskinBaseUrl?: string,
	agentServerSecret?: string,
	sessionLogRouters?: Map<string, (line: string) => void>,
	sessionExitCodes?: Map<string, number>,
	browserSidecar?: BrowserSidecar | null,
): Promise<void> {
	const run = msb.run ?? defaultRunner()
	const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

	// Log streaming: buffer lines and POST them to the Maskin backend in batches.
	// Best-effort — if the POST fails, sessions still complete.
	let logBuffer: Array<{ stream: 'stdout' | 'stderr'; content: string }> = []
	let flushTimer: NodeJS.Timeout | null = null

	const flushLogs = async (): Promise<void> => {
		if (!maskinBaseUrl || logBuffer.length === 0) {
			logBuffer = []
			return
		}
		const batch = logBuffer.splice(0)
		try {
			await fetch(`${maskinBaseUrl}/api/internal/agent-servers/sessions/${sessionId}/logs`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${agentServerSecret}`,
				},
				body: JSON.stringify({ logs: batch }),
			})
		} catch (err) {
			logger.warn('failed to POST logs to Maskin', { sessionId, error: String(err) })
		}
	}

	const scheduleFlush = (): void => {
		if (flushTimer) return
		flushTimer = setTimeout(() => {
			flushTimer = null
			void flushLogs()
		}, LOG_FLUSH_INTERVAL_MS)
	}

	// Register a push function so the /sessions/:id/logs/ingest endpoint can
	// deliver lines into this session's log buffer.
	if (sessionLogRouters && maskinBaseUrl) {
		sessionLogRouters.set(sessionId, (line: string) => {
			logBuffer.push({ stream: 'stdout', content: line })
			if (logBuffer.length >= LOG_FLUSH_MAX_LINES) {
				void flushLogs()
			} else {
				scheduleFlush()
			}
		})
	}

	await waitForCompletion(msb.msbBin, sessionId, { run, sleep, now: Date.now })

	// Unregister before flushing so no new lines arrive mid-flush.
	sessionLogRouters?.delete(sessionId)
	if (flushTimer) {
		clearTimeout(flushTimer)
		flushTimer = null
	}
	await flushLogs()

	// Read the exit code recorded by the /complete endpoint, then clean up the entry.
	let exitCode = sessionExitCodes?.get(sessionId) ?? 0
	sessionExitCodes?.delete(sessionId)

	// Push workspace BEFORE reporting completion so a push failure can be reflected
	// in the exit code. Reporting first would mark the session completed even when
	// the workspace was lost, giving the user a silently incorrect starting state on
	// the next session. pushSessionWorkspace already retries transient storage
	// errors (e.g. S3 `SlowDown` throttling) internally — only a failure that
	// survives those retries reaches this catch, so this only overrides a genuine
	// agent success (exitCode 0) when the workspace is truly lost, not on a blip.
	if (storage) {
		try {
			const { archiveBytes } = await pushSessionWorkspace(storage, sessionId, sessionDir, {
				sleep,
			})
			logger.info('session workspace pushed to S3', { sessionId, archiveBytes })
		} catch (err) {
			logger.error('session workspace push failed after retries', {
				sessionId,
				error: String(err),
			})
			if (exitCode === 0) exitCode = 1
		}
	}

	if (maskinBaseUrl) {
		// Retry up to 3 times with a 5s gap. Cleanup (deleteSessionDir + removeSandbox)
		// only runs after a successful report so the sandbox is never silently orphaned:
		// if we clean up before reporting, there is nothing left to retry with and the
		// session row in apps/dev stays `running` until the 2-hour watchdog reaper fires.
		const REPORT_RETRIES = 3
		const REPORT_RETRY_DELAY_MS = 5_000
		let reported = false
		for (let attempt = 1; attempt <= REPORT_RETRIES; attempt++) {
			try {
				await fetch(`${maskinBaseUrl}/api/internal/agent-servers/sessions/${sessionId}/complete`, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						Authorization: `Bearer ${agentServerSecret}`,
					},
					body: JSON.stringify({ exitCode }),
				})
				logger.info('session completion reported to Maskin', { sessionId, exitCode })
				reported = true
				break
			} catch (err) {
				logger.warn('failed to report session completion to Maskin, will retry', {
					sessionId,
					attempt,
					maxAttempts: REPORT_RETRIES,
					error: String(err),
				})
				if (attempt < REPORT_RETRIES) {
					await sleep(REPORT_RETRY_DELAY_MS)
				}
			}
		}
		if (!reported) {
			// All retries exhausted. The session row in apps/dev will stay `running`
			// until the watchdog reaper (or a reconcile call on next boot) marks it
			// terminal. Cleanup still runs so the stopped VM and tmp dir don't linger
			// on disk indefinitely — the workspace is already safely in S3.
			logger.error(
				'session completion report failed after all retries — session may appear running until watchdog fires',
				{ sessionId, exitCode },
			)
		}
	}

	try {
		await deleteSessionDir(sessionDir)
		logger.info('session dir cleaned up', { sessionId, sessionDir })
	} catch (err) {
		logger.warn('session dir cleanup failed', { sessionId, error: String(err) })
	}

	// A `create`d sandbox lingers in "stopped" state after it stops (via the
	// /complete signal or the max-duration backstop) until explicitly removed.
	// Remove it so stopped VMs don't accumulate in `msb list` across sessions.
	try {
		await removeSandbox(sessionId, msb)
		logger.info('sandbox removed', { sessionId })
	} catch (err) {
		logger.warn('sandbox removal failed', { sessionId, error: String(err) })
	}

	// AC-T5: tear the sidecar down within 60s of session end so no orphaned
	// Chromium VMs linger. `cleanupBrowserSidecar` is a no-op when no sidecar
	// was provisioned (the common path).
	if (browserSidecar) {
		await cleanupBrowserSidecar(browserSidecar, msb)
	}
}

export function buildApp(deps: AppDeps): Hono {
	const app = new Hono()
	const inputQueue = new InputQueue()
	// Connects the /sessions/:id/logs/ingest endpoint to monitorSession's buffer.
	const sessionLogRouters = new Map<string, (line: string) => void>()
	// Receives exit codes from the /sessions/:id/complete endpoint for monitorSession.
	const sessionExitCodes = new Map<string, number>()

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

	// VM-facing endpoints — registered BEFORE requireBearer so microsandbox VMs
	// (which hold no AGENT_SERVER_SECRET) can reach them. Security relies on the
	// 122-bit session ID entropy and host-loopback reachability.

	// GET /sessions/:id/input/stream — VM polls here to receive newline-delimited
	// JSON user turns for interactive sessions.
	app.get('/sessions/:id/input/stream', async (c) => {
		const { id } = c.req.param()
		if (!SESSION_ID_RE.test(id)) return c.json({ error: 'Invalid session id' }, 400)
		return stream(c, async (s) => {
			let resolveStream!: () => void
			const done = new Promise<void>((resolve) => {
				resolveStream = resolve
			})
			const unregister = await inputQueue.registerStream(id, async (line) => {
				try {
					await s.write(line)
					return true
				} catch {
					resolveStream()
					return false
				}
			})
			c.req.raw.signal.addEventListener('abort', () => {
				unregister()
				resolveStream()
			})
			await done
			unregister()
		})
	})

	// POST /sessions/:id/logs/ingest — agent-run.sh streams all agent output here
	// over a single long-lived chunked POST (`curl -T -`). We read the request
	// body as it arrives and push each newline-delimited line into the session's
	// log buffer immediately, so monitorSession forwards them to the Maskin
	// backend live (~2s batches) instead of all at once at session end.
	app.post('/sessions/:id/logs/ingest', async (c) => {
		const { id } = c.req.param()
		if (!SESSION_ID_RE.test(id)) return c.json({ error: 'Invalid session id' }, 400)

		const push = sessionLogRouters.get(id)
		const rawBody = c.req.raw.body
		if (!rawBody) return c.json({ ok: true })

		const handleLine = push ?? ((_line: string) => {}) // drain body even if not monitored
		const decoder = new TextDecoder()
		let buf = ''
		const reader = rawBody.getReader()
		try {
			for (;;) {
				const { done, value } = await reader.read()
				if (done) break
				buf += decoder.decode(value as Uint8Array, { stream: true })
				let nl = buf.indexOf('\n')
				while (nl !== -1) {
					const line = buf.slice(0, nl + 1)
					buf = buf.slice(nl + 1)
					if (line.trimEnd()) handleLine(line)
					nl = buf.indexOf('\n')
				}
			}
			const remaining = buf + decoder.decode()
			if (remaining.trimEnd()) handleLine(remaining)
		} catch {
			// Connection closed early — that's fine, we have what we got
		}
		return c.json({ ok: true })
	})

	// POST /sessions/:id/complete — agent-run.sh's EXIT trap signals that the
	// session workload finished. A `create`d microVM is persistent and does NOT
	// power off when its entrypoint exits (its PID 1 is microsandbox's agentd),
	// so we stop it here. The resulting running → stopped transition is what
	// monitorSession's waitForCompletion polls for; it then flushes logs, reports
	// completion, pushes the workspace to S3, and removes the sandbox. Registered
	// before requireBearer because the VM holds no AGENT_SERVER_SECRET — the 122-bit
	// session id + host-loopback reachability are the guard, same as ingest/input.
	app.post('/sessions/:id/complete', async (c) => {
		const { id } = c.req.param()
		if (!SESSION_ID_RE.test(id)) return c.json({ error: 'Invalid session id' }, 400)

		// Parse optional exit code from agent-run.sh. Missing body or parse failure
		// defaults to 0 so the endpoint stays compatible with older agent images.
		let exitCode = 0
		try {
			const raw = await c.req.json()
			if (raw && typeof raw === 'object' && typeof raw.exitCode === 'number') {
				exitCode = raw.exitCode
			}
		} catch {
			// no body or non-JSON — keep default 0
		}
		sessionExitCodes.set(id, exitCode)

		logger.info('completion signal received', { sessionId: id, exitCode })
		// Graceful stop (not force-remove) so the bind-mounted /agent workspace
		// flushes before the S3 push. Deferred (not immediate): `msb stop` tears
		// down this VM's network, and if we stop before this response flushes back
		// to the VM, agent-run.sh's report_complete curl blocks indefinitely (curl
		// --max-time isn't honored once the smoltcp socket is destroyed), wedging
		// the EXIT trap so the session never actually completes. Responding first
		// and stopping after COMPLETE_STOP_DELAY_MS lets the curl return cleanly.
		// Best-effort and idempotent.
		setTimeout(() => {
			void stopSandbox(id, deps.msb).catch((err) => {
				logger.warn('failed to stop sandbox on completion signal', {
					sessionId: id,
					error: String(err),
				})
			})
		}, COMPLETE_STOP_DELAY_MS)
		return c.json({ ok: true })
	})

	// All other /sessions routes require the shared bearer token.
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
					body.sourceSessionId,
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
		const pullPolicy: PullPolicy = warmHit ? 'if-missing' : 'always'

		// Inject AGENT_SERVER_URL so agent-run.sh can stream interactive input
		// from this server. The microVM can reach us at host.microsandbox.internal
		// (written into the VM's /etc/hosts by microsandbox) on our own PORT.
		const agentServerInternalHost =
			deps.env.AGENT_SERVER_INTERNAL_HOST ?? 'host.microsandbox.internal'
		const sessionEnv: Record<string, string> = {
			...body.env,
			AGENT_SERVER_URL: `http://${agentServerInternalHost}:${deps.env.PORT}`,
		}

		// AC-T1/AC-T6: provision a Chromium CDP sidecar only when the flag is on.
		// A failed sidecar must not take down the session — the agent falls back
		// to an instrumentation-gap comment instead of fabricating a browser pass.
		let browserSidecar: BrowserSidecar | null = null
		if (body.browserRequired === true) {
			browserSidecar = await provisionBrowserSidecar(body.sessionId.slice(0, 16), deps.msb, {
				image: deps.env.BROWSER_SIDECAR_IMAGE,
				bridgeGateway: deps.env.MSB_BRIDGE_GATEWAY,
			})
			if (browserSidecar) {
				sessionEnv.BROWSER_CDP_URL = browserSidecar.cdpUrl
				logger.info('browser sidecar attached to session', {
					sessionId: body.sessionId,
					sidecarName: browserSidecar.name,
					cdpUrl: browserSidecar.cdpUrl,
				})
			} else {
				logger.warn('browser sidecar unavailable — session continues without browser', {
					sessionId: body.sessionId,
				})
			}
		}

		try {
			const result = await spawnSession(
				{
					sessionId: body.sessionId,
					image: body.image,
					env: sessionEnv,
					...(body.memoryMib !== undefined && { memoryMib: body.memoryMib }),
					...(body.cpus !== undefined && { cpus: body.cpus }),
					hostPort: deps.env.PORT,
					...(deps.env.MASKIN_AGENT_SERVER_PUBLIC_HOST !== undefined && {
						publicHost: deps.env.MASKIN_AGENT_SERVER_PUBLIC_HOST,
					}),
					sessionDir,
					pullPolicy,
					...(deps.env.SESSION_MAX_DURATION !== '' &&
						deps.env.SESSION_MAX_DURATION !== '0' && {
							maxDuration: deps.env.SESSION_MAX_DURATION,
						}),
					// Only opened when a sidecar was provisioned — keeps the default
					// session firewall posture tight for the common path.
					...(browserSidecar !== null && { allowPrivateNet: true }),
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

			// Write exec trigger to the bind-mounted session dir. entrypoint.sh sleeps
			// during create-time (no trigger); finding this file tells it to run the
			// real workload. Must happen before msb exec is launched.
			await writeFile(join(sessionDir, '.exec-trigger'), '1', { mode: 0o644 })

			// Background: wait for VM exit → flush logs → report completion →
			// push workspace to S3 → delete local dir → drain input queue.
			// Register session in sessionLogRouters synchronously (before first await)
			// so ingest calls from the forthcoming exec don't miss.
			void monitorSession(
				body.sessionId,
				sessionDir,
				deps.storage,
				deps.msb,
				deps.env.MASKIN_BASE_URL,
				deps.env.AGENT_SERVER_SECRET,
				sessionLogRouters,
				sessionExitCodes,
				browserSidecar,
			)
				.catch((err) => {
					logger.error('monitorSession crashed unexpectedly', {
						sessionId: body.sessionId,
						error: String(err),
					})
					// monitorSession crashed before reaching its own cleanupBrowserSidecar
					// block — clean up here so the sidecar VM isn't left orphaned.
					if (browserSidecar) {
						void cleanupBrowserSidecar(browserSidecar, deps.msb).catch((cleanupErr) => {
							logger.warn('browser sidecar cleanup after monitorSession crash failed', {
								sessionId: body.sessionId,
								error: String(cleanupErr),
							})
						})
					}
				})
				.finally(() => {
					inputQueue.drainSession(body.sessionId)
				})

			// Launch msb exec in the background. entrypoint.sh finds the trigger and
			// runs agent-run.sh under the exec TCP proxy (the proxy is only active
			// during exec sessions, not during the VM's create-time boot).
			launchSessionExec(body.sessionId, deps.msb)

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
			// Don't orphan the sidecar — spawnSession failed before monitorSession
			// would have torn it down. Best-effort, idempotent.
			if (browserSidecar) {
				await cleanupBrowserSidecar(browserSidecar, deps.msb).catch(() => {})
			}
			return c.json({ error: 'spawn_failed', message: String(err) }, 500)
		}
	})

	// POST /sessions/:id/input — apps/dev calls this to deliver a user turn to an
	// interactive session. Bearer auth is inherited from the /sessions/* middleware.
	app.post('/sessions/:id/input', async (c) => {
		const { id } = c.req.param()
		if (!SESSION_ID_RE.test(id)) return c.json({ error: 'Invalid session id' }, 400)
		let body: unknown
		try {
			body = await c.req.json()
		} catch {
			return c.json({ error: 'Invalid JSON' }, 400)
		}
		if (
			!body ||
			typeof body !== 'object' ||
			typeof (body as Record<string, unknown>).content !== 'string'
		) {
			return c.json({ error: 'Missing content field' }, 400)
		}
		const payload = {
			type: 'user',
			message: { role: 'user', content: (body as Record<string, unknown>).content as string },
		}
		await inputQueue.enqueue(id, `${JSON.stringify(payload)}\n`)
		return c.json({ ok: true })
	})

	// POST /sessions/:id/stop — apps/dev calls this to force-stop a session's
	// sandbox (user-initiated stop). Bearer auth is inherited from the
	// /sessions/* middleware. Idempotent, like the /complete handler's deferred
	// stopSandbox call above: stopping an already-stopped or absent sandbox is
	// not an error. apps/dev treats this call as authoritative and marks the
	// session terminal itself rather than waiting for monitorSession to report
	// back — that watcher lives in this process's memory and would be gone
	// after a redeploy, leaving the session stuck otherwise.
	app.post('/sessions/:id/stop', async (c) => {
		const { id } = c.req.param()
		if (!SESSION_ID_RE.test(id)) return c.json({ error: 'Invalid session id' }, 400)
		try {
			await stopSandbox(id, deps.msb)
		} catch (err) {
			logger.warn('failed to stop sandbox on external stop request', {
				sessionId: id,
				error: String(err),
			})
		}
		return c.json({ ok: true })
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
