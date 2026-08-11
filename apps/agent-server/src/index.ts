import './lib/sentry'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { serve } from '@hono/node-server'
import type { StorageProvider } from '@maskin/storage'
import { Hono } from 'hono'
import { stream } from 'hono/streaming'
import { z } from 'zod'
import { bearerAuth } from './lib/auth'
import { type AgentServerEnv, parseEnv } from './lib/env'
import { logger } from './lib/logger'
import { Sentry } from './lib/sentry'
import { ImageWarmer } from './services/image-warmer'
import { InputQueue } from './services/input-queue'
import {
	type BrowserSidecar,
	type MicrosandboxDeps,
	type PreviewPortMapping,
	type PullPolicy,
	type SshRelay,
	cleanupBrowserSidecar,
	defaultRunner,
	ensureAgentServerSshKey,
	launchSessionExec,
	listSandboxNames,
	provisionBrowserSidecar,
	readMsbVersion,
	removeSandbox,
	resolvePreviewPortMappings,
	spawnSession,
	startSshRelay,
	stopSandbox,
	waitForCompletion,
} from './services/microsandbox'
import {
	deleteSessionDir,
	pullSessionWorkspace,
	pushSessionWorkspace,
} from './services/session-workspace'

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

const MAX_PREVIEW_GUEST_PORTS = 8

const SESSION_REQUEST_SCHEMA = z
	.object({
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
		// Guest port(s) inside the session to publish on the msb bridge gateway
		// (e.g. a Vite dev server on 5173), so the browser sidecar's Playwright can
		// reach them. Only takes effect when browserRequired is also true — the
		// forwarding exists to let the sidecar view the session's own dev server.
		// Capped well below ephemeral port exhaustion range; a session only ever
		// needs to forward a handful of local dev servers.
		previewGuestPorts: z
			.array(z.number().int().positive().max(65535))
			.max(MAX_PREVIEW_GUEST_PORTS)
			.optional(),
		sourceSessionId: z.string().regex(SESSION_ID_RE).optional(),
	})
	.refine((data) => !data.previewGuestPorts || data.browserRequired === true, {
		message: 'previewGuestPorts requires browserRequired to be true',
		path: ['previewGuestPorts'],
	})

