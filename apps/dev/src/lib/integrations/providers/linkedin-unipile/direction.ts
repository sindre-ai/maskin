/**
 * Inbound versus sent-by-us for a Unipile message.new delivery.
 *
 * No network calls, ever. Order of evidence:
 *   (a) `is_sender` present (boolean or 0/1): true drops as own_message, false
 *       is an inbound candidate.
 *   (b) cross-check: when the in-process MCP registry already holds own ids for
 *       the integration, a sender id in that set while `is_sender` is false is
 *       a direction_conflict and drops. Failing toward drop is deliberate:
 *       emitting our own message would wake a rep on its own words.
 *   (c) `is_sender` absent: the registry alone decides. Registry empty means
 *       direction_unknown (drop, the sweep recovers).
 *
 * The registry is read only, never awaited and never populated from here.
 */

import { getLinkedInMcpInstancesForIntegration } from '@maskin/mcp/linkedin'

export type DirectionSource = 'is_sender' | 'sender_id_fallback'

export type DirectionVerdict =
	| { kind: 'inbound'; source: DirectionSource }
	| {
			kind: 'drop'
			reason: 'own_message' | 'direction_conflict' | 'direction_unknown'
			source: DirectionSource
	  }

/** Boolean or 0/1 only. Anything else (absent, strings, other numbers) reads as absent. */
export function coerceIsSender(value: unknown): boolean | null {
	if (typeof value === 'boolean') return value
	if (value === 1) return true
	if (value === 0) return false
	return null
}

const URN_PREFIXES = ['urn:li:person:', 'urn:li:organization:']

export function stripLinkedinUrnPrefix(id: string): string {
	for (const prefix of URN_PREFIXES) {
		if (id.startsWith(prefix)) return id.slice(prefix.length)
	}
	return id
}

/** Own ids the registry currently holds for this integration. Empty when it holds none. */
export function readOwnLinkedinIds(integrationId: string): Set<string> {
	const ids = new Set<string>()
	for (const instance of getLinkedInMcpInstancesForIntegration(integrationId)) {
		if (instance.identityUrn) ids.add(stripLinkedinUrnPrefix(instance.identityUrn))
	}
	return ids
}

export function decideDirection(input: {
	isSender: unknown
	senderId: string | null
	ownIds: ReadonlySet<string>
}): DirectionVerdict {
	const isSender = coerceIsSender(input.isSender)
	const senderId = input.senderId ? stripLinkedinUrnPrefix(input.senderId) : null
	const senderIsOwn = senderId !== null && input.ownIds.has(senderId)

	if (isSender === true) return { kind: 'drop', reason: 'own_message', source: 'is_sender' }
	if (isSender === false) {
		if (senderIsOwn) return { kind: 'drop', reason: 'direction_conflict', source: 'is_sender' }
		return { kind: 'inbound', source: 'is_sender' }
	}

	// is_sender absent: the registry is the only evidence left.
	if (input.ownIds.size === 0 || senderId === null) {
		return { kind: 'drop', reason: 'direction_unknown', source: 'sender_id_fallback' }
	}
	if (senderIsOwn) return { kind: 'drop', reason: 'own_message', source: 'sender_id_fallback' }
	return { kind: 'inbound', source: 'sender_id_fallback' }
}
