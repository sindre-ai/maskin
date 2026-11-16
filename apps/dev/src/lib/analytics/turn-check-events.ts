import { logger } from '../logger'
import type { WorkLeftKind } from '../work-left'
import { capturePosthogEvent } from './posthog'

export interface TurnCheckProps {
	workspaceId: string
	/** The agent whose turn was checked; the distinct id. */
	agentId: string
	/** Only chat turns are checked today; unattended runs are handled by the task restart. */
	surface: 'chat' | 'unattended'
	/** `phrase_check` now; `state_check` once the next step is read from state. */
	stage: 'phrase_check' | 'state_check'
	/** 1 or 2 for a send-back; the number of send-backs already spent for a cap hit. */
	sendBackNumber: number
	/** Which ending was found. A category, never the text. */
	reason: WorkLeftKind
}

async function emit(event: string, p: TurnCheckProps): Promise<void> {
	try {
		await capturePosthogEvent(event, p.agentId, {
			workspace_id: p.workspaceId,
			agent_id: p.agentId,
			surface: p.surface,
			stage: p.stage,
			send_back_number: p.sendBackNumber,
			reason: p.reason,
		})
	} catch (err) {
		logger.warn(`Failed to emit ${event}`, { agentId: p.agentId, error: String(err) })
	}
}

/**
 * One event per turn the end-of-turn check sends back. Counts, categories and ids only: never the
 * final message, the correction text or any title. Not sampled, since the counts are the measure.
 * Best-effort: never throws, so callers fire it without awaiting.
 */
export const trackTurnSentBack = (p: TurnCheckProps): Promise<void> => emit('turn_sent_back', p)

/** One event per turn that reached the send-back cap and was let through. Same properties. */
export const trackTurnCheckCapHit = (p: TurnCheckProps): Promise<void> =>
	emit('turn_check_cap_hit', p)
