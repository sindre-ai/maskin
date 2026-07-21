import { capturePosthogEvent } from './posthog'

// Ship-metric guardrail events for the TipTap editor bet. The bet's guardrail —
// "silent-write-clobbers = 0 in the 30 days after ship" — is only measurable if
// every 409 from the object-body autosave path produces an event in PostHog.
// The `detected` event fires from the server (T2's 409 branch) so a single
// emission covers both HTTP PATCH and MCP `update_objects` (MCP passes through
// the same handler). The paired `resolved` event fires client-side from T4's
// reconcile-banner action handlers — see `apps/web/src/lib/analytics.ts`.
//
// Names + property shapes are a stable contract. The Product Analyst's
// `posthog_query` on the parent bet keys off these exact strings — do not
// rename or collapse the resolution enum without coordinating there.

export const EDITOR_WRITE_CONFLICT_DETECTED = 'editor_write_conflict_detected'

export type EditorWriteConflictSource = 'patch' | 'mcp'

export interface EditorWriteConflictDetectedProps {
	objectId: string
	workspaceId: string
	actorId: string
	source: EditorWriteConflictSource
}

// Best-effort PostHog capture for a 409 detected at the object PATCH handler.
// Never throws; analytics failure must not break the write path. `distinctId`
// keys on `actorId` so PostHog's person-level joins line up with the rest of
// the taxonomy — workspace_id / actor_id also travel as properties so the
// query can slice either way.
export async function capturePosthogEditorWriteConflictDetected(
	props: EditorWriteConflictDetectedProps,
): Promise<void> {
	await capturePosthogEvent(EDITOR_WRITE_CONFLICT_DETECTED, props.actorId, {
		object_id: props.objectId,
		workspace_id: props.workspaceId,
		actor_id: props.actorId,
		source: props.source,
	})
}