export type AppDeps = {
	env: AgentServerEnv
	storage: StorageProvider | null
	msb: MicrosandboxDeps
	warmer?: ImageWarmer | null
	/**
	 * Shared with `main()`'s boot-time `reconcileOnBoot` pass so a reattached
	 * `monitorSession()` call for a sandbox that survived a restart writes into
	 * the same map the HTTP handlers below read from. Tests may also inject a
	 * map directly to assert what the /stop and /complete handlers write into
	 * it. Omitted → buildApp creates its own fresh map (still fully
	 * backward-compatible for any caller that doesn't need to share it).
	 */
	sessionExitCodes?: Map<string, number>
	/** Same sharing rationale as `sessionExitCodes` — see its doc comment. */
	sessionLogRouters?: Map<string, (line: string) => void>
	/**
	 * Mutable flag flipped by `main()`'s SIGTERM handler. `POST /sessions`
	 * rejects new work with 503 while `draining` is true, so a session request
	 * that arrives in the shutdown window can't be left half-spawned (created
	 * but never registered with `monitorSession`) when the process exits.
	 * Omitted → never drains (always accepts), which is what every existing
	 * test expects.
	 */
	drainState?: { draining: boolean }
	/**
	 * Mutable flag flipped once `main()`'s boot-time `reconcileOnBoot()` pass
	 * finishes (success or failure). `POST /sessions` rejects new work with
	 * 503 while `ready` is false, so a session apps/dev dispatches to this box
	 * in the window between the HTTP listener coming up and reconcileOnBoot's
	 * `msb list` snapshot completing can never be spawned here — otherwise
	 * that snapshot could see the new sandbox and reconcileOnBoot's reattach
	 * loop would call `monitorSession` on it a second time (duplicate S3
	 * push/completion report, clobbered log routing), or worse, apps/dev could
	 * still be mid-write on the session's DB row and report it back as an
	 * unclaimed orphan, causing reconcileOnBoot to force-remove a sandbox that
	 * was just created. Omitted → always ready (always accepts), which is
	 * what every existing test expects.
	 */
	readyState?: { ready: boolean }
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

// Exit code seeded into `sessionExitCodes` when a session is force-stopped via
// POST /sessions/:id/stop (as opposed to a graceful exit reported through
// POST /sessions/:id/complete, whose EXIT trap always supplies a real exit
// code). Guarantees that if monitorSession's independent waitForCompletion
// poll ever notices this session's VM went to "stopped" as a side effect of
// the forced kill, it reports a nonzero code — never the 0 default at
// `sessionExitCodes?.get(sessionId) ?? 0` below — so markRemoteSessionComplete
// always computes 'failed', never 'completed', for an explicitly-stopped
// session, even if apps/dev crashes before it can record the stop itself.
// 137 = 128 + SIGKILL(9), the conventional "force-killed" exit code.
//
// Accepted tradeoff: if the session's own agent-run.sh EXIT trap reports a
// real exit code to /complete within the same narrow window as a stop
// request — in either order — the later write wins and the earlier one is
// silently overwritten. A stop racing a natural completion within
// milliseconds is a genuine ambiguity, not a bug this fix is meant to close.
export const FORCED_STOP_EXIT_CODE = 137

// Filename of the marker written into a session's own dir the moment
// POST /sessions/:id/complete records its exit code (see that handler below).
// Unlike sessionExitCodes and the deferred stopSandbox timer in that handler,
// this file lives on disk and survives a process restart, so reconcileOnBoot
// can recover a session's real exit code and re-issue its stop on the next
// boot if this process is killed before that timer ever fires.
const EXIT_CODE_MARKER_FILENAME = '.exit-code'

// Upper bound on how long a `sessionExitCodes` entry seeded by /stop may
// outlive its write. monitorSession (the only reader/deleter, see its
// `sessionExitCodes?.delete(sessionId)` below) polls sandbox status every
// COMPLETION_POLL_INTERVAL_MS (5s in services/microsandbox.ts), so a session
// it's still actively tracking will consume the entry within seconds of the
// sandbox actually stopping. A /stop call for a session with no live monitor
// on this box (already finished here, or never dispatched here) would
// otherwise leak this entry for the life of the process — this timer bounds
// that instead of relying on an unbounded Map.
export const SESSION_EXIT_CODE_SENTINEL_TTL_MS = 10 * 60 * 1000

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
	previewRelays?: SshRelay[],
): Promise<void> {
	const run = msb.run ?? defaultRunner()
	const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

	// Log streaming: buffer lines and POST them to the Maskin backend in batches.
	// Best-effort — if the POST fails, sessions still complete.
	let logBuffer: Array<{ stream: 'stdout' | 'stderr'; content: string }> = []
	let flushTimer: NodeJS.Timeout | null = null

	const LOG_FLUSH_RETRIES = 3
	const LOG_FLUSH_RETRY_DELAY_MS = 2_000

	const flushLogs = async (): Promise<void> => {
		if (!maskinBaseUrl || logBuffer.length === 0) {
			logBuffer = []
			return
		}
		const batch = logBuffer.splice(0)
		for (let attempt = 1; attempt <= LOG_FLUSH_RETRIES; attempt++) {
			try {
				const res = await fetch(
					`${maskinBaseUrl}/api/internal/agent-servers/sessions/${sessionId}/logs`,
					{
						method: 'POST',
						headers: {
							'Content-Type': 'application/json',
							Authorization: `Bearer ${agentServerSecret}`,
						},
						body: JSON.stringify({ logs: batch }),
					},
				)
				if (!res.ok) {
					throw new Error(`Maskin log ingest responded with ${res.status}`)
				}
				return
			} catch (err) {
				logger.warn('failed to POST logs to Maskin, will retry', {
					sessionId,
					attempt,
					maxAttempts: LOG_FLUSH_RETRIES,
					error: String(err),
				})
				if (attempt < LOG_FLUSH_RETRIES) {
					await sleep(LOG_FLUSH_RETRY_DELAY_MS)
				}
			}
		}
		// All retries exhausted — this batch is genuinely gone. Leave a visible
		// marker for the next successful flush so the gap isn't silent.
		logger.error('failed to POST logs to Maskin after all retries, batch dropped', {
			sessionId,
			droppedLines: batch.length,
		})
		logBuffer.push({
			stream: 'stdout',
			content: `[system] ${batch.length} log lines failed to reach Maskin after ${LOG_FLUSH_RETRIES} attempts and were dropped\n`,
		})
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
		for (const relay of previewRelays ?? []) relay.stop()
		await cleanupBrowserSidecar(browserSidecar, msb)
	}
}

