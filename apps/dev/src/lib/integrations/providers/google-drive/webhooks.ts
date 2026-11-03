/**
 * Drive channel deliveries are handled by the dedicated POST /google-drive route
 * on webhookApp (see webhook-handler.ts), which is registered ahead of the
 * '/:provider' catch-all. This verifier is the catch-all's fallback for the
 * google-drive provider: it rejects everything, so nothing can reach the generic
 * email-keyed routing, which would fan one Google account's change to every
 * workspace that connected it.
 */
export const driveWebhookVerifier = (_body: string, _headers: Record<string, string>): boolean =>
	false
