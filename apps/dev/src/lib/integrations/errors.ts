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
