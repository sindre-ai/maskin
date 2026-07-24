import type { ObjectResponse } from '../api'

// Payload handed to the T5 analytics emit sites. Kept minimal (ids + versions)
// so PostHog captures don't ship the raw document body.
export interface ConflictDetectedPayload {
	objectId: string
	objectType: string
	staleVersion: number | null
	freshVersion: number | null
	mineLength: number
	theirsLength: number
}

// Four-value split: `kept_mine` / `took_theirs` when the user clicks the
// top-level banner buttons directly, and `reviewed_then_*` when they open the
// diff overlay before committing. Mirrors `EditorWriteConflictResolution` in
// `@/lib/analytics` — the PostHog query keys off these exact strings.
export type ConflictResolutionOutcome =
	| 'kept_mine'
	| 'took_theirs'
	| 'reviewed_then_kept_mine'
	| 'reviewed_then_took_theirs'

export interface ConflictResolvedPayload {
	objectId: string
	objectType: string
	freshVersion: number | null
	resolution: ConflictResolutionOutcome
}

// Extract the fresh server state from a 409 body. The server contract
// (`staleVersionErrorSchema` in `apps/dev/src/lib/openapi-schemas.ts`) puts the
// full `ObjectResponse` under `current`, so that's the only shape we accept.
export function extractTheirsFrom409(body: unknown): ObjectResponse | null {
	if (!body || typeof body !== 'object') return null
	const record = body as Record<string, unknown>
	const current = record.current
	if (!current || typeof current !== 'object') return null
	const candidate = current as Record<string, unknown>
	if (typeof candidate.id !== 'string') return null
	if (typeof candidate.type !== 'string') return null
	return candidate as unknown as ObjectResponse
}
