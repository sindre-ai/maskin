import { execFile as execFileCb } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFileCb)
import type { Database } from '@maskin/db'
import {
	events,
	actors,
	integrations,
	objects,
	sessionLogs,
	sessions,
	workspaces,
} from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { and, count as countFn, desc, eq, lt, or } from 'drizzle-orm'
import { getValidOAuthToken } from '../lib/claude-oauth'
import { TokenManager } from '../lib/integrations/oauth/token-manager'
import { getProvider } from '../lib/integrations/registry'
import { logger } from '../lib/logger'
import type { WorkspaceSettings } from '../lib/types'
import { AgentStorageManager } from './agent-storage'
import { ContainerManager, type LogChunk, type StreamJsonUserMessage } from './container-manager'
import { WORKSPACE_STARTUP_BLOCK, renderWorkspaceBriefing } from './workspace-briefing'

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
		{ tempDir: string; browserContainerId?: string; networkName?: string }
	> = new Map()
	private agentBaseBuildContext: string | null = null
	private drainingWorkspaces: Set<string> = new Set()

	constructor(
		private db: Database,
		private storage: StorageProvider,
	) {
		super()
		this.containers = new ContainerManager()
		this.agentStorage = new AgentStorageManager(storage, db)
	}

	setAgentBaseBuildContext(buildContext: string) {
		this.agentBaseBuildContext = buildContext
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
			await this.writeWorkspaceBriefing(session.workspaceId, tempDir, sessionId)

			// Build env vars and launch container. Let launchContainer derive
			// the container name from session.id so re-entry (e.g. a watchdog
			// retry) doesn't collide with a Docker name we forced ourselves.
			const containerId = await this.launchContainer(session, tempDir)

			await this.db
				.update(sessions)
				.set({
					status: 'running',
					containerId,
					startedAt: new Date(),
					timeoutAt: this.computeTimeout(session),
					updatedAt: new Date(),
				})
				.where(eq(sessions.id, sessionId))

			logger.info(`Session started: ${sessionId}`, { containerId })

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

			this.containers.detachStdin(sessionId)
			await this.clearActiveSession(sessionId)
			await this.cleanupBrowserSidecar(sessionId)
			await this.cleanupSession(sessionId)
			throw err
		}
	}

	/**
	 * Deliver a user turn to an interactive session's stdin. Caller must have
	 * already validated the session is interactive and in `running` state; this
	 * method only performs the stdin write and propagates any underlying error.
	 */
	async writeInput(sessionId: string, payload: StreamJsonUserMessage): Promise<void> {
		await this.containers.write(sessionId, payload)
	}

	async stopSession(sessionId: string): Promise<void> {
		const [session] = await this.db
			.select()
			.from(sessions)
			.where(eq(sessions.id, sessionId))
			.limit(1)

		if (!session || !session.containerId) {
			throw new Error(`Session ${sessionId} not found or has no container`)
		}

		this.containers.detachStdin(sessionId)
		await this.containers.stop(session.containerId)
		// handleCompletion will be called by the exit watcher
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

		await this.db
			.update(sessions)
			.set({ status: 'snapshotting', updatedAt: new Date() })
			.where(eq(sessions.id, sessionId))

		try {
			// Tar the agent workspace
			await this.containers.exec(session.containerId, [
				'tar',
				'-czf',
				'/tmp/snapshot.tar.gz',
				'/agent/',
			])

			const tarStream = await this.containers.copyFrom(session.containerId, '/tmp/snapshot.tar.gz')

			// Stream snapshot directly to S3
			const snapshotKey = `snapshots/${sessionId}.tar.gz`
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
			// Revert status on failure
			await this.db
				.update(sessions)
				.set({ status: 'running', updatedAt: new Date() })
				.where(eq(sessions.id, sessionId))
			throw err
		}
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

			const snapshotPath = join(tempDir, 'snapshot.tar.gz')
			await writeFile(snapshotPath, snapshotBuffer)
			await execFileAsync('tar', ['-xzf', snapshotPath, '-C', tempDir])

			// Also pull latest agent files (other sessions may have added learnings)
			await this.agentStorage.pullAgentFiles(session.actorId, session.workspaceId, tempDir)
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
			.where(and(eq(sessions.workspaceId, workspaceId), eq(sessions.status, 'running')))

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
	 * Shared helper: build env vars (including integration credentials) and create+start container.
	 */
	private async launchContainer(
		session: typeof sessions.$inferSelect,
		tempDir: string,
		containerName?: string,
	): Promise<string> {
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
			MASKIN_API_URL: 'http://host.docker.internal:3000',
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
			envVars.ACTION_PROMPT = `${WORKSPACE_STARTUP_BLOCK}${session.actionPrompt}`
		}

		// Inject LLM API key: agent-level first, then workspace-level fallback
		const [ws] = await this.db
			.select()
			.from(workspaces)
			.where(eq(workspaces.id, session.workspaceId))
			.limit(1)
		const wsSettings = (ws?.settings as WorkspaceSettings) ?? {}
		const wsLlmKeys = wsSettings.llm_keys ?? {}

		if (llmConfig.api_key) {
			if (agent.llmProvider === 'anthropic') {
				envVars.ANTHROPIC_API_KEY = llmConfig.api_key as string
			} else if (agent.llmProvider === 'openai') {
				envVars.OPENAI_API_KEY = llmConfig.api_key as string
			}
		} else {
			// Check for Claude OAuth tokens (subscription auth) before API key fallback
			try {
				const oauthResult = await getValidOAuthToken(this.db, session.workspaceId)
				if (oauthResult) {
					// Claude Code reads OAuth from ~/.claude/.credentials.json, not env vars.
					// Pass full token set so agent-run.sh can write the credentials file.
					envVars.CLAUDE_OAUTH_ACCESS_TOKEN = oauthResult.tokens.accessToken
					envVars.CLAUDE_OAUTH_REFRESH_TOKEN = oauthResult.tokens.refreshToken
					envVars.CLAUDE_OAUTH_EXPIRES_AT = String(oauthResult.tokens.expiresAt)
					if (oauthResult.tokens.scopes) {
						envVars.CLAUDE_OAUTH_SCOPES = JSON.stringify(oauthResult.tokens.scopes)
					}
					if (oauthResult.tokens.subscriptionType) {
						envVars.CLAUDE_OAUTH_SUBSCRIPTION_TYPE = oauthResult.tokens.subscriptionType
					}
				} else if (wsLlmKeys.anthropic) {
					envVars.ANTHROPIC_API_KEY = wsLlmKeys.anthropic
				}
			} catch (err) {
				logger.warn('Failed to use Claude OAuth tokens, falling back to API key', {
					sessionId: session.id,
					error: String(err),
				})
				if (wsLlmKeys.anthropic) {
					envVars.ANTHROPIC_API_KEY = wsLlmKeys.anthropic
				}
			}
			if (wsLlmKeys.openai) {
				envVars.OPENAI_API_KEY = wsLlmKeys.openai
			}
		}

		// Inject agent's API key for Maskin MCP access
		if (agent.apiKey) {
			envVars.MASKIN_API_KEY = agent.apiKey
		}

		// Agent-level MCP config (from tools field, stored as { mcpServers: { ... } })
		const agentTools = agent.tools as Record<string, unknown> | null
		if (agentTools && Object.keys(agentTools).length > 0) {
			envVars.AGENT_MCP_JSON = JSON.stringify(agentTools)
		}

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

		const tokenManager = new TokenManager()
		for (const integration of activeIntegrations) {
			try {
				const resolved = getProvider(integration.provider)
				const accessToken = await tokenManager.getValidToken(this.db, integration.id, resolved)
				const envVarName =
					resolved.config.mcp?.envKey ?? `${integration.provider.toUpperCase()}_TOKEN`
				envVars[envVarName] = accessToken
			} catch (err) {
				logger.warn(`Failed to load credentials for ${integration.provider}`, {
					error: String(err),
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
		const userEnvVars = (sessionConfig.env_vars as Record<string, string>) ?? {}
		for (const [key, value] of Object.entries(userEnvVars)) {
			if (!RESERVED_ENV_KEYS.has(key)) {
				envVars[key] = value
			} else {
				logger.warn(`Ignoring reserved env var from user config: ${key}`, {
					sessionId: session.id,
				})
			}
		}

		// Session-level MCP config (convert array → { mcpServers: { ... } } format)
		const mcps = sessionConfig.mcps as Array<Record<string, unknown>> | undefined
		if (mcps?.length) {
			const mcpServers: Record<string, unknown> = {}
			for (const [i, mcp] of mcps.entries()) {
				mcpServers[`session-mcp-${i}`] = mcp
			}
			envVars.MCP_SERVERS_JSON = JSON.stringify({ mcpServers })
		}

		const name = containerName ?? `anko-session-${session.id.slice(0, 8)}`
		const image = (sessionConfig.base_image as string) ?? 'agent-base:latest'

		// Ensure the image exists — rebuild if it was pruned or lost
		if (image === 'agent-base:latest' && this.agentBaseBuildContext) {
			await this.containers.ensureImage(image, this.agentBaseBuildContext)
		}

		// Provision browser sidecar if Playwright MCP is configured
		let networkMode: string | undefined
		if (this.needsBrowserSidecar(envVars)) {
			const prefix = session.id.slice(0, 8)
			const result = await this.provisionBrowserSidecar(session.id, prefix)
			if (result) {
				envVars.BROWSER_CDP_URL = `ws://anko-browser-${prefix}:9222`
				networkMode = result.networkName
			}
		}

		const containerId = await this.containers.create({
			image,
			name,
			env: envVars,
			memoryMb: (sessionConfig.memory_mb as number) ?? 4096,
			cpuShares: (sessionConfig.cpu_shares as number) ?? 1024,
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

	private computeTimeout(session: typeof sessions.$inferSelect): Date {
		const sessionConfig = session.config as Record<string, unknown>
		const timeoutSeconds = (sessionConfig.timeout_seconds as number) ?? 3600
		return new Date(Date.now() + timeoutSeconds * 1000)
	}

	private streamContainerLogs(sessionId: string, containerId: string) {
		;(async () => {
			try {
				for await (const chunk of this.containers.logs(containerId)) {
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
				}
			} catch (err) {
				logger.error('Log streaming failed', {
					sessionId,
					error: String(err),
				})
				// Surface the interruption so SSE clients don't hang on a blank
				// spinner while the container keeps running without logs.
				await this.insertSystemLog(
					sessionId,
					'Log stream interrupted — session may still be running',
				).catch((logErr) =>
					logger.error('Failed to write log-stream-interrupted system log', {
						sessionId,
						error: String(logErr),
					}),
				)
			}
		})()
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
					await this.handleCompletion(sessionId, containerId, status.exitCode ?? 1)
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

	private async handleCompletion(
		sessionId: string,
		containerId: string,
		exitCode: number,
	): Promise<void> {
		const [session] = await this.db
			.select()
			.from(sessions)
			.where(eq(sessions.id, sessionId))
			.limit(1)

		if (!session) return

		// Skip if already in a terminal or transitional state (avoid double-processing)
		if (['completed', 'failed', 'timeout', 'paused', 'snapshotting'].includes(session.status))
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

		const status = exitCode === 0 ? 'completed' : 'failed'

		await this.db
			.update(sessions)
			.set({
				status,
				result: { exit_code: exitCode },
				completedAt: new Date(),
				updatedAt: new Date(),
			})
			.where(eq(sessions.id, sessionId))

		await this.db.insert(events).values({
			workspaceId: session.workspaceId,
			actorId: session.actorId,
			action: `session_${status}`,
			entityType: 'session',
			entityId: sessionId,
			data: { exit_code: exitCode },
		})

		await this.insertSystemLog(sessionId, `Session ${status} with exit code ${exitCode}`)

		// Clear active session link on object
		await this.clearActiveSession(sessionId)

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
					updatedAt: now,
				})
				.where(eq(sessions.id, session.id))

			await this.db.insert(events).values({
				workspaceId: session.workspaceId,
				actorId: session.actorId,
				action: 'session_timeout',
				entityType: 'session',
				entityId: session.id,
				data: {},
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

		// 2. Auto-pause idle non-interactive sessions (no log output for >10 minutes).
		// Interactive sessions (Sindre chat) are long-lived by design and naturally
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
			if (lastActivity && lastActivity < tenMinutesAgo) {
				logger.info(`Auto-pausing idle session: ${session.id}`)
				this.pauseSession(session.id).catch((err) =>
					logger.error('Auto-pause failed', { sessionId: session.id, error: String(err) }),
				)
			}
		}

		// 3. Archive old paused sessions (7 days)
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
	 * Check if the MCP config references ${BROWSER_CDP_URL}, indicating a browser sidecar is needed.
	 */
	private needsBrowserSidecar(envVars: Record<string, string>): boolean {
		const agentMcp = envVars.AGENT_MCP_JSON ?? ''
		const sessionMcp = envVars.MCP_SERVERS_JSON ?? ''
		return agentMcp.includes('${BROWSER_CDP_URL}') || sessionMcp.includes('${BROWSER_CDP_URL}')
	}

	/**
	 * Provision a headless Chrome sidecar container on a per-session Docker network.
	 * Returns the network name and browser container ID, or null if provisioning fails.
	 * On failure, the agent session continues without browser capability.
	 */
	private async provisionBrowserSidecar(
		sessionId: string,
		prefix: string,
	): Promise<{ networkName: string; browserContainerId: string } | null> {
		const networkName = `anko-net-${prefix}`
		const browserName = `anko-browser-${prefix}`
		let browserContainerId: string | undefined

		try {
			await this.containers.pullImage('chromedp/headless-shell:latest')
			await this.containers.createNetwork(networkName)

			browserContainerId = await this.containers.create({
				image: 'chromedp/headless-shell:latest',
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

			// Track sidecar resources for cleanup
			const sessionData = this.activeSessions.get(sessionId)
			if (sessionData) {
				sessionData.browserContainerId = browserContainerId
				sessionData.networkName = networkName
			}

			logger.info('Browser sidecar started', { sessionId, browserName, networkName })
			await this.insertSystemLog(
				sessionId,
				'Browser sidecar started — Playwright MCP can connect via CDP',
			)

			return { networkName, browserContainerId }
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

	/**
	 * Clean up browser sidecar container and its Docker network.
	 * Called before cleanupSession() in all exit paths.
	 */
	private async cleanupBrowserSidecar(sessionId: string): Promise<void> {
		const sessionData = this.activeSessions.get(sessionId)
		if (!sessionData) return

		if (sessionData.browserContainerId) {
			await this.containers
				.stop(sessionData.browserContainerId)
				.catch((err) =>
					logger.warn('Failed to stop browser sidecar', { sessionId, error: String(err) }),
				)
			await this.containers
				.remove(sessionData.browserContainerId)
				.catch((err) =>
					logger.warn('Failed to remove browser sidecar', { sessionId, error: String(err) }),
				)
		}

		if (sessionData.networkName) {
			await this.containers
				.removeNetwork(sessionData.networkName)
				.catch((err) =>
					logger.warn('Failed to remove session network', { sessionId, error: String(err) }),
				)
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
