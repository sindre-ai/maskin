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

export interface PgThreadEvent {
	id: string
	thread_id: string
	actor_id: string
	kind: string
	created_at: string
}

export interface PgThreadTyping {
	thread_id: string
	actor_id: string
	status: string
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

		await this.sql.listen('thread_event', (payload) => {
			try {
				const event = JSON.parse(payload) as PgThreadEvent
				this.emit('thread_event', event)
			} catch {
				// ignore malformed payloads
			}
		})
	}

	async stop() {
		await this.sql.end()
	}
}
