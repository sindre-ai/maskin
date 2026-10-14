import { logger } from '../../../logger'
import { OAuth2Handler } from '../../oauth/handler'
import type { PreDisconnectContext } from '../../types'
import { config } from './config'
import { stopDriveChannel } from './watch'

/**
 * preDisconnect: stop the row's notification channel (channels.stop, which
 * needs a live token, so it goes first), then revoke the Google grant at the
 * revoke URL before the row is removed, so the grant disappears from the user's
 * Google account when Maskin stops trusting it. Revoking the refresh token kills
 * every derived access token; fall back to the access token if no refresh token
 * is stored.
 *
 * Best-effort: errors are logged and swallowed so disconnect always succeeds.
 */
export async function revokeDriveGrant(ctx: PreDisconnectContext): Promise<void> {
	await stopDriveChannel(ctx)
	try {
		const token = ctx.credentials.refreshToken ?? ctx.credentials.accessToken
		if (!token) {
			logger.warn('Google Drive disconnect: no token to revoke', {
				integrationId: ctx.integrationId,
			})
			return
		}
		if (config.auth.type === 'oauth2') {
			await new OAuth2Handler(config.auth.config).revokeToken(token)
			logger.info('Google Drive grant revoked', { integrationId: ctx.integrationId })
		}
	} catch (err) {
		logger.warn('Google Drive revoke failed (continuing with disconnect)', {
			integrationId: ctx.integrationId,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}
