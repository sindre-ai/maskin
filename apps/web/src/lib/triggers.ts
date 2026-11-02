/**
 * An event belongs in a trigger's CHANGES transcript only if it records a
 * change *to* the trigger. `POST /api/triggers` writes a `created` event of
 * its own, so every trigger has one from birth — counting it would make the
 * transcript non-empty before anyone has changed anything.
 */
export function isTriggerChange(
	event: { entityId: string; action: string },
	triggerId: string,
): boolean {
	return event.entityId === triggerId && event.action !== 'created'
}

const byName = (a: { name: string; id: string }, b: { name: string; id: string }) =>
	a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }) ||
	a.id.localeCompare(b.id)

/**
 * Splits triggers into the ones a flow names (`LoopSummary.triggerIds` is the
 * canonical membership) and the ones that run on their own. Each side is sorted
 * A to Z by name.
 */
export function splitTriggersByFlow<T extends { id: string; name: string }>(
	triggers: readonly T[],
	loops: readonly { triggerIds: readonly string[] }[],
): { inFlows: T[]; standalone: T[] } {
	const tied = new Set(loops.flatMap((l) => l.triggerIds))
	const sorted = [...triggers].sort(byName)
	return {
		inFlows: sorted.filter((t) => tied.has(t.id)),
		standalone: sorted.filter((t) => !tied.has(t.id)),
	}
}
