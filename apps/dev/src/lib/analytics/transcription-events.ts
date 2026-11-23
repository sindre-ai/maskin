import { capturePosthogEvent } from './posthog'

/**
 * Where a transcription came from: the chat's dictation button, or the
 * `transcribe_file` MCP tool.
 */
export type TranscriptionSource = 'chat_dictation' | 'mcp_file'

export interface TranscriptionCompletedProps {
	workspaceId: string
	actorId: string
	source: TranscriptionSource
	model: string
	/** What OpenRouter charged for the request; 0 when it did not report a cost. */
	costUsd: number
	/** Seconds of audio transcribed; 0 when the provider did not report it. */
	audioSeconds: number
	/** The transcribed file, for the MCP tool. Absent for chat dictation. */
	fileId?: string
}

/**
 * One `transcription_completed` per successful transcription, so PostHog can
 * split speech spend per workspace. Speech is priced per audio second rather
 * than per token, so the event carries USD and seconds, not token counts.
 *
 * Best-effort: `capturePosthogEvent` never throws and never blocks the caller.
 */
export async function trackTranscriptionCompleted(p: TranscriptionCompletedProps): Promise<void> {
	await capturePosthogEvent('transcription_completed', p.workspaceId, {
		workspace_id: p.workspaceId,
		actor_id: p.actorId,
		source: p.source,
		model: p.model,
		cost_usd: p.costUsd,
		audio_seconds: p.audioSeconds,
		file_id: p.fileId ?? null,
	})
}
