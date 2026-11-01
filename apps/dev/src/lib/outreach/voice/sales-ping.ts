import { recordEvent } from '../../events/record-event'
import { logger } from '../../logger'
import type { VoiceDb } from './apply'

export interface SalesPing {
	workspaceId: string
	contactId: string
	actorId: string
	/** 3 = a fallback happened, 4 = a warm lead, 5 = a compliance failure. */
	attention: 3 | 4 | 5
	reason: string
	data?: Record<string, unknown>
}

/**
 * A ping to #sales, recorded as an audit event on the contact carrying attention and channel, the
 * same shape recordDeadLetter uses (effects.ts). Delivery to Slack itself is not wired: no in-app
 * Slack poster exists on this branch, so whatever reads these events does the posting.
 */
export async function pingSales(db: VoiceDb, ping: SalesPing): Promise<void> {
	logger.warn('voice sales ping', {
		contactId: ping.contactId,
		attention: ping.attention,
		reason: ping.reason,
	})
	await recordEvent(db, {
		workspaceId: ping.workspaceId,
		actorId: ping.actorId,
		action: 'voice_sales_ping',
		entityType: 'object',
		entityId: ping.contactId,
		data: { attention: ping.attention, channel: '#sales', reason: ping.reason, ...ping.data },
	})
}
