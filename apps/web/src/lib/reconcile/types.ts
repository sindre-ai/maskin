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

export interface ConflictResolvedPayload {
	objectId: string
	objectType: string
	freshVersion: number | null
	resolution: 'keep_mine' | 'take_theirs' | 'review'
}

// Extract the fresh server state from a 409 body. T2's approach comment shows
// two possible shapes: `{ object: ObjectResponse, error?: { code, message } }`
// and a bare `ObjectResponse`. Accept both; return null if neither matches.
export function extractTheirsFrom409(body: unknown): ObjectResponse | null {
	if (!body || typeof body !== 'object') return null
	const record = body as Record<string, unknown>
	const candidate =
		record.object && typeof record.object === 'object'
			? (record.object as Record<string, unknown>)
			: record
	if (typeof candidate.id !== 'string') return null
	if (typeof candidate.type !== 'string') return null
	return candidate as unknown as ObjectResponse
}
