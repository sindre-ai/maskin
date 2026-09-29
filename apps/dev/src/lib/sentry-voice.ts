import { Sentry } from './sentry'

// Sentry tagging helper for the [Voice v1 bet]
// (https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/16bd0042-ff3d-4056-839c-410b0cd6f06e).
//
// The four voice surfaces that should carry the voice_session_id tag on any
// Sentry event: 5xx from voice routes, WS handshake failures on
// /api/voice-sessions/:id/events, tool-proxy exceptions on the same WS, and
// vendor `error` events from OpenAI Realtime. Each of those code paths lands
// in a follow-up commit alongside the hangup route + sweeper — this helper
// scaffolds the tag surface so those paths have one place to reach for it.

/**
 * Wrap a code block that runs inside a voice session so any Sentry event
 * captured under it carries the `voice_session_id` tag. Uses Sentry's
 * `withScope` isolation so the tag does not leak to unrelated events on the
 * same request.
 *
 * Zero cost when Sentry is uninitialised — `withScope` and `scope.setTag`
 * are safe no-ops on an unconfigured client (see `apps/dev/src/lib/sentry.ts`).
 */
export function withVoiceSessionScope<T>(
	voiceSessionId: string,
	fn: () => T | Promise<T>,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		Sentry.withScope((scope) => {
			scope.setTag('voice_session_id', voiceSessionId)
			try {
				Promise.resolve(fn()).then(resolve, reject)
			} catch (err) {
				reject(err)
			}
		})
	})
}

/**
 * Capture an exception with the `voice_session_id` tag attached, without
 * wrapping the caller in a scope. Use this on synchronous error paths where
 * the surrounding scope is short-lived (e.g. a vendor error event handler
 * that fires once and returns).
 */
export function captureVoiceException(voiceSessionId: string, err: unknown): void {
	Sentry.withScope((scope) => {
		scope.setTag('voice_session_id', voiceSessionId)
		Sentry.captureException(err)
	})
}
