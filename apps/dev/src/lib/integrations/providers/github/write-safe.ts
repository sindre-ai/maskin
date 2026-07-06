import type { Database } from '@maskin/db'
import { logger } from '../../../logger'
import { TokenManager } from '../../oauth/token-manager'
import { getProvider } from '../../registry'

export interface GithubWriteRequest {
	url: string
	method: 'POST' | 'PATCH' | 'PUT' | 'DELETE'
	body?: unknown
	headers?: Record<string, string>
}

/**
 * Wrap a GitHub REST write so that a 401 triggers exactly one token re-mint
 * and retry. All responses (including a second 401) are returned as-is for
 * the caller to handle.
 *
 * The re-mint step reuses {@link TokenManager.getValidToken} — the github
 * provider's customAuth flow always exchanges a fresh JWT for a fresh
 * installation token, so a second call after a 401 is a real re-mint rather
 * than a re-read of a cached value.
 */
export async function performGithubWrite(
	db: Database,
	integrationId: string,
	request: GithubWriteRequest,
): Promise<Response> {
	const attempt = async (): Promise<Response> => {
		const token = await mintFreshToken(db, integrationId)
		const hasBody = request.body !== undefined
		return fetch(request.url, {
			method: request.method,
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: 'application/vnd.github+json',
				'X-GitHub-Api-Version': '2022-11-28',
				...(hasBody ? { 'Content-Type': 'application/json' } : {}),
				...request.headers,
			},
			body: hasBody ? JSON.stringify(request.body) : undefined,
		})
	}

	const response = await attempt()
	if (response.status !== 401) {
		return response
	}

	logger.warn('GitHub write returned 401 — re-minting installation token and retrying once', {
		integrationId,
		url: request.url,
		method: request.method,
	})

	return attempt()
}

async function mintFreshToken(db: Database, integrationId: string): Promise<string> {
	const provider = getProvider('github')
	const manager = new TokenManager()
	return manager.getValidToken(db, integrationId, provider)
}
