import { z } from 'zod'
import { LOOP_STATUSES } from './objects'

/**
 * Response schema for `GET /api/loops` — the list-view read shape T3 renders
 * for the `/loops` page. One row per Loop object with a small set of derived
 * fields computed on read (not materialised); T1's architecture decision on
 * bet/loops-first-class names each derivation and its source.
 *
 * `pill` composes the object's stored lifecycle status with a per-viewer
 * `waiting_on_viewer` flag so the frontend can render e.g. "Learning" vs
 * "Waiting on you" from a single field without re-implementing the composite
 * signal client-side. `waiting_on_you` only ever overrides the three "live"
 * statuses (`learning` | `supervised` | `fully_autonomous`) — `draft` and
 * `paused` are not "live" and always render as themselves regardless of
 * unread activity. Fields intentionally match the design spec attached to
 * the parent bet — status pill, per-loop stats, agent-avatar chips.
 */
export const loopPillSchema = z.enum([...LOOP_STATUSES, 'waiting_on_you'])

export const loopSummarySchema = z.object({
	id: z.string().uuid(),
	workspaceId: z.string().uuid(),
	/** Free-text loop name — mirrors `objects.title`. Nullable for parity with
	 * the underlying objects table (untitled loops are legal). */
	name: z.string().nullable(),
	/** Full loop description — mirrors `objects.content`. */
	content: z.string().nullable(),
	/** Raw lifecycle status enum stored on `objects.status`. */
	status: z.enum(LOOP_STATUSES),
	/** Composite badge signal: `status` combined with `waiting_on_viewer` so
	 * the frontend renders one badge without branching on both fields. */
	pill: loopPillSchema,
	/** Plain-language entry condition — metadata field, may be omitted. */
	entryCondition: z.string().nullable(),
	/** Plain-language close condition — metadata field, may be omitted. */
	closeCondition: z.string().nullable(),
	/** Objects (bets/tasks/insights) currently being processed by this loop —
	 * COUNT of objects reached via an `in_loop` relationship edge (source=loop,
	 * target=child; child objects carry no `metadata.loop_id` back-reference)
	 * that are in a non-terminal status for their type. Empty loops return 0,
	 * never null. */
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
	/** Trigger ids referenced in `metadata.trigger_ids` on the loop row —
	 * the loop's raw step membership, used by the loop detail page to read
	 * each trigger's own name/action_prompt/agent. Never null; empty array
	 * when no triggers are linked. */
	triggerIds: z.array(z.string().uuid()),
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

/**
 * Read shape for one step in a Loop's vertical-story flow (Loops v4, D6c).
 * A step is a `triggers` row that a Loop's `metadata.trigger_ids` references,
 * plus the resolved step agent (from `triggers.target_actor_id`). Mirrors the
 * `LoopStep` TypeScript type in `packages/mcp/src/setup-guidance/types.ts`
 * that the readiness-check wiring already composes, but adds the three
 * Loops v4 fields the vertical-story renderer and the escalation reconciler
 * both key off.
 *
 * The three new fields — `handsOffToActorId`, `escalatesToActorId`,
 * `escalateAfterMs` — are all optional (`.nullish()`), because the DB
 * columns are nullable and the majority of steps will never set them. When
 * every one is null, the renderer just omits the HANDS OFF and ESCALATES TO
 * rows for that step and the reconciler ignores it.
 *
 * Sits in this file rather than `objects.ts` (which the task body pointed at)
 * because every other Loop read shape lives here alongside `loopSummarySchema`;
 * putting `LoopStep` next to its sibling read shape keeps consumers importing
 * from one place. Exported through the schemas barrel.
 */
export const loopStepAgentSchema = z.object({
	id: z.string().uuid(),
	name: z.string().nullish(),
	description: z.string().nullish(),
})

export const loopStepSchema = z.object({
	triggerId: z.string().uuid(),
	triggerName: z.string().nullish(),
	/** `triggers.action_prompt` — the prompt handed to the agent when the trigger fires. */
	triggerActionPrompt: z.string().nullish(),
	/** `triggers.type` — cron / event / reminder / etc. Renderer uses this to
	 * pick the eyebrow copy on the TRIGGER · FIRES row. Optional so a legacy
	 * step without a resolved trigger row (foreign / deleted) doesn't fail
	 * validation. */
	triggerType: z.string().nullish(),
	/** Full `triggers.config` JSON — cron scope, event filter, reminder timing. */
	triggerConfig: z.unknown().optional(),
	/** Resolved step agent (from `triggers.target_actor_id`). `null` = no agent assigned. */
	agent: loopStepAgentSchema.nullable(),
	/** Resolved hand-off target actor. Populated iff `handsOffToActorId` is set
	 * and the actor still exists; null otherwise. The renderer prefers this
	 * name over re-looking-up in the actors list. Defaults to null so the D6a
	 * expand-slice call sites (which don't know about resolved actors) still
	 * parse this shape unchanged. */
	handsOffToActor: loopStepAgentSchema.nullable().default(null),
	/** Resolved escalation target actor. Populated iff `escalatesToActorId` is
	 * set and the actor still exists; null otherwise. Defaults to null for
	 * the same reason `handsOffToActor` does. */
	escalatesToActor: loopStepAgentSchema.nullable().default(null),
	/** Per-step per-viewer signal: does the step have any session in
	 * `waiting_for_input` status right now? Drives the HANDS OFF row's `{n}
	 * pending` badge in the vertical-story renderer. Defaults to false so
	 * call sites that don't compute the signal (e.g. the D6a schema tests,
	 * the T1 shared helpers before they land) still parse this shape. */
	waitingOnViewer: z.boolean().default(false),
	/** Count of sessions on this trigger currently in `waiting_for_input`
	 * status. `0` when `waitingOnViewer` is false. */
	pendingCount: z.number().int().nonnegative().default(0),
	/**
	 * Loops v4 (D6a). Target agent (or 'you') the step hands off to when it
	 * completes. Explicit, not derived from the next step's `agent.id`, so the
	 * vertical-story renderer treats HANDS OFF as a first-class row rather
	 * than inferring it from step ordering. Null when the step doesn't hand
	 * off anywhere — the renderer omits the row entirely.
	 */
	handsOffToActorId: z.string().uuid().nullish(),
	/**
	 * Loops v4 (D6a). Target agent the D6b reconciler pings via an attention-4
	 * comment when the step has been waiting on the viewer for longer than
	 * `escalateAfterMs`. Null when the step has no escalation configured — the
	 * reconciler skips the row and the renderer's ESCALATES TO row does not
	 * render.
	 */
	escalatesToActorId: z.string().uuid().nullish(),
	/**
	 * Loops v4 (D6a). Milliseconds a step may stay in `waitingOnViewer` before
	 * the reconciler escalates it. Non-negative integer; null pairs with
	 * `escalatesToActorId = null` and disables escalation for the step.
	 */
	escalateAfterMs: z.number().int().nonnegative().nullish(),
})

export type LoopStep = z.infer<typeof loopStepSchema>

/** Response for `GET /api/loops/:id/steps` — the vertical-story renderer's
 * data feed on the loop-detail page. One step per trigger id in the loop's
 * `metadata.trigger_ids`, preserved in that order (a spine, not a set).
 * Returns `{ steps: [] }` — not 404 — for a loop with no triggers or an
 * unknown id (mirrors `/api/loops` and `/api/loops/:id/activity`). */
export const listLoopStepsResponseSchema = z.object({
	steps: z.array(loopStepSchema),
})

export type ListLoopStepsResponse = z.infer<typeof listLoopStepsResponseSchema>
