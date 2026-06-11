/**
 * Shared types for the MCP card action layer.
 *
 * Companion to `packages/mcp/ACTIONS.md`. The widget catalog
 * (`apps/web/src/mcp-apps/shared/widgets/`) consumes these so any card can
 * wire mutations through a single confirmation/optimistic/audit-aware
 * surface instead of re-implementing the plumbing per widget.
 */

import type { ObjectResponse } from '../types'

/**
 * Identifier for a v1 mutation surface. Mapped to a confirmation policy in
 * `policy.ts`. Add a new key whenever a new in-card mutation lands — the
 * dispatcher will refuse to render an `<ActionButton>` for an unknown kind.
 */
export type MutationKind =
	| 'object_status'
	| 'object_driver'
	| 'object_relationship_add'
	| 'object_delete'

/**
 * Per-mutation policy. Drives `<ActionButton>` and `<ConfirmDialog>` so the
 * confirmation behaviour can't drift between widgets.
 */
export interface MutationPolicy {
	kind: MutationKind
	/** Whether the action requires a confirmation dialog before firing. */
	confirm: boolean
	/** Short label rendered on the button itself (e.g. "Delete"). */
	label: string
	/** Title shown inside the confirmation dialog. */
	confirmTitle?: string
	/** Body shown inside the confirmation dialog (one short sentence). */
	confirmDescription?: string
	/** Visual variant — destructive draws the red-styled button + confirm. */
	variant: 'default' | 'destructive'
	/** Whether the affordance triggers a state change that the card should
	 * render optimistically (status / owner) vs a side-effect that should not
	 * be shown until the server confirms (delete). */
	optimistic: boolean
}

/** Result of a finished mutation, surfaced to the caller for inline UI. */
export interface MutationOutcome {
	success: boolean
	error?: string
}

/**
 * Snapshot of an in-flight mutation, returned by `useObjectMutation`. Cards
 * read `optimisticValue` for instant feedback; the value clears once the
 * server confirms (success → cleared via `onSuccess` reconcile, error →
 * cleared on next render with `error` populated).
 */
export interface ObjectMutationState<T> {
	/** Pending value while the server hasn't confirmed yet. `null` when idle. */
	optimisticValue: T | null
	/** True between dispatch and the next ontoolresult. */
	isPending: boolean
	/** Error text, set when the call rejected or the server returned an error. */
	error: string | null
}

/**
 * Hook return shape — kept narrow on purpose so widgets only pluck what they
 * need (no leaking call-tool internals).
 */
export interface ObjectMutation<T> extends ObjectMutationState<T> {
	run: (next: T) => Promise<MutationOutcome>
	reset: () => void
}

export type { ObjectResponse }
