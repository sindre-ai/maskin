import type { KmsProvider } from '@maskin/auth'
import type { Database } from '@maskin/db'
import {
	INTEGRATION_STATUS_ACTIVE,
	type Integration,
	type ScopeGrant,
	integrations,
} from '@maskin/db/schema'
import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
import { capturePosthogEvent } from '../analytics/posthog'
import { decryptStoredCredential } from '../crypto'
import { recordEvent } from '../events/record-event'
import { getKmsProvider } from '../keychain-kms'
import { insertCredentialAccessLog } from './credential-audit'
import {
	CredentialNotFoundError,
	CredentialPendingError,
	CredentialUnavailableError,
	CredentialUndoneError,
	ScopeDeniedError,
} from './errors'
import { mintHeaders, vaultHeaders } from './header-mint'
import type { DecryptedCredential } from './types'

/**
 * Providers whose credentials are actor-scoped: a workspace can hold multiple
 * connected accounts for the same provider, one per actor. The single source
 * of truth for this decision — the schema treats `integrations.actor_id` as
 * a plain nullable column, so nothing at the DB layer prevents a caller from
 * storing an actor-scoped credential for a provider not listed here. Adding
 * to this set is a conscious call: it changes the uniqueness contract from
 * "one connection per workspace" to "one connection per (workspace, actor)"
 * for that provider, and every reader that fetches its credentials must
 * supply a real actorId.
 */
export const actorScopedProviders = new Set<string>(['linkedin-unipile'])

/**
 * Fetches the connected credential row for a (workspace, provider, actor)
 * triple, gated by the actor-scoped-provider allow-list.
 *
 * - For a provider IN `actorScopedProviders`: matches on the exact
 *   `actor_id = actorId`. Passing `actorId = null` for a scoped provider is a
 *   caller bug (there is no workspace-shared row to fall back to) and returns
 *   null — the read cannot silently promote a workspace-scoped row into an
 *   actor-scoped surface. Pass `{ fallbackToAnyActor: true }` to widen the
 *   read to any connected identity in the workspace — see below.
 * - For any other provider: matches on `actor_id IS NULL`, preserving the
 *   pre-0065 workspace-scoped semantics regardless of what the caller passes
 *   for `actorId`. This makes it safe to thread an actorId through every call
 *   site — the allow-list is what decides whether it's honored.
 *
 * In both cases `status = 'active'` is required, so pending, errored or
 * revoked connections never leak to a caller expecting live credentials.
 * `'active'` is the vocabulary every write path in routes/integrations.ts
 * uses and every other reader filters on — this helper must not invent its
 * own status value, or it silently matches nothing.
 */
export interface IntegrationCredentialOptions {
	/**
	 * For an actor-scoped provider, fall back to ANY connected identity in the
	 * workspace when the calling actor has none of its own.
	 *
	 * Actor-scoping exists so a workspace can hold several connected accounts
	 * for one provider — one per human — and so the LinkedIn add-on can bill
	 * per identity. It was never meant to mean "only the human who connected
	 * may use it": agents are actors too and never go through a connect flow,
	 * so a strict read makes the credential unreachable from exactly the place
	 * it is meant to be used (an agent's MCP tool call). Same expectation
	 * every other provider sets — one person connects Gmail, every agent in
	 * the workspace can use it.
	 *
	 * Callers that must resolve one specific human's account (billing counts,
	 * the reconnect surface) leave this off and get the strict behaviour.
	 */
	fallbackToAnyActor?: boolean
	/**
	 * Keychain read context. With it, the call resolves the row the same way and
	 * then reads it through {@link getCredential}: scope enforced, audit row
	 * written, value decrypted. Without it the call returns the raw row exactly
	 * as before, for the readers that decrypt it themselves.
	 */
	ctx?: CredentialReadContext
}

export async function getIntegrationCredential(
	db: Database,
	workspaceId: string,
	provider: string,
	actorId: string | null,
	options: IntegrationCredentialOptions & { ctx: CredentialReadContext },
): Promise<DecryptedCredential | null>
export async function getIntegrationCredential(
	db: Database,
	workspaceId: string,
	provider: string,
	actorId: string | null,
	options?: IntegrationCredentialOptions,
): Promise<Integration | null>
export async function getIntegrationCredential(
	db: Database,
	workspaceId: string,
	provider: string,
	actorId: string | null,
	options: IntegrationCredentialOptions = {},
): Promise<Integration | DecryptedCredential | null> {
	const row = await findIntegrationRow(db, workspaceId, provider, actorId, options)
	if (!options.ctx) return row
	return row ? getCredential(db, workspaceId, row.id, options.ctx) : null
}

async function findIntegrationRow(
	db: Database,
	workspaceId: string,
	provider: string,
	actorId: string | null,
	options: IntegrationCredentialOptions,
): Promise<Integration | null> {
	const requiresActor = actorScopedProviders.has(provider)
	if (requiresActor && !actorId && !options.fallbackToAnyActor) return null
	// A Keychain read also sees a chat capture still inside its undo window
	// (readable on purpose: the session that triggered it resumes at once).
	const scope = and(
		eq(integrations.workspaceId, workspaceId),
		eq(integrations.provider, provider),
		options.ctx
			? inArray(integrations.status, [INTEGRATION_STATUS_ACTIVE, 'pending_undo'])
			: eq(integrations.status, INTEGRATION_STATUS_ACTIVE),
	)
	if (requiresActor && actorId) {
		const [own] = await db
			.select()
			.from(integrations)
			.where(and(scope, eq(integrations.actorId, actorId)))
			.limit(1)
		if (own) return own
		if (!options.fallbackToAnyActor) return null
	}
	if (requiresActor) {
		// Deterministic pick: oldest connected identity wins. Sending as a
		// human is not something to decide by whichever row Postgres happens to
		// return, and an unordered read would silently change whose LinkedIn an
		// agent posts from as soon as a second person connects.
		const [any] = await db
			.select()
			.from(integrations)
			.where(scope)
			.orderBy(asc(integrations.createdAt))
			.limit(1)
		return any ?? null
	}
	const rows = await db
		.select()
		.from(integrations)
		.where(and(scope, isNull(integrations.actorId)))
		.limit(1)
	return rows[0] ?? null
}

