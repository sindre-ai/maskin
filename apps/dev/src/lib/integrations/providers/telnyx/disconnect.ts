import { logger } from '../../../logger'
import type { PreDisconnectContext } from '../../types'

/**
 * preDisconnect hook: revoke the Telnyx API key server-side so a disconnected
 * workspace leaves no live credential behind (DELETE /v2/api_keys/{id}).
 *
 * Best-effort, like the other providers' hooks: any failure is logged and the
 * local disconnect still goes through. The key id has to be stored next to the
 * key as credentials.apiKeyId; without it there is nothing addressable to
 * revoke, so the hook logs and returns.
 */
export async function revokeTelnyxApiKey(ctx: PreDisconnectContext): Promise<void> {
	const apiKey = ctx.credentials.accessToken
	const apiKeyId = ctx.credentials.apiKeyId
	if (!apiKey || typeof apiKeyId !== 'string' || apiKeyId === '') {
		logger.warn('telnyx disconnect: no api key id stored, key not revoked', {
			integrationId: ctx.integrationId,
		})
		return
	}
	try {
		const res = await fetch(`https://api.telnyx.com/v2/api_keys/${encodeURIComponent(apiKeyId)}`, {
			method: 'DELETE',
			headers: { Authorization: `Bearer ${apiKey}` },
			signal: AbortSignal.timeout(10_000),
		})
		// 404: already gone upstream, which is the state we wanted.
		if (!res.ok && res.status !== 404) {
			logger.error('telnyx disconnect: api key revoke failed', {
				integrationId: ctx.integrationId,
				status: res.status,
			})
		}
	} catch (err) {
		logger.error('telnyx disconnect: api key revoke errored', {
			integrationId: ctx.integrationId,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}
