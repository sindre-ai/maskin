import { capturePosthogEvent } from './posthog'

// Server-side PostHog events for the Skjald webhook receiver. They make "does
// Skjald connect on the first try" measurable: every delivery the receiver
// turns away is a `skjald_webhook_rejected` with a reason, every delivery that
// becomes or updates a meeting is a `skjald_meeting_ingested`.
//
// Properties are deliberately identifiers and enums only. No transcript text,
// meeting titles, speaker names, signing secret or webhook token ever goes in.
export const SKJALD_WEBHOOK_REJECTED = 'skjald_webhook_rejected'
export const SKJALD_MEETING_INGESTED = 'skjald_meeting_ingested'

export type SkjaldRejectReason =
	| 'unknown_token'
	| 'invalid_signature'
	| 'invalid_json'
	| 'invalid_payload'

// An unknown token has no workspace to attribute to, and PostHog drops events
// with an empty distinct id, so rejections without a workspace share this id.
const UNATTRIBUTED_DISTINCT_ID = 'skjald-webhook-unattributed'

const KNOWN_EVENT_TYPES = new Set(['transcription.completed', 'outcome.created', 'outcome.updated'])

// The x-skjald-event header is attacker-controlled on a rejected delivery, so
// only a known type is passed on; anything else is bucketed.
function eventTypeProp(eventType: string | undefined): string | null {
	if (!eventType) return null
	return KNOWN_EVENT_TYPES.has(eventType) ? eventType : 'other'
}

interface SkjaldRejectedProps {
	reason: SkjaldRejectReason
	eventType?: string
	// Absent when the token matched no integration.
	workspaceId?: string
	integrationId?: string
}

export async function trackSkjaldWebhookRejected(p: SkjaldRejectedProps): Promise<void> {
	await capturePosthogEvent(SKJALD_WEBHOOK_REJECTED, p.workspaceId ?? UNATTRIBUTED_DISTINCT_ID, {
		reason: p.reason,
		event_type: eventTypeProp(p.eventType),
		workspace_id: p.workspaceId ?? null,
		integration_id: p.integrationId ?? null,
	})
}

interface SkjaldIngestedProps {
	workspaceId: string
	integrationId: string
	eventType: string
	action: 'created' | 'updated'
}

export async function trackSkjaldMeetingIngested(p: SkjaldIngestedProps): Promise<void> {
	await capturePosthogEvent(SKJALD_MEETING_INGESTED, p.workspaceId, {
		workspace_id: p.workspaceId,
		integration_id: p.integrationId,
		event_type: eventTypeProp(p.eventType),
		action: p.action,
	})
}
