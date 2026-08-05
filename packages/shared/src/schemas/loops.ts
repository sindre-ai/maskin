import { z } from 'zod'

/**
 * Response schema for `GET /api/loops` — the list-view read shape T3 renders
 * for the `/loops` page. One row per Loop object with a small set of derived
 * fields computed on read (not materialised); T1's architecture decision on
 * bet/loops-first-class names each derivation and its source.
 *
 * `pill` composes the object's stored lifecycle status with a per-viewer
 * `waiting_on_viewer` flag so the frontend can render "Running" vs
 * "Waiting on you" from a single field without re-implementing the composite
 * signal client-side. Fields intentionally match the design spec attached to
 * the parent bet — status pill, per-loop stats, agent-avatar chips.
 */
export const loopPillSchema = z.enum(['running', 'waiting_on_you', 'paused', 'archived'])
export type LoopPill = z.infer<typeof loopPillSchema>

export const loopSummarySchema = z.object({
	id: z.string().uuid(),
	workspaceId: z.string().uuid(),
	/** Free-text loop name — mirrors `objects.title`. Nullable for parity with
	 * the underlying objects table (untitled loops are legal). */
	name: z.string().nullable(),
	/** Full loop guarantee / description — mirrors `objects.content`. */
	guarantee: z.string().nullable(),
	/** Raw lifecycle status enum stored on `objects.status`. */
	status: z.enum(['running', 'waiting', 'paused', 'archived']),
	/** Composite badge signal: `status` combined with `waiting_on_viewer` so
	 * the frontend renders one badge without branching on both fields. */
	pill: loopPillSchema,
	/** Plain-language entry condition — metadata field, may be omitted. */
	entryCondition: z.string().nullable(),
	/** Plain-language close condition — metadata field, may be omitted. */
	closeCondition: z.string().nullable(),
	/** Number of human decision points named on the loop — metadata field. */
	humanDecisionPoints: z.number().int().nonnegative().nullable(),
	/** Objects (bets/tasks/insights) currently being processed by this loop —
	 * COUNT of objects with `metadata.loop_id = this.id` in a non-terminal
	 * status for their type. Empty loops return 0, never null. */
	inProgressCount: z.number().int().nonnegative(),
	/** Same query as `inProgressCount` but filtered to terminal statuses. */
	closedCount: z.number().int().nonnegative(),
	/** Median (updated_at − created_at) across closed items, in milliseconds.
	 * Null when there are no closed items yet. */
	medianTimeToCloseMs: z.number().int().nonnegative().nullable(),
	/** Distinct agent-actor ids reachable through triggers referenced in
	 * `metadata.trigger_ids` — used by T3 for the avatar chip strip. Never
	 * null; empty array when no triggers are linked. */
	agentIds: z.array(z.string().uuid()),
	/** Per-viewer signal: does the viewer have unread activity on any object
	 * currently linked to this loop? Reused from the same expression the
	 * unread-feed uses in `subscriptions.ts`. */
	waitingOnViewer: z.boolean(),
	createdAt: z.string().nullable(),
	updatedAt: z.string().nullable(),
})

export type LoopSummary = z.infer<typeof loopSummarySchema>

export const listLoopsResponseSchema = z.object({
	loops: z.array(loopSummarySchema),
})

export type ListLoopsResponse = z.infer<typeof listLoopsResponseSchema>
