import { z } from 'zod'

/**
 * Loop status enum for the multi-agent pipeline primitive registered by the
 * work extension. `archived` is silent (mirrors the bet convention in
 * `TERMINAL_BET_STATUSES` — archive doesn't fan out or notify). `waiting`
 * is an explicit lifecycle bit for loops that are paused on human input;
 * distinct from the per-viewer `waiting_on_viewer` derivation below, which
 * flips a `running` loop into the amber "Waiting on you" pill without
 * changing the stored status.
 */
export const LOOP_STATUSES = ['running', 'waiting', 'paused', 'archived'] as const
export type LoopStatus = (typeof LOOP_STATUSES)[number]

export const loopStatusSchema = z.enum(LOOP_STATUSES)

/**
 * Canonical response shape for the `/api/loops` list endpoint. The frontend
 * (T3) codes against this — do not fork a second shape in `apps/web`.
 *
 * Materialised fields (persisted on the object row):
 * - `id`, `name` (objects.title), `guarantee` (objects.content), `status`
 * - `entry_condition`, `close_condition`, `human_decision_points` — plain
 *   metadata text captured on the row; not parsed as a DSL.
 * - `trigger_ids[]` — which triggers belong to this loop. Triggers live
 *   outside the object graph, so membership travels as metadata rather
 *   than an edge.
 * - `installed_from_package_id` — set when the loop was materialised from
 *   a Marketplace package install; null for hand-created loops. Locked in
 *   the schema now so a future install flow doesn't force a migration.
 *
 * Derived fields (computed per-request, never stored):
 * - `in_progress_count`, `closed_count` — count of objects with
 *   `metadata.loop_id = <this loop>` split by terminal status.
 * - `median_time_to_close_ms` — median of `updated_at - created_at` over
 *   closed items in ms (null when there are none).
 * - `agent_ids[]` — distinct `triggers.target_actor_id` for the loop's
 *   trigger set. Empty when no triggers are attached.
 * - `waiting_on_viewer` — true when the caller has unread activity on any
 *   object linked to this loop. Composes with `status` on the frontend to
 *   render the pill: paused/archived override, running+waiting_on_viewer
 *   shows amber, waiting status also shows amber.
 */
export const loopResponseSchema = z.object({
	id: z.string().uuid(),
	name: z.string().nullable(),
	guarantee: z.string().nullable(),
	status: loopStatusSchema,
	entry_condition: z.string().nullable(),
	close_condition: z.string().nullable(),
	human_decision_points: z.number().int().nullable(),
	trigger_ids: z.array(z.string().uuid()),
	installed_from_package_id: z.string().uuid().nullable(),
	in_progress_count: z.number().int().nonnegative(),
	closed_count: z.number().int().nonnegative(),
	median_time_to_close_ms: z.number().nullable(),
	agent_ids: z.array(z.string().uuid()),
	waiting_on_viewer: z.boolean(),
	created_at: z.string().nullable(),
	updated_at: z.string().nullable(),
})

export type LoopResponse = z.infer<typeof loopResponseSchema>

export const loopsListResponseSchema = z.object({
	loops: z.array(loopResponseSchema),
})

export type LoopsListResponse = z.infer<typeof loopsListResponseSchema>
