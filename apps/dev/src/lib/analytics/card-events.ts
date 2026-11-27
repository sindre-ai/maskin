import { logger } from '../logger'
import { capturePosthogEvent } from './posthog'

/**
 * A decision card reached its deadline with no answer and its default was carried out (see
 * services/decision-default-wake.ts). The web page sends `foryou_card_action` with
 * `answered_by_default: false` when a person taps; this is the other half, `answered_by_default: true`,
 * kept as its own event so it never counts as a person acting on a card. Ids and flags only: no card
 * text, option label or name.
 *
 * Best-effort: a capture failure never blocks the wake.
 */
export async function trackCardAnsweredByDefault(p: {
	workspaceId: string
	agentId: string
	cardId: number
}): Promise<void> {
	try {
		await capturePosthogEvent('foryou_card_default_applied', p.agentId, {
			workspace_id: p.workspaceId,
			card_id: String(p.cardId),
			card_kind: 'decision',
			answered_by_default: true,
		})
	} catch (err) {
		logger.warn('Failed to emit foryou_card_default_applied', {
			cardId: p.cardId,
			error: String(err),
		})
	}
}
