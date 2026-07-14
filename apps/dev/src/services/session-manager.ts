import { execFile as execFileCb } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createGzip } from 'node:zlib'

const execFileAsync = promisify(execFileCb)
import type { Database } from '@maskin/db'
import {
	events,
	actors,
	agentServers,
	integrations,
	objects,
	relationships,
	sessionLogs,
	sessions,
	workspaces,
} from '@maskin/db/schema'
import { githubOwnerLoginToEnvKey } from '@maskin/shared'
import type { StorageProvider } from '@maskin/storage'
import {
	and,
	asc,
	count as countFn,
	desc,
	eq,
	inArray,
	isNotNull,
	isNull,
	lt,
	ne,
	notInArray,
	or,
	sql,
} from 'drizzle-orm'
import {
	claimLoopActiveDay,
	trackLoopActiveDay,
	utcDayString,
} from '../lib/analytics/catalog-events'
import {
	isClaudeFailoverEnabled,
	recordRuntimeClaudeOAuthBackupExhausted,
	recordRuntimeClaudeOAuthFailover,
} from '../lib/claude-failover'
import { classifyCreditExhaustion } from '../lib/credit-classifier'
import { frontendBaseUrl } from '../lib/file-urls'
import {
	GITHUB_PREFLIGHT_SLACK_CHANNEL,
	type PreflightVerdict,
	collectGitHubMcpIdentities,
	postGitHubPreflightSlackAlert,
	runGitHubPreflight,
	stripFailedIdentities,
} from '../lib/github/preflight'
import { isAuthRevokedError } from '../lib/integrations/errors'
import { TokenManager } from '../lib/integrations/oauth/token-manager'
import { fetchInstallationOwnerLogin } from '../lib/integrations/providers/github/auth'
import {
	type SessionGithubInstall,
	sessionGithubLogClassifier,
} from '../lib/integrations/providers/github/log-classifier'
import {
	type TokenMetadata,
	stampTokenMetadata,
} from '../lib/integrations/providers/github/token-metadata'
import { isSlackBotToken } from '../lib/integrations/providers/slack/mcp-server'
import { getProvider } from '../lib/integrations/registry'
import {
	FallbackQuotaExceededError,
	LLM_ROUTE_OAUTH,
	type LlmRoute,
	resolveLlmRoute,
} from '../lib/llm-routing'
import { logger } from '../lib/logger'
import type { IntegrationConfig, WorkspaceSettings } from '../lib/types'
import {
	AgentServerAuthError,
	AgentServerClient,
	AgentServerHttpError,
} from './agent-server-client'
import { AgentStorageManager, type PullWorkspaceSkillsResult } from './agent-storage'
import { ContainerManager, type LogChunk, type StreamJsonUserMessage } from './container-manager'
import { type RuntimeEndReason, RuntimeTelemetry } from './runtime-telemetry'
import type { SessionDispatchQueue } from './session-dispatch-queue'
import { type SessionUsage, extractSessionUsage, parseUsageFromLogChunks } from './usage-parser'
import { buildWorkspaceStartupBlock, renderWorkspaceBriefing } from './workspace-briefing'

/**
 * Today's runtime is Docker on the same host as `apps/dev`. The bet introduces
 * a real `agent_servers` table (T5) + dispatcher (T6) — until those land, every
 * session is bucketed under this synthetic URL so the ship-metric query has a
 * stable group-by key from day one.
 */
const LOCAL_RUNTIME_BUCKET = 'local-docker'

/**
 * Mirrors the allowlist regex enforced on the API side by
 * `apps/dev/src/routes/integrations.ts` and
 * `apps/dev/src/lib/integrations/providers/github/auth.ts` (T4). Kept in sync so
 * a slug rejected at mint time is also rejected at source, before it ever
 * reaches the credential helper.
 */
const REPO_SLUG_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/

/**
 * Strip the common URL forms (`https://github.com/…`, `git@github.com:…`), a
 * trailing `.git`, and a trailing slash, then re-check against `REPO_SLUG_RE`.
 * Returns null when the input can't be reduced to `owner/name`.
 */
