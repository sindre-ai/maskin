import { type PosthogEventProps, capturePosthogEvent as captureShared } from '@maskin/shared'
import { logger } from '../logger'

export type { PosthogEventProps }

// Thin wrapper over @maskin/shared's capturePosthogEvent that routes debug/warn
// through this app's Sentry-integrated logger. The shared helper defaults to
// console output so leaf packages (e.g. @maskin/email) can call it without
// pulling apps/dev in.
export async function capturePosthogEvent(
	event: string,
	distinctId: string,
	properties: PosthogEventProps,
): Promise<void> {
	return captureShared(event, distinctId, properties, {
		onSkip: (msg, ctx) => logger.debug(msg, ctx),
		onError: (msg, ctx) => logger.warn(msg, ctx),
	})
}
