import type { NormalizedEvent, WebhookFanOutContext } from '../../types'

/**
 * Safe no-op stubs for the Drive watch hooks. Channel creation, the HMAC
 * verifier, channel-id routing and the changes.list fan-out belong to the
 * folder-watch task, which replaces these three functions in place.
 *
 * Until then no channel exists, so no legitimate delivery can arrive: the
 * verifier rejects everything, and the other two are inert.
 */
export const driveWebhookVerifier = (_body: string, _headers: Record<string, string>): boolean =>
	false

export const driveWebhookPreHandler = (
	_payload: unknown,
	_headers: Record<string, string>,
): { body: unknown; status?: number } | null => null

export const driveWebhookFanOut = async (
	_ctx: WebhookFanOutContext,
): Promise<NormalizedEvent[]> => []
