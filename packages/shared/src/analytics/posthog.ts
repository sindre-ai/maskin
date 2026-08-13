const DEFAULT_POSTHOG_HOST = 'https://eu.i.posthog.com'
const CAPTURE_TIMEOUT_MS = 2_000

export type PosthogEventProps = Record<
	string,
	string | number | boolean | null | undefined | string[]
>

export interface PosthogCaptureOptions {
	// Called when the request fails or returns non-2xx. Defaults to console.warn
	// so leaf packages don't have to depend on an app-layer logger.
	onError?: (message: string, context: Record<string, unknown>) => void
	// Called when POSTHOG_API_KEY is unset. Defaults to console.debug.
	onSkip?: (message: string, context: Record<string, unknown>) => void
}

/**
 * Best-effort PostHog capture that runs from any package.
 *
 * Contract: never throws, never blocks the caller. If `POSTHOG_API_KEY` is
 * unset (local dev, CI without analytics), we call `onSkip` and return. If the
 * request fails, we call `onError` — the caller's happy path still succeeded.
 */
export async function capturePosthogEvent(
	event: string,
	distinctId: string,
	properties: PosthogEventProps,
	opts?: PosthogCaptureOptions,
): Promise<void> {
	const onSkip = opts?.onSkip ?? ((m, c) => console.debug(m, c))
	const onError = opts?.onError ?? ((m, c) => console.warn(m, c))

	const apiKey = process.env.POSTHOG_API_KEY?.trim()
	if (!apiKey) {
		onSkip('PostHog capture skipped — POSTHOG_API_KEY unset', { event, distinctId })
		return
	}
	const host = process.env.POSTHOG_HOST?.trim() || DEFAULT_POSTHOG_HOST

	const body = {
		api_key: apiKey,
		event,
		distinct_id: distinctId,
		properties,
		timestamp: new Date().toISOString(),
	}

	try {
		const res = await fetch(`${host.replace(/\/$/, '')}/i/v0/e/`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(CAPTURE_TIMEOUT_MS),
		})
		if (!res.ok) {
			onError('PostHog capture non-2xx', { event, distinctId, status: res.status })
		}
	} catch (err) {
		onError('PostHog capture failed', { event, distinctId, error: String(err) })
	}
}
