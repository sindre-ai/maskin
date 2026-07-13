import type { Database } from '@maskin/db'
import { integrations } from '@maskin/db/schema'
import { eq, sql } from 'drizzle-orm'
import { logger } from '../../../logger'
import type { IntegrationConfig } from '../../../types'
import type { PostInstallContext } from '../../types'

/**
 * Tiers we care about for feature gating. `unknown` covers a fresh install
 * where the probe hasn't run yet or a probe that failed — those degrade to
 * fail-open (paid behaviour) so a transient Slack API blip never blocks a
 * paying customer from using `assistant:write`. Only an explicit Free signal
 * blocks the call.
 */
export type SlackTier = 'free' | 'paid' | 'unknown'

export interface SlackTierCacheEntry {
	tier: SlackTier
	fetchedAt: number
}

export interface SlackIntegrationConfig extends IntegrationConfig {
	slackTierCache?: SlackTierCacheEntry
}

/** Refresh tier roughly once a day. Tier flips are a billing-cadence event. */
export const SLACK_TIER_CACHE_TTL_MS = 24 * 60 * 60 * 1000

const SLACK_API_BASE = 'https://slack.com/api'
const PROBE_TIMEOUT_MS = 10_000

/**
 * Required for `assistant:write` (the bot side panel / typing indicator API).
 * Slack only grants this scope on Pro / Business+ / Enterprise — the presence
 * of the scope in `apps.permissions.info` is the documented tier discriminator
 * for assistant-side features. Free workspaces silently drop the scope from
 * the granted set, even when requested in the manifest.
 */
const ASSISTANT_WRITE_SCOPE = 'assistant:write'

interface PermissionsInfoResponse {
	ok: boolean
	error?: string
	info?: {
		team?: { scopes?: string[] }
		channel?: { scopes?: string[] }
		user?: { scopes?: string[] }
	}
}

/**
 * Hit `apps.permissions.info` and decide which tier the workspace is on.
 * Free signal: ok=true and the response does NOT list `assistant:write` in
 * any of team/channel/user scopes. Anything else (paid scopes present, or
 * API error we can't classify) returns `unknown` — fail-open so a probe
 * failure never blocks a real paying workspace.
 */
export async function probeSlackTier(accessToken: string): Promise<SlackTier> {
	let res: Response
	try {
		res = await fetch(`${SLACK_API_BASE}/apps.permissions.info`, {
			headers: { Authorization: `Bearer ${accessToken}` },
			signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
		})
	} catch (err) {
		logger.warn('Slack tier probe: network error', {
			error: err instanceof Error ? err.message : String(err),
		})
		return 'unknown'
	}

	let body: PermissionsInfoResponse
	try {
		body = (await res.json()) as PermissionsInfoResponse
	} catch (err) {
		logger.warn('Slack tier probe: malformed response', {
			error: err instanceof Error ? err.message : String(err),
			status: res.status,
		})
		return 'unknown'
	}

	if (!body.ok) {
		logger.warn('Slack tier probe: API returned not-ok', { error: body.error ?? 'unknown' })
		return 'unknown'
	}

	const allScopes = [
		...(body.info?.team?.scopes ?? []),
		...(body.info?.channel?.scopes ?? []),
		...(body.info?.user?.scopes ?? []),
	]
	return allScopes.includes(ASSISTANT_WRITE_SCOPE) ? 'paid' : 'free'
}

/** True when the cache entry is present and fresher than the TTL. */
function isFresh(entry: SlackTierCacheEntry | undefined, now: number): boolean {
	if (!entry) return false
	return now - entry.fetchedAt < SLACK_TIER_CACHE_TTL_MS
}

/**
 * Synchronous gate read. Returns false only when we have a fresh cache entry
 * that explicitly says `free`. Unknown / stale / missing entries fail open
 * (returns true) so that a paying customer is never blocked by a probe miss;
 * the lazy refresher below populates the cache before a stale `free` re-reads
 * incorrectly.
 *
 * Callers that need the *current* tier (e.g. about to make a hot `assistant:write`
 * call) should `await refreshSlackTierIfStale(...)` first so the cache is fresh
 * before this check. The split is deliberate: the gate is sync and DB-free so
 * it can be called inside tight render paths (App Home view builder, unfurl
 * payload assembly) without an extra await.
 */