// ── Keychain: the single choke point ────────────────────────────────────────

export type CredentialReadContext = {
	requestingActorId: string
	requestingLoopId?: string | null
	/** For audit. */
	sessionId: string
	/** Host or URL being called. Audit only. */
	outboundTarget?: string
	/** Correlation id, for audit. */
	requestId: string
}

export interface GetCredentialDeps {
	/** Defaults to the process KMS provider chosen by KEYCHAIN_KMS. */
	kms?: KmsProvider
}

function isScopeGranted(grants: unknown, ctx: CredentialReadContext): boolean {
	if (!Array.isArray(grants)) return false
	return (grants as ScopeGrant[]).some((grant) => {
		switch (grant?.kind) {
			case 'workspace':
				return true
			case 'actor':
				return typeof grant.actorId === 'string' && grant.actorId === ctx.requestingActorId
			case 'loop':
				return (
					typeof grant.loopId === 'string' &&
					!!ctx.requestingLoopId &&
					grant.loopId === ctx.requestingLoopId
				)
			default:
				// Unknown kind: fail closed.
				return false
		}
	})
}

/**
 * Every read of a stored credential goes through here. In order: load the row,
 * accept only active or pending_undo, enforce scope_grants against the
 * requesting actor or loop, unwrap the DEK and decrypt, then write the audit row
 * in the same transaction. A denied scope check writes an events row and no
 * audit row (nothing was read). Failure is always a typed error, never null.
 *
 * The audit insert comes after the decrypt and takes a per-workspace lock until
 * commit, so no KMS call happens while that lock is held.
 */
export async function getCredential(
	db: Database,
	workspaceId: string,
	integrationId: string,
	ctx: CredentialReadContext,
	deps: GetCredentialDeps = {},
): Promise<DecryptedCredential> {
	const [row] = await db
		.select()
		.from(integrations)
		.where(and(eq(integrations.id, integrationId), eq(integrations.workspaceId, workspaceId)))
		.limit(1)
	if (!row) throw new CredentialNotFoundError(integrationId)

	if (row.status === 'undone') throw new CredentialUndoneError(integrationId)
	if (row.status === 'pending') throw new CredentialPendingError(integrationId)
	if (row.status !== INTEGRATION_STATUS_ACTIVE && row.status !== 'pending_undo') {
		throw new CredentialUnavailableError(integrationId, row.status)
	}

	if (!isScopeGranted(row.scopeGrants, ctx)) {
		await recordEvent(db, {
			workspaceId,
			actorId: ctx.requestingActorId,
			action: 'credential_scope_denied',
			entityType: 'integration',
			entityId: row.id,
			data: {
				attention: 3,
				provider: row.provider,
				request_id: ctx.requestId,
				session_id: ctx.sessionId,
				loop_id: ctx.requestingLoopId ?? null,
				outbound_target: ctx.outboundTarget ?? null,
			},
		})
		throw new ScopeDeniedError(integrationId, ctx.requestingActorId)
	}

	// Legacy rows (no dek_ciphertext) never touch KMS, so resolve it lazily.
	const kms: KmsProvider = deps.kms ?? {
		encrypt: (ws, dek) => getKmsProvider(db).encrypt(ws, dek),
		decrypt: (ws, wrapped) => getKmsProvider(db).decrypt(ws, wrapped),
	}
	const value = await decryptStoredCredential(kms, {
		workspaceId,
		credentials: row.credentials,
		dekCiphertext: row.dekCiphertext,
	})

	await db.transaction((tx) =>
		insertCredentialAccessLog(tx, {
			workspaceId,
			integrationId: row.id,
			actorId: ctx.requestingActorId,
			sessionId: ctx.sessionId,
			loopId: ctx.requestingLoopId ?? null,
			outboundTarget: ctx.outboundTarget ?? null,
			action: 'read',
			source: row.source,
			requestId: ctx.requestId,
		}),
	)

	void capturePosthogEvent('keychain_credential_accessed', ctx.requestingActorId, {
		workspace_id: workspaceId,
		integration_id: row.id,
		provider: row.provider,
		provider_mode: row.providerMode,
		source: row.source,
		has_outbound_target: !!ctx.outboundTarget,
	})

	const adapterKind =
		typeof (row.metadata as { adapterKind?: unknown } | null)?.adapterKind === 'string'
			? (row.metadata as { adapterKind: string }).adapterKind
			: null
	return {
		id: row.id,
		workspaceId,
		provider: row.provider,
		providerMode: row.providerMode,
		source: row.source,
		value,
		credentialSource: adapterKind ? (adapterKind as `external:${string}`) : 'vault',
		getHeaders: (headerCtx) =>
			adapterKind
				? mintHeaders(adapterKind, row.id, headerCtx)
				: Promise.resolve(vaultHeaders(row.provider, value)),
		// A credential must not leak into a log line through JSON.stringify.
		toJSON: () => ({ id: row.id, workspaceId, provider: row.provider }),
	} as DecryptedCredential
}
