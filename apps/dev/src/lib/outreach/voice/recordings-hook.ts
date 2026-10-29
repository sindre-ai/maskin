import type { StorageProvider } from '@maskin/storage'
import { recordEvent } from '../../events/record-event'
import { createTelnyxClient } from '../../integrations/providers/telnyx/client'
import { readTelnyxRuntimeConfig } from '../../integrations/providers/telnyx/config'
import { logger } from '../../logger'
import type { PostCallContext, PostCallHook } from './post-call'
import { MIRROR_STATUSES, contactActorId, mirrorCallArtifacts } from './recordings'

let storage: StorageProvider | null = null

/** Called once from index.ts with the app's S3 provider. Unset (tests), the hook logs and does nothing. */
export function configureVoiceArtifactStorage(provider: StorageProvider | null): void {
	storage = provider
}

function findRecordingViaTelnyx(callId: string) {
	const { apiKey, apiBaseUrl } = readTelnyxRuntimeConfig()
	if (!apiKey) throw new Error('TELNYX_API_KEY is not configured')
	return createTelnyxClient({ apiKey, baseUrl: apiBaseUrl }).findRecording(callId)
}

function endedAtOf(ctx: PostCallContext): Date {
	const parsed = ctx.endedAt ? new Date(ctx.endedAt) : null
	return parsed && !Number.isNaN(parsed.getTime()) ? parsed : new Date()
}

async function mirrorInBackground(ctx: PostCallContext, provider: StorageProvider): Promise<void> {
	const startedAt = Date.now()
	const result = await mirrorCallArtifacts(
		{ workspaceId: ctx.workspaceId, contactId: ctx.contactId },
		{
			callId: ctx.callId,
			endedAt: endedAtOf(ctx),
			recordingUrl: ctx.recordingUrl,
			transcriptUrl: ctx.transcriptUrl,
		},
		{ db: ctx.db, storage: provider, findRecording: findRecordingViaTelnyx },
	)
	// Telnyx recording timing is unverified: attempts and elapsed time are the observation to read back.
	logger.info('voice mirror finished', {
		callId: ctx.callId,
		contactId: ctx.contactId,
		outcome: result.outcome,
		attempts: 'attempts' in result ? result.attempts : 0,
		elapsedMs: Date.now() - startedAt,
	})
	if (result.outcome !== 'failed') return

	const actorId = await contactActorId(ctx.db, ctx.contactId)
	if (!actorId) return
	await recordEvent(ctx.db, {
		workspaceId: ctx.workspaceId,
		actorId,
		action: 'voice_mirror_failed',
		entityType: 'object',
		entityId: ctx.contactId,
		data: { call_id: ctx.callId, attempts: result.attempts, reason: result.reason },
	})
}

/**
 * Post-call hook 2 (see post-call.ts): mirror the recording and transcript to S3.
 * Starts the mirror and returns at once, so the webhook 200 never waits on Telnyx
 * or S3. A restart mid-retry drops that call's mirror; Telnyx still hosts the file.
 */
export const voiceMirrorHook: PostCallHook = {
	name: 'voice-mirror',
	run(ctx) {
		if (!MIRROR_STATUSES.has(ctx.status)) return
		if (!storage) {
			logger.warn('voice mirror skipped: no storage configured', { callId: ctx.callId })
			return
		}
		void mirrorInBackground(ctx, storage).catch((err) =>
			logger.error('voice mirror crashed', {
				callId: ctx.callId,
				contactId: ctx.contactId,
				error: err instanceof Error ? err.message : String(err),
			}),
		)
	},
}
