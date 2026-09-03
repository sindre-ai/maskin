/**
 * Error taxonomy for the linkedin-unipile provider.
 *
 * Six named classes cover every failure the backend route can surface to a
 * caller. The MCP tool handlers (Task 3) map these codes to the SDK's
 * `{ isError, content: [{ text }] }` envelope with the code inline, so the
 * agent can branch on reconnect / retry / abort without parsing prose.
 *
 * v1 stubs — the codes and messages ship here so the /connect + /callback
 * routes can reference them (see routes/integrations-linkedin-unipile.ts).
 * Handler-side wiring (mapping Unipile HTTP responses to these classes,
 * retry policy, and the exact LINKEDIN_ACCOUNT_RESTRICTED discriminator
 * against Unipile's error catalog) lands in Task 3.
 */

export type LinkedinUnipileErrorCode =
	| 'CREDENTIAL_NOT_CONNECTED'
	| 'CREDENTIAL_REVOKED'
	| 'RATE_LIMITED_UNIPILE'
	| 'LINKEDIN_ACCOUNT_RESTRICTED'
	| 'UNIPILE_UNAVAILABLE'
	| 'INVALID_INPUT'

export class LinkedinUnipileError extends Error {
	readonly code: LinkedinUnipileErrorCode
	readonly cause?: unknown

	constructor(code: LinkedinUnipileErrorCode, message: string, cause?: unknown) {
		super(message)
		this.name = 'LinkedinUnipileError'
		this.code = code
		this.cause = cause
	}
}

export class CredentialNotConnectedError extends LinkedinUnipileError {
	constructor(cause?: unknown) {
		super(
			'CREDENTIAL_NOT_CONNECTED',
			'LinkedIn is not connected for this actor. Ask the workspace member to reconnect at Settings > Integrations.',
			cause,
		)
	}
}

export class CredentialRevokedError extends LinkedinUnipileError {
	constructor(cause?: unknown) {
		super(
			'CREDENTIAL_REVOKED',
			'The LinkedIn connection has been revoked. Reconnect at Settings > Integrations.',
			cause,
		)
	}
}

export class RateLimitedUnipileError extends LinkedinUnipileError {
	constructor(cause?: unknown) {
		super(
			'RATE_LIMITED_UNIPILE',
			'LinkedIn provider is rate-limited. Try again in ~1 minute.',
			cause,
		)
	}
}

/**
 * TODO(pr#N — Task 3): Confirm the exact discriminator on Unipile's error
 * body that marks a LinkedIn account as restricted (spec residual 2). The
 * class exists here so /callback can be typed against the full taxonomy; the
 * handler-side detection lands with the send-message MCP tool.
 */
export class LinkedinAccountRestrictedError extends LinkedinUnipileError {
	constructor(cause?: unknown) {
		super(
			'LINKEDIN_ACCOUNT_RESTRICTED',
			'LinkedIn has restricted this account. Sending will be blocked until LinkedIn lifts the restriction (typically 24-72h).',
			cause,
		)
	}
}

export class UnipileUnavailableError extends LinkedinUnipileError {
	constructor(cause?: unknown) {
		super(
			'UNIPILE_UNAVAILABLE',
			'LinkedIn provider is temporarily unavailable. Retry in a few minutes.',
			cause,
		)
	}
}

export class InvalidInputError extends LinkedinUnipileError {
	constructor(reason: string, cause?: unknown) {
		super('INVALID_INPUT', `INVALID_INPUT: ${reason}`, cause)
	}
}
