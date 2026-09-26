import { logger } from '../logger'
import { capturePosthogEvent } from './posthog'

interface SystemPromptCorruptionPreventedProps {
	cause: 'null_write' | 'empty_write' | 'shrink_to_zero'
	writePath: 'patch_actor' | 'loop_version_pusher_locked_install' | 'loop_version_pusher_dedup'
	writerActorId?: string
	actorId: string
	workspaceId: string
	previousLength: number
	attemptedLength: number
}

// PostHog emit for the guard's trip path. Behind POSTHOG_SYSTEM_PROMPT_EVENT
// (default off) — Magnus-decides toggle post-ship, not a rollout gate. Sentry
// remains the source of truth for the 7-day-silent Won criterion.
export async function trackSystemPromptCorruptionPrevented(
	p: SystemPromptCorruptionPreventedProps,
): Promise<void> {
	if (process.env.POSTHOG_SYSTEM_PROMPT_EVENT !== 'true') return
	try {
		await capturePosthogEvent('system_prompt_corruption_prevented', p.actorId, {
			cause: p.cause,
			write_path: p.writePath,
			writer_actor_id: p.writerActorId,
			actor_id: p.actorId,
			workspace_id: p.workspaceId,
			previous_length: p.previousLength,
			attempted_length: p.attemptedLength,
		})
	} catch (err) {
		logger.warn('Failed to emit system_prompt_corruption_prevented', {
			actorId: p.actorId,
			error: String(err),
		})
	}
}
