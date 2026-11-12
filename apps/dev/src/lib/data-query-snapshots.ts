import { randomUUID } from 'node:crypto'
import type { DataQueryResult } from '@maskin/shared'

/**
 * The full answer to a data query, held briefly so the pages after the first are cut from the
 * same result instead of each re-running the aggregation. That makes a many-page read cost one
 * database query, and keeps the pages consistent with each other while rows change underneath.
 *
 * The first page of a query never reads this: it always runs fresh, so a view that reloads when
 * its data changes never sees a stale number. A snapshot only serves the pages that follow it.
 * In-process, so a page that lands on another instance (or after expiry) just recomputes.
 */

const SNAPSHOT_TTL_MS = 60_000
const MAX_SNAPSHOTS = 64
/** Groups held across every snapshot; the oldest go first when a new one would not fit. */
const MAX_SNAPSHOT_GROUPS = 500_000

type Snapshot = {
	workspaceId: string
	specKey: string
	result: DataQueryResult
	expiresAt: number
}

const snapshots = new Map<string, Snapshot>()
let heldGroups = 0

function drop(id: string) {
	const snap = snapshots.get(id)
	if (!snap) return
	heldGroups -= snap.result.groups.length
	snapshots.delete(id)
}

function dropExpired(now: number) {
	for (const [id, snap] of snapshots) if (snap.expiresAt <= now) drop(id)
}

/** Keeps `result` and returns the id that reaches it; null when it is too big to hold. */
export function saveSnapshot(
	workspaceId: string,
	specKey: string,
	result: DataQueryResult,
): string | null {
	if (result.groups.length > MAX_SNAPSHOT_GROUPS) return null
	dropExpired(Date.now())
	while (
		snapshots.size >= MAX_SNAPSHOTS ||
		heldGroups + result.groups.length > MAX_SNAPSHOT_GROUPS
	) {
		const oldest = snapshots.keys().next().value
		if (oldest === undefined) break
		drop(oldest)
	}
	const id = randomUUID()
	snapshots.set(id, { workspaceId, specKey, result, expiresAt: Date.now() + SNAPSHOT_TTL_MS })
	heldGroups += result.groups.length
	return id
}

/**
 * The held result, only for the workspace and query it was saved for: an id alone never
 * reaches another workspace's numbers.
 */
export function readSnapshot(
	id: string,
	workspaceId: string,
	specKey: string,
): DataQueryResult | null {
	const snap = snapshots.get(id)
	if (!snap) return null
	if (snap.expiresAt <= Date.now()) {
		drop(id)
		return null
	}
	return snap.workspaceId === workspaceId && snap.specKey === specKey ? snap.result : null
}

/** Test hook: forget everything held. */
export function clearSnapshots() {
	snapshots.clear()
	heldGroups = 0
}
