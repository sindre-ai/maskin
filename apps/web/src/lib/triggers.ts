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
