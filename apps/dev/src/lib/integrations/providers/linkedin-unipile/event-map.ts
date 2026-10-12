/**
 * Unipile event type -> Maskin event mapping.
 *
 * One typed constant keyed by Unipile event type. It lives here and not in the
 * ProviderConfig `events.mapping` field because that shape only holds
 * entityType and action, and Unipile events also need a dedupe key, a
 * classifier and a flag.
 *
 * Adding a row: one object below, one fixture in `__fixtures__/`, one entry in
 * `config.ts` events.definitions, and an allowlist entry on the Unipile
 * endpoint. The table-driven test in `__tests__` fails if a row misses its
 * fixture, if deliveryKey returns null on that fixture, or if the entityType is
 * absent from the config definitions.
 */

import type { Database } from '@maskin/db'
import type { integrations } from '@maskin/db/schema'
import { FLAGS, type FlagId } from '../../../feature-flags'
import { decideDirection, readOwnLinkedinIds } from './direction'
import type { UnipileEnvelope } from './envelope'
import { resolveSender } from './sender-resolution'

export type IntegrationRow = typeof integrations.$inferSelect

export interface ClassifyContext {
	db: Database
	envelope: UnipileEnvelope
	integration: IntegrationRow
	/** Own ids the in-process registry holds for an integration (read only). */
	ownIds: (integrationId: string) => Set<string>
}

export type ClassifyResult =
	| {
			kind: 'emit'
			action: string
			entityId: string
			data: Record<string, unknown>
			/** Extra fields for the per-delivery log line. */
			log?: Record<string, unknown>
	  }
	| {
			kind: 'drop'
			reason: string
			/** Leave the claims unprocessed (the sweep recovers) instead of marking them done. */
			keepClaim?: boolean
			log?: Record<string, unknown>
	  }

export interface EventMapRow {
	entityType: string
	/** Every action this row can emit. */
	actions: readonly string[]
	accountId: (envelope: UnipileEnvelope) => string | null
	/** Content dedupe key, or null to skip the content claim. */
	deliveryKey: (envelope: UnipileEnvelope) => string | null
	classify: (ctx: ClassifyContext) => Promise<ClassifyResult>
	flag: FlagId
}

const PROVIDER = 'linkedin-unipile'

function str(value: unknown): string | null {
	return typeof value === 'string' && value.length > 0 ? value : null
}

/** Id of the event resource (the message id for message.new), shared by claims and logs. */
export function resourceId(envelope: UnipileEnvelope): string | null {
	return str(envelope.resource?.id)
}

export const EVENT_MAP: Readonly<Record<string, EventMapRow>> = {
	'message.new': {
		entityType: 'linkedin.message',
		actions: ['received', 'received_cold', 'received_unresolved'],
		accountId: (envelope) => envelope.accountId,
		deliveryKey: (envelope) => {
			const messageId = resourceId(envelope)
			return envelope.accountId && messageId ? `msg:${envelope.accountId}:${messageId}` : null
		},
		// Ids only (plus the contact's id, status and driver for a known sender). No
		// message text, preview, display name, public identifier or attachments in a
		// cold or unresolved row.
		//   received            sender matched a contact; entityId is the contact id
		//   received_cold       lookup succeeded, no contact matched
		//   received_unresolved no public identifier could be obtained
		classify: async ({ db, envelope, integration, ownIds }) => {
			const message = envelope.resource ?? {}
			const messageId = str(message.id)
			if (!messageId) return { kind: 'drop', reason: 'malformed_payload' }

			const chatId = str(message.chat_id)
			const senderId = str(message.sender_id)
			const verdict = decideDirection({
				isSender: message.is_sender,
				senderId,
				ownIds: ownIds(integration.id),
			})
			const log = { direction_source: verdict.source, chat_id: chatId }

			if (verdict.kind === 'drop') {
				return {
					kind: 'drop',
					reason: verdict.reason,
					// direction_unknown keeps its claim so a retry still dedupes and the sweep recovers.
					keepClaim: verdict.reason === 'direction_unknown',
					log,
				}
			}

			const data: Record<string, unknown> = {
				provider: PROVIDER,
				unipile_event_type: envelope.type,
				integration_id: integration.id,
				unipile_account_id: envelope.accountId,
				external_id: messageId,
				envelope_id: envelope.envelopeId,
				provider_timestamp: str(message.timestamp),
				chat_id: chatId,
				message_id: messageId,
				sender_provider_id: senderId,
				direction: 'inbound',
				direction_source: verdict.source,
			}

			const resolution = await resolveSender({
				db,
				integration,
				message,
				chatId,
				senderId,
				accountId: envelope.accountId,
			})

			if (resolution.kind === 'known') {
				const { contact, publicIdentifier } = resolution
				return {
					kind: 'emit',
					action: 'received',
					entityId: contact.id,
					data: {
						...data,
						...(publicIdentifier ? { sender_public_identifier: publicIdentifier } : {}),
						contact_id: contact.id,
						contact_status: contact.status,
						contact_driver_id: contact.driverId,
					},
					log: { ...log, resolution: 'known', contact_id: contact.id },
				}
			}
			if (resolution.kind === 'cold') {
				return {
					kind: 'emit',
					action: 'received_cold',
					entityId: integration.id,
					data,
					log: { ...log, resolution: 'cold' },
				}
			}
			return {
				kind: 'emit',
				action: 'received_unresolved',
				entityId: integration.id,
				data,
				log: { ...log, resolution: 'unresolved', unresolved_reason: resolution.reason },
			}
		},
		flag: FLAGS.LINKEDIN_UNIPILE_EVENTS,
	},
}

/** Own-property lookup so a type like "constructor" can never resolve to a prototype member. */
export function getEventMapRow(type: string | null): EventMapRow | null {
	if (!type || !Object.hasOwn(EVENT_MAP, type)) return null
	return EVENT_MAP[type] ?? null
}

export { readOwnLinkedinIds }
