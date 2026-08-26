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
