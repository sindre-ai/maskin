import { EmailSendError } from './errors'

// Structured, non-leaky classification of a send-time failure. The raw
// `EmailSendError` carries the provider's own message (which may echo the
// recipient address or a provider message id), plus a `cause` that can
// contain the full underlying error object. Neither is safe to include in
// a tool response that lands in an agent transcript. `sanitizeSendError`
// collapses the failure to one of four codes and a fixed generic message;
// the full context stays in the server log via the caller's log line.
export type SanitizedErrorCode =
	| 'provider_error'
	| 'transport_error'
	| 'configuration_error'
	| 'unexpected_error'

export interface SanitizedSendError {
	code: SanitizedErrorCode
	// Fixed, generic string. Never interpolates the raw provider message,
	// the message id, or the recipient. Callers must forward this verbatim
	// to any user-visible surface.
	message: string
}

const GENERIC_MESSAGES: Record<SanitizedErrorCode, string> = {
	provider_error: 'Email provider rejected the send. See server logs for the specific reason.',
	transport_error: 'Could not reach the email provider. See server logs for the specific reason.',
	configuration_error:
		'Email provider is not configured on this host. See server logs for the specific reason.',
	unexpected_error:
		'Email send failed for an unexpected reason. See server logs for the specific reason.',
}

// Provider codes that indicate a network/DNS/timeout failure inside the SDK
// rather than a rejection from the provider itself. `sendEmail` throws
// `EmailSendError('transport_error', ...)` for the SDK-throws branch;
// anything else riding EmailSendError is a provider-side rejection.
const TRANSPORT_PROVIDER_CODES = new Set<string>(['transport_error'])

// Config-shaped errors that surface as plain `Error` from `readResendEnv`
// (not wrapped in EmailSendError). Matching by message keeps the primitive
// self-contained without importing `readResendEnv` internals here.
const CONFIGURATION_MESSAGE_PATTERNS: RegExp[] = [
	/RESEND_API_KEY environment variable is required/,
	/EMAIL_FROM environment variable is required/,
]

export function sanitizeSendError(err: unknown): SanitizedSendError {
	if (err instanceof EmailSendError) {
		const code: SanitizedErrorCode = TRANSPORT_PROVIDER_CODES.has(err.providerCode)
			? 'transport_error'
			: 'provider_error'
		return { code, message: GENERIC_MESSAGES[code] }
	}
	if (err instanceof Error && CONFIGURATION_MESSAGE_PATTERNS.some((re) => re.test(err.message))) {
		return { code: 'configuration_error', message: GENERIC_MESSAGES.configuration_error }
	}
	return { code: 'unexpected_error', message: GENERIC_MESSAGES.unexpected_error }
}
