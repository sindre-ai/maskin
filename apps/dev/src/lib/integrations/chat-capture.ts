import { randomUUID } from 'node:crypto'
import type { KmsProvider } from '@maskin/auth/kms'
import type { Database } from '@maskin/db'
import {
	type ScopeGrant,
	conversationParticipants,
	integrations,
	sessions,
	workspaceMembers,
} from '@maskin/db/schema'
import { SECRET_PROVIDER_IDS, type SecretProviderId } from '@maskin/shared'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { encryptEnvelope } from '../crypto'
import { recordEvent } from '../events/record-event'
import { insertCredentialAccessLog } from './credential-audit'

/** How long a captured key stays undoable before the sweeper activates it. */
export const UNDO_WINDOW_MS = 5 * 60 * 1000

export const CHAT_CAPTURE_PROVIDERS: readonly SecretProviderId[] = SECRET_PROVIDER_IDS

export class ChatCaptureError extends Error {
	constructor(
		readonly status: 400 | 403 | 404,
		readonly code: 'BAD_REQUEST' | 'FORBIDDEN' | 'NOT_FOUND',
		message: string,
	) {
		super(message)
		this.name = 'ChatCaptureError'
	}
}

export interface ChatCaptureInput {
	workspaceId: string
	/** The human who pasted the key. */
	actorId: string
	sessionId: string
	detectedProvider: SecretProviderId
	displayName: string
	scopeGrants?: ScopeGrant[]
	/** Consumed here and never stored, logged or put on an event. */
	rawSecret: string
}

export interface ChatCaptureResult {
	integrationId: string
	undoExpiresAt: Date
	scopeGrants: ScopeGrant[]
	origin: { sessionId: string }
}

/**
 * Vaults a secret pasted in chat. The row lands as pending_undo: readable through
 * getCredential during the window, flipped to active by the sweeper afterwards.
 *
 * Order matters for the invariant that no data key outlives the request: the
 * DEK is generated, used to encrypt, wrapped by KMS and zeroised inside
 * encryptEnvelope, before the transaction opens. The transaction then carries
 * only ciphertext, so no KMS call happens while the audit chain lock is held.
 */
export async function captureChatSecret(
	db: Database,
	kms: KmsProvider,
	input: ChatCaptureInput,
	now: Date = new Date(),
): Promise<ChatCaptureResult> {
	const { workspaceId, actorId, sessionId } = input

	const [session] = await db
		.select({ id: sessions.id, actorId: sessions.actorId, conversationId: sessions.conversationId })
		.from(sessions)
		.where(and(eq(sessions.id, sessionId), eq(sessions.workspaceId, workspaceId)))
		.limit(1)
	if (!session) throw new ChatCaptureError(404, 'NOT_FOUND', 'Session not found')

	// Only someone in the conversation the key was pasted into can vault it.
	if (session.conversationId) {
		const [participant] = await db
			.select({ actorId: conversationParticipants.actorId })
			.from(conversationParticipants)
			.where(
				and(
					eq(conversationParticipants.conversationId, session.conversationId),
					eq(conversationParticipants.actorId, actorId),
					isNull(conversationParticipants.leftAt),
				),
			)
			.limit(1)
		if (!participant) throw new ChatCaptureError(403, 'FORBIDDEN', 'Not a participant in this chat')
	}

	// Only caller-supplied grants are checked against membership. The default is the
	// session's own driver, which the session row already vouches for.
	const requested = input.scopeGrants ?? []
	const requestedActorIds = [
		...new Set(requested.flatMap((g) => (g.kind === 'actor' ? [g.actorId] : []))),
	]
	if (requestedActorIds.length > 0) {
		const members = await db
			.select({ actorId: workspaceMembers.actorId })
			.from(workspaceMembers)
			.where(
				and(
					eq(workspaceMembers.workspaceId, workspaceId),
					inArray(workspaceMembers.actorId, requestedActorIds),
				),
			)
		if (members.length !== requestedActorIds.length) {
			throw new ChatCaptureError(
				400,
				'BAD_REQUEST',
				'A scope grant names an actor outside this workspace',
			)
		}
	}
	// Omitted means the default (the session driver). An explicit empty list is the
	// user's "Save unassigned": fail closed, nobody can read it.
	const grants: ScopeGrant[] = input.scopeGrants
		? requested
		: [{ kind: 'actor', actorId: session.actorId }]

	const { credentials, dekCiphertext } = await encryptEnvelope(kms, workspaceId, input.rawSecret)
	const undoExpiresAt = new Date(now.getTime() + UNDO_WINDOW_MS)
	const integrationId = randomUUID()

	await db.transaction(async (tx) => {
		await tx.insert(integrations).values({
			id: integrationId,
			workspaceId,
			provider: input.detectedProvider,
			status: 'pending_undo',
			credentials,
			dekCiphertext,
			providerMode: 'byo_apikey',
			displayName: input.displayName,
			scopeGrants: grants,
			source: 'chat_capture',
			originSessionId: sessionId,
			undoExpiresAt,
			createdBy: actorId,
		})
		await insertCredentialAccessLog(tx, {
			workspaceId,
			integrationId,
			actorId,
			sessionId,
			action: 'create',
			source: 'chat_capture',
			requestId: `chat-capture:${integrationId}`,
		})
		await recordEvent(tx, {
			workspaceId,
			actorId,
			action: 'created',
			entityType: 'integration',
			entityId: integrationId,
			// Never the value, the ciphertext or the wrapped key.
			data: {
				provider: input.detectedProvider,
				provider_mode: 'byo_apikey',
				source: 'chat_capture',
				origin_session_id: sessionId,
			},
		})
	})

	return { integrationId, undoExpiresAt, scopeGrants: grants, origin: { sessionId } }
}
