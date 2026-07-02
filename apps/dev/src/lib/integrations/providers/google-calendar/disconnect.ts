import { logger } from '../../../logger'
import { OAuth2Handler } from '../../oauth/handler'
import type { PreDisconnectContext } from '../../types'
import { config } from './config'

/**
 * Revoke the Google OAuth grant for a Google Calendar integration before the
 * row flips to `revoked`. Wired via the `preDisconnect` provider hook so the
 * grant disappears from the user's Google account at the same moment Maskin
 * stops trusting the credentials — without this, the token would still be
 * usable until it expires naturally.
 *
 * Best-effort: errors are logged and swallowed so the generic disconnect path
 * always succeeds (matches `stopGmailWatch`'s contract).
 */
export async function revokeGoogleCalendarGrant(ctx: PreDisconnectContext): Promise<void> {
	try {
		const credentials = ctx.credentials
		// Revoking the refresh token kills the whole grant (Google revokes all
		// derived access tokens). Fall back to the access token if a refresh
		// token isn't stored — still revokes that single token.
		const token = credentials.refreshToken ?? credentials.accessToken
		if (!token) {
			logger.warn('Google Calendar disconnect: no token to revoke', {
				integrationId: ctx.integrationId,
			})
			return
		}

		if (config.auth.type === 'oauth2') {
			const handler = new OAuth2Handler(config.auth.config)
			await handler.revokeToken(token)
			logger.info('Google Calendar grant revoked', { integrationId: ctx.integrationId })
		}
	} catch (err) {
		logger.warn('Google Calendar revoke failed (continuing with disconnect)', {
			integrationId: ctx.integrationId,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}