export function buildApp(deps: AppDeps): Hono {
	const app = new Hono()
	app.onError((err, c) => {
		Sentry.captureException(err, { tags: { path: c.req.path, method: c.req.method } })
		logger.error('unhandled error', { path: c.req.path, method: c.req.method, error: String(err) })
		return c.json({ error: 'internal_error' }, 500)
	})
	const inputQueue = new InputQueue()
	// Connects the /sessions/:id/logs/ingest endpoint to monitorSession's buffer.
	// Injectable via deps so main()'s boot-time reconcile pass can reattach
	// monitorSession for sandboxes that survived a restart (see AppDeps.sessionLogRouters).
	const sessionLogRouters = deps.sessionLogRouters ?? new Map<string, (line: string) => void>()
	// Receives exit codes from the /sessions/:id/complete and /sessions/:id/stop
	// endpoints for monitorSession. Injectable via deps (see AppDeps.sessionExitCodes).
	const sessionExitCodes = deps.sessionExitCodes ?? new Map<string, number>()

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

		// Persist the exit code to the session's own dir — see
		// EXIT_CODE_MARKER_FILENAME's comment for why this needs to survive a
		// restart independently of sessionExitCodes and the deferred stop below.
		await writeFile(
			join(deps.env.AGENT_SESSION_ROOT, id, EXIT_CODE_MARKER_FILENAME),
			String(exitCode),
			'utf8',
		).catch((err) => {
			logger.warn('failed to persist exit code marker', { sessionId: id, error: String(err) })
		})

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
		// Reject new work once shutdown has begun — otherwise a session created
		// in the ~10s shutdown window could be only half-spawned (sandbox
		// created but never registered with monitorSession) when the process
		// exits, leaving one more stray orphan for the next boot's reconcile
		// pass to clean up. Already-running sessions are unaffected by this.
		if (deps.drainState?.draining) {
			return c.json({ error: 'draining' }, 503)
		}
		// Reject new work until the boot-time reconcile pass has finished —
		// otherwise this session's sandbox could be snapshotted by reconcileOnBoot
		// mid-creation and either get a duplicate monitorSession attached or be
		// force-removed as a false-positive orphan (see AppDeps.readyState).
		if (deps.readyState && !deps.readyState.ready) {
			return c.json({ error: 'starting_up' }, 503)
		}
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
		let previewPortMappings: PreviewPortMapping[] = []
		let previewForwardingFailed = false
		// Released once the SSH relay(s) into these ports have actually been
		// started (success or failure) further down — see the preview-relay
		// block after spawnSession. Keeps the held probe sockets from leaking
		// on every code path.
		let releasePreviewPorts: () => void = () => {}
		if (body.browserRequired === true) {
			// Resolve preview port relay ports before provisioning the sidecar so
			// we know which allow@host:tcp:<port> rules the sidecar needs baked in
			// at create time — the relay itself can only start once the session VM
			// is Running, further down.
			if (body.previewGuestPorts && body.previewGuestPorts.length > 0) {
				try {
					const resolved = await resolvePreviewPortMappings(body.previewGuestPorts, deps.msb)
					previewPortMappings = resolved.mappings
					releasePreviewPorts = resolved.release
				} catch (err) {
					previewForwardingFailed = true
					logger.warn('preview port resolution failed — continuing without preview forwarding', {
						sessionId: body.sessionId,
						error: String(err),
					})
				}
			}
			browserSidecar = await provisionBrowserSidecar(body.sessionId.slice(0, 16), deps.msb, {
				image: deps.env.BROWSER_SIDECAR_IMAGE,
				sshKeyPath: deps.env.AGENT_SERVER_SSH_KEY_PATH,
				agentServerInternalHost,
				...(previewPortMappings.length > 0 && {
					extraAllowedHostPorts: previewPortMappings.map((m) => m.relayPort),
				}),
			})
			if (browserSidecar) {
				sessionEnv.BROWSER_CDP_URL = browserSidecar.cdpUrl
				const primaryPreviewMapping = previewPortMappings[0]
				if (primaryPreviewMapping) {
					sessionEnv.PREVIEW_URL = `http://${agentServerInternalHost}:${primaryPreviewMapping.relayPort}`
				}
				logger.info('browser sidecar attached to session', {
					sessionId: body.sessionId,
					sidecarName: browserSidecar.name,
					cdpUrl: browserSidecar.cdpUrl,
					previewUrl: sessionEnv.PREVIEW_URL,
				})
			} else {
				if (previewPortMappings.length > 0) {
					previewForwardingFailed = true
				}
				logger.warn('browser sidecar unavailable — session continues without browser', {
					sessionId: body.sessionId,
				})
			}
		}

		const previewRelays: SshRelay[] = []
		try {
			let result: Awaited<ReturnType<typeof spawnSession>>
			try {
				result = await spawnSession(
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
						// session firewall posture tight for the common path. Grants
						// reachability into exactly the sidecar's CDP SSH-relay port,
						// not the old allow@private blanket RFC1918 range.
						...(browserSidecar?.cdpRelay !== undefined && {
							extraAllowedHostPorts: [browserSidecar.cdpRelay.relayPort],
						}),
					},
					deps.msb,
				)
			} catch (err) {
				// spawnSession failed — no live VM to relay into, release the
				// preview-port reservations now.
				releasePreviewPorts()
				throw err
			}
			logger.info('session spawned', {
				sessionId: body.sessionId,
				image: body.image,
				warmHit,
				pullPolicy,
				envOverflowSpilled: result.envOverflowSpilled,
				envSanitized: result.envSanitized,
			})

			// Session VM is now Running — actually open the SSH-relay tunnel(s) into
			// its preview port(s), targeting the same relayPort numbers already
			// baked into the sidecar's allow@host:tcp:<port> net-rules above. Must
			// happen after spawnSession (the relay target must be a live VM); the
			// pre-reserved port numbers are only released once this has run,
			// whatever the outcome — see resolvePreviewPortMappings.
			if (browserSidecar && previewPortMappings.length > 0) {
				try {
					for (const mapping of previewPortMappings) {
						const relay = await startSshRelay(
							body.sessionId,
							mapping.guestPort,
							deps.env.AGENT_SERVER_SSH_KEY_PATH,
							deps.msb,
							{ relayPort: mapping.relayPort },
						)
						if (relay) {
							previewRelays.push(relay)
						} else {
							previewForwardingFailed = true
							logger.warn('preview port ssh relay failed to establish', {
								sessionId: body.sessionId,
								guestPort: mapping.guestPort,
								relayPort: mapping.relayPort,
							})
						}
					}
				} finally {
					releasePreviewPorts()
				}
			} else {
				releasePreviewPorts()
			}

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
				previewRelays,
			)
				.catch((err) => {
					logger.error('monitorSession crashed unexpectedly', {
						sessionId: body.sessionId,
						error: String(err),
					})
					// monitorSession crashed before reaching its own cleanup tail — clean
					// up here so the sidecar VM and preview relays aren't left orphaned.
					for (const relay of previewRelays) relay.stop()
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
					...(sessionEnv.PREVIEW_URL !== undefined && { preview_url: sessionEnv.PREVIEW_URL }),
					...(previewForwardingFailed && { preview_forwarding_failed: true }),
				},
				201,
			)
		} catch (err) {
			logger.error('session spawn failed', { sessionId: body.sessionId, error: String(err) })
			// Don't orphan the sidecar or any preview relays — spawnSession failed
			// before monitorSession would have torn them down. Best-effort, idempotent.
			for (const relay of previewRelays) relay.stop()
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
		// Seed BEFORE stopping the sandbox, and regardless of whether the stop
		// below succeeds — see FORCED_STOP_EXIT_CODE's comment.
		sessionExitCodes.set(id, FORCED_STOP_EXIT_CODE)
		// Self-cleaning: only deletes if nothing has consumed or overwritten the
		// entry by then — see SESSION_EXIT_CODE_SENTINEL_TTL_MS's comment.
		setTimeout(() => {
			if (sessionExitCodes.get(id) === FORCED_STOP_EXIT_CODE) {
				sessionExitCodes.delete(id)
			}
		}, SESSION_EXIT_CODE_SENTINEL_TTL_MS).unref()
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

// Browser sidecar VMs (see provisionBrowserSidecar) never have their own DB
// session row, so a bare `msb list` snapshot sent to /reconcile would always
// report them as unclaimed — including one still attached to a live session —
// and get force-removed. They're matched to their owning session's sandbox
// name by this naming convention instead (see the reattach loop below) and
// never sent to apps/dev at all.
const BROWSER_SIDECAR_PREFIX = 'anko-browser-'

/**
 * Reads the exit-code marker written by POST /sessions/:id/complete (see
 * EXIT_CODE_MARKER_FILENAME). Returns null if the session hasn't completed
 * yet (still genuinely running) or the marker is missing/unreadable for any
 * other reason — the caller treats that as "no recovery needed".
 */
async function readExitCodeMarker(sessionDir: string): Promise<number | null> {
	try {
		const raw = await readFile(join(sessionDir, EXIT_CODE_MARKER_FILENAME), 'utf8')
		const parsed = Number.parseInt(raw, 10)
		return Number.isFinite(parsed) ? parsed : null
	} catch {
		return null
	}
}

export type ReconcileOnBootDeps = {
	env: AgentServerEnv
	storage: StorageProvider | null
	msb: MicrosandboxDeps
	sessionLogRouters: Map<string, (line: string) => void>
	sessionExitCodes: Map<string, number>
	fetchImpl?: typeof fetch
}

/**
 * Runs once on boot (see main()). Tells apps/dev which sandboxes this box
 * still has running — so sessions that are genuinely gone (a hard crash, or
 * simply the first restart after deploying the KillMode fix below) get marked
 * failed within seconds instead of sitting `running` until the 2-hour
 * watchdog fires — removes any sandbox apps/dev doesn't recognize as claimed
 * by a live session, and reattaches monitorSession for everything else so a
 * session that survived the restart still gets its workspace pushed to S3
 * and its completion reported once it finishes. Without this, that session's
 * /complete signal would land on this fresh process, which has no monitor
 * waiting for it, and the DB row would stall until the watchdog times it out
 * even though the work already finished.
 *
 * Also reattaches (or removes, if orphaned) each reattached session's browser
 * CDP sidecar VM by naming convention, and recovers a session's real exit
 * code plus re-issues its stop from the on-disk marker POST
 * /sessions/:id/complete writes, in case this process was killed/restarted
 * before that handler's own deferred stopSandbox call ever fired.
 *
 * No-ops (with a log line) if AGENT_SERVER_ID or MASKIN_BASE_URL aren't
 * configured — a box that hasn't set AGENT_SERVER_ID yet still boots
 * normally, just without this pass.
 */
export async function reconcileOnBoot(deps: ReconcileOnBootDeps): Promise<void> {
	const { env } = deps
	if (!env.AGENT_SERVER_ID || !env.MASKIN_BASE_URL) {
		logger.info('reconcile-on-boot skipped', {
			reason: !env.AGENT_SERVER_ID ? 'AGENT_SERVER_ID not set' : 'MASKIN_BASE_URL not set',
		})
		return
	}
	const fetchFn = deps.fetchImpl ?? fetch

	let names: string[]
	try {
		names = await listSandboxNames(deps.msb)
	} catch (err) {
		logger.error('reconcile-on-boot: msb list failed, skipping this pass', { error: String(err) })
		return
	}
	// Owned by naming convention (see provisionBrowserSidecar) — matched against
	// reattached sessions below and never reported to apps/dev.
	const browserSidecarNames = new Set(
		names.filter((name) => name.startsWith(BROWSER_SIDECAR_PREFIX)),
	)
	const claimableSandboxes = names.filter((name) => !browserSidecarNames.has(name))

	let result: { marked_failed: string[]; orphan_sandboxes: string[] }
	try {
		const res = await fetchFn(`${env.MASKIN_BASE_URL}/api/internal/agent-servers/reconcile`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${env.AGENT_SERVER_SECRET}`,
			},
			body: JSON.stringify({
				agent_server_id: env.AGENT_SERVER_ID,
				sandboxes: claimableSandboxes,
			}),
			signal: AbortSignal.timeout(10_000),
		})
		if (!res.ok) {
			logger.error('reconcile-on-boot: reconcile call failed', { status: res.status })
			return
		}
		result = (await res.json()) as { marked_failed: string[]; orphan_sandboxes: string[] }
	} catch (err) {
		logger.error('reconcile-on-boot: reconcile call threw, skipping this pass', {
			error: String(err),
		})
		return
	}

	logger.info('reconcile-on-boot complete', {
		reportedSandboxes: claimableSandboxes.length,
		markedFailed: result.marked_failed.length,
		orphanCount: result.orphan_sandboxes.length,
	})

	const orphanSet = new Set(result.orphan_sandboxes)
	// Independent per-sandbox removals — run concurrently rather than one at a
	// time so a box with many orphans (e.g. after a hard crash) doesn't stretch
	// this pass out linearly. POST /sessions stays gated on this whole function
	// finishing (see AppDeps.readyState), so a slow sequential loop here would
	// directly extend how long new sessions get rejected after every restart.
	await Promise.all(
		result.orphan_sandboxes.map((name) =>
			removeSandbox(name, deps.msb).catch((err) => {
				logger.warn('reconcile-on-boot: failed to remove orphan sandbox', {
					name,
					error: String(err),
				})
			}),
		),
	)

	// Everything reported that ISN'T an orphan is, by the reconciler's own
	// logic, still claimed by a live (non-terminal) DB session row — reattach
	// its monitor so it gets a normal S3 push + completion report when it
	// eventually finishes. Sandbox name === sessionId for main sessions (see
	// buildMsbCreateArgs), so sessionDir is derivable without any extra state.
	for (const name of claimableSandboxes) {
		if (orphanSet.has(name)) continue
		const sessionDir = join(deps.env.AGENT_SESSION_ROOT, name)

		// If /complete already ran for this session before the restart, its
		// exit code marker survived on disk even though the in-memory
		// sessionExitCodes entry and the deferred stopSandbox timer (see POST
		// /sessions/:id/complete) did not. Recover both here so the session
		// doesn't wedge in "running" until SESSION_MAX_DURATION and doesn't
		// silently report exit code 0 for a run that actually failed.
		const recoveredExitCode = await readExitCodeMarker(sessionDir)
		if (recoveredExitCode !== null) {
			deps.sessionExitCodes.set(name, recoveredExitCode)
			await stopSandbox(name, deps.msb).catch((err) => {
				logger.warn('reconcile-on-boot: failed to re-issue stop for completed session', {
					sessionId: name,
					error: String(err),
				})
			})
		}

		// Reattach the sidecar this session provisioned, if any, so its normal
		// end-of-session cleanupBrowserSidecar call still fires instead of
		// leaking the Chromium VM (see BROWSER_SIDECAR_PREFIX above). cdpUrl is
		// irrelevant here — it was only ever needed to inject BROWSER_CDP_URL
		// into the session VM at spawn time, and cleanupBrowserSidecar only
		// reads `.name`.
		const sidecarName = `${BROWSER_SIDECAR_PREFIX}${name.slice(0, 16)}`
		const browserSidecar: BrowserSidecar | null = browserSidecarNames.has(sidecarName)
			? { name: sidecarName, cdpUrl: '' }
			: null
		if (browserSidecar) browserSidecarNames.delete(sidecarName)

		void monitorSession(
			name,
			sessionDir,
			deps.storage,
			deps.msb,
			env.MASKIN_BASE_URL,
			env.AGENT_SERVER_SECRET,
			deps.sessionLogRouters,
			deps.sessionExitCodes,
			browserSidecar,
		).catch((err) => {
			logger.error('reconcile-on-boot: reattached monitorSession crashed', {
				sessionId: name,
				error: String(err),
			})
		})
	}

	// Any browser sidecar left unmatched belongs to a session that's either an
	// orphan itself or no longer exists at all (e.g. it crashed between
	// provisioning the sidecar and finishing) — remove it directly since it
	// never has its own DB row for apps/dev to reconcile.
	if (browserSidecarNames.size > 0) {
		await Promise.all(
			Array.from(browserSidecarNames, (name) =>
				removeSandbox(name, deps.msb).catch((err) => {
					logger.warn('reconcile-on-boot: failed to remove orphan browser sidecar', {
						name,
						error: String(err),
					})
				}),
			),
		)
	}
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

	// Best-effort: a box that can't mint/authorize its relay keypair here still
	// boots — browser-required sessions will simply fail sidecar/preview relay
	// setup individually later (provisionBrowserSidecar / startSshRelay never
	// throw past the session boundary), consistent with this file's philosophy
	// of not crashing the whole box over an optional-capability failure.
	try {
		await ensureAgentServerSshKey(env.AGENT_SERVER_SSH_KEY_PATH, msb)
	} catch (err) {
		logger.error('failed to ensure agent-server ssh relay keypair', { error: String(err) })
	}

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

	// Created here (rather than inside buildApp) so the boot-time reconcile
	// pass below can reattach monitorSession into the same maps the HTTP
	// handlers read from — see AppDeps.sessionLogRouters/sessionExitCodes.
	const sessionLogRouters = new Map<string, (line: string) => void>()
	const sessionExitCodes = new Map<string, number>()
	const drainState = { draining: false }
	// Starts false so POST /sessions 503s until reconcileOnBoot below finishes —
	// see AppDeps.readyState for why that gate has to be closed before any new
	// session can be created on this box.
	const readyState = { ready: false }

	const app = buildApp({
		env,
		storage,
		msb,
		warmer,
		sessionLogRouters,
		sessionExitCodes,
		drainState,
		readyState,
	})

	const server = serve({ fetch: app.fetch, port: env.PORT, hostname: '0.0.0.0' }, ({ port }) => {
		logger.info('agent-server listening', { port })
	})

	// The HTTP listener above accepts connections immediately (health checks,
	// VM-facing endpoints for sessions that survived the restart, etc.), but
	// POST /sessions stays gated by `readyState` until this pass finishes —
	// `.finally` flips it whether reconcile succeeded, failed, or no-opped
	// (AGENT_SERVER_ID/MASKIN_BASE_URL unset), so a box is never stuck
	// rejecting sessions forever.
	void reconcileOnBoot({ env, storage, msb, sessionLogRouters, sessionExitCodes })
		.catch((err) => {
			logger.error('reconcile-on-boot failed unexpectedly', { error: String(err) })
		})
		.finally(() => {
			readyState.ready = true
			logger.info('agent-server ready to accept new sessions')
		})

	let shuttingDown = false
	const shutdown = async (signal: string): Promise<void> => {
		if (shuttingDown) return
		shuttingDown = true
		// Set before anything else so POST /sessions starts rejecting new work
		// the instant shutdown begins, not after the warmer/server teardown below.
		drainState.draining = true
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
