import type { Database } from '@maskin/db'
import { events } from '@maskin/db/schema'
import type { PgEvent, PgNotifyBridge } from '@maskin/realtime'
import { eq } from 'drizzle-orm'
import { logger } from '../lib/logger'
import { applyOptOutReply } from '../lib/outreach/voice/optout-reply'

/**
 * Reads the inbound resend.email received event and hands mail addressed to the
 * voice opt-out address to applyOptOutReply. Independent of any trigger, so it
 * keeps working while the Rune inbox sweep stays disabled. Same shape as
 * CommentDispatcher: one PgNotifyBridge listener registered on start().
 */
export class VoiceOptOutListener {
	private handler: ((event: PgEvent) => void) | null = null

	constructor(
		private db: Database,
		private bridge: PgNotifyBridge,
	) {}

	start(): void {
		if (this.handler) return
		this.handler = (event: PgEvent) => {
			if (event.entity_type !== 'resend.email' || event.action !== 'received') return
			this.handleEvent(event).catch((err) =>
				logger.error('voice.optout.failed', {
					eventId: event.event_id,
					error: err instanceof Error ? err.message : String(err),
				}),
			)
		}
		this.bridge.on('event', this.handler)
		logger.info('Voice opt-out listener started')
	}

	stop(): void {
		if (this.handler) {
			this.bridge.off('event', this.handler)
			this.handler = null
		}
	}

	async handleEvent(event: PgEvent): Promise<void> {
		const eventId = Number(event.event_id)
		if (!Number.isFinite(eventId)) return

		const [row] = await this.db
			.select({ data: events.data })
			.from(events)
			.where(eq(events.id, eventId))
			.limit(1)
		if (!row) return

		const data = (row.data ?? {}) as {
			email_id?: unknown
			from?: unknown
			to?: unknown
			subject?: unknown
			text?: unknown
		}
		await applyOptOutReply(this.db, {
			workspaceId: event.workspace_id,
			emailId: typeof data.email_id === 'string' ? data.email_id : String(event.event_id),
			from: typeof data.from === 'string' ? data.from : undefined,
			to: Array.isArray(data.to) ? data.to.filter((a): a is string => typeof a === 'string') : [],
			subject: typeof data.subject === 'string' ? data.subject : undefined,
			text: typeof data.text === 'string' ? data.text : undefined,
		})
	}
}
