import type { ObjectResponse } from './api'

const ORDER_STEP = 1024

/**
 * Effective sort key for a bet within its pipeline column.
 *
 * Why: drag-to-reorder writes a numeric `metadata.order`. Bets that have
 * never been dragged fall back to a deterministic value derived from
 * `createdAt` so newer bets float to the top of a column. The two seeds
 * mix: dragged bets land between non-dragged ones using midpoint math
 * without needing a global renumber.
 */
export function getEffectiveOrder(bet: ObjectResponse): number {
	const raw = bet.metadata?.order
	if (typeof raw === 'number' && Number.isFinite(raw)) return raw

	if (bet.createdAt) {
		const parsed = Date.parse(bet.createdAt)
		if (Number.isFinite(parsed)) return parsed
	}

	return 0
}

export function sortBetsByOrder(bets: ObjectResponse[]): ObjectResponse[] {
	return [...bets].sort((a, b) => {
		const diff = getEffectiveOrder(b) - getEffectiveOrder(a)
		if (diff !== 0) return diff
		return a.id.localeCompare(b.id)
	})
}

/**
 * Compute the new `metadata.order` for a bet being moved to `targetIndex`
 * in an already-sorted column. The list passed in is the column *after*
 * removing the moved item.
 *
 * Convention: higher order = higher in the column (sort DESC).
 */
export function computeNewOrderForInsert(
	sortedColumnWithoutMoved: ObjectResponse[],
	targetIndex: number,
): number {
	const len = sortedColumnWithoutMoved.length
	const clamped = Math.max(0, Math.min(targetIndex, len))

	if (len === 0) return ORDER_STEP

	if (clamped === 0) {
		const top = getEffectiveOrder(sortedColumnWithoutMoved[0])
		return top + ORDER_STEP
	}

	if (clamped === len) {
		const bottom = getEffectiveOrder(sortedColumnWithoutMoved[len - 1])
		return bottom - ORDER_STEP
	}

	const above = getEffectiveOrder(sortedColumnWithoutMoved[clamped - 1])
	const below = getEffectiveOrder(sortedColumnWithoutMoved[clamped])
	return (above + below) / 2
}
