import { ApiErrorCode } from '@maskin/shared'

/**
 * Thrown by the integrations layer when an external provider has revoked the
 * user's grant (Google `invalid_grant` on refresh, or a `401` on a data call
 * after the integration has been marked `revoked`).
 *
 * Carries the `auth_revoked` ApiErrorCode so route handlers can map it to the
 * standard API error response without re-classifying.
 */
export class IntegrationAuthRevokedError extends Error {
	readonly code = ApiErrorCode.AUTH_REVOKED
	readonly status = 401
	readonly integrationId: string

	constructor(integrationId: string, message?: string) {
		super(message ?? `Integration ${integrationId} authorization has been revoked`)
		this.name = 'IntegrationAuthRevokedError'
		this.integrationId = integrationId
	}
}

export function isAuthRevokedError(err: unknown): err is IntegrationAuthRevokedError {
	return err instanceof IntegrationAuthRevokedError
}

/**
 * Thrown when an outbound call to a provider fails while building an install
 * URL — the provider is down, unreachable, or answered non-2xx.
 *
 * Distinct from a local failure (missing `INTEGRATION_ENCRYPTION_KEY`, a
 * malformed state envelope) so the connect route can answer 502 "upstream is
 * down, retry" for this and 500 "server misconfiguration, retrying won't help"
 * for everything else. Collapsing the two tells an operator with a missing key
 * to keep clicking Connect forever.
 */
export class ProviderUnreachableError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options)
		this.name = 'ProviderUnreachableError'
	}
}

// ── Keychain: typed failures of getCredential ───────────────────────────────
// A read either returns a credential or throws one of these. There is no null
// for "denied", "undone" or "KMS said no", so a caller cannot mistake any of
// them for "no credential configured".

export class CredentialNotFoundError extends Error {
	constructor(readonly integrationId: string) {
		super(`Credential ${integrationId} not found`)
		this.name = 'CredentialNotFoundError'
	}
}

/** The requesting actor or loop holds none of the credential's scope grants. */
export class ScopeDeniedError extends Error {
	constructor(
		readonly integrationId: string,
		readonly requestingActorId: string,
	) {
		super(`Actor ${requestingActorId} is not granted credential ${integrationId}`)
		this.name = 'ScopeDeniedError'
	}
}

/** status = 'undone': the user undid a chat capture; the material is zeroised. */
export class CredentialUndoneError extends Error {
	constructor(readonly integrationId: string) {
		super(`Credential ${integrationId} was undone`)
		this.name = 'CredentialUndoneError'
	}
}

/** status = 'pending': a connect flow has not completed, so there is nothing to read. */
export class CredentialPendingError extends Error {
	constructor(readonly integrationId: string) {
		super(`Credential ${integrationId} is still pending`)
		this.name = 'CredentialPendingError'
	}
}

/** Any other status that is not active or pending_undo (revoked, error, inactive, awaiting_secret). */
export class CredentialUnavailableError extends Error {
	constructor(
		readonly integrationId: string,
		readonly status: string,
	) {
		super(`Credential ${integrationId} is ${status}`)
		this.name = 'CredentialUnavailableError'
	}
}
