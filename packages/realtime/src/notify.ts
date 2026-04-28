import { EventEmitter } from 'node:events'
import postgres from 'postgres'

export interface PgEvent {
	workspace_id: string
	actor_id: string
	action: string
	entity_type: string
	entity_id: string
	event_id: string
	/** @deprecated No longer included in NOTIFY payload — fetch from events table if needed */
	data?: Record<string, unknown> | null
}

export interface PgSessionLogEvent {
	id: number
	session_id: string
	stream: 'stdout' | 'stderr' | 'system'
	content: string
}

export class PgNotifyBridge extends EventEmitter {
	private sql: postgres.Sql

	constructor(databaseUrl: string) {
		super()
		this.sql = postgres(databaseUrl, {
			max: 1,
		})
	}

	async start() {
		await this.sql.listen('events', (payload) => {
			try {
				const event = JSON.parse(payload) as PgEvent
				this.emit('event', event)
			} catch {
				// ignore malformed payloads
			}
		})

		await this.sql.listen('session_logs', (payload) => {
			try {
				const log = JSON.parse(payload) as PgSessionLogEvent
				this.emit('session_log', log)
			} catch {
				// ignore malformed payloads
			}
		})
	}

	async stop() {
		await this.sql.end()
	}
}