function normalizeRepoSlug(raw: string): string | null {
	let s = raw.trim()
	s = s.replace(/^https?:\/\/github\.com\//i, '')
	s = s.replace(/^git@github\.com:/i, '')
	s = s.replace(/\.git$/i, '')
	s = s.replace(/\/$/, '')
	return REPO_SLUG_RE.test(s) ? s : null
}

/**
 * `sessions.startedAt`/`createdAt` are typed `Date | null` by Drizzle but
 * `createdAt` is always populated (DB default). When measuring elapsed runtime
 * for telemetry, prefer `startedAt`, fall back to `createdAt`, and emit zero if
 * both are missing rather than crashing analytics.
 */
function elapsedMs(startedAt: Date | null, createdAt: Date | null): number {
	const anchor = startedAt ?? createdAt
	return anchor ? Date.now() - anchor.getTime() : 0
}

export interface CreateSessionParams {
	actorId: string
	actionPrompt: string
	/**
	 * Free-form session config. Recognized keys include:
	 *   - `interactive?: boolean` — when true, start the container with stdin
	 *     attached so subsequent user turns can be delivered via
	 *     `ContainerManager.write()`. The value is also persisted to
	 *     `sessions.interactive` so downstream routes (e.g. the input route)
	 *     can gate on it without re-parsing config.
	 *   - everything else is passed through as-is to the container env/runtime.
	 */
	config?: Record<string, unknown>
	triggerId?: string
	createdBy: string
	autoStart?: boolean
	/** ID of a prior session whose workspace snapshot should be restored at startup. */
	sourceSessionId?: string
}

/**
 * dockerode surfaces missing/stopped containers as either a 404 (not found)
 * or a 409 with an "is not running" message. Either means the container is
 * gone for our purposes and the session can't be snapshotted.
 */
function isContainerGoneError(err: unknown): boolean {
	if (!err || typeof err !== 'object') return false
	const statusCode = (err as { statusCode?: unknown }).statusCode
	if (statusCode === 404) return true
	const message = (err as { message?: unknown }).message
	if (typeof message !== 'string') return false
	return /HTTP code 404/.test(message) || /is not running/.test(message)
}

function claudeRuntimeFailoverReason(
	failureReason: { provider: string; reason_code: string } | null,
	stdoutTail: string,
): string | null {
	if (!failureReason || failureReason.provider !== 'anthropic') return null
	if (failureReason.reason_code === 'not_logged_in') return 'auth_failed'

	const usageCodes = new Set([
		'session_limit',
		'weekly_limit',
		'opus_limit',
		'server_rate_limit',
		'request_rejected_429',
		'credit_balance_low',
		'billing_error',
		'max_plan_rate_limit',
		'rate_limit_error',
	])
	if (!usageCodes.has(failureReason.reason_code)) return null

	if (stdoutTail.includes('"rateLimitType":"weekly"')) return 'quota_exhausted_weekly'
	if (stdoutTail.includes('"rateLimitType":"five_hour"')) return 'quota_exhausted_5h'
	if (failureReason.reason_code === 'weekly_limit') return 'quota_exhausted_weekly'
	return 'quota_exhausted'
}

/**
 * Decides whether `buildLaunchSpec`'s resolved LLM route needs persisting on
 * `sessions.config`, and if so, returns the merged config. Returns `null`
 * when nothing changed.
 *
 * Clears `claude_oauth_runtime_failover_retry_of` whenever the slot resolves
 * back to `primary`. That marker only means anything while the session is
 * still actually running on the backup a prior runtime failover put it on —
 * leaving it stamped after a lazy recovery flips the slot back to primary
 * would make `maybeRetryClaudeOAuthOnBackup`'s gate (which treats a
 * `retry_of` string alone as sufficient, regardless of the current
 * `llm_oauth_slot`) misclassify a later, unrelated primary failure as
 * "backup already exhausted".
 */
export function mergeLaunchRouteConfig(
	existingConfig: Record<string, unknown>,
	routeTaken: LlmRoute,
	nextOauthSlot: string | undefined,
): Record<string, unknown> | null {
	const needsUpdate =
		existingConfig.llm_route !== routeTaken ||
		(nextOauthSlot && existingConfig.llm_oauth_slot !== nextOauthSlot)
	if (!needsUpdate) return null

	const updatedConfig: Record<string, unknown> = {
		...existingConfig,
		llm_route: routeTaken,
		...(nextOauthSlot ? { llm_oauth_slot: nextOauthSlot } : {}),
	}
	if (nextOauthSlot === 'primary') {
		updatedConfig.claude_oauth_runtime_failover_retry_of = undefined
	}
	return updatedConfig
}

export interface SessionLogEvent extends LogChunk {
	sessionId: string
	logId: number
}

export class SessionManager extends EventEmitter {
	private containers: ContainerManager
	private agentStorage: AgentStorageManager
	private watchdogInterval: NodeJS.Timeout | null = null
	private activeSessions: Map<
		string,
		{
			tempDir: string
			browserContainerId?: string
			networkName?: string
			/**
			 * Rolling tail of stdout (capped at STDOUT_TAIL_BYTES). Lets
			 * `handleCompletion` parse the final stream-json `result` event from
			 * memory, sidestepping any race with the DB log persistence pipeline.
			 */
			stdoutTail?: string
			/** Resolves when `streamContainerLogs` has fully drained. */
			logsDrained?: Promise<void>
		}
	> = new Map()
	/**
	 * Cap on the in-memory stdout tail per session. The usage parser only
	 * scans the last 200 lines, so 64 KB is plenty even with verbose runs.
	 */
	private static readonly STDOUT_TAIL_BYTES = 64 * 1024
	/** Max time to wait for the log stream to drain before parsing usage. */
	private static readonly LOGS_DRAIN_TIMEOUT_MS = 5000
	/**
	 * Docker's logs(follow:true) endpoint can drop transient (HTTP keepalive
	 * timeouts, Docker Desktop hiccups, network blips). Without reattaching,
	 * `session_logs` stops growing and the idle watchdog ~10 min later mistakes
	 * the silence for an idle agent and force-pauses a still-running container.
	 * Reconnect a handful of times before giving up.
	 */
	private static readonly LOG_STREAM_MAX_RECONNECTS = 5
	private static readonly LOG_STREAM_RECONNECT_DELAY_MS = 2000
	/**
	 * AC-T5: cap how long `cleanupBrowserSidecar` waits for Docker to actually
	 * surface a 404 on the sidecar container after `remove({ force: true })`.
	 * `remove -f` is normally synchronous, but a slow daemon can briefly keep
	 * the container row visible — the SLA bounds how long we tolerate that.
	 */
	private static readonly SIDECAR_TEARDOWN_SLA_MS = 60_000
	private static readonly SIDECAR_TEARDOWN_POLL_INTERVAL_MS = 500
	private agentBaseBuildContext: string | null = null
	private browserSidecarBuildContext: string | null = null
	private browserSidecarImageReady: Promise<void> | null = null
	private drainingWorkspaces: Set<string> = new Set()
	private dispatchQueue: SessionDispatchQueue | null = null
	/**
	 * Session IDs the operator (or the agent itself) has asked to stop. Read by
	 * `handleCompletion` to distinguish a `user_stopped` end from a `failed` one
	 * even though both arrive at `watchContainerExit` as a non-zero exit code.
	 */
	private stopRequested: Set<string> = new Set()

	constructor(
		private db: Database,
		private storage: StorageProvider,
		private telemetry: RuntimeTelemetry = new RuntimeTelemetry(),
	) {
		super()
		this.containers = new ContainerManager()
		this.agentStorage = new AgentStorageManager(storage, db)
	}

	setAgentBaseBuildContext(buildContext: string) {
		this.agentBaseBuildContext = buildContext
	}

	setBrowserSidecarBuildContext(buildContext: string) {
		this.browserSidecarBuildContext = buildContext
	}

	warmBrowserSidecarImage(): Promise<void> {
		return this.prepareBrowserSidecarImage()
	}

	/**
	 * Wire a `SessionDispatchQueue` to take over the start path. When set
	 * (production), `startSession` enqueues the session instead of spawning a
	 * local Docker container; the queue calls the `SessionDispatcher`, which
	 * routes to an `agent_servers` row over HTTPS. Local-dev leaves this null
	 * and the manager keeps spawning Docker.
	 */
	setDispatchQueue(queue: SessionDispatchQueue) {
		this.dispatchQueue = queue
	}

	async start() {
		// Start watchdog for timeouts and idle sessions
		this.watchdogInterval = setInterval(() => {
			this.runWatchdog().catch((err) =>
				logger.error('Session watchdog failed', { error: String(err) }),
			)
		}, 60_000)
		logger.info('Session manager started')
	}

	async stop() {
		if (this.watchdogInterval) {
			clearInterval(this.watchdogInterval)
			this.watchdogInterval = null
		}
		await this.telemetry.shutdown()
	}

	/**
	 * Per-agent-server snapshot of how many sessions are currently `starting` or
	 * `running`. Used by the telemetry gauge loop to emit
	 * `runtime_concurrent_sessions_gauge`. Until `agent_servers` lands (T5) every
	 * session bucket is the local Docker runtime.
	 */
	async getConcurrencyByAgentServer(): Promise<Map<string, number>> {
		const [row] = await this.db
			.select({ count: countFn() })
			.from(sessions)
			.where(inArray(sessions.status, ['starting', 'running']))
		return new Map([[LOCAL_RUNTIME_BUCKET, Number(row?.count ?? 0)]])
	}

	async createSession(
		workspaceId: string,
		params: CreateSessionParams,
	): Promise<typeof sessions.$inferSelect> {
		const config = params.config ?? {}
		const interactive = config.interactive === true

		const [session] = await this.db
			.insert(sessions)
			.values({
				workspaceId,
				actorId: params.actorId,
				triggerId: params.triggerId,
				status: 'pending',
				actionPrompt: params.actionPrompt,
				config,
				interactive,
				createdBy: params.createdBy,
				sourceSessionId: params.sourceSessionId,
			})
			.returning()

		if (!session) {
			throw new Error('Failed to create session')
		}

		await this.db.insert(events).values({
			workspaceId,
			actorId: params.actorId,
			action: 'session_created',
			entityType: 'session',
			entityId: session.id,
			data: {},
		})

		logger.info(`Session created: ${session.id}`, { workspaceId })

		if (params.autoStart !== false) {
			this.startSession(session.id).catch((err) =>
				logger.error('Session start failed', { sessionId: session.id, error: String(err) }),
			)
		}

		return session
	}

	async startSession(sessionId: string): Promise<void> {
		const [session] = await this.db
			.select()
			.from(sessions)
			.where(eq(sessions.id, sessionId))
			.limit(1)

		if (!session || (session.status !== 'pending' && session.status !== 'queued')) {
			throw new Error(`Session ${sessionId} not found or not in pending/queued state`)
		}

		// Check workspace concurrency limit — queue instead of rejecting
		const hasCapacity = await this.hasCapacity(session.workspaceId)
		if (!hasCapacity) {
			await this.db
				.update(sessions)
				.set({ status: 'queued', updatedAt: new Date() })
				.where(eq(sessions.id, sessionId))

			await this.insertSystemLog(sessionId, 'Session queued — waiting for capacity')
			logger.info(`Session queued: ${sessionId}`, { workspaceId: session.workspaceId })
			return
		}

		// Update status to starting
		await this.db
			.update(sessions)
			.set({ status: 'starting', updatedAt: new Date() })
			.where(eq(sessions.id, sessionId))

		// Production path: hand off to the dispatch queue, which routes through
		// `SessionDispatcher` to an agent_servers row over HTTPS. The agent-
		// server pulls its own /agent workspace from S3 (T8), so we don't
		// pre-stage a temp dir locally — we only own the queue handoff.
		if (this.dispatchQueue) {
			try {
				await this.dispatchQueue.enqueue(sessionId)
				logger.info(`Session enqueued for remote dispatch: ${sessionId}`, {
					workspaceId: session.workspaceId,
				})
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err)
				await this.db
					.update(sessions)
					.set({
						status: 'failed',
						result: { error: `Enqueue failed: ${message}` },
						completedAt: new Date(),
						updatedAt: new Date(),
					})
					.where(eq(sessions.id, sessionId))
				await this.db.insert(events).values({
					workspaceId: session.workspaceId,
					actorId: session.actorId,
					action: 'session_failed',
					entityType: 'session',
					entityId: sessionId,
					data: { error: `Enqueue failed: ${message}` },
				})
				throw err
			}
			return
		}

		try {
			// Pull agent files from S3 to temp dir (chmod 777 so non-root agent user in container can write)
			const tempDir = await mkdtemp(join(tmpdir(), 'anko-session-'))
			for (const sub of ['', 'skills', 'learnings', 'memory', 'workspace']) {
				const dir = sub ? join(tempDir, sub) : tempDir
				if (sub) await mkdir(dir, { recursive: true })
				await chmod(dir, 0o777)
			}
			this.activeSessions.set(sessionId, { tempDir })

			await this.agentStorage.pullAgentFiles(session.actorId, session.workspaceId, tempDir)
			const pullResult = await this.agentStorage.pullWorkspaceSkillsForAgent(
				session.actorId,
				session.workspaceId,
				tempDir,
			)
			await this.reportSkillPullFailures(sessionId, pullResult)
			await this.writeWorkspaceBriefing(session.workspaceId, tempDir, sessionId)

			// Restore workspace from a prior session if requested. Overwrites
			// the staged agent files with the prior session's full /agent/ snapshot,
			// so the agent picks up exactly where the previous session left off.
			if (session.sourceSessionId) {
				// Verify the source session belongs to the same workspace before
				// restoring its snapshot — prevents cross-workspace data leakage.
				const [sourceSession] = await this.db
					.select({ id: sessions.id })
					.from(sessions)
					.where(
						and(
							eq(sessions.id, session.sourceSessionId),
							eq(sessions.workspaceId, session.workspaceId),
						),
					)
				if (!sourceSession) {
					logger.warn('sourceSessionId does not belong to this workspace — skipping restore', {
						sessionId,
						sourceSessionId: session.sourceSessionId,
						workspaceId: session.workspaceId,
					})
				} else {
					const snapshotKey = `session-workspaces/${session.sourceSessionId}.tar.gz`
					if (await this.storage.exists(snapshotKey)) {
						const buf = await this.storage.get(snapshotKey)
						const archivePath = join(tempDir, '_source_snapshot.tar.gz')
						await writeFile(archivePath, buf)
						try {
							await execFileAsync('tar', [
								'-xzf',
								archivePath,
								'-C',
								tempDir,
								'--strip-components=1',
							])
						} finally {
							await rm(archivePath, { force: true })
						}
						await this.insertSystemLog(
							sessionId,
							`Workspace restored from session ${session.sourceSessionId}`,
						)
						logger.info('Workspace restored from source session', {
							sessionId,
							sourceSessionId: session.sourceSessionId,
						})
					} else {
						logger.warn('Source session workspace snapshot not found — starting fresh', {
							sessionId,
							sourceSessionId: session.sourceSessionId,
						})
					}
				}
			}

			// Build env vars and launch container. Let launchContainer derive
			// the container name from session.id so re-entry (e.g. a watchdog
			// retry) doesn't collide with a Docker name we forced ourselves.
			const containerId = await this.launchContainer(session, tempDir)

			const startedAt = new Date()
			await this.db
				.update(sessions)
				.set({
					status: 'running',
					containerId,
					startedAt,
					timeoutAt: this.computeTimeout(session),
					updatedAt: startedAt,
				})
				.where(eq(sessions.id, sessionId))

			logger.info(`Session started: ${sessionId}`, { containerId })

			const sessionStartLatencyMs = session.createdAt
				? startedAt.getTime() - session.createdAt.getTime()
				: 0
			this.telemetry.recordSessionStarted({
				sessionId,
				agentServerUrl: LOCAL_RUNTIME_BUCKET,
				sessionStartLatencyMs,
			})
			// Per-session isolation is structural in Docker (separate cgroup, separate
			// bind-mounted /agent tempDir). The future agent-server runtime (T2) will
			// swap in a real probe — until then this is a literal observation, not a
			// placeholder.
			this.telemetry.recordCrossSessionCheck({
				sessionId,
				agentServerUrl: LOCAL_RUNTIME_BUCKET,
				hostIsolationOk: true,
			})

			// Start streaming logs
			this.streamContainerLogs(sessionId, containerId)

			// Watch for container exit
			this.watchContainerExit(sessionId, containerId)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			await this.db
				.update(sessions)
				.set({
					status: 'failed',
					result: { error: message },
					completedAt: new Date(),
					updatedAt: new Date(),
				})
				.where(eq(sessions.id, sessionId))

			await this.db.insert(events).values({
				workspaceId: session.workspaceId,
				actorId: session.actorId,
				action: 'session_failed',
				entityType: 'session',
				entityId: sessionId,
				data: { error: message },
			})

			this.telemetry.recordSessionEnded({
				sessionId,
				endReason: 'failed',
				durationMs: elapsedMs(null, session.createdAt),
				agentServerUrl: LOCAL_RUNTIME_BUCKET,
			})

			this.containers.detachStdin(sessionId)
			await this.clearActiveSession(sessionId)
			await this.cleanupBrowserSidecar(sessionId)
			await this.cleanupSession(sessionId)
			throw err
		}
	}

	/**
	 * Deliver a user turn to an interactive session's stdin. Routes to the remote
	 * agent-server when the session was dispatched there, otherwise writes to the
	 * local Docker stdin stream. Caller must have already validated the session is
	 * interactive and in `running` state.
	 */
	async writeInput(sessionId: string, payload: StreamJsonUserMessage): Promise<void> {
		const [session] = await this.db
			.select()
			.from(sessions)
			.where(eq(sessions.id, sessionId))
			.limit(1)

		if (session?.agentServerId) {
			const [serverRow] = await this.db
				.select({ id: agentServers.id, url: agentServers.url, secret: agentServers.secret })
				.from(agentServers)
				.where(eq(agentServers.id, session.agentServerId))
				.limit(1)
			if (!serverRow) {
				throw new Error(`Agent server ${session.agentServerId} not found`)
			}
			const client = new AgentServerClient({ server: serverRow })
			await client.sendInput(sessionId, payload)
		} else {
			await this.containers.write(sessionId, payload)
		}

		// The CLI does not echo the user turn back to stdout — only the
		// assistant response. Persist the same JSON envelope we wrote to
		// stdin as a stdout-stream log row so historical transcripts and the
		// live SSE feed can render the user's turn alongside the agent's
		// reply.
		const [log] = await this.db
			.insert(sessionLogs)
			.values({
				sessionId,
				stream: 'stdout',
				content: JSON.stringify(payload),
			})
			.returning()
		if (log) {
			this.emit('log', {
				sessionId,
				logId: log.id,
				stream: 'stdout',
				data: log.content,
			} satisfies SessionLogEvent)
		}
	}

	async stopSession(sessionId: string): Promise<void> {
		const [session] = await this.db
			.select()
			.from(sessions)
			.where(eq(sessions.id, sessionId))
			.limit(1)

		if (!session) {
			throw new Error(`Session ${sessionId} not found or has no container`)
		}

		if (session.agentServerId) {
			const [serverRow] = await this.db
				.select({ id: agentServers.id, url: agentServers.url, secret: agentServers.secret })
				.from(agentServers)
				.where(eq(agentServers.id, session.agentServerId))
				.limit(1)
			if (!serverRow) {
				throw new Error(`Agent server ${session.agentServerId} not found`)
			}
			const client = new AgentServerClient({ server: serverRow })
			try {
				await client.stopSession(sessionId)
			} catch (err) {
				// Sanitize before rethrowing — the route handler surfaces this
				// message verbatim to the API caller (apps/dev/src/routes/sessions.ts),
				// and AgentServerHttpError's raw message embeds the agent-server's
				// internal URL plus up to 200 chars of its HTTP response body, which
				// must not reach an external client. Full details still go to the log.
				if (err instanceof AgentServerAuthError) {
					logger.error(
						'agent-server rejected bearer token while stopping session — secret rotation race',
						{ sessionId, agentServerId: serverRow.id, agentServerUrl: serverRow.url },
					)
					throw new Error(`Failed to stop session ${sessionId}: agent-server rejected bearer token`)
				}
				if (err instanceof AgentServerHttpError) {
					logger.error('agent-server returned an error while stopping session', {
						sessionId,
						agentServerId: serverRow.id,
						agentServerUrl: serverRow.url,
						status: err.status,
						body: err.body,
					})
					throw new Error(
						`Failed to stop session ${sessionId}: agent-server returned HTTP ${err.status}`,
					)
				}
				// Anything else (e.g. a raw network/DNS failure thrown by fetch inside
				// postJson) isn't a typed AgentServerClient error and carries no
				// built-in sanitization — its raw message can still embed internal
				// details. Sanitize it the same way as the two branches above instead
				// of rethrowing unmodified; full details still go to the log.
				logger.error('unexpected error while stopping session on agent-server', {
					sessionId,
					agentServerId: serverRow.id,
					agentServerUrl: serverRow.url,
					error: String(err),
				})
				throw new Error(`Failed to stop session ${sessionId}: agent-server request failed`)
			}
			// Remote sessions have no local exit watcher — the agent-server's own
			// completion monitor lives in that process's memory and may already be
			// gone (e.g. after a redeploy), so it can never call back to report
			// completion. Treat this explicit, successful stop as authoritative
			// instead of waiting on a callback that might never arrive.
			await this.markRemoteSessionComplete(sessionId, null)
			return
		}

		if (!session.containerId) {
			throw new Error(`Session ${sessionId} not found or has no container`)
		}

		this.stopRequested.add(sessionId)
		this.containers.detachStdin(sessionId)
		await this.containers.stop(session.containerId)
		// handleCompletion will be called by the exit watcher
	}

	/**
	 * Copy the container's /agent/ directory to S3 as session-workspaces/{sessionId}.tar.gz
	 * so continuation sessions can restore from it via sourceSessionId. Works on stopped
	 * containers (before docker rm). Called non-fatally from handleCompletion.
	 */
	private async snapshotWorkspaceAfterExit(sessionId: string, containerId: string): Promise<void> {
		const tarStream = await this.containers.copyFrom(containerId, '/agent/')
		await this.storage.put(`session-workspaces/${sessionId}.tar.gz`, tarStream.pipe(createGzip()))
		logger.info('Workspace snapshot saved', { sessionId })
	}

	async pauseSession(sessionId: string): Promise<void> {
		const [session] = await this.db
			.select()
			.from(sessions)
			.where(eq(sessions.id, sessionId))
			.limit(1)

		if (!session || session.status !== 'running' || !session.containerId) {
			throw new Error(`Session ${sessionId} not in running state`)
		}

		// Self-heal: if the container disappeared (stopped or removed externally),
		// the session can never be snapshotted. Mark it failed and exit so the
		// auto-pause loop stops retrying every minute.
		if (!(await this.isContainerAlive(session.containerId))) {
			await this.markSessionFailedAfterContainerLoss(session.id, session.workspaceId)
			return
		}

		await this.db
			.update(sessions)
			.set({ status: 'snapshotting', updatedAt: new Date() })
			.where(eq(sessions.id, sessionId))

		try {
			// dockerode's getArchive (copyFrom) already returns a tar archive of
			// the container path — entries are prefixed with `agent/`. Stream
			// that straight to S3 with no extra packaging.
			//
			// The earlier implementation ran `tar -czf /tmp/snapshot.tar.gz
			// /agent/` inside the container and then copied THAT file out,
			// which wrapped the gzipped tar in a second (uncompressed) tar from
			// dockerode. The bytes saved to S3 were `tar(snapshot.tar.gz)`, not
			// `snapshot.tar.gz`, so `tar -xzf` on resume always failed with
			// "not in gzip format" and the resume catch block silently marked
			// the session failed — losing the workspace.
			const tarStream = await this.containers.copyFrom(session.containerId, '/agent/')

			const snapshotKey = `snapshots/${sessionId}.tar`
			await this.storage.put(snapshotKey, tarStream as import('node:stream').Readable)

			// Stop and remove container
			this.containers.detachStdin(sessionId)
			await this.containers.stop(session.containerId)
			await this.containers.remove(session.containerId)

			await this.db
				.update(sessions)
				.set({
					status: 'paused',
					snapshotPath: snapshotKey,
					containerId: null,
					currentActivity: null,
					updatedAt: new Date(),
				})
				.where(eq(sessions.id, sessionId))

			await this.insertSystemLog(sessionId, 'Session paused and snapshot saved')

			await this.cleanupBrowserSidecar(sessionId)
			await this.cleanupSession(sessionId)

			logger.info(`Session paused: ${sessionId}`)

			// Start next queued session if capacity is available
			await this.drainQueue(session.workspaceId).catch((err) =>
				logger.error('Failed to drain queue after pause', { error: String(err) }),
			)
		} catch (err) {
			// If the container vanished mid-pause, route to terminal-failed state
			// instead of reverting to 'running' (which would be re-retried forever).
			if (isContainerGoneError(err)) {
				await this.markSessionFailedAfterContainerLoss(session.id, session.workspaceId)
				return
			}
			await this.db
				.update(sessions)
				.set({ status: 'running', updatedAt: new Date() })
				.where(eq(sessions.id, sessionId))
			throw err
		}
	}

	private async isContainerAlive(containerId: string): Promise<boolean> {
		try {
			const status = await this.containers.inspect(containerId)
			return status.running
		} catch {
			return false
		}
	}

	private async markSessionFailedAfterContainerLoss(
		sessionId: string,
		workspaceId: string,
	): Promise<void> {
		const [existing] = await this.db
			.select({ startedAt: sessions.startedAt, createdAt: sessions.createdAt })
			.from(sessions)
			.where(eq(sessions.id, sessionId))
			.limit(1)

		await this.db
			.update(sessions)
			.set({
				status: 'failed',
				containerId: null,
				completedAt: new Date(),
				currentActivity: null,
				updatedAt: new Date(),
			})
			.where(eq(sessions.id, sessionId))

		await this.insertSystemLog(
			sessionId,
			'Container disappeared before pause could complete — session marked failed',
		).catch((err) =>
			logger.warn('Failed to insert system log for container-loss cleanup', {
				sessionId,
				error: String(err),
			}),
		)

		if (existing) {
			this.telemetry.recordSessionEnded({
				sessionId,
				endReason: 'failed',
				durationMs: elapsedMs(existing.startedAt, existing.createdAt),
				agentServerUrl: LOCAL_RUNTIME_BUCKET,
			})
		}

		await this.clearActiveSession(sessionId).catch(() => {})

		this.containers.detachStdin(sessionId)
		await this.cleanupBrowserSidecar(sessionId).catch(() => {})
		await this.cleanupSession(sessionId).catch(() => {})

		logger.warn('Session marked failed after container loss', { sessionId })

		await this.drainQueue(workspaceId).catch((err) =>
			logger.error('Failed to drain queue after container-loss cleanup', { error: String(err) }),
		)
	}

	async resumeSession(sessionId: string): Promise<void> {
		const [session] = await this.db
			.select()
			.from(sessions)
			.where(eq(sessions.id, sessionId))
			.limit(1)

		if (!session || session.status !== 'paused' || !session.snapshotPath) {
			throw new Error(`Session ${sessionId} not in paused state or no snapshot`)
		}

		await this.db
			.update(sessions)
			.set({ status: 'starting', updatedAt: new Date() })
			.where(eq(sessions.id, sessionId))

		try {
			// Download and extract snapshot
			const snapshotBuffer = await this.storage.get(session.snapshotPath)
			const tempDir = await mkdtemp(join(tmpdir(), 'anko-session-'))
			await chmod(tempDir, 0o777)
			this.activeSessions.set(sessionId, { tempDir })

			const snapshotPath = join(tempDir, 'snapshot.tar')
			await writeFile(snapshotPath, snapshotBuffer)
			// The snapshot is an uncompressed tar from dockerode's getArchive,
			// rooted at `agent/...`. Strip that prefix so files land at
			// tempDir/skills, tempDir/workspace, etc., which is what the
			// `${tempDir}:/agent` bind mount expects. Remove the tarball
			// afterwards so it doesn't appear as a stray `/agent/snapshot.tar`
			// inside the resumed container.
			await execFileAsync('tar', ['-xf', snapshotPath, '-C', tempDir, '--strip-components=1'])
			await rm(snapshotPath, { force: true })

			// Pull latest agent files AND workspace skills — between pause and resume
			// the attachment set and skill content may have changed, so overwrite
			// any stale snapshot folders for currently-attached skills.
			await this.agentStorage.pullAgentFiles(session.actorId, session.workspaceId, tempDir)
			const pullResult = await this.agentStorage.pullWorkspaceSkillsForAgent(
				session.actorId,
				session.workspaceId,
				tempDir,
				{ overwrite: true },
			)
			await this.reportSkillPullFailures(sessionId, pullResult)
			await this.writeWorkspaceBriefing(session.workspaceId, tempDir, sessionId)

			// Build env vars (including integration credentials) and launch container
			const containerId = await this.launchContainer(
				session,
				tempDir,
				`anko-session-${sessionId.slice(0, 8)}-resumed`,
			)

			await this.db
				.update(sessions)
				.set({
					status: 'running',
					containerId,
					timeoutAt: this.computeTimeout(session),
					snapshotPath: null,
					updatedAt: new Date(),
				})
				.where(eq(sessions.id, sessionId))

			await this.insertSystemLog(sessionId, 'Session resumed from snapshot')

			this.streamContainerLogs(sessionId, containerId)
			this.watchContainerExit(sessionId, containerId)

			logger.info(`Session resumed: ${sessionId}`, { containerId })
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			await this.db
				.update(sessions)
				.set({
					status: 'failed',
					result: { error: message },
					completedAt: new Date(),
					updatedAt: new Date(),
				})
				.where(eq(sessions.id, sessionId))

			await this.db.insert(events).values({
				workspaceId: session.workspaceId,
				actorId: session.actorId,
				action: 'session_failed',
				entityType: 'session',
				entityId: sessionId,
				data: { error: message },
			})

			this.telemetry.recordSessionEnded({
				sessionId,
				endReason: 'failed',
				durationMs: elapsedMs(session.startedAt, session.createdAt),
				agentServerUrl: LOCAL_RUNTIME_BUCKET,
			})

			this.containers.detachStdin(sessionId)
			await this.clearActiveSession(sessionId)
			await this.cleanupBrowserSidecar(sessionId)
			await this.cleanupSession(sessionId)
			throw err
		}
	}

	private async hasCapacity(workspaceId: string): Promise<boolean> {
		const [workspace] = await this.db
			.select()
			.from(workspaces)
			.where(eq(workspaces.id, workspaceId))
			.limit(1)

		const settings = (workspace?.settings as WorkspaceSettings) ?? {}
		const maxConcurrent = settings.max_concurrent_sessions ?? 3

		const [result] = await this.db
			.select({ count: countFn() })
			.from(sessions)
			.where(
				and(
					eq(sessions.workspaceId, workspaceId),
					inArray(sessions.status, ['starting', 'running']),
				),
			)

		return !result || result.count < maxConcurrent
	}

	/**
	 * Drain the queue: start queued sessions for a workspace until capacity is full or queue is empty.
	 * Called after a session completes, fails, or times out, and from the watchdog as a safety net.
	 * Uses a per-workspace lock to prevent concurrent drain calls from racing.
	 */
	private async drainQueue(workspaceId: string): Promise<void> {
		// Prevent concurrent drains for the same workspace
		if (this.drainingWorkspaces.has(workspaceId)) return
		this.drainingWorkspaces.add(workspaceId)

		try {
			while (await this.hasCapacity(workspaceId)) {
				// Atomically claim the oldest queued session by transitioning its status.
				// If two callers race, only one gets a non-empty result from the UPDATE.
				const [nextQueued] = await this.db
					.select()
					.from(sessions)
					.where(and(eq(sessions.workspaceId, workspaceId), eq(sessions.status, 'queued')))
					.orderBy(sessions.createdAt)
					.limit(1)

				if (!nextQueued) break

				const [claimed] = await this.db
					.update(sessions)
					.set({ status: 'pending', updatedAt: new Date() })
					.where(and(eq(sessions.id, nextQueued.id), eq(sessions.status, 'queued')))
					.returning()

				if (!claimed) break

				logger.info(`Draining queue: starting session ${claimed.id}`, { workspaceId })
				// Await start so capacity check on next iteration reflects the new running session
				await this.startSession(claimed.id).catch((err) =>
					logger.error('Failed to start queued session', {
						sessionId: claimed.id,
						error: String(err),
					}),
				)
			}
		} finally {
			this.drainingWorkspaces.delete(workspaceId)
		}
	}

	/**
	 * Build the launch spec for a session — env vars (including integration
	 * credentials), image, and resource limits. The shape mirrors
	 * `StartSessionRequest` on `AgentServerClient` so the SessionDispatcher (T6)
	 * can pass it straight through to apps/agent-server. Local Docker launches
	 * call this from `launchContainer` so both paths derive env identically.
	 */
	async buildLaunchSpec(session: typeof sessions.$inferSelect): Promise<{
		image: string
		env: Record<string, string>
		memoryMib: number
		cpus: number
		cpuShares: number
		browserRequired: boolean
	}> {
		const [agent] = await this.db
			.select()
			.from(actors)
			.where(eq(actors.id, session.actorId))
			.limit(1)

		if (!agent || agent.type !== 'agent') {
			throw new Error('Agent not found or not an agent type')
		}

		const llmConfig = (agent.llmConfig as Record<string, unknown>) ?? {}
		const sessionConfig = session.config as Record<string, unknown>

		const envVars: Record<string, string> = {
			SESSION_ID: session.id,
			AGENT_RUNTIME: (sessionConfig.runtime as string) ?? 'claude-code',
			SYSTEM_PROMPT: agent.systemPrompt ?? 'You are a helpful AI agent.',
			MASKIN_API_URL: process.env.MASKIN_BACKEND_URL ?? 'http://host.docker.internal:3000',
			MASKIN_WORKSPACE_ID: session.workspaceId,
		}

		// Interactive sessions have no opening ACTION_PROMPT — the first user turn
		// arrives via POST /api/sessions/:id/input over the attached stdin stream.
		// Non-interactive sessions pass the action prompt positionally so `claude -p`
		// runs it and exits; interactive sets INTERACTIVE=1 so agent-run.sh takes
		// the stdin-driven stream-json branch instead.
		// session.actionPrompt is the user's original prompt and is never written back
		// wrapped — safe to re-prepend on every launch, including resume.
		if (session.interactive) {
			envVars.INTERACTIVE = '1'
		} else {
			// frontendBaseUrl falls back to the dev value outside production; it
			// only throws on a missing FRONTEND_URL in prod, which is the same
			// failure mode as fileViewerUrl and is intentional.
			const startupBlock = buildWorkspaceStartupBlock({
				workspaceId: session.workspaceId,
				frontendUrl: frontendBaseUrl(),
			})
			envVars.ACTION_PROMPT = `${startupBlock}${session.actionPrompt}`
		}

		// Resolve LLM credentials in priority order:
		//   agent override → workspace custom_llm → Claude OAuth → workspace api key → system fallback
		// See lib/llm-routing.ts. The route taken is persisted on
		// sessions.config.llm_route so we can attribute usage and enforce
		// the system-fallback per-actor daily quota.
		const [ws] = await this.db
			.select()
			.from(workspaces)
			.where(eq(workspaces.id, session.workspaceId))
			.limit(1)
		const wsSettings = (ws?.settings as WorkspaceSettings) ?? {}
		const wsLlmKeys = wsSettings.llm_keys ?? {}

		let routeTaken: LlmRoute | null = null
		let oauthSlotTaken: string | undefined
		try {
			const resolved = await resolveLlmRoute({
				db: this.db,
				workspaceId: session.workspaceId,
				actorId: session.actorId,
				wsSettings,
				agent: {
					provider: agent.llmProvider,
					apiKey: (llmConfig.api_key as string | undefined) ?? null,
				},
			})
			if (resolved) {
				routeTaken = resolved.route
				oauthSlotTaken = resolved.oauthSlot
				Object.assign(envVars, resolved.envVars)
			}
		} catch (err) {
			if (err instanceof FallbackQuotaExceededError) {
				logger.warn('System LLM fallback quota exceeded', {
					sessionId: session.id,
					actorId: session.actorId,
					used: err.used,
					limit: err.limit,
				})
			}
			throw err
		}

		// Non-anthropic agent override (OpenAI native via OPENAI_API_KEY).
		if (llmConfig.api_key && agent.llmProvider === 'openai') {
			envVars.OPENAI_API_KEY = llmConfig.api_key as string
		}
		// Workspace OpenAI key — independent of the anthropic-side routing above.
		if (!llmConfig.api_key && wsLlmKeys.openai) {
			envVars.OPENAI_API_KEY = wsLlmKeys.openai
		}

		// Persist the chosen route on the session config so cron-based quota
		// queries (and later analytics) can find fallback sessions cheaply.
		if (routeTaken) {
			const existingConfig = (session.config as Record<string, unknown>) ?? {}
			const nextOauthSlot = routeTaken === LLM_ROUTE_OAUTH ? oauthSlotTaken : undefined
			const updatedConfig = mergeLaunchRouteConfig(existingConfig, routeTaken, nextOauthSlot)
			if (updatedConfig) {
				await this.db
					.update(sessions)
					.set({ config: updatedConfig })
					.where(eq(sessions.id, session.id))
				;(session as { config: Record<string, unknown> }).config = updatedConfig
			}
		}

		// Inject agent's API key for Maskin MCP access. Refuse to launch without
		// one — an empty Bearer token causes MCP writes to either fail outright
		// or, when a fallback key is present in the env, get attributed to the
		// wrong actor (the original "agent comments posted as a human" bug).
		if (!agent.apiKey) {
			throw new Error(
				`Cannot launch session for agent ${agent.id} (${agent.name ?? 'unnamed'}): apiKey is null. Backfill the actor row before retrying.`,
			)
		}
		envVars.MASKIN_API_KEY = agent.apiKey

		// Agent-level MCP config (from tools field, stored as { mcpServers: { ... } }).
		// The AGENT_MCP_JSON env var is written further down, after the GitHub
		// preflight has had a chance to strip failed identities from
		// `agentTools.mcpServers` — otherwise a broken identity would be re-attached
		// via the agent config even after we drop it from MCP_SERVERS_JSON.
		const agentTools = agent.tools as Record<string, unknown> | null
		const agentToolsMcpServers =
			agentTools && typeof agentTools.mcpServers === 'object' && agentTools.mcpServers !== null
				? (agentTools.mcpServers as Record<string, unknown>)
				: null

		// Inject runtime-specific config
		if (sessionConfig.runtime_config) {
			const rtConfig = sessionConfig.runtime_config as Record<string, unknown>
			if (rtConfig.max_turns) envVars.MAX_TURNS = String(rtConfig.max_turns)
			if (rtConfig.approval_mode) envVars.CODEX_APPROVAL_MODE = rtConfig.approval_mode as string
			if (rtConfig.command) envVars.CUSTOM_COMMAND = rtConfig.command as string
		}

		// Load integration credentials for MCP servers
		const activeIntegrations = await this.db
			.select()
			.from(integrations)
			.where(
				and(eq(integrations.workspaceId, session.workspaceId), eq(integrations.status, 'active')),
			)
			.orderBy(asc(integrations.createdAt))

		const tokenManager = new TokenManager()
		// MCP servers injected by virtue of a workspace having an active
		// integration with `mcp.autoInject = true`. Workspace-scoped data pipes
		// (e.g. PostHog → Synthesizer) belong here; tools an agent opts into
		// per-config still go through the agent/session MCP paths.
		//
		// GitHub installations get both a per-owner env var (GITHUB_TOKEN_<OWNER>)
		// and an auto-injected MCP server entry (github-<owner>) with the token
		// baked in. The bare GITHUB_TOKEN is aliased from the first installation
		// so existing agent configs using ${GITHUB_TOKEN} continue to work.
		const autoInjectedMcpServers: Record<string, unknown> = {}
		const resolvedGithubInstalls: Array<{
			ownerLogin: string
			token: string
			integrationId: string
			installationId: string
			tokenMetadata: TokenMetadata
		}> = []
		for (const integration of activeIntegrations) {
			try {
				const resolved = getProvider(integration.provider)
				const accessToken = await tokenManager.getValidToken(this.db, integration.id, resolved)

				if (integration.provider === 'github') {
					const ownerLogin = await this.resolveGithubOwnerLogin(integration)
					if (!ownerLogin) continue

					const installationId = integration.externalId
					if (!installationId) {
						logger.warn(
							'GitHub integration has no externalId; cannot stamp token metadata for tool-call tagging',
							{
								integrationId: integration.id,
								sessionId: session.id,
							},
						)
						continue
					}

					envVars[`GITHUB_TOKEN_${githubOwnerLoginToEnvKey(ownerLogin)}`] = accessToken
					resolvedGithubInstalls.push({
						ownerLogin,
						token: accessToken,
						integrationId: integration.id,
						installationId,
						tokenMetadata: stampTokenMetadata(accessToken, installationId),
					})
				} else {
					// Slack: only inject the bot token. A user token (xoxp-) here means
					// the install granted user scopes instead of bot scopes — posting
					// with it would attribute every message to the human installer
					// (the mesh-firm bug). Skip injection so the agent gets a clean
					// "Slack not configured" error from its tools rather than silently
					// posting as a person.
					if (integration.provider === 'slack' && !isSlackBotToken(accessToken)) {
						logger.warn(
							'Skipping Slack token injection — stored access token is not a bot (xoxb-) token',
							{
								sessionId: session.id,
								workspaceId: session.workspaceId,
								integrationId: integration.id,
								tokenPrefix: accessToken.slice(0, 5),
							},
						)
						continue
					}

					const envVarName =
						resolved.config.mcp?.envKey ??
						`${integration.provider.toUpperCase().replace(/-/g, '_')}_TOKEN`
					envVars[envVarName] = accessToken
					if (resolved.config.mcp?.autoInject && resolved.config.mcp.server) {
						autoInjectedMcpServers[`integration-${integration.provider}`] =
							resolved.config.mcp.server
						logger.info('Auto-injected MCP server for active integration', {
							sessionId: session.id,
							workspaceId: session.workspaceId,
							provider: integration.provider,
						})
					}
				}
			} catch (err) {
				if (isAuthRevokedError(err)) {
					logger.warn(
						`Integration ${integration.provider} is revoked — skipping token injection; user must reconnect`,
						{
							integrationId: integration.id,
							provider: integration.provider,
						},
					)
				} else {
					logger.warn(`Failed to load credentials for ${integration.provider}`, {
						integrationId: integration.id,
						error: String(err),
					})
				}
			}
		}

		// Inject per-org GitHub MCP server entries with literal tokens (no envsubst placeholder).
		// Each installation gets its own named entry (e.g. github-sindre-ai) so agents in
		// multi-org workspaces can target specific orgs via mcp__github-<owner>__* tools.
		// We also set bare GITHUB_TOKEN so existing agent configs using ${GITHUB_TOKEN}
		// continue to work after envsubst expansion.
		for (const { ownerLogin, token } of resolvedGithubInstalls) {
			autoInjectedMcpServers[`github-${ownerLogin.toLowerCase()}`] = {
				type: 'stdio',
				command: 'npx',
				args: ['-y', '@modelcontextprotocol/server-github'],
				env: { GITHUB_PERSONAL_ACCESS_TOKEN: token },
			}
		}
		// Register the session's github installs with the log classifier so
		// tool_result envelopes coming back from the container carry a cause_tag
		// alongside the failure — the parent bet's AC-6 grep-verifier reads
		// session_logs, not this process's memory.
		const classifierInstalls: SessionGithubInstall[] = resolvedGithubInstalls.map((r) => ({
			ownerLoginLower: r.ownerLogin.toLowerCase(),
			installationId: r.installationId,
			tokenMetadata: r.tokenMetadata,
		}))
		sessionGithubLogClassifier.registerSession(session.id, classifierInstalls)
		const primaryGithubToken = resolvedGithubInstalls[0]?.token
		if (primaryGithubToken) {
			envVars.GITHUB_TOKEN = primaryGithubToken
		}
		// GITHUB_INTEGRATION_ID lets the container's git credential helper
		// (docker/agent-base/github-credential-helper.sh) mint a fresh installation
		// token via GET /api/integrations/:id/github-token on every git operation,
		// instead of relying on the GITHUB_TOKEN value above going stale after
		// GitHub's 1-hour installation-token TTL for sessions that outlive it.
		const primaryGithubIntegrationId = resolvedGithubInstalls[0]?.integrationId
		if (primaryGithubIntegrationId) {
			envVars.GITHUB_INTEGRATION_ID = primaryGithubIntegrationId
			// GITHUB_REPO lets the credential helper append ?repo=owner/name to the
			// token-mint request; the API side (integrations.ts githubTokenRoute)
			// uses it to re-discover the current installation id when the App is
			// reinstalled mid-session (T4's mint-on-write recovery). Left unset when
			// no defensible source resolves — a wrong slug 404s the discovery hop
			// and mis-maps to AUTH_REVOKED per T4's error mapping.
			const resolved = await this.resolveGithubRepoSlug(session)
			if (resolved.slug) {
				envVars.GITHUB_REPO = resolved.slug
				logger.info('Resolved GITHUB_REPO for GitHub App recovery hint', {
					sessionId: session.id,
					source: resolved.source,
				})
			} else {
				logger.warn('No GITHUB_REPO source resolved — recovery hint will be omitted', {
					sessionId: session.id,
					rejected: resolved.rejected,
				})
			}
		}

		// Merge user-provided env vars, filtering out reserved keys
		const RESERVED_ENV_KEYS = new Set([
			'SESSION_ID',
			'AGENT_RUNTIME',
			'SYSTEM_PROMPT',
			'ACTION_PROMPT',
			'INTERACTIVE',
			'MASKIN_API_URL',
			'MASKIN_WORKSPACE_ID',
			'ANTHROPIC_API_KEY',
			'ANTHROPIC_AUTH_TOKEN',
			'ANTHROPIC_BASE_URL',
			'ANTHROPIC_MODEL',
			'ANTHROPIC_SMALL_FAST_MODEL',
			'OPENAI_API_KEY',
			'MAX_TURNS',
			'CODEX_APPROVAL_MODE',
			'CUSTOM_COMMAND',
			'MCP_SERVERS_JSON',
			'AGENT_MCP_JSON',
			'MASKIN_API_KEY',
			'CLAUDE_OAUTH_ACCESS_TOKEN',
			'CLAUDE_OAUTH_REFRESH_TOKEN',
			'CLAUDE_OAUTH_EXPIRES_AT',
			'CLAUDE_OAUTH_SCOPES',
			'CLAUDE_OAUTH_SUBSCRIPTION_TYPE',
			'BROWSER_CDP_URL',
		])
		// Only reserve GITHUB_TOKEN when we actually injected one; otherwise a
		// user-supplied PAT (no GitHub integration configured) must pass through.
		if (primaryGithubToken) {
			RESERVED_ENV_KEYS.add('GITHUB_TOKEN')
		}
		if (primaryGithubIntegrationId) {
			RESERVED_ENV_KEYS.add('GITHUB_INTEGRATION_ID')
			RESERVED_ENV_KEYS.add('GITHUB_REPO')
		}
		const userEnvVars = (sessionConfig.env_vars as Record<string, string>) ?? {}
		for (const [key, value] of Object.entries(userEnvVars)) {
			if (!RESERVED_ENV_KEYS.has(key) && !key.startsWith('GITHUB_TOKEN_')) {
				envVars[key] = value
			} else {
				logger.warn(`Ignoring reserved env var from user config: ${key}`, {
					sessionId: session.id,
				})
			}
		}

		// Session-level MCP config (convert array → { mcpServers: { ... } } format), merged
		// with auto-injected workspace MCPs and per-org GitHub MCPs. Keys are namespaced so
		// the sources can't collide (github-<owner>, integration-<provider>, session-mcp-N).
		const mcps = sessionConfig.mcps as Array<Record<string, unknown>> | undefined
		const sessionMcpServers: Record<string, unknown> = { ...autoInjectedMcpServers }
		if (mcps?.length) {
			for (const [i, mcp] of mcps.entries()) {
				sessionMcpServers[`session-mcp-${i}`] = mcp
			}
		}

		// Startup preflight: live-validate every attached GitHub identity BEFORE the
		// container launches. Each identity gets one authenticated read + one
		// write-scope probe; a missing token short-circuits without touching the
		// network (that's how 2026-07-11 dropped calls into the anonymous 60/hr
		// bucket). Failed identities are gated by dropping their MCP entries from
		// both the agent config and the session config, so subsequent tool calls
		// under that namespace cannot fire. One consolidated Slack alert per session
		// lands on C075JBZ65RT so a task never has to rediscover the outage.
		// Each `github-<owner>` MCP entry's token was minted from a specific
		// installation (see resolvedGithubInstalls above) — carry that id through
		// to the verdict so a Slack alert or log line names the exact installation
		// behind an unexpected failure, instead of just the MCP server name.
		const installationIdByMcpName = new Map(
			resolvedGithubInstalls.map((install) => [
				`github-${install.ownerLogin.toLowerCase()}`,
				install.installationId,
			]),
		)
		const preflightIdentities = collectGitHubMcpIdentities(
			[agentToolsMcpServers, sessionMcpServers],
			envVars,
		).map((id) => ({ ...id, installationId: installationIdByMcpName.get(id.name) }))
		let preflightVerdicts: PreflightVerdict[] = []
		if (preflightIdentities.length > 0) {
			preflightVerdicts = await runGitHubPreflight(preflightIdentities)
			const failed = preflightVerdicts.filter((v) => !v.healthy)
			if (failed.length > 0) {
				logger.warn('GitHub preflight failed for one or more identities', {
					sessionId: session.id,
					workspaceId: session.workspaceId,
					failed: failed.map((v) => ({
						name: v.name,
						failureClass: v.failureClass,
						installationId: v.installationId,
					})),
				})
				const slackBotToken = envVars.SLACK_BOT_TOKEN
				if (slackBotToken) {
					await postGitHubPreflightSlackAlert({
						botToken: slackBotToken,
						channelId: GITHUB_PREFLIGHT_SLACK_CHANNEL,
						verdicts: preflightVerdicts,
						context: {
							sessionId: session.id,
							workspaceId: session.workspaceId,
						},
					})
				} else {
					logger.warn('GitHub preflight failed but no SLACK_BOT_TOKEN available — alert not sent', {
						sessionId: session.id,
						workspaceId: session.workspaceId,
					})
				}
			}
		}
		const gatedAgentToolsMcpServers = stripFailedIdentities(agentToolsMcpServers, preflightVerdicts)
		const gatedSessionMcpServers = stripFailedIdentities(sessionMcpServers, preflightVerdicts)

		if (agentTools && Object.keys(agentTools).length > 0) {
			const gatedAgentTools = gatedAgentToolsMcpServers
				? { ...agentTools, mcpServers: gatedAgentToolsMcpServers }
				: agentTools
			envVars.AGENT_MCP_JSON = JSON.stringify(gatedAgentTools)
		}
		if (Object.keys(gatedSessionMcpServers).length > 0) {
			envVars.MCP_SERVERS_JSON = JSON.stringify({ mcpServers: gatedSessionMcpServers })
		}

		const browserRequired =
			sessionConfig.browserRequired === true || this.needsBrowserSidecar(envVars)

		const image =
			(sessionConfig.base_image as string) ?? process.env.AGENT_BASE_IMAGE ?? 'agent-base:latest'
		// memory_mb / cpu_shares are the Docker-native units used historically;
		// the spec exposes MiB and a CPU count so apps/agent-server can pass
		// them through to libkrun without re-translating per call site.
		const memoryMib = (sessionConfig.memory_mb as number) ?? 4096
		const cpuShares = (sessionConfig.cpu_shares as number) ?? 1024
		const cpus = Math.max(1, Math.round(cpuShares / 1024))

		return { image, env: envVars, memoryMib, cpus, cpuShares, browserRequired }
	}

	/**
	 * Resolve the `owner/name` slug for the container's `GITHUB_REPO` env var,
	 * consumed by the git credential helper as a `?repo=` hint on token-mint
	 * requests. Sourcing order, per T8:
	 *   1. task-level override — the scoped task's own `metadata.repo`
	 *   2. bet — either the scoped bet's `metadata.repo`, or the parent bet
	 *      reached via a `breaks_into` edge on the scoped task
	 *   3. sandbox default — `process.env.GITHUB_REPO`
	 * Every candidate is normalized (strip https/ssh URL forms and .git suffix)
	 * and re-checked against T4's `REPO_SLUG_RE`. A malformed candidate is
	 * skipped with a `rejected:<label>` marker so we never forward a wrong slug
	 * to the token route (which would 404 the discovery hop and mis-map to
	 * AUTH_REVOKED per T4's error mapping).
	 */
	async resolveGithubRepoSlug(session: typeof sessions.$inferSelect): Promise<{
		slug: string | null
		source: 'task' | 'bet' | 'env' | 'none'
		rejected?: string
	}> {
		const scopedRows = await this.db
			.select({ id: objects.id, type: objects.type, metadata: objects.metadata })
			.from(objects)
			.where(eq(objects.activeSessionId, session.id))
			.limit(1)
		const scoped = scopedRows[0]

		// 1. task-level override
		if (scoped?.type === 'task') {
			const raw = (scoped.metadata as Record<string, unknown> | null)?.repo
			if (typeof raw === 'string' && raw.trim() !== '') {
				const slug = normalizeRepoSlug(raw)
				if (slug) return { slug, source: 'task' }
				return { slug: null, source: 'none', rejected: `task:${scoped.id}` }
			}
		}

		// 2. bet.metadata.repo — the scoped bet itself, or the parent bet via
		//    a `breaks_into` edge on the scoped task (either direction).
		let betId: string | null = null
		if (scoped?.type === 'bet') {
			betId = scoped.id
		} else if (scoped?.type === 'task') {
			// `relationships.sourceType`/`targetType` are storage-layer labels
			// constrained to 'object' | 'file' (see 0046_relationship_type_check.sql)
			// — they never carry the specialized object type. Resolve the other
			// endpoint by id and check its actual type via `objects.type`, same
			// pattern as the object graph endpoint in routes/objects.ts.
			const edgeRows = await this.db
				.select({
					sourceId: relationships.sourceId,
					targetId: relationships.targetId,
				})
				.from(relationships)
				.where(
					and(
						eq(relationships.type, 'breaks_into'),
						or(eq(relationships.sourceId, scoped.id), eq(relationships.targetId, scoped.id)),
					),
				)
			const otherIds = [
				...new Set(
					edgeRows
						.map((edge) => (edge.sourceId === scoped.id ? edge.targetId : edge.sourceId))
						.filter((otherId) => otherId !== scoped.id),
				),
			]
			if (otherIds.length > 0) {
				const betRows = await this.db
					.select({ id: objects.id })
					.from(objects)
					.where(and(inArray(objects.id, otherIds), eq(objects.type, 'bet')))
					.limit(1)
				betId = betRows[0]?.id ?? null
			}
		}
		if (betId) {
			const betRows = await this.db
				.select({ metadata: objects.metadata })
				.from(objects)
				.where(eq(objects.id, betId))
				.limit(1)
			const raw = (betRows[0]?.metadata as Record<string, unknown> | null)?.repo
			if (typeof raw === 'string' && raw.trim() !== '') {
				const slug = normalizeRepoSlug(raw)
				if (slug) return { slug, source: 'bet' }
				return { slug: null, source: 'none', rejected: `bet:${betId}` }
			}
		}

		// 3. sandbox default
		const envRaw = process.env.GITHUB_REPO
		if (typeof envRaw === 'string' && envRaw.trim() !== '') {
			const slug = normalizeRepoSlug(envRaw)
			if (slug) return { slug, source: 'env' }
			return { slug: null, source: 'none', rejected: 'env:GITHUB_REPO' }
		}

		return { slug: null, source: 'none' }
	}

	/**
	 * Shared helper: build the launch spec and create+start the local Docker
	 * container. Local-dev only — production goes through the dispatch queue
	 * to apps/agent-server.
	 */
	private async launchContainer(
		session: typeof sessions.$inferSelect,
		tempDir: string,
		containerName?: string,
	): Promise<string> {
		const spec = await this.buildLaunchSpec(session)
		const envVars = { ...spec.env }
		const name = containerName ?? `anko-session-${session.id.slice(0, 8)}`

		// Ensure the image exists — rebuild if it was pruned or lost
		if (spec.image === 'agent-base:latest' && this.agentBaseBuildContext) {
			await this.containers.ensureImage(spec.image, this.agentBaseBuildContext)
		}

		// Write exec-trigger so the entrypoint starts the agent. The entrypoint
		// checks for this file to distinguish local Docker (immediate start) from
		// the microsandbox path (where the agent-server writes the file after
		// the TCP proxy is active). On the local Docker path we write it here.
		await writeFile(join(tempDir, '.exec-trigger'), '')

		// Provision browser sidecar when the browserRequired flag is set
		let networkMode: string | undefined
		if (spec.browserRequired) {
			const prefix = session.id.slice(0, 16)
			const result = await this.provisionBrowserSidecar(session.id, prefix)
			if (result) {
				envVars.BROWSER_CDP_URL = `http://${result.browserIp}:9222`
				networkMode = result.networkName
			}
		}

		// Write the exec-trigger file before starting — the entrypoint checks for
		// /agent/.exec-trigger and sleeps forever without it (microsandbox contract).
		await writeFile(join(tempDir, '.exec-trigger'), '')

		const containerId = await this.containers.create({
			image: spec.image,
			name,
			env: envVars,
			memoryMb: spec.memoryMib,
			cpuShares: spec.cpuShares,
			binds: [`${tempDir}:/agent:rw`],
			networkMode,
			interactive: session.interactive,
		})

		await this.containers.start(containerId)

		if (session.interactive) {
			await this.containers.attachStdin(session.id, containerId)
		}

		return containerId
	}

	/**
	 * Existing seeded/template agents opt into browser access by referencing
	 * ${BROWSER_CDP_URL} in their MCP config. Keep that contract while newer
	 * callers can use config.browserRequired directly.
	 */
	private needsBrowserSidecar(envVars: Record<string, string>): boolean {
		const agentMcp = envVars.AGENT_MCP_JSON ?? ''
		const sessionMcp = envVars.MCP_SERVERS_JSON ?? ''
		return agentMcp.includes('${BROWSER_CDP_URL}') || sessionMcp.includes('${BROWSER_CDP_URL}')
	}

	/**
	 * Return the GitHub owner_login for an integration row, lazily backfilling it
	 * via the GitHub API and persisting back to the row when missing. Returns
	 * undefined (and logs) if the backfill cannot complete — the caller skips that
	 * integration rather than failing the whole session.
	 */
	private async resolveGithubOwnerLogin(
		integration: typeof integrations.$inferSelect,
	): Promise<string | undefined> {
		const config = (integration.config as IntegrationConfig | null) ?? {}
		if (config.owner_login) return config.owner_login

		const installationId = integration.externalId
		if (!installationId) {
			logger.warn('GitHub integration has no externalId; cannot backfill owner_login', {
				integrationId: integration.id,
			})
			return undefined
		}

		try {
			const ownerLogin = await fetchInstallationOwnerLogin(installationId)
			await this.db
				.update(integrations)
				.set({
					config: { ...config, owner_login: ownerLogin },
					updatedAt: new Date(),
				})
				.where(eq(integrations.id, integration.id))
			logger.info('Backfilled owner_login for GitHub integration', {
				integrationId: integration.id,
				ownerLogin,
			})
			return ownerLogin
		} catch (err) {
			logger.warn('Failed to backfill owner_login for GitHub integration; skipping', {
				integrationId: integration.id,
				installationId,
				error: err instanceof Error ? err.message : String(err),
			})
			return undefined
		}
	}

	private computeTimeout(session: typeof sessions.$inferSelect): Date {
		const sessionConfig = session.config as Record<string, unknown>
		const timeoutSeconds = (sessionConfig.timeout_seconds as number) ?? 7200
		return new Date(Date.now() + timeoutSeconds * 1000)
	}

	private streamContainerLogs(sessionId: string, containerId: string) {
		const drained = (async () => {
			// First connect replays history (`tail: 'all'`); reconnects after a
			// transient drop pick up from "now" (`tail: 0`) so we don't duplicate
			// every prior log row. A few seconds of missed output is acceptable —
			// the goal is just to keep the stream alive so the idle watchdog
			// doesn't mistake stream silence for agent inactivity.
			let attempt = 0
			let firstConnect = true
			while (true) {
				try {
					const logOpts = firstConnect ? {} : { tail: 0 as const }
					firstConnect = false
					for await (const chunk of this.containers.logs(containerId, true, logOpts)) {
						attempt = 0
						if (chunk.stream === 'stdout') {
							await this.emitGithubCauseTagIfAny(sessionId, chunk.data)
						}
						const [log] = await this.db
							.insert(sessionLogs)
							.values({
								sessionId,
								stream: chunk.stream,
								content: chunk.data,
							})
							.returning()

						if (log) {
							this.emit('log', {
								sessionId,
								logId: log.id,
								stream: chunk.stream,
								data: chunk.data,
							} satisfies SessionLogEvent)
						}

						if (chunk.stream === 'stdout') {
							const sessionData = this.activeSessions.get(sessionId)
							if (sessionData) {
								const next = (sessionData.stdoutTail ?? '') + chunk.data
								sessionData.stdoutTail =
									next.length > SessionManager.STDOUT_TAIL_BYTES
										? next.slice(next.length - SessionManager.STDOUT_TAIL_BYTES)
										: next
							}
						}
					}
					// Stream ended naturally — container exited and Docker closed the
					// connection. `watchContainerExit` will handle terminal cleanup.
					return
				} catch (err) {
					attempt++
					logger.warn('Log stream errored', {
						sessionId,
						error: String(err),
						attempt,
					})

					// If the container is gone we can't recover the stream. Let the
					// exit watcher take it from here.
					if (!(await this.isContainerAlive(containerId))) {
						logger.info('Log stream ended; container no longer running', { sessionId })
						return
					}

					if (attempt >= SessionManager.LOG_STREAM_MAX_RECONNECTS) {
						// Genuinely cannot reattach. Surface to SSE clients so they
						// don't sit on a blank spinner indefinitely.
						await this.insertSystemLog(
							sessionId,
							'Log stream interrupted — session may still be running',
						).catch((logErr) =>
							logger.error('Failed to write log-stream-interrupted system log', {
								sessionId,
								error: String(logErr),
							}),
						)
						return
					}

					await new Promise((resolve) =>
						setTimeout(resolve, SessionManager.LOG_STREAM_RECONNECT_DELAY_MS),
					)
				}
			}
		})()

		const sessionData = this.activeSessions.get(sessionId)
		if (sessionData) sessionData.logsDrained = drained
	}

	private watchContainerExit(sessionId: string, containerId: string) {
		// Tolerate a few transient Docker API failures in a row before giving
		// up and marking the session failed — a single EBUSY/socket timeout
		// shouldn't strand the session as "running" until the hour-long
		// timeout reaper catches it.
		const MAX_CONSECUTIVE_INSPECT_FAILURES = 5
		let consecutiveFailures = 0
		const poll = async () => {
			try {
				const status = await this.containers.inspect(containerId)
				consecutiveFailures = 0
				if (!status.running) {
					await this.handleCompletion(sessionId, containerId, status.exitCode)
					return
				}
			} catch (err) {
				consecutiveFailures++
				logger.warn('Container inspect failed', {
					sessionId,
					containerId,
					error: String(err),
					consecutiveFailures,
				})
				if (consecutiveFailures >= MAX_CONSECUTIVE_INSPECT_FAILURES) {
					logger.error('Container inspect failed repeatedly, marking session failed', {
						sessionId,
						containerId,
					})
					await this.handleCompletion(sessionId, containerId, 1).catch((completionErr) => {
						logger.error('handleCompletion failed after inspect give-up', {
							sessionId,
							error: String(completionErr),
						})
					})
					return
				}
			}
			setTimeout(poll, 2000)
		}
		setTimeout(poll, 2000)
	}

	/** Session statuses that count as "the agent is still doing work". */
	private static readonly ACTIVE_SESSION_STATUSES = [
		'pending',
		'starting',
		'queued',
		'running',
		'snapshotting',
	] as const

	/**
	 * Session statuses that are already resolved (or mid-way through their own
	 * lifecycle path) — a session in one of these must never be reprocessed as
	 * newly-completing, whether the completion signal came from the local
	 * Docker exit watcher (`handleCompletion`) or from a remote agent-server
	 * (`markRemoteSessionComplete`).
	 */
	private static readonly TERMINAL_OR_TRANSITIONAL_STATUSES = [
		'completed',
		'failed',
		'timeout',
		'paused',
		'snapshotting',
	] as const

	/**
	 * True if the actor has an active session other than `excludeSessionId`.
	 * Used to avoid clobbering agent-level `agentState` when one of several
	 * concurrent sessions transitions — the agent should only flip to a
	 * terminal/paused state once its last active session does.
	 */
	private async hasOtherActiveSessions(
		actorId: string,
		excludeSessionId: string,
	): Promise<boolean> {
		const [other] = await this.db
			.select({ id: sessions.id })
			.from(sessions)
			.where(
				and(
					eq(sessions.actorId, actorId),
					ne(sessions.id, excludeSessionId),
					inArray(sessions.status, SessionManager.ACTIVE_SESSION_STATUSES),
				),
			)
			.limit(1)
		return Boolean(other)
	}

	private async maybeRetryClaudeOAuthOnBackup(params: {
		session: typeof sessions.$inferSelect
		failureReason: { provider: string; reason_code: string } | null
		stdoutTail: string
	}): Promise<void> {
		const { session, failureReason, stdoutTail } = params
		// Mirrors the session-start gate in resolveClaudeCredentialsWithFailover —
		// flipping the flag off must stop failover everywhere, not just at
		// session start. Without this, an operator using the flag as an
		// incident kill-switch would still see mid-session runtime failures
		// flip active_slot to backup and fire the failover event.
		if (!isClaudeFailoverEnabled()) return
		const config = ((session.config as Record<string, unknown>) ?? {}) as Record<string, unknown>
		if (config.llm_route !== LLM_ROUTE_OAUTH) return

		const reason = claudeRuntimeFailoverReason(failureReason, stdoutTail)
		if (!reason) return

		if (
			config.llm_oauth_slot === 'backup' ||
			typeof config.claude_oauth_runtime_failover_retry_of === 'string'
		) {
			await recordRuntimeClaudeOAuthBackupExhausted({
				db: this.db,
				workspaceId: session.workspaceId,
				actorId: session.actorId,
				reason,
				sourceSessionId: session.id,
			})
			await this.insertSystemLog(
				session.id,
				'Claude backup subscription also hit a usage limit; no further Claude OAuth fallback is available',
			)
			return
		}

		if (config.llm_oauth_slot !== 'primary') return

		const [existingRetry] = await this.db
			.select({ id: sessions.id })
			.from(sessions)
			.where(
				and(
					eq(sessions.workspaceId, session.workspaceId),
					sql`${sessions.config}->>'claude_oauth_runtime_failover_retry_of' = ${session.id}`,
				),
			)
			.limit(1)
		if (existingRetry) return

		const didFailover = await recordRuntimeClaudeOAuthFailover({
			db: this.db,
			workspaceId: session.workspaceId,
			actorId: session.actorId,
			reason,
			sourceSessionId: session.id,
		})
		if (!didFailover) return

		await this.insertSystemLog(
			session.id,
			'Claude primary subscription hit a usage limit; retrying this session on the backup subscription',
		)
		await this.createSession(session.workspaceId, {
			actorId: session.actorId,
			actionPrompt: session.actionPrompt,
			config: {
				...config,
				llm_oauth_slot: 'backup',
				claude_oauth_runtime_failover_retry_of: session.id,
			},
			triggerId: session.triggerId ?? undefined,
			createdBy: session.createdBy,
			autoStart: true,
			sourceSessionId: session.id,
		})
	}

	private async handleCompletion(
		sessionId: string,
		containerId: string,
		exitCode: number | null,
	): Promise<void> {
		const [session] = await this.db
			.select()
			.from(sessions)
			.where(eq(sessions.id, sessionId))
			.limit(1)

		if (!session) return

		// Skip if already in a terminal or transitional state (avoid double-processing)
		if (
			(SessionManager.TERMINAL_OR_TRANSITIONAL_STATUSES as readonly string[]).includes(
				session.status,
			)
		)
			return

		try {
			// Push learnings back to S3
			const sessionData = this.activeSessions.get(sessionId)
			if (sessionData) {
				await this.agentStorage
					.pushAgentFiles(session.actorId, session.workspaceId, sessionId, sessionData.tempDir, {
						actionPrompt: session.actionPrompt,
					})
					.catch((err) =>
						logger.warn('Failed to push learnings', { sessionId, error: String(err) }),
					)
			}
		} catch (err) {
			logger.warn('Failed to push session files', { sessionId, error: String(err) })
		}

		// Extract token / cost usage from the tail of stdout. Codex and custom
		// runtimes don't emit structured usage — extractor returns null and the
		// columns stay NULL. Parser failures must never block the status update,
		// so this is wrapped in its own try/catch.
		//
		// Prefer the in-memory stdout tail captured by `streamContainerLogs`:
		// the container exit poll can fire before the final `result` chunk has
		// been persisted to `session_logs`, so a DB-only read can race and
		// silently miss usage. We wait briefly for the log stream to drain so
		// the in-memory buffer contains the final chunk, then parse from it.
		// The DB path is kept as a fallback for the resume-from-snapshot case
		// where the tail buffer may be empty.
		let usage: SessionUsage | null = null
		try {
			const drained = this.activeSessions.get(sessionId)?.logsDrained
			if (drained) {
				await Promise.race([
					drained,
					new Promise<void>((resolve) => setTimeout(resolve, SessionManager.LOGS_DRAIN_TIMEOUT_MS)),
				])
			}
			const tail = this.activeSessions.get(sessionId)?.stdoutTail
			if (tail) {
				usage = parseUsageFromLogChunks([tail])
			}
			if (!usage) {
				usage = await extractSessionUsage(this.db, sessionId)
			}
		} catch (err) {
			logger.warn('Failed to parse usage from session logs', {
				sessionId,
				error: String(err),
			})
		}

		const stdoutTail = this.activeSessions.get(sessionId)?.stdoutTail ?? ''
		const failureReason =
			exitCode !== null
				? classifyCreditExhaustion(stdoutTail, { includeAmbiguousSignals: exitCode !== 0 })
				: null
		const status = exitCode === 0 && !failureReason ? 'completed' : 'failed'
		if (failureReason) {
			logger.info('Session credit-exhaustion classified', {
				sessionId,
				reason_code: failureReason.reason_code,
				provider: failureReason.provider,
				exitCode,
			})
		}

		// SSE clients subscribed to /logs/stream rely on the "Session
		// completed|failed|timed out|paused" system log to emit their `done`
		// event and close. If any DB write below throws, subscribers would sit
		// in the 30s keep-alive loop indefinitely — so swallow persistence
		// errors here and always attempt the terminal system log.
		try {
			await this.db
				.update(sessions)
				.set({
					status,
					result: {
						exit_code: exitCode,
						...(failureReason ? { failure_reason: failureReason } : {}),
					},
					completedAt: new Date(),
					updatedAt: new Date(),
					currentActivity: null,
					...(usage
						? {
								totalCostUsd: usage.totalCostUsd?.toString() ?? null,
								inputTokens: usage.inputTokens,
								outputTokens: usage.outputTokens,
								cacheCreationInputTokens: usage.cacheCreationInputTokens,
								cacheReadInputTokens: usage.cacheReadInputTokens,
								durationMs: usage.durationMs,
							}
						: {}),
				})
				.where(eq(sessions.id, sessionId))
		} catch (err) {
			logger.error('Failed to update session status in handleCompletion', {
				sessionId,
				status,
				error: String(err),
			})
		}

		// Sync agentState on the actor so the agents overview reflects terminal status.
		// completed → idle (agent finished cleanly), failed → failed (needs attention).
		// Skip if the agent still has other active sessions, so one finishing
		// session doesn't prematurely flip an agent that's still working.
		try {
			if (!(await this.hasOtherActiveSessions(session.actorId, sessionId))) {
				await this.db
					.update(actors)
					.set({
						agentState: status === 'completed' ? 'idle' : 'failed',
						agentStateUpdatedAt: new Date(),
						updatedAt: new Date(),
					})
					.where(eq(actors.id, session.actorId))
			}
		} catch (err) {
			logger.warn('Failed to sync agentState after session completion', {
				sessionId,
				error: String(err),
			})
		}

		try {
			await this.db.insert(events).values({
				workspaceId: session.workspaceId,
				actorId: session.actorId,
				action: `session_${status}`,
				entityType: 'session',
				entityId: sessionId,
				data: { exit_code: exitCode, ...(failureReason ? { failure_reason: failureReason } : {}) },
			})
		} catch (err) {
			logger.error('Failed to insert completion event in handleCompletion', {
				sessionId,
				status,
				error: String(err),
			})
		}

		if (status === 'failed') {
			await this.maybeRetryClaudeOAuthOnBackup({ session, failureReason, stdoutTail }).catch(
				(err) =>
					logger.warn('Failed to retry Claude OAuth session on backup', {
						sessionId,
						error: String(err),
					}),
			)
		}

		// Ship-metric emit. If this session belongs to a managed-catalog actor
		// (carries `metadata.installed_package_id`), claim the per-(workspace,
		// install, UTC day) idempotency slot and emit `loop_active_day` to
		// PostHog when the claim is won. Both the lookup and the emit are
		// best-effort — analytics failures must not affect the completion
		// path that downstream watchdogs and SSE clients depend on.
		await this.maybeEmitLoopActiveDay(session.actorId, session.workspaceId).catch((err) => {
			logger.warn('Failed loop_active_day emit', { sessionId, error: String(err) })
		})

		try {
			await this.insertSystemLog(sessionId, `Session ${status} with exit code ${exitCode}`)
		} catch (err) {
			logger.error('Failed to write terminal system log — SSE clients may hang', {
				sessionId,
				status,
				error: String(err),
			})
			// Last-ditch fan-out: synthesize a log event on the bus so SSE
			// subscribers see `done` even when DB insert is failing. The log id
			// is synthetic (negative) so it can't collide with real rows.
			this.emit('log', {
				sessionId,
				logId: -Date.now(),
				stream: 'system',
				data: `Session ${status} with exit code ${exitCode}`,
			})
		}

		const wasUserStopped = this.stopRequested.delete(sessionId)
		const endReason: RuntimeEndReason = wasUserStopped
			? 'user_stopped'
			: status === 'completed'
				? 'completed'
				: failureReason
					? 'irrecoverable'
					: 'failed'
		this.telemetry.recordSessionEnded({
			sessionId,
			endReason,
			durationMs: elapsedMs(session.startedAt, session.createdAt),
			agentServerUrl: LOCAL_RUNTIME_BUCKET,
		})

		// Clear active session link on object
		await this.clearActiveSession(sessionId)

		// Snapshot the full /agent/ workspace before removing the container so a
		// continuation session can restore it via sourceSessionId. Non-fatal.
		await this.snapshotWorkspaceAfterExit(sessionId, containerId).catch((err) =>
			logger.warn('Failed to snapshot workspace after exit', {
				sessionId,
				containerId,
				error: String(err),
			}),
		)

		// Cleanup
		this.containers.detachStdin(sessionId)
		await this.cleanupBrowserSidecar(sessionId)
		await this.containers
			.remove(containerId)
			.catch((err) =>
				logger.warn('Failed to remove container', { sessionId, containerId, error: String(err) }),
			)
		await this.cleanupSession(sessionId)

		logger.info(`Session ${status}: ${sessionId}`, { exitCode })

		// Start next queued session if capacity is available
		await this.drainQueue(session.workspaceId).catch((err) =>
			logger.error('Failed to drain queue after completion', { error: String(err) }),
		)
	}

	/**
	 * If the completing session's actor is part of a managed-catalog install
	 * (carries `metadata.installed_package_id`), claim today's idempotency
	 * slot and emit `loop_active_day`. Returns silently when the actor isn't
	 * a managed install or when today has already been claimed for that
	 * install — both are normal no-ops.
	 */
	private async maybeEmitLoopActiveDay(actorId: string, workspaceId: string): Promise<void> {
		const [actor] = await this.db
			.select({ metadata: actors.metadata })
			.from(actors)
			.where(eq(actors.id, actorId))
			.limit(1)

		const meta = (actor?.metadata as Record<string, unknown> | null) ?? null
		const installedPackageId = meta?.installed_package_id
		if (typeof installedPackageId !== 'string' || installedPackageId.length === 0) return

		const utcDay = utcDayString()
		const claim = await claimLoopActiveDay(this.db, installedPackageId, utcDay)
		if (!claim) return

		// Guard against a misaligned actor metadata (workspace_id mismatch is
		// not expected but can happen if an install row was deleted while a
		// session was still in flight). The emitted workspace_id is the one
		// stored on the install row, which is the canonical join key for
		// PostHog's Synthesizer.
		if (claim.workspaceId !== workspaceId) {
			logger.warn('loop_active_day workspace mismatch', {
				actorWorkspace: workspaceId,
				installWorkspace: claim.workspaceId,
				installedPackageId,
			})
		}

		await trackLoopActiveDay({
			installedPackageId: claim.installedPackageId,
			packageId: claim.packageId,
			packageSlug: claim.packageSlug,
			workspaceId: claim.workspaceId,
			utcDay,
		})

		logger.info('loop_active_day emitted', {
			installedPackageId: claim.installedPackageId,
			workspaceId: claim.workspaceId,
			utcDay,
		})
	}

	private async runWatchdog(): Promise<void> {
		const now = new Date()
		const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000)

		// 1. Find sessions past timeout — push learnings before cleanup
		const timedOut = await this.db
			.select()
			.from(sessions)
			.where(and(eq(sessions.status, 'running'), lt(sessions.timeoutAt, now)))

		for (const session of timedOut) {
			logger.warn(`Session timed out: ${session.id}`)

			// Push learnings before destroying container
			const sessionData = this.activeSessions.get(session.id)
			if (sessionData) {
				await this.agentStorage
					.pushAgentFiles(session.actorId, session.workspaceId, session.id, sessionData.tempDir, {
						actionPrompt: session.actionPrompt,
					})
					.catch((err) =>
						logger.warn('Failed to push learnings on timeout', {
							sessionId: session.id,
							error: String(err),
						}),
					)
			}

			if (session.containerId) {
				this.containers.detachStdin(session.id)
				await this.containers.stop(session.containerId).catch((err) =>
					logger.warn('Failed to stop timed-out container', {
						sessionId: session.id,
						containerId: session.containerId,
						error: String(err),
					}),
				)
				await this.containers.remove(session.containerId).catch((err) =>
					logger.warn('Failed to remove timed-out container', {
						sessionId: session.id,
						containerId: session.containerId,
						error: String(err),
					}),
				)
			}

			await this.db
				.update(sessions)
				.set({
					status: 'timeout',
					result: { error: 'Session timed out' },
					completedAt: now,
					currentActivity: null,
					updatedAt: now,
				})
				.where(eq(sessions.id, session.id))

			// Only sync the agent to idle if this was its last active session.
			if (!(await this.hasOtherActiveSessions(session.actorId, session.id))) {
				await this.db
					.update(actors)
					.set({ agentState: 'idle', agentStateUpdatedAt: now, updatedAt: now })
					.where(eq(actors.id, session.actorId))
					.catch((err) =>
						logger.warn('Failed to sync agentState after session timeout', {
							sessionId: session.id,
							error: String(err),
						}),
					)
			}

			await this.db.insert(events).values({
				workspaceId: session.workspaceId,
				actorId: session.actorId,
				action: 'session_timeout',
				entityType: 'session',
				entityId: session.id,
				data: {},
			})

			this.telemetry.recordSessionEnded({
				sessionId: session.id,
				endReason: 'irrecoverable',
				durationMs: elapsedMs(session.startedAt, session.createdAt),
				agentServerUrl: LOCAL_RUNTIME_BUCKET,
			})

			await this.insertSystemLog(session.id, 'Session timed out').catch((err) =>
				logger.warn('Failed to write timeout system log', {
					sessionId: session.id,
					error: String(err),
				}),
			)

			await this.clearActiveSession(session.id)
			await this.cleanupBrowserSidecar(session.id)
			await this.cleanupSession(session.id)

			// Start next queued session if capacity is available
			await this.drainQueue(session.workspaceId).catch((err) =>
				logger.error('Failed to drain queue after timeout', { error: String(err) }),
			)
		}

		// 2. Reap agent-server sessions that exceeded the default 2-hour timeout but
		// never had timeoutAt set (dispatcher bug in earlier versions). The normal
		// timeout reaper above requires timeoutAt to be non-null, so without this
		// fallback these sessions accumulate as permanent zombies consuming workspace
		// capacity indefinitely.
		const defaultTimeoutMs = 7200 * 1000
		const defaultTimeoutAgo = new Date(now.getTime() - defaultTimeoutMs)
		const stuckAgentSessions = await this.db
			.select()
			.from(sessions)
			.where(
				and(
					eq(sessions.status, 'running'),
					isNotNull(sessions.agentServerId),
					isNull(sessions.timeoutAt),
					lt(sessions.startedAt, defaultTimeoutAgo),
				),
			)
		for (const session of stuckAgentSessions) {
			logger.warn('Reaping stuck agent-server session (no timeoutAt, past default 2h limit)', {
				sessionId: session.id,
			})
			await this.db
				.update(sessions)
				.set({
					status: 'timeout',
					result: { error: 'Session timed out' },
					completedAt: now,
					currentActivity: null,
					updatedAt: now,
				})
				.where(eq(sessions.id, session.id))
			await this.drainQueue(session.workspaceId).catch((err) =>
				logger.error('Failed to drain queue after stuck agent-server session reap', {
					error: String(err),
				}),
			)
		}

		// 3. Auto-pause idle non-interactive sessions (no log output for >10 minutes).
		// Interactive sessions (chat) are long-lived by design and naturally
		// idle between user turns — pausing them silently breaks the next /input call.
		const runningSessions = await this.db
			.select()
			.from(sessions)
			.where(and(eq(sessions.status, 'running'), eq(sessions.interactive, false)))

		for (const session of runningSessions) {
			const [lastLog] = await this.db
				.select()
				.from(sessionLogs)
				.where(eq(sessionLogs.sessionId, session.id))
				.orderBy(desc(sessionLogs.createdAt))
				.limit(1)

			const lastActivity = lastLog?.createdAt ?? session.startedAt
			if (!lastActivity || lastActivity >= tenMinutesAgo) continue

			// The "no logs in 10 min" heuristic gives a false positive whenever
			// dockerode's log stream drops mid-session — the session_logs table
			// stops growing even though the container is happily working. Before
			// pausing, confirm the container is actually gone *or* genuinely
			// idle; if it's still running, leave the reattach loop in
			// streamContainerLogs to recover and try again next tick.
			if (!session.containerId) {
				// A `running` row with no containerId is unrecoverable — pauseSession
				// would reject on the same guard and the watchdog would log-spam
				// every minute forever. Route to terminal-failed instead.
				logger.warn('Marking session failed: running with no containerId', {
					sessionId: session.id,
				})
				await this.markSessionFailedAfterContainerLoss(session.id, session.workspaceId).catch(
					(err) =>
						logger.error('Failed to mark session failed after container loss', {
							sessionId: session.id,
							error: String(err),
						}),
				)
				continue
			}

			if (!(await this.isContainerAlive(session.containerId))) {
				if (session.agentServerId) {
					// Agent-server session — containerId is an msb sandbox name on a
					// remote host; local Docker inspect is meaningless here. The
					// agent-server reports completion via its exit callback.
					continue
				}
				// Local Docker session — container is gone. watchContainerExit is not
				// re-registered after a server restart, so it will never fire for
				// these sessions. Mark as failed to free workspace capacity.
				logger.warn('Marking session failed: local container no longer running', {
					sessionId: session.id,
				})
				await this.markSessionFailedAfterContainerLoss(session.id, session.workspaceId).catch(
					(err) =>
						logger.error('Failed to mark session failed after container loss', {
							sessionId: session.id,
							error: String(err),
						}),
				)
				continue
			}

			logger.info(`Auto-pausing idle session: ${session.id}`)
			this.pauseSession(session.id)
				.then(async () => {
					// Only reflect paused at the agent level if no other session is active.
					if (await this.hasOtherActiveSessions(session.actorId, session.id)) return
					await this.db
						.update(actors)
						.set({ agentState: 'paused', agentStateUpdatedAt: new Date(), updatedAt: new Date() })
						.where(eq(actors.id, session.actorId))
						.catch((err) =>
							logger.warn('Failed to sync agentState after auto-pause', {
								sessionId: session.id,
								error: String(err),
							}),
						)
				})
				.catch((err) =>
					logger.error('Auto-pause failed', { sessionId: session.id, error: String(err) }),
				)
		}

		// 4. Archive old paused sessions (7 days)
		const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
		const expiredPaused = await this.db
			.select()
			.from(sessions)
			.where(and(eq(sessions.status, 'paused'), lt(sessions.updatedAt, sevenDaysAgo)))

		for (const session of expiredPaused) {
			if (session.snapshotPath) {
				await this.storage.delete(session.snapshotPath).catch((err) =>
					logger.warn('Failed to delete snapshot', {
						sessionId: session.id,
						snapshotPath: session.snapshotPath,
						error: String(err),
					}),
				)
			}
			await this.db
				.update(sessions)
				.set({ status: 'completed', snapshotPath: null, updatedAt: now })
				.where(eq(sessions.id, session.id))

			await this.clearActiveSession(session.id)
			logger.info(`Archived expired paused session: ${session.id}`)
		}

		// 4. Prune old session logs (30 days)
		const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
		await this.db.delete(sessionLogs).where(lt(sessionLogs.createdAt, thirtyDaysAgo))

		// 5. Recover stuck pending sessions — sessions stuck in 'pending' for >2 minutes
		// without being started (e.g., startSession promise was lost or never called)
		const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000)
		const stuckPending = await this.db
			.select()
			.from(sessions)
			.where(and(eq(sessions.status, 'pending'), lt(sessions.updatedAt, twoMinutesAgo)))

		for (const session of stuckPending) {
			logger.warn(`Recovering stuck pending session: ${session.id}`, {
				workspaceId: session.workspaceId,
			})
			// Move to queued so drainQueue picks them up in order
			await this.db
				.update(sessions)
				.set({ status: 'queued', updatedAt: new Date() })
				.where(and(eq(sessions.id, session.id), eq(sessions.status, 'pending')))
				.catch((err) =>
					logger.error('Failed to recover stuck pending session', {
						sessionId: session.id,
						error: String(err),
					}),
				)
		}

		// 6. Fail sessions stuck in 'starting' for >10 minutes (zombie session cleanup)
		const stuckStarting = await this.db
			.select()
			.from(sessions)
			.where(and(eq(sessions.status, 'starting'), lt(sessions.updatedAt, tenMinutesAgo)))

		for (const session of stuckStarting) {
			logger.warn(`Failing zombie session stuck in starting: ${session.id}`, {
				workspaceId: session.workspaceId,
			})

			await this.db
				.update(sessions)
				.set({
					status: 'failed',
					result: { error: 'Session stuck in starting state' },
					completedAt: new Date(),
					updatedAt: new Date(),
				})
				.where(eq(sessions.id, session.id))

			await this.db.insert(events).values({
				workspaceId: session.workspaceId,
				actorId: session.actorId,
				action: 'session_failed',
				entityType: 'session',
				entityId: session.id,
				data: { error: 'Session stuck in starting state' },
			})

			this.telemetry.recordSessionEnded({
				sessionId: session.id,
				endReason: 'failed',
				durationMs: elapsedMs(session.startedAt, session.createdAt),
				agentServerUrl: LOCAL_RUNTIME_BUCKET,
			})

			await this.cleanupBrowserSidecar(session.id).catch(() => {})
			await this.clearActiveSession(session.id)
			await this.cleanupSession(session.id)

			// Free capacity for the workspace so queued sessions can start
			await this.drainQueue(session.workspaceId).catch((err) =>
				logger.error('Failed to drain queue after zombie cleanup', { error: String(err) }),
			)
		}

		// 7. Drain queued sessions for workspaces that have capacity
		const queuedSessions = await this.db
			.select({ workspaceId: sessions.workspaceId })
			.from(sessions)
			.where(or(eq(sessions.status, 'queued'), eq(sessions.status, 'pending')))
			.groupBy(sessions.workspaceId)

		for (const { workspaceId } of queuedSessions) {
			await this.drainQueue(workspaceId).catch((err) =>
				logger.error('Failed to drain queue in watchdog', { workspaceId, error: String(err) }),
			)
		}
	}

	private async reportSkillPullFailures(
		sessionId: string,
		result: PullWorkspaceSkillsResult,
	): Promise<void> {
		if (result.failures.length === 0) return
		const names = result.failures.map((f) => f.name).join(', ')
		await this.insertSystemLog(
			sessionId,
			`Warning: ${result.failures.length} workspace skill(s) could not be pulled and are unavailable in this session: ${names}`,
		)
	}

	private async insertSystemLog(sessionId: string, content: string): Promise<void> {
		const [log] = await this.db
			.insert(sessionLogs)
			.values({ sessionId, stream: 'system', content })
			.returning()

		if (log) {
			this.emit('log', {
				sessionId,
				logId: log.id,
				stream: 'system',
				data: content,
			} satisfies SessionLogEvent)
		}
	}

	/**
	 * Provision a headless Chrome sidecar container on a per-session Docker network.
	 * Returns the network name and browser container ID, or null if provisioning fails.
	 * On failure, the agent session continues without browser capability.
	 */
	private async provisionBrowserSidecar(
		sessionId: string,
		prefix: string,
	): Promise<{ networkName: string; browserIp: string } | null> {
		const networkName = `anko-net-${prefix}`
		const browserName = `anko-browser-${prefix}`
		let browserContainerId: string | undefined
		const image = process.env.BROWSER_SIDECAR_IMAGE ?? 'browser-sidecar:latest'

		try {
			await this.prepareBrowserSidecarImage()
			await this.containers.createNetwork(networkName)

			browserContainerId = await this.containers.create({
				image,
				name: browserName,
				env: {},
				memoryMb: 512,
				cpuShares: 512,
				binds: [],
				networkMode: networkName,
			})

			await this.containers.start(browserContainerId)

			// Brief wait for Chrome to initialize CDP listener
			await new Promise((resolve) => setTimeout(resolve, 2000))

			// Use the container's IP address on the session network so Chrome
			// accepts the WebSocket connection — Chrome's CDP rejects Host headers
			// that are hostnames, but accepts IP addresses and localhost.
			const browserIp = await this.containers.getIpOnNetwork(browserContainerId, networkName)
			if (!browserIp) {
				throw new Error('Could not determine browser sidecar IP on session network')
			}

			// Track sidecar resources for cleanup
			const sessionData = this.activeSessions.get(sessionId)
			if (sessionData) {
				sessionData.browserContainerId = browserContainerId
				sessionData.networkName = networkName
			}

			logger.info('Browser sidecar started', { sessionId, browserName, networkName, browserIp })
			await this.insertSystemLog(
				sessionId,
				'Browser sidecar started — Playwright MCP can connect via CDP',
			)

			return { networkName, browserIp }
		} catch (err) {
			logger.error('Browser sidecar failed — agent will run without browser', {
				sessionId,
				error: String(err),
			})
			await this.insertSystemLog(
				sessionId,
				`Browser sidecar failed to start: ${err instanceof Error ? err.message : String(err)}. Agent will continue without browser capability.`,
			)

			// Clean up partial resources
			if (browserContainerId) {
				await this.containers.stop(browserContainerId).catch(() => {})
				await this.containers.remove(browserContainerId).catch(() => {})
			}
			await this.containers.removeNetwork(networkName).catch(() => {})

			// Clear sidecar tracking
			const sessionData = this.activeSessions.get(sessionId)
			if (sessionData) {
				sessionData.browserContainerId = undefined
				sessionData.networkName = undefined
			}

			return null
		}
	}

	private prepareBrowserSidecarImage(): Promise<void> {
		if (!this.browserSidecarImageReady) {
			this.browserSidecarImageReady = this.buildOrPullBrowserSidecarImage().catch((err) => {
				this.browserSidecarImageReady = null
				throw err
			})
		}
		return this.browserSidecarImageReady
	}

	private async buildOrPullBrowserSidecarImage(): Promise<void> {
		const image = process.env.BROWSER_SIDECAR_IMAGE ?? 'browser-sidecar:latest'
		if (image === 'browser-sidecar:latest' && this.browserSidecarBuildContext) {
			await this.containers.ensureImage(image, this.browserSidecarBuildContext)
			return
		}
		await this.containers.pullImage(image)
	}

	/**
	 * Clean up browser sidecar container and its Docker network.
	 * Called before cleanupSession() in all exit paths. After invoking
	 * stop+remove this polls Docker until the container is actually gone so
	 * the caller has a real teardown guarantee — `remove({ force: true })` is
	 * normally synchronous but the Docker daemon can briefly keep the row
	 * around, and an unrecoverable sidecar would otherwise leak a Chromium
	 * process tree on the host (AC-T5: 60s SLA, container-count delta 0).
	 */
	private async cleanupBrowserSidecar(sessionId: string): Promise<void> {
		const sessionData = this.activeSessions.get(sessionId)
		if (!sessionData) return
		if (!sessionData.browserContainerId && !sessionData.networkName) return

		const start = Date.now()
		const browserContainerId = sessionData.browserContainerId
		const networkName = sessionData.networkName
		let slaViolation = false

		if (browserContainerId) {
			await this.containers
				.stop(browserContainerId)
				.catch((err) =>
					logger.warn('Failed to stop browser sidecar', { sessionId, error: String(err) }),
				)
			await this.containers
				.remove(browserContainerId)
				.catch((err) =>
					logger.warn('Failed to remove browser sidecar', { sessionId, error: String(err) }),
				)

			const gone = await this.waitForContainerGone(
				browserContainerId,
				SessionManager.SIDECAR_TEARDOWN_SLA_MS,
			)
			if (!gone) {
				slaViolation = true
				logger.error('Browser sidecar still present after teardown SLA', {
					sessionId,
					browserContainerId,
					slaMs: SessionManager.SIDECAR_TEARDOWN_SLA_MS,
				})
			}
		}

		if (networkName) {
			await this.containers
				.removeNetwork(networkName)
				.catch((err) =>
					logger.warn('Failed to remove session network', { sessionId, error: String(err) }),
				)
		}

		// Idempotency: clear bookkeeping so a duplicate cleanup call is a no-op
		// (the 7 session-end paths can fire close together — watchdog + handler).
		sessionData.browserContainerId = undefined
		sessionData.networkName = undefined

		if (!slaViolation) {
			logger.info('Browser sidecar teardown complete', {
				sessionId,
				elapsedMs: Date.now() - start,
			})
		}
	}

	/**
	 * Poll `containers.inspect` until the container returns 404 (gone) or the
	 * deadline elapses. Returns true if the container was confirmed gone.
	 * Treats only 404 / "No such container" as gone — a stopped-but-present
	 * container still counts as a leak for the AC-T5 delta check.
	 */
	private async waitForContainerGone(containerId: string, deadlineMs: number): Promise<boolean> {
		const deadline = Date.now() + deadlineMs
		while (Date.now() < deadline) {
			if (await this.isContainerGone(containerId)) return true
			await new Promise((r) => setTimeout(r, SessionManager.SIDECAR_TEARDOWN_POLL_INTERVAL_MS))
		}
		return this.isContainerGone(containerId)
	}

	private async isContainerGone(containerId: string): Promise<boolean> {
		try {
			await this.containers.inspect(containerId)
			return false
		} catch (err) {
			const statusCode = (err as { statusCode?: unknown }).statusCode
			if (statusCode === 404) return true
			const message = (err as { message?: unknown }).message
			if (typeof message === 'string' && /No such container|HTTP code 404/.test(message)) {
				return true
			}
			return false
		}
	}

	/**
	 * Generate the workspace briefing and write it to `/agent/workspace/WORKSPACE.md`
	 * (inside the container) by writing to the mounted tempDir before launch.
	 * Briefing failures never block session start — the agent can still fall back
	 * to direct MCP queries.
	 */
	private async writeWorkspaceBriefing(
		workspaceId: string,
		tempDir: string,
		sessionId: string,
	): Promise<void> {
		try {
			const briefing = await renderWorkspaceBriefing(this.db, this.storage, workspaceId)
			await writeFile(join(tempDir, 'workspace', 'WORKSPACE.md'), briefing)
		} catch (err) {
			logger.warn('Failed to write workspace briefing', {
				sessionId,
				workspaceId,
				error: String(err),
			})
		}
	}

	private async cleanupSession(sessionId: string): Promise<void> {
		const sessionData = this.activeSessions.get(sessionId)
		if (sessionData) {
			await rm(sessionData.tempDir, { recursive: true, force: true }).catch((err) =>
				logger.warn('Failed to clean up temp dir', {
					sessionId,
					tempDir: sessionData.tempDir,
					error: String(err),
				}),
			)
			this.activeSessions.delete(sessionId)
		}
		// Always drop classifier state — safe if never registered, and covers
		// paths (queue-drain rejection, remote sessions) that have no
		// activeSessions entry to key off.
		sessionGithubLogClassifier.unregisterSession(sessionId)
	}

	/**
	 * Append log lines received from a remote agent-server and emit them on the
	 * in-process bus so SSE /logs/stream clients see them in real time.
	 *
	 * `stdout` lines are also passed through the github tool-call classifier —
	 * a failed `tool_result` for a `mcp__github-*` tool triggers an extra
	 * `system`-stream log line carrying `cause_tag=<tag>` so a grep of
	 * `session_logs` for the last 100 failures finds every tagged failure.
	 */
	async appendRemoteSessionLogs(
		sessionId: string,
		lines: Array<{ stream: 'stdout' | 'stderr' | 'system'; content: string }>,
	): Promise<void> {
		for (const line of lines) {
			if (line.stream === 'stdout') {
				await this.emitGithubCauseTagIfAny(sessionId, line.content)
			}
			const [log] = await this.db
				.insert(sessionLogs)
				.values({ sessionId, stream: line.stream, content: line.content })
				.returning()
			if (log) {
				this.emit('log', {
					sessionId,
					logId: log.id,
					stream: line.stream,
					data: line.content,
				} satisfies SessionLogEvent)
			}
		}
	}

	/**
	 * Run one chunk of stdout through the github tool-call log classifier.
	 * Chunks may contain multiple newline-delimited stream-json envelopes; each
	 * one is classified independently. Emits at most one `system`-stream log
	 * line per failed github tool_result, carrying the parent bet AC-6
	 * cause_tag and (when present) the installation_id + mint_age_seconds.
	 * Errors are swallowed — a classifier hiccup must not drop the original
	 * log write.
	 */
	private async emitGithubCauseTagIfAny(sessionId: string, chunk: string): Promise<void> {
		if (chunk.length === 0) return
		const lines = chunk.split('\n')
		for (const line of lines) {
			if (line.length === 0) continue
			try {
				const result = await sessionGithubLogClassifier.classifyLine(sessionId, line)
				if (result) {
					await this.insertSystemLog(sessionId, result.taggedLine)
				}
			} catch (err) {
				logger.warn('github log classifier failed for a line', {
					sessionId,
					error: err instanceof Error ? err.message : String(err),
				})
			}
		}
	}

	/**
	 * Mark a remote agent-server session as completed or failed. Mirrors the
	 * relevant parts of `handleCompletion` but skips local Docker cleanup (the
	 * agent-server owns the sandbox lifecycle; the workspace is already in S3).
	 *
	 * Uses a compare-and-set UPDATE (status NOT IN the terminal/transitional
	 * set, in the WHERE clause, with `.returning()` in place of a preliminary
	 * SELECT) so two concurrent calls for the same session — e.g. a stop
	 * request racing the agent-server's async completion report, or two
	 * racing stop requests — can never both observe 'running' and both write
	 * a terminal event. Exactly one call's UPDATE matches the row; the other
	 * gets zero rows back and no-ops.
	 */
	private static readonly CAS_UPDATE_RETRIES = 3
	private static readonly CAS_UPDATE_RETRY_DELAY_MS = 150

	async markRemoteSessionComplete(sessionId: string, exitCode: number | null): Promise<void> {
		const status = exitCode === 0 ? 'completed' : 'failed'

		// Extract token / cost usage from the remote session's stdout tail.
		// Unlike the local Docker path, there is no in-memory tail buffer for a
		// microsandbox session — its stdout is streamed into `session_logs` via
		// the agent-server's HTTP log-ingest endpoint, flushed before this
		// /complete signal is reported, so the DB-backed extractor is the only
		// source available here. Parser/DB failures must never block the status
		// update, so this is wrapped in its own try/catch — same pattern as the
		// local completion path in handleCompletion().
		let usage: SessionUsage | null = null
		try {
			usage = await extractSessionUsage(this.db, sessionId)
		} catch (err) {
			logger.warn('Failed to parse usage from remote session logs', {
				sessionId,
				error: String(err),
			})
		}

		// A thrown DB error here (distinct from a clean 0-row CAS miss) must not
		// permanently strand the session: giving up immediately would skip the
		// audit event, the terminal system log (which SSE /logs/stream clients
		// need to close), activeSessionId clearing, and the queue drain below —
		// leaving a connected client hanging until the watchdog reaper eventually
		// fires. Retry a few times with linear backoff before accepting that, per
		// the retry pattern already used for transient errors in
		// pushSessionWorkspace (apps/agent-server/src/services/session-workspace.ts).
		let updated: typeof sessions.$inferSelect | undefined
		let updateErr: unknown
		for (let attempt = 1; attempt <= SessionManager.CAS_UPDATE_RETRIES; attempt++) {
			try {
				;[updated] = await this.db
					.update(sessions)
					.set({
						status,
						result: { exit_code: exitCode },
						completedAt: new Date(),
						updatedAt: new Date(),
						currentActivity: null,
						...(usage
							? {
									totalCostUsd: usage.totalCostUsd?.toString() ?? null,
									inputTokens: usage.inputTokens,
									outputTokens: usage.outputTokens,
									cacheCreationInputTokens: usage.cacheCreationInputTokens,
									cacheReadInputTokens: usage.cacheReadInputTokens,
									durationMs: usage.durationMs,
								}
							: {}),
					})
					.where(
						and(
							eq(sessions.id, sessionId),
							notInArray(sessions.status, [...SessionManager.TERMINAL_OR_TRANSITIONAL_STATUSES]),
						),
					)
					.returning()
				updateErr = undefined
				break
			} catch (err) {
				updateErr = err
				if (attempt < SessionManager.CAS_UPDATE_RETRIES) {
					await new Promise((resolve) =>
						setTimeout(resolve, SessionManager.CAS_UPDATE_RETRY_DELAY_MS * attempt),
					)
				}
			}
		}
		if (updateErr) {
			// Best-effort: a DB hiccup here must not surface as a thrown error to
			// stopSession()'s caller, which would otherwise report a 400 "stop
			// failed" even though the remote sandbox kill already succeeded.
			logger.error('Failed to update remote session status after retries', {
				sessionId,
				status,
				error: String(updateErr),
			})
			// The CAS UPDATE never persisted after all retries — most likely a
			// transient DB outage, not a lost race (a lost race returns 0 rows
			// without throwing, handled by the `!updated` check below). Returning
			// here unconditionally would skip every side effect below and strand
			// the session at 'running' with a hung SSE /logs/stream client — the
			// exact bug class this method exists to fix. Do one read-only lookup
			// to decide whether those side effects should still run.
			let fallback: typeof sessions.$inferSelect | undefined
			try {
				;[fallback] = await this.db
					.select()
					.from(sessions)
					.where(eq(sessions.id, sessionId))
					.limit(1)
			} catch (err) {
				logger.error('Fallback session lookup after CAS retries also failed — giving up', {
					sessionId,
					error: String(err),
				})
				return
			}
			if (!fallback) return
			// Another call already resolved this session while our retries were
			// failing (its own report landed, or a concurrent call won the CAS) —
			// no-op to avoid a duplicate terminal event.
			if (
				(SessionManager.TERMINAL_OR_TRANSITIONAL_STATUSES as readonly string[]).includes(
					fallback.status,
				)
			) {
				return
			}
			// Best-effort: try once more to persist the status directly (not
			// CAS-guarded — the read above just confirmed no other call has
			// resolved it). If this also fails, still fall through to the side
			// effects below so the session doesn't hang forever, matching the
			// pre-CAS code's unconditional fallthrough on an UPDATE error.
			try {
				await this.db
					.update(sessions)
					.set({
						status,
						result: { exit_code: exitCode },
						completedAt: new Date(),
						updatedAt: new Date(),
						currentActivity: null,
						...(usage
							? {
									totalCostUsd: usage.totalCostUsd?.toString() ?? null,
									inputTokens: usage.inputTokens,
									outputTokens: usage.outputTokens,
									cacheCreationInputTokens: usage.cacheCreationInputTokens,
									cacheReadInputTokens: usage.cacheReadInputTokens,
									durationMs: usage.durationMs,
								}
							: {}),
					})
					.where(eq(sessions.id, sessionId))
			} catch (err) {
				logger.error(
					'Fallback direct status update also failed — continuing with best-effort cleanup only',
					{ sessionId, error: String(err) },
				)
			}
			updated = fallback
		}

		// No row matched: either the session doesn't exist, or it was already
		// terminal/transitional (this call lost the race, or is a stale retry).
		if (!updated) return

		try {
			if (!(await this.hasOtherActiveSessions(updated.actorId, sessionId))) {
				await this.db
					.update(actors)
					.set({
						agentState: status === 'completed' ? 'idle' : 'failed',
						agentStateUpdatedAt: new Date(),
						updatedAt: new Date(),
					})
					.where(eq(actors.id, updated.actorId))
			}
		} catch (err) {
			logger.warn('Failed to sync agentState for remote session', { sessionId, error: String(err) })
		}

		try {
			await this.db.insert(events).values({
				workspaceId: updated.workspaceId,
				actorId: updated.actorId,
				action: `session_${status}`,
				entityType: 'session',
				entityId: sessionId,
				data: { exit_code: exitCode },
			})
		} catch (err) {
			logger.error('Failed to insert remote session completion event', {
				sessionId,
				error: String(err),
			})
		}

		// Terminal system log is required for SSE /logs/stream clients to close.
		await this.insertSystemLog(sessionId, `Session ${status} with exit code ${exitCode}`).catch(
			(err) => {
				logger.error('Failed to write terminal system log for remote session', {
					sessionId,
					error: String(err),
				})
				this.emit('log', {
					sessionId,
					logId: -Date.now(),
					stream: 'system',
					data: `Session ${status} with exit code ${exitCode}`,
				})
			},
		)

		await this.clearActiveSession(sessionId)
		sessionGithubLogClassifier.unregisterSession(sessionId)
		await this.drainQueue(updated.workspaceId).catch((err) =>
			logger.error('Failed to drain queue after remote session completion', { error: String(err) }),
		)

		logger.info(`Remote session ${status}: ${sessionId}`, { exitCode })
	}

	/** Clear activeSessionId on any object linked to this session. */
	private async clearActiveSession(sessionId: string): Promise<void> {
		await this.db
			.update(objects)
			.set({ activeSessionId: null, updatedAt: new Date() })
			.where(eq(objects.activeSessionId, sessionId))
			.catch((err) =>
				logger.warn('Failed to clear activeSessionId', { sessionId, error: String(err) }),
			)
	}
}
