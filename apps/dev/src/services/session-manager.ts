import { exec as execCb } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execAsync = promisify(execCb)
import type { Database } from '@ai-native/db'
import {
	events,
	actors,
	integrations,
	objects,
	sessionLogs,
	sessions,
	workspaces,
} from '@ai-native/db/schema'
import type { StorageProvider } from '@ai-native/storage'
import { and, count as countFn, desc, eq, lt } from 'drizzle-orm'
import { getValidOAuthToken } from '../lib/claude-oauth'
import { decrypt } from '../lib/crypto'
import { getProvider } from '../lib/integrations/registry'
import { logger } from '../lib/logger'
import type { WorkspaceSettings } from '../lib/types'
import { AgentStorageManager } from './agent-storage'
import { ContainerManager, type LogChunk } from './container-manager'

export type SessionErrorCode = 'invalid_state' | 'not_found' | 'limit_reached'

export class SessionError extends Error {
	constructor(
		message: string,
		public code: SessionErrorCode,
	) {
		super(message)
		this.name = 'SessionError'
	}
}

export interface CreateSessionParams {
	actorId: string
	actionPrompt: string
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
	private activeSessions: Map<string, { tempDir: string }> = new Map()

	constructor(
		private db: Database,
		private storage: StorageProvider,
	) {
		super()
		this.containers = new ContainerManager()
		this.agentStorage = new AgentStorageManager(storage, db)
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
		const [session] = await this.db
			.insert(sessions)
			.values({
				workspaceId,
				actorId: params.actorId,
				triggerId: params.triggerId,
				status: 'pending',
				actionPrompt: params.actionPrompt,
				config: params.config ?? {},
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

		if (!session) {
			throw new SessionError(`Session ${sessionId} not found`, 'not_found')
		}
		if (session.status !== 'pending') {
			throw new SessionError(`Session ${sessionId} is not in pending state`, 'invalid_state')
		}

		// Check workspace concurrency limit
		await this.checkConcurrencyLimit(session.workspaceId)

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

			// Build env vars and launch container
			const containerId = await this.launchContainer(session, tempDir, sessionId)

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

			await this.clearActiveSession(sessionId)
			await this.cleanupSession(sessionId)
			throw err
		}
	}

	async stopSession(sessionId: string): Promise<void> {
		const [session] = await this.db
			.select()
			.from(sessions)
			.where(eq(sessions.id, sessionId))
			.limit(1)

		if (!session) {
			throw new SessionError(`Session ${sessionId} not found`, 'not_found')
		}
		if (!session.containerId) {
			throw new SessionError(`Session ${sessionId} has no container`, 'invalid_state')
		}

		await this.containers.stop(session.containerId)
		// handleCompletion will be called by the exit watcher
	}

	async pauseSession(sessionId: string): Promise<void> {
		const [session] = await this.db
			.select()
			.from(sessions)
			.where(eq(sessions.id, sessionId))
			.limit(1)

		if (!session) {
			throw new SessionError(`Session ${sessionId} not found`, 'not_found')
		}
		if (session.status !== 'running' || !session.containerId) {
			throw new SessionError(`Session ${sessionId} is not in running state`, 'invalid_state')
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

			await this.cleanupSession(sessionId)

			logger.info(`Session paused: ${sessionId}`)
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

		if (!session) {
			throw new SessionError(`Session ${sessionId} not found`, 'not_found')
		}
		if (session.status !== 'paused') {
			throw new SessionError(`Session ${sessionId} is not in paused state`, 'invalid_state')
		}
		if (!session.snapshotPath) {
			throw new SessionError(`Session ${sessionId} has no snapshot`, 'invalid_state')
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
			await execAsync(`tar -xzf "${snapshotPath}" -C "${tempDir}"`)

			// Also pull latest agent files (other sessions may have added learnings)
			await this.agentStorage.pullAgentFiles(session.actorId, session.workspaceId, tempDir)

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

			await this.clearActiveSession(sessionId)
			await this.cleanupSession(sessionId)
			throw err
		}
	}

	private async checkConcurrencyLimit(workspaceId: string): Promise<void> {
		const [workspace] = await this.db
			.select()
			.from(workspaces)
			.where(eq(workspaces.id, workspaceId))
			.limit(1)

		const settings = (workspace?.settings as WorkspaceSettings) ?? {}
		const maxConcurrent = settings.max_concurrent_sessions ?? 5

		const [result] = await this.db
			.select({ count: countFn() })
			.from(sessions)
			.where(and(eq(sessions.workspaceId, workspaceId), eq(sessions.status, 'running')))

		if (result && result.count >= maxConcurrent) {
			throw new SessionError(
				`Workspace has reached its concurrent session limit (${maxConcurrent}). Wait for a session to complete or increase the limit.`,
				'limit_reached',
			)
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
			ACTION_PROMPT: session.actionPrompt,
			AI_NATIVE_API_URL: 'http://host.docker.internal:3000',
			AI_NATIVE_WORKSPACE_ID: session.workspaceId,
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

		// Inject agent's API key for AI Native MCP access
		if (agent.apiKey) {
			envVars.AI_NATIVE_API_KEY = agent.apiKey
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

		for (const integration of activeIntegrations) {
			try {
				const provider = getProvider(integration.provider)
				const creds = JSON.parse(decrypt(integration.credentials))
				const accessToken = await provider.getAccessToken(creds)
				envVars[`${integration.provider.toUpperCase()}_TOKEN`] = accessToken
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
			'AI_NATIVE_API_URL',
			'AI_NATIVE_WORKSPACE_ID',
			'ANTHROPIC_API_KEY',
			'OPENAI_API_KEY',
			'MAX_TURNS',
			'CODEX_APPROVAL_MODE',
			'CUSTOM_COMMAND',
			'MCP_SERVERS_JSON',
			'AGENT_MCP_JSON',
			'AI_NATIVE_API_KEY',
			'CLAUDE_OAUTH_ACCESS_TOKEN',
			'CLAUDE_OAUTH_REFRESH_TOKEN',
			'CLAUDE_OAUTH_EXPIRES_AT',
			'CLAUDE_OAUTH_SCOPES',
			'CLAUDE_OAUTH_SUBSCRIPTION_TYPE',
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
		const containerId = await this.containers.create({
			image: (sessionConfig.base_image as string) ?? 'agent-base:latest',
			name,
			env: envVars,
			memoryMb: (sessionConfig.memory_mb as number) ?? 1024,
			cpuShares: (sessionConfig.cpu_shares as number) ?? 1024,
			binds: [`${tempDir}:/agent:rw`],
		})

		await this.containers.start(containerId)
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
			}
		})()
	}

	private watchContainerExit(sessionId: string, containerId: string) {
		const poll = async () => {
			try {
				const status = await this.containers.inspect(containerId)
				if (!status.running) {
					await this.handleCompletion(sessionId, containerId, status.exitCode ?? 1)
					return
				}
			} catch (err) {
				logger.warn('Container inspect failed, stopping exit watcher', {
					sessionId,
					containerId,
					error: String(err),
				})
				return
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
					.pushAgentFiles(session.actorId, session.workspaceId, sessionId, sessionData.tempDir)
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
		await this.containers
			.remove(containerId)
			.catch((err) =>
				logger.warn('Failed to remove container', { sessionId, containerId, error: String(err) }),
			)
		await this.cleanupSession(sessionId)

		logger.info(`Session ${status}: ${sessionId}`, { exitCode })
	}

	private async runWatchdog(): Promise<void> {
		const now = new Date()

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
					.pushAgentFiles(session.actorId, session.workspaceId, session.id, sessionData.tempDir)
					.catch((err) =>
						logger.warn('Failed to push learnings on timeout', {
							sessionId: session.id,
							error: String(err),
						}),
					)
			}

			if (session.containerId) {
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

			await this.clearActiveSession(session.id)
			await this.cleanupSession(session.id)
		}

		// 2. Auto-pause idle sessions (no log output for >10 minutes)
		const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000)
		const runningSessions = await this.db
			.select()
			.from(sessions)
			.where(eq(sessions.status, 'running'))

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
