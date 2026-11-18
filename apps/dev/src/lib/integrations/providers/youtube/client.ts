import type { Database } from '@maskin/db'
import { logger } from '../../../logger'
import { TokenManager } from '../../oauth/token-manager'
import { getCachedRead, getPurgeEpoch, setCachedRead } from './cache'
import { YoutubeError, classifyYoutubeError } from './errors'
import { purgeYoutubeData } from './purge'
import { chargeYoutubeQuota } from './quota'
import { getYoutubeAccessToken, getYoutubeIntegrationId } from './token'

const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3'

export interface YoutubeClientContext {
	db: Database
	workspaceId: string
	/** The authenticated caller. The Keychain read is attributed to it. */
	actorId: string
}

export interface YoutubeRead {
	/** Tool name, part of the cache key. */
	tool: string
	/** Path under youtube/v3, for example channels. */
	path: string
	params: Record<string, string>
	/** Quota units the call costs. */
	units: number
}

/**
 * Thin fetch wrapper over youtube/v3. Order of operations:
 *  1. the active integration row (a revoked row never resolves),
 *  2. the cache, so a repeat read costs no quota,
 *  3. the quota guard, charged before the Google call and not refunded on failure,
 *  4. the call itself.
 * A 401 means the grant was revoked between refreshes: the row is marked revoked and the caller
 * gets RECONSENT_REQUIRED. Response bodies are never logged or put in an error: only the HTTP
 * status, Google's error reason and the integration id leave this file.
 */
export async function youtubeRead<T = unknown>(
	ctx: YoutubeClientContext,
	read: YoutubeRead,
): Promise<T> {
	const { db, workspaceId, actorId } = ctx
	const integrationId = await getYoutubeIntegrationId(db, workspaceId, actorId)

	const cached = getCachedRead(integrationId, read.tool, read.params)
	if (cached !== undefined) return cached as T

	const epoch = getPurgeEpoch(integrationId)
	await chargeYoutubeQuota(db, workspaceId, read.units)

	const accessToken = await getYoutubeAccessToken(db, integrationId, workspaceId)
	const url = `${YOUTUBE_API_BASE}/${read.path}?${new URLSearchParams(read.params).toString()}`

	let res: Response
	try {
		res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
	} catch {
		throw new YoutubeError({
			code: 'PROVIDER_ERROR',
			message: 'The YouTube API could not be reached.',
			integration_id: integrationId,
		})
	}

	if (!res.ok) {
		const bodyText = await res.text().catch(() => '')
		const error = classifyYoutubeError(
			res.status,
			bodyText,
			integrationId,
			res.headers.get('retry-after'),
		)
		if (res.status === 401) {
			try {
				await new TokenManager().markRevoked(db, integrationId)
			} catch (markErr) {
				// The caller still gets RECONSENT_REQUIRED; the next 401 retries the mark.
				logger.warn('Could not mark the YouTube integration revoked after a 401', {
					integrationId,
					error: markErr instanceof Error ? markErr.message : String(markErr),
				})
			}
			// Revoked on Google's side: the data we hold has to go too. Never throws.
			await purgeYoutubeData(db, { integrationId, workspaceId })
		}
		logger.info('YouTube API call failed', {
			integrationId,
			tool: read.tool,
			httpStatus: res.status,
			reason: error.reason,
		})
		throw error
	}

	const body = (await res.json()) as T
	setCachedRead(integrationId, read.tool, read.params, body, epoch)
	return body
}
