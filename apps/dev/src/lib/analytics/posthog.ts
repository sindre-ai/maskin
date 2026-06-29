import { logger } from '../logger'

const DEFAULT_POSTHOG_HOST = 'https://eu.i.posthog.com'
const CAPTURE_TIMEOUT_MS = 2_000

export type PosthogEventProps = Record<string, string | number | boolean | null | undefined>

/**
 * Best-effort PostHog capture from the backend.
 *
 * Why this exists instead of `posthog-node`: there is exactly one call site
 * today (the Slack send path) and adding a queueing client for a single
 * fire-and-forget event is more rope than it earns. A raw fetch against
 * PostHog's `/i/v0/e/` ingestion endpoint is enough.
 *
 * Contract: never throws, never blocks the caller. If `POSTHOG_API_KEY` is
 * unset (local dev, CI without analytics), we log once at debug and return.
 * If the request fails, we log at warn — the agent's Slack post still
 * succeeded, the analytics gap is a follow-up.
 */
export async function capturePosthogEvent(
	event: string,
	distinctId: string,
	properties: PosthogEventProps,
	options: { timestamp?: Date } = {},
): Promise<void> {
	const apiKey = process.env.POSTHOG_API_KEY?.trim()
	if (!apiKey) {
		logger.debug('PostHog capture skipped — POSTHOG_API_KEY unset', { event, distinctId })
		return
	}
	const host = process.env.POSTHOG_HOST?.trim() || DEFAULT_POSTHOG_HOST

	const body = {
		api_key: apiKey,
		event,
		distinct_id: distinctId,
		properties,
		timestamp: (options.timestamp ?? new Date()).toISOString(),
	}

	try {
		const res = await fetch(`${host.replace(/\/$/, '')}/i/v0/e/`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(CAPTURE_TIMEOUT_MS),
		})
		if (!res.ok) {
			logger.warn('PostHog capture non-2xx', { event, distinctId, status: res.status })
		}
	} catch (err) {
		logger.warn('PostHog capture failed', { event, distinctId, error: String(err) })
	}
}
