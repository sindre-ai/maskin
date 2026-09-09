import type { Database } from '@maskin/db'
import { logger } from '../../../logger'
import { TokenManager } from '../../oauth/token-manager'
import { getProvider } from '../../registry'

/**
 * Per-integration mint + retry-on-401 shim used by the Maskin-owned GitHub MCP
 * server (see `mcp-server.ts` / `routes/integrations-github-mcp.ts`). Replaces
 * the third-party `@modelcontextprotocol/server-github` stdio subprocess that
 * carried a token baked into its env once at session launch — that token expired
 * exactly one hour later (GitHub App installation token TTL) with no way to
 * refresh it from outside the subprocess, so any long-running session (Code
 * Reviewer's `pnpm test` + Playwright, 10-20 min) silently 401'd on every write
 * past the mint moment.
 *
 * Shape:
 *   - `getGithubToken` returns a cached token, or mints one via
 *     `TokenManager.getValidToken` (which internally calls
 *     `mintInstallationTokenWithRecovery` for the github provider). The cache
 *     is process-wide, keyed on integration id, with a 50-minute soft TTL —
 *     well inside GitHub's own 60-minute hard TTL so the retry-on-401 path is
 *     a safety net, not the primary refresh mechanism.
 *   - `remintGithubToken` forces a fresh mint, increments a per-integration
 *     re-mint counter, and logs it — that log line is the observability signal
 *     the parent insight requires ("expect >0 within a week; if 0, the shim
 *     isn't wired in").
 *
 * The retry-once-on-401 loop itself lives in `mcp-server.ts` at each tool's
 * fetch site so a 401 can be distinguished from other 4xx/5xx classes without
 * this module owning the transport.
 */

interface CachedToken {
	token: string
	mintedAt: number
}

// Cache tokens up to 50 minutes — GitHub App installation tokens live exactly
// 60 minutes with no refresh, so 50 leaves a 10-minute buffer for the retry
// path to catch any drift between our mint clock and GitHub's.
const TOKEN_CACHE_TTL_MS = 50 * 60 * 1000

const tokenCache = new Map<string, CachedToken>()
const remintCounts = new Map<string, number>()

export async function getGithubToken(db: Database, integrationId: string): Promise<string> {
	const existing = tokenCache.get(integrationId)
	if (existing && Date.now() - existing.mintedAt < TOKEN_CACHE_TTL_MS) {
		return existing.token
	}
	return mintAndCache(db, integrationId, { reason: 'cache-miss' })
}

/**
 * Force a fresh mint, invalidating any cached token first. Called by the MCP
 * server on 401 to distinguish token freshness (recoverable) from a scope /
 * permissions bug (retry hits 401 again — surface as terminal).
 */
export async function remintGithubToken(db: Database, integrationId: string): Promise<string> {
	tokenCache.delete(integrationId)
	const next = (remintCounts.get(integrationId) ?? 0) + 1
	remintCounts.set(integrationId, next)
	logger.info('GitHub MCP: re-minted token after 401', {
		integrationId,
		remintCount: next,
	})
	return mintAndCache(db, integrationId, { reason: 'remint-on-401' })
}

async function mintAndCache(
	db: Database,
	integrationId: string,
	opts: { reason: 'cache-miss' | 'remint-on-401' },
): Promise<string> {
	const provider = getProvider('github')
	const tokenManager = new TokenManager()
	const token = await tokenManager.getValidToken(db, integrationId, provider)
	tokenCache.set(integrationId, { token, mintedAt: Date.now() })
	if (opts.reason === 'cache-miss') {
		logger.debug('GitHub MCP: minted token (cache miss)', { integrationId })
	}
	return token
}

/**
 * Test-only helper — clears both the token cache and the per-integration remint
 * counter so tests don't leak state across `it()` blocks. Not exported through
 * the module's normal callers.
 */
export function _resetGithubTokenCacheForTests(): void {
	tokenCache.clear()
	remintCounts.clear()
}

/**
 * Test / observability helper — returns the current re-mint counter for a
 * given integration. Used by the 401-retry unit test to assert the counter
 * ticked exactly once per re-mint event.
 */
export function getRemintCountForTests(integrationId: string): number {
	return remintCounts.get(integrationId) ?? 0
}
