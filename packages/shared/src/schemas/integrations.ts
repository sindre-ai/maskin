import { z } from 'zod'

export const eventDefinitionSchema = z.object({
	entityType: z.string(),
	actions: z.array(z.string()),
	label: z.string(),
})

export const providerInfoSchema = z.object({
	name: z.string(),
	displayName: z.string(),
	events: z.array(eventDefinitionSchema),
})

export const providerParamsSchema = z.object({
	provider: z.string().min(1),
})

export const integrationParamsSchema = z.object({
	id: z.string().uuid(),
})

/**
 * Gmail Pub/Sub push envelope. Google publishes a base64-encoded JSON blob in
 * `message.data` whose decoded shape is `{ emailAddress, historyId }`.
 */
export const gmailPubsubEnvelopeSchema = z.object({
	subscription: z.string(),
	message: z.object({
		data: z.string(),
		messageId: z.string().optional(),
		publishTime: z.string().optional(),
	}),
})

export const gmailPubsubMessageDataSchema = z.object({
	emailAddress: z.string().email(),
	historyId: z.union([z.string(), z.number()]).transform((v) => String(v)),
})

/** Converts a GitHub org/user login to the env var suffix used for its token (e.g. "sindre-ai" → "SINDRE_AI"). */
export function githubOwnerLoginToEnvKey(ownerLogin: string): string {
	return ownerLogin.toUpperCase().replace(/[^A-Z0-9]/g, '_')
}

/** Mirrors Skjald's `DiarizedSegment` (webhooks/events.rs). */
export const skjaldDiarizedSegmentSchema = z.object({
	transcript_id: z.string(),
	speaker_id: z.string(),
	speaker_name: z.string(),
	audio_start_time: z.number().nullable().optional(),
	audio_end_time: z.number().nullable().optional(),
})

/** Mirrors Skjald's `TranscriptionCompletedPayload` (webhooks/events.rs). */
export const skjaldTranscriptionCompletedPayloadSchema = z.object({
	meeting_id: z.string().min(1),
	meeting_title: z.string().min(1),
	segment_count: z.number(),
	folder_path: z.string().nullable().optional(),
	created_at: z.string(),
	// Only present when the webhook's payload mode is "Full content".
	transcript_text: z.string().nullable().optional(),
	diarization_status: z.string(),
	// Only present when `diarization_status` is `"completed"`.
	speaker_segments: z.array(skjaldDiarizedSegmentSchema).nullable().optional(),
})

export type SkjaldDiarizedSegment = z.infer<typeof skjaldDiarizedSegmentSchema>
export type SkjaldTranscriptionCompletedPayload = z.infer<typeof skjaldTranscriptionCompletedPayloadSchema>
