import { EventEmitter } from 'node:events'
import type { Database } from '@maskin/db'
import { sessions } from '@maskin/db/schema'
import { eq, inArray } from 'drizzle-orm'
import { logger } from '../lib/logger'

export interface CreateSessionParams {
	actorId: string
	actionPrompt: string
	config?: Record<string, unknown>
	triggerId?: string
	createdBy: string
	autoStart?: boolean
}

export interface SessionLogEvent {
	sessionId: string
	logId: number
	stream: 'stdout' | 'stderr' | 'system'
	data: string
}

/**
 * Thin-client SessionManager that delegates execution to agent-server via HTTP.
 * Reads session state from the shared database. Proxies live log events from
 * agent-server's SSE stream and re-emits them on this EventEmitter.
 */
export class SessionManager extends EventEmitter {
	private abortControllers = new Map<string, AbortController>()
	private agentServerUrl: string

	constructor(
		private db: Database,
		agentServerUrl: string,
		private agentServerSecret: string,
	) {
		super()
		this.agentServerUrl = agentServerUrl.replace(/\/$/, '')
	}

	async start() {
		const activeSessions = await this.db
			.select({ id: sessions.id })
			.from(sessions)
			.where(inArray(sessions.status, ['running', 'starting']))

		for (const session of activeSessions) {
			this.subscribeToLogs(session.id)
		}

		logger.info('Session manager (thin client) started', {
			agentServerUrl: this.agentServerUrl,
			reconnected: activeSessions.length,
		})
	}

	async stop() {
		for (const [, controller] of this.abortControllers) {
			controller.abort()
		}
		this.abortControllers.clear()
	}

	async createSession(
		workspaceId: string,
		params: CreateSessionParams,
	): Promise<typeof sessions.$inferSelect> {
		const res = await this.request('POST', '/sessions', {
			workspace_id: workspaceId,
			actor_id: params.actorId,
			action_prompt: params.actionPrompt,
			config: params.config,
			trigger_id: params.triggerId,
			created_by: params.createdBy,
			auto_start: params.autoStart,
		})

		if (!res.ok) {
			const body = await res.json().catch(() => ({ error: res.statusText }))
			throw new Error(body.error || `Agent server returned ${res.status}`)
		}

		const data = await res.json()

		// Read back from shared DB for consistent types
		const [session] = await this.db
			.select()
			.from(sessions)
			.where(eq(sessions.id, data.id))
			.limit(1)

		if (!session) {
			throw new Error('Session created on agent-server but not found in database')
		}

		if (params.autoStart !== false) {
			this.subscribeToLogs(session.id)
		}

		return session
	}

	async stopSession(sessionId: string): Promise<void> {
		const res = await this.request('POST', `/sessions/${sessionId}/stop`)
		if (!res.ok) {
			const body = await res.json().catch(() => ({ error: res.statusText }))
			throw new Error(body.error || `Failed to stop session: ${res.status}`)
		}
		this.unsubscribeFromLogs(sessionId)
	}

	async pauseSession(sessionId: string): Promise<void> {
		const res = await this.request('POST', `/sessions/${sessionId}/pause`)
		if (!res.ok) {
			const body = await res.json().catch(() => ({ error: res.statusText }))
			throw new Error(body.error || `Failed to pause session: ${res.status}`)
		}
		this.unsubscribeFromLogs(sessionId)
	}

	async resumeSession(sessionId: string): Promise<void> {
		const res = await this.request('POST', `/sessions/${sessionId}/resume`)
		if (!res.ok) {
			const body = await res.json().catch(() => ({ error: res.statusText }))
			throw new Error(body.error || `Failed to resume session: ${res.status}`)
		}
		this.subscribeToLogs(sessionId)
	}

	private async request(method: string, path: string, body?: unknown): Promise<Response> {
		return fetch(`${this.agentServerUrl}${path}`, {
			method,
			headers: {
				'Content-Type': 'application/json',
				'X-Agent-Server-Secret': this.agentServerSecret,
			},
			body: body ? JSON.stringify(body) : undefined,
		})
	}

	private subscribeToLogs(sessionId: string) {
		if (this.abortControllers.has(sessionId)) return

		const controller = new AbortController()
		this.abortControllers.set(sessionId, controller)

		const url = `${this.agentServerUrl}/sessions/${sessionId}/logs/stream`

		fetch(url, {
			headers: { 'X-Agent-Server-Secret': this.agentServerSecret },
			signal: controller.signal,
		})
			.then(async (res) => {
				if (!res.ok || !res.body) {
					this.abortControllers.delete(sessionId)
					return
				}

				const reader = res.body.getReader()
				const decoder = new TextDecoder()
				let buffer = ''
				let currentEvent = ''
				let currentId = ''
				let currentData = ''

				while (true) {
					const { done, value } = await reader.read()
					if (done) break

					buffer += decoder.decode(value, { stream: true })
					const lines = buffer.split('\n')
					buffer = lines.pop() ?? ''

					for (const line of lines) {
						if (line.startsWith('event:')) {
							currentEvent = line.slice(6).trim()
						} else if (line.startsWith('id:')) {
							currentId = line.slice(3).trim()
						} else if (line.startsWith('data:')) {
							currentData = line.slice(5).trim()
						} else if (line === '') {
							if (currentEvent === 'done') {
								this.abortControllers.delete(sessionId)
								return
							}
							if (currentEvent) {
								this.emit('log', {
									sessionId,
									logId: Number(currentId) || 0,
									stream: currentEvent,
									data: currentData,
								} satisfies SessionLogEvent)
							}
							currentEvent = ''
							currentId = ''
							currentData = ''
						}
					}
				}

				this.abortControllers.delete(sessionId)
			})
			.catch((err) => {
				if (controller.signal.aborted) return
				logger.warn('Failed to subscribe to agent-server log stream', {
					sessionId,
					error: String(err),
				})
				this.abortControllers.delete(sessionId)
			})
	}

	private unsubscribeFromLogs(sessionId: string) {
		const controller = this.abortControllers.get(sessionId)
		if (controller) {
			controller.abort()
			this.abortControllers.delete(sessionId)
		}
	}
}
