import type { Database } from '@maskin/db'
import { findHighConfidenceSecret } from '@maskin/shared'
import { createApiError } from '../errors'
import { recordEvent } from '../events/record-event'

export const RAW_SECRET_MESSAGE =
	'This message looks like it contains a secret, so it was not sent. Vault it in Keychain instead.'

/**
 * Keychain backstop for human-authored text. The composer guard should catch a
 * pasted secret before the request exists, so reaching here with one is a
 * bypass. Every route that stores or forwards a person's text calls this, not
 * only the post-message route: a send-clean-then-edit or a direct API client
 * would otherwise skip the scan. The event names the pattern, never the value.
 *
 * Returns the 400 body to send when a secret is found, otherwise null.
 */
export async function refuseRawSecret(
	db: Database,
	input: {
		content: string
		workspaceId: string
		actorId: string
		actorType: string
		entityType: string
		entityId: string
	},
) {
	const hit = findHighConfidenceSecret(input.content)
	if (!hit) return null
	await recordEvent(db, {
		workspaceId: input.workspaceId,
		actorId: input.actorId,
		action: 'credential_scanner_bypass_attempt',
		entityType: input.entityType,
		entityId: input.entityId,
		data: { attention: 3, pattern_id: hit.patternId, caller_type: input.actorType },
	})
	return createApiError('RAW_SECRET_DETECTED', RAW_SECRET_MESSAGE)
}
