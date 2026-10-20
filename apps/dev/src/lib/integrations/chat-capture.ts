import { randomUUID } from 'node:crypto'
import type { KmsProvider } from '@maskin/auth/kms'
import type { Database } from '@maskin/db'
import { conversationParticipants, integrations, sessions } from '@maskin/db/schema'
import { SECRET_PROVIDER_IDS, type SecretProviderId } from '@maskin/shared'
import { and, eq, isNull } from 'drizzle-orm'
import { encryptEnvelope } from '../crypto'
import { recordEvent } from '../events/record-event'
import { actorsAreWorkspaceAgents } from './agent-access'
import { insertKeychainGrants } from './agent-grants'
import { BYO_APIKEY_PROVIDER } from './byo-apikey'
import { BYO_LOGIN_PROVIDER, type LoginFields, encodeLogin } from './byo-login'
import { insertCredentialAccessLog } from './credential-audit'
import { assertSlugFree, assertValidCredentialName, lockCredentialSlug } from './credential-name'
import { assertValidCredentialValue } from './credential-value'
import { assertValidLoginFields } from './login-value'

/** How long a captured key stays undoable before the sweeper activates it. */
export const UNDO_WINDOW_MS = 5 * 60 * 1000

/** Not a provider: the user typed the ! prefix and named the key themselves, so nothing was detected. */
export const MANUAL_CAPTURE = 'manual'

export type ChatCaptureProvider = SecretProviderId | typeof MANUAL_CAPTURE

export const CHAT_CAPTURE_PROVIDERS: readonly ChatCaptureProvider[] = [
	...SECRET_PROVIDER_IDS,
	MANUAL_CAPTURE,
]

/**
 * How the capture started: the user typed the prefix, the scanner caught a pasted key,
 * or the user filled in a card an agent put in the chat. The client never says; the
 * server derives it from what the request carries.
 */
export type ChatCaptureTrigger = 'prefix' | 'detected' | 'card'

export function captureTrigger(provider: ChatCaptureProvider): ChatCaptureTrigger {
	return provider === MANUAL_CAPTURE ? 'prefix' : 'detected'
}

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

interface ChatCaptureBase {
	workspaceId: string
	/** The human who pasted the key. */
	actorId: string
	sessionId: string
	displayName: string
	/** Agents that may use the key. Omitted: the session driver. Empty: nobody (saved unassigned). */
	agentIds?: string[]
	/** The secret came from a card an agent asked for, not from the composer. */
	viaCard?: boolean
}

/**
 * What is being vaulted: one API key (with the provider the scanner detected, or
 * manual), or one username and password. Either way it is consumed here and never
 * stored, logged or put on an event in the clear.
 */
export type ChatCaptureInput = ChatCaptureBase &
	(
		| { detectedProvider: ChatCaptureProvider; rawSecret: string; login?: undefined }
		| { login: LoginFields; detectedProvider?: undefined; rawSecret?: undefined }
	)

export interface ChatCaptureResult {
	integrationId: string
	trigger: ChatCaptureTrigger
	/** What the row stores as its provider: the detected one, or custom for a manual capture. */
	provider: string
	/** Null for a card capture: it is active straight away and has no undo window. */
	undoExpiresAt: Date | null
	/** Agents granted the key. */
	agentIds: string[]
	origin: { sessionId: string }
}

/**
 * Vaults a secret pasted in chat. The row lands as pending_undo: readable through
 * getCredential during the window, flipped to active by the sweeper afterwards.
 *
 * A capture from a card an agent asked for (viaCard) is the exception: the person
 * chose to type it in, there is no composer text to take back and no Undo button, so
 * it is active straight away and has no window.
 *
 * Order matters for the invariant that no data key outlives the request: the
 * DEK is generated, used to encrypt, wrapped by the master key and zeroised inside
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
	// Before anything is read or encrypted. The name rule needs no database, and its
	// messages never repeat the name.
	assertValidCredentialName(input.displayName)
	if (input.login) assertValidLoginFields(input.login.username, input.login.password)
	else assertValidCredentialValue(input.rawSecret)

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
	} else if (session.actorId !== actorId) {
		// No conversation means no human to ask: an autonomous or triggered run. Vaulting
		// stops and respawns the session, so only the session's own driver may do it.
		throw new ChatCaptureError(403, 'FORBIDDEN', 'Not the driver of this session')
	}

	// Only caller-supplied grants are checked against membership. The default is the
	// session's own driver, which the session row already vouches for.
	const requested = input.agentIds ?? []
	if (!(await actorsAreWorkspaceAgents(db, workspaceId, requested))) {
		throw new ChatCaptureError(400, 'BAD_REQUEST', 'A grant names an agent outside this workspace')
	}
	// Omitted means the default (the session driver). An explicit empty list is the
	// user's "Save unassigned": fail closed, nobody can read it.
	const agentIds: string[] = input.agentIds ? requested : [session.actorId]

	// A taken name is refused before the KMS call. The check is repeated under the lock
	// below, because two vaults of one name can both pass this one.
	await assertSlugFree(db, workspaceId, input.displayName)

	const plaintext = input.login ? encodeLogin(input.login) : input.rawSecret
	const { credentials, dekCiphertext } = await encryptEnvelope(kms, workspaceId, plaintext)
	const undoExpiresAt = input.viaCard ? null : new Date(now.getTime() + UNDO_WINDOW_MS)
	const integrationId = randomUUID()
	const providerMode = input.login ? 'byo_login' : 'byo_apikey'
	const provider = input.login
		? BYO_LOGIN_PROVIDER
		: input.detectedProvider === MANUAL_CAPTURE
			? BYO_APIKEY_PROVIDER
			: input.detectedProvider

	await db.transaction(async (tx) => {
		await lockCredentialSlug(tx, workspaceId, input.displayName)
		await assertSlugFree(tx, workspaceId, input.displayName)
		await tx.insert(integrations).values({
			id: integrationId,
			workspaceId,
			provider,
			status: undoExpiresAt ? 'pending_undo' : 'active',
			credentials,
			dekCiphertext,
			providerMode,
			defaultAgentAccess: 'none',
			displayName: input.displayName,
			source: 'chat_capture',
			originSessionId: sessionId,
			undoExpiresAt,
			createdBy: actorId,
		})
		await insertKeychainGrants(tx, {
			workspaceId,
			integrationId,
			actorIds: agentIds,
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
				provider,
				provider_mode: providerMode,
				source: 'chat_capture',
				origin_session_id: sessionId,
			},
		})
	})

	return {
		integrationId,
		trigger: input.viaCard || input.login ? 'card' : captureTrigger(input.detectedProvider),
		provider,
		undoExpiresAt,
		agentIds,
		origin: { sessionId },
	}
}
