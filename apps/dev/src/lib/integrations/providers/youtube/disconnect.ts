import type { Database } from '@maskin/db'
import { logger } from '../../../logger'
import { OAuth2Handler, TokenRequestError } from '../../oauth/handler'
import type { PreDisconnectContext } from '../../types'
import { config } from './config'
import { purgeYoutubeData } from './purge'

/**
 * preDisconnect for YouTube: revoke the Google grant, then clear every copy of YouTube data we
 * hold. Google wants the data gone within 7 days of a revoke and stored data within 30 days.
 *
 * The two steps sit in separate try blocks so the purge runs even when the revoke throws, and
 * neither throws out of here: the disconnect always completes. A revoke that fails leaves the
 * grant alive at Google until the person removes the app on their Google permissions page.
 * There is no retry.
 */
export async function revokeYoutubeGrant(ctx: PreDisconnectContext): Promise<void> {
	try {
		await revoke(ctx)
	} catch (err) {
		const status = err instanceof TokenRequestError ? err.status : undefined
		logger.warn('YouTube revoke failed (continuing with disconnect)', {
			integrationId: ctx.integrationId,
			status,
			// Not the message of a TokenRequestError: it carries Google's response body.
			error: err instanceof TokenRequestError ? undefined : errorMessage(err),
		})
	}

	try {
		await purgeYoutubeData(ctx.db as Database, {
			integrationId: ctx.integrationId,
			workspaceId: ctx.workspaceId,
		})
	} catch (err) {
		logger.warn('YouTube purge failed (continuing with disconnect)', {
			integrationId: ctx.integrationId,
			error: errorMessage(err),
		})
	}
}

async function revoke(ctx: PreDisconnectContext): Promise<void> {
	// Revoking the refresh token kills the whole grant. Fall back to the access token if no
	// refresh token is stored.
	const token = ctx.credentials.refreshToken ?? ctx.credentials.accessToken
	if (!token) {
		logger.warn('YouTube disconnect: no token to revoke', { integrationId: ctx.integrationId })
		return
	}
	if (config.auth.type !== 'oauth2') {
		throw new Error('YouTube provider config is not oauth2')
	}

	try {
		await new OAuth2Handler(config.auth.config).revokeToken(token)
		logger.info('YouTube grant revoked', { integrationId: ctx.integrationId })
	} catch (err) {
		// Already expired or revoked: the grant is gone, which is what we wanted.
		if (
			err instanceof TokenRequestError &&
			err.status === 400 &&
			err.oauthError === 'invalid_token'
		) {
			logger.info('YouTube grant was already revoked at Google', {
				integrationId: ctx.integrationId,
			})
			return
		}
		throw err
	}
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err)
}