export function canUseAssistantWrite(
	integration: { config: unknown },
	now: number = Date.now(),
): boolean {
	const config = (integration.config as SlackIntegrationConfig | null) ?? {}
	const entry = config.slackTierCache
	if (!entry || !isFresh(entry, now)) return true
	return entry.tier !== 'free'
}

/**
 * Atomic field-level merge of the tier cache into `integrations.config`. Uses
 * `jsonb_set` so a concurrent writer touching a sibling key (e.g.
 * `system_actor_id`) is not clobbered — same pattern as gmail/watch.ts.
 */
async function writeTierCache(
	db: Database,
	integrationId: string,
	entry: SlackTierCacheEntry,
): Promise<void> {
	const json = JSON.stringify(entry)
	await db
		.update(integrations)
		.set({
			config: sql`jsonb_set(COALESCE(${integrations.config}, '{}'::jsonb), '{slackTierCache}', ${json}::jsonb, true)`,
			updatedAt: new Date(),
		})
		.where(eq(integrations.id, integrationId))
}

/**
 * Lazy refresher used by hot paths before they call the sync gate. If the
 * cache is already fresh this is a no-op (no DB write, no fetch). Otherwise
 * it probes Slack, writes the new entry, and mutates the in-memory
 * `integration.config.slackTierCache` so the caller's sync gate read sees
 * the new value without another DB round-trip.
 *
 * Errors from the probe are caught and logged — a probe failure leaves the
 * previous cache entry in place (so a stale `free` is not flipped to allow
 * by a transient API blip; the next successful probe will correct it).
 */
export async function refreshSlackTierIfStale(
	db: Database,
	integration: { id: string; config: unknown },
	accessToken: string,
	now: number = Date.now(),
): Promise<SlackTier> {
	const config = (integration.config as SlackIntegrationConfig | null) ?? {}
	const existing = config.slackTierCache
	if (existing && isFresh(existing, now)) return existing.tier

	const tier = await probeSlackTier(accessToken)
	if (tier === 'unknown' && existing) {
		// Probe failed and we still have a prior reading — keep the old entry,
		// don't write a fresh `unknown` that would flip a previous `free` to
		// fail-open until the next probe.
		logger.info('Slack tier probe returned unknown; keeping previous cache entry', {
			integrationId: integration.id,
			previousTier: existing.tier,
		})
		return existing.tier
	}

	const entry: SlackTierCacheEntry = { tier, fetchedAt: now }
	await writeTierCache(db, integration.id, entry)
	// Mutate the caller's in-memory copy so the immediately-following sync gate
	// read sees the new value without re-fetching the row.
	;(integration.config as SlackIntegrationConfig) = { ...config, slackTierCache: entry }
	logger.info('Slack tier cache refreshed', { integrationId: integration.id, tier })
	return tier
}

/**
 * `postInstall` hook — wired in registry.ts. Runs immediately after OAuth
 * stores the bot token so the cache is populated before the first webhook
 * arrives. Non-fatal on probe failure: an `unknown` install just means the
 * lazy refresher will retry on the first `assistant:write` attempt.
 */
export async function probeSlackTierOnInstall(ctx: PostInstallContext): Promise<void> {
	const accessToken = ctx.credentials.accessToken
	if (!accessToken) {
		logger.warn('Slack tier postInstall: no access token in credentials', {
			integrationId: ctx.integrationId,
		})
		return
	}
	const db = ctx.db as Database
	const tier = await probeSlackTier(accessToken)
	const entry: SlackTierCacheEntry = { tier, fetchedAt: Date.now() }
	await writeTierCache(db, ctx.integrationId, entry)
	logger.info('Slack tier cache seeded on install', { integrationId: ctx.integrationId, tier })
}
