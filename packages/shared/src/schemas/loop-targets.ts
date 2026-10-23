import { z } from 'zod'

/**
 * `LoopTarget.source` — how a `TargetCard` knows where its `actual` number
 * comes from. Union of three shapes so untyped strings can't drift in and mint
 * a fourth kind by accident (bet SPEC Q1, Architect confirmation 2026-09-03):
 *
 * - **plain string** — a human label the operator wrote before the number is
 *   wired to anything (e.g. "posts published this month"). The card renders
 *   the string; nothing on the server tries to resolve it.
 * - **`metric:<namespace>.<key>`** — a reference into the workspace's metric
 *   registry, resolved on read by whoever populates `actual` server-side.
 * - **`event:<slug>`** — a reference to a named event stream, same treatment.
 *
 * Order matters — Zod's union is first-match, and the two prefixed shapes are
 * strictly narrower than the plain string, so if `plain string` came first
 * every `metric:` value would silently classify as plain. `metric:` and
 * `event:` are placed before the fallback for that reason.
 */
export const loopTargetSourceSchema = z.union([
	z.string().regex(/^metric:[a-z0-9_]+(\.[a-z0-9_]+)+$/i, {
		message: 'metric: source must look like `metric:<namespace>.<key>`',
	}),
	z.string().regex(/^event:[a-z0-9_-]+$/i, {
		message: 'event: source must look like `event:<slug>`',
	}),
	z.string().min(1).max(200),
])
export type LoopTargetSource = z.infer<typeof loopTargetSourceSchema>

/**
 * A single row inside `metadata.targets` on a loop (bet SPEC D5). Zod-locked
 * so an ad-hoc metadata write from an MCP tool or a legacy client can't
 * poison the render layer with a missing / wrong-type field. `pace` is
 * intentionally not on the shape — it is derived on read from
 * `actual` / `target` (+ optional `pace_policy`), never persisted; persisting
 * it would desync on the next write.
 *
 * `pace_policy` is optional and only meaningful when a caller wants to pin the
 * verdict rule ("strict" — behind unless `actual >= target`; "window" — allow
 * a rolling tolerance). Absent means the default "behind unless caught up"
 * verdict.
 */
export const loopTargetSchema = z.object({
	label: z.string().min(1).max(120),
	source: loopTargetSourceSchema,
	actual: z.number(),
	target: z.number(),
	ownerActorId: z.string().uuid().optional(),
	pace_policy: z.enum(['strict', 'window']).optional(),
})
export type LoopTarget = z.infer<typeof loopTargetSchema>
