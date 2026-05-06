import type { ObjectResponse } from './api'

/**
 * Fractional ordering for tasks within a single board column.
 *
 * Tasks store their position via `metadata.order` (a number). Reordering
 * computes a midpoint between the two adjacent anchors so a single update
 * suffices — no batch renumber on every drop, and concurrent reorders by
 * different clients do not stomp on each other unless they pick the *same*
 * pair of anchors at the same instant.
 *
 * The pattern mirrors `bet-order.ts` from the Bridge bet (PR #322): one
 * shared module so both bet-level and task-level reorders use the same math
 * and the same rebalance threshold.
 */

export const TASK_ORDER_INITIAL = 1024
export const TASK_ORDER_GAP = 1024

/**
 * Smallest gap before a midpoint round-trip risks losing precision. With
 * IEEE-754 doubles, a gap below this threshold is the signal that the column
 * needs a rebalance pass — not handled in v1, but the threshold is named so
 * a future task can hook into it.
 */
export const TASK_ORDER_MIN_GAP = 1e-9

export interface TaskOrderInput {
	id: string
	metadata?: ObjectResponse['metadata']
	createdAt?: ObjectResponse['createdAt']
}

/**
 * Read `metadata.order` off a task. Returns `null` when absent or invalid
 * (NaN, infinite). Treats finite numbers — including 0 and negatives — as
 * valid order keys.
 */
export function getTaskOrder(task: TaskOrderInput | null | undefined): number | null {
	if (!task || !task.metadata) return null
	const raw = (task.metadata as Record<string, unknown>).order
	if (typeof raw !== 'number') return null
	if (!Number.isFinite(raw)) return null
	return raw
}

/**
 * Sort tasks by `metadata.order` ascending. Ties — and tasks without an
 * order key — fall back to `createdAt` ascending, then `id` ascending. Tasks
 * without an order land *after* tasks that have one, so freshly-created
 * tasks gather at the bottom of their column until the user reorders them.
 */
export function sortTasksByOrder<T extends TaskOrderInput>(tasks: readonly T[]): T[] {
	const copy = tasks.slice()
	copy.sort((a, b) => {
		const ao = getTaskOrder(a)
		const bo = getTaskOrder(b)
		if (ao !== null && bo !== null) {
			if (ao !== bo) return ao - bo
		} else if (ao !== null) {
			return -1
		} else if (bo !== null) {
			return 1
		}
		const at = a.createdAt ?? ''
		const bt = b.createdAt ?? ''
		if (at !== bt) return at < bt ? -1 : 1
		if (a.id !== b.id) return a.id < b.id ? -1 : 1
		return 0
	})
	return copy
}

/**
 * Compute a new order key that lands strictly between `prev` and `next`.
 * - `prev = null, next = null`: empty list → return the seed value.
 * - `prev = null`: insert at the head → one gap below `next`.
 * - `next = null`: insert at the tail → one gap above `prev`.
 * - Otherwise: the midpoint.
 *
 * Throws when the gap collapses below {@link TASK_ORDER_MIN_GAP}; the
 * caller's column needs a rebalance pass before the next reorder lands.
 */
export function orderBetween(prev: number | null, next: number | null): number {
	if (prev !== null && !Number.isFinite(prev)) {
		throw new Error(`orderBetween: prev must be finite, got ${prev}`)
	}
	if (next !== null && !Number.isFinite(next)) {
		throw new Error(`orderBetween: next must be finite, got ${next}`)
	}
	if (prev === null && next === null) return TASK_ORDER_INITIAL
	if (prev === null && next !== null) return next - TASK_ORDER_GAP
	if (prev !== null && next === null) return prev + TASK_ORDER_GAP
	// Both defined.
	const lo = prev as number
	const hi = next as number
	if (lo >= hi) {
		throw new Error(`orderBetween: prev (${lo}) must be < next (${hi})`)
	}
	if (hi - lo < TASK_ORDER_MIN_GAP) {
		throw new Error(
			`orderBetween: gap collapsed (${hi - lo}); column needs a rebalance before reordering further`,
		)
	}
	return lo + (hi - lo) / 2
}

/**
 * Given a column already sorted by `metadata.order`, compute the order key
 * to assign to `movingTaskId` so it lands at visible position `targetIndex`
 * (0 inserts at the head, `column.length` inserts at the tail).
 *
 * The moving task is excluded from the anchor pair before computing — this
 * keeps the reorder idempotent and correctly handles the "drop a card on
 * itself" no-op (caller can detect the no-op by comparing returned order to
 * the existing one, or simply skip the mutation).
 */
export function computeReorderOrder<T extends TaskOrderInput>(
	sortedColumn: readonly T[],
	movingTaskId: string,
	targetIndex: number,
): number {
	const without = sortedColumn.filter((t) => t.id !== movingTaskId)
	const clamped = Math.max(0, Math.min(targetIndex, without.length))
	const prev = clamped === 0 ? null : getTaskOrder(without[clamped - 1])
	const next = clamped >= without.length ? null : getTaskOrder(without[clamped])
	return orderBetween(prev, next)
}
