import { Sentry } from './sentry'

/** Tags any Sentry event raised under a live call with its `live_session_id`. */
export function withLiveSessionScope<T>(
	liveSessionId: string,
	fn: () => T | Promise<T>,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		Sentry.withScope((scope) => {
			scope.setTag('live_session_id', liveSessionId)
			try {
				Promise.resolve(fn()).then(resolve, reject)
			} catch (err) {
				reject(err)
			}
		})
	})
}

export function captureLiveException(liveSessionId: string, err: unknown): void {
	Sentry.withScope((scope) => {
		scope.setTag('live_session_id', liveSessionId)
		Sentry.captureException(err)
	})
}
