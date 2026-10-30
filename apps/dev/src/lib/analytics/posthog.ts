import { createHash } from 'node:crypto'
import type { Database } from '@maskin/db'
import { workspaces } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { logger } from '../logger'

const DEFAULT_POSTHOG_HOST = 'https://eu.i.posthog.com'
const CAPTURE_TIMEOUT_MS = 2_000

export type PosthogEventProps = Record<
	string,
	string | number | boolean | null | undefined | string[] | number[]
>

export interface WorkspacePrivacy {
	shareUsage: boolean
	anonymize: boolean
}

// How long a workspace's privacy read is reused. Short enough that flipping the
// switch in Settings takes effect within a minute; long enough that a burst of
// events (session completed, Slack send) costs one query, not one per event.
const PRIVACY_CACHE_TTL_MS = 30_000
const PRIVACY_CACHE_CAP = 1_000

type PrivacyReader = (workspaceId: string) => Promise<WorkspacePrivacy>
type PrivacyEntry = { expiresAt: number; value: Promise<WorkspacePrivacy> }

let readPrivacy: PrivacyReader | null = null
const privacyCache = new Map<string, PrivacyEntry>()

/**
 * Wires the workspace privacy lookup to the database. Called once at startup.
 * Until it is called, no workspace-scoped event leaves the process: the web
 * honours the same two settings, and an unreadable setting must not mean "send".
 */
export function configurePosthogPrivacy(db: Database): void {
	privacyCache.clear()
	readPrivacy = async (workspaceId) => {
		const [row] = await db
			.select({ settings: workspaces.settings })
			.from(workspaces)
			.where(eq(workspaces.id, workspaceId))
			.limit(1)
		// A deleted workspace has no setting to read, so nothing to send for.
		if (!row) throw new Error('workspace not found')
		// Same defaults as the settings schema and the web: sharing on, anonymise off.
		const privacy = (row.settings as { privacy?: Record<string, unknown> } | null)?.privacy
		return {
			shareUsage: privacy?.share_usage !== false,
			anonymize: privacy?.anonymize_workspace === true,
		}
	}
}

/** Test-only: drops the lookup and its cache. */
export function __resetPosthogPrivacyForTesting(): void {
	readPrivacy = null
	privacyCache.clear()
}

function cachedPrivacy(workspaceId: string): Promise<WorkspacePrivacy> {
	const reader = readPrivacy
	if (!reader) return Promise.reject(new Error('privacy lookup not configured'))
	const now = Date.now()
	const hit = privacyCache.get(workspaceId)
	if (hit && hit.expiresAt > now) return hit.value

	const value = reader(workspaceId)
	const entry: PrivacyEntry = { expiresAt: now + PRIVACY_CACHE_TTL_MS, value }
	privacyCache.set(workspaceId, entry)
	// A failed read must not be served for the rest of the window.
	value.catch(() => {
		if (privacyCache.get(workspaceId) === entry) privacyCache.delete(workspaceId)
	})
	if (privacyCache.size > PRIVACY_CACHE_CAP) {
		for (const [k, e] of privacyCache) {
			if (e.expiresAt <= now) privacyCache.delete(k)
		}
	}
	return value
}

// Direct identifiers a person or workspace owner typed: names and emails.
// Ids stay, as on the web, because the joins key off them.
const IDENTIFYING_KEY =
	/(^|_)email$|^(name|username|real_name|display_name|workspace_name|agent_name)$/

function stripIdentifiers(properties: PosthogEventProps): PosthogEventProps {
	return Object.fromEntries(
		Object.entries(properties).filter(([key]) => !IDENTIFYING_KEY.test(key)),
	)
}

// Same treatment as the web (hashDistinctId in apps/web/src/lib/posthog.ts).
function hashDistinctId(value: string): string {
	return createHash('sha256').update(value).digest('hex')
}

/**
 * One warn-level line at startup when production has no PostHog key.
 * `capturePosthogEvent` returns silently without it (debug log only), so a
 * missing key otherwise reads as "analytics healthy, nothing happened". A log
 * line only: it cannot detect a key that is set but over its billing limit.
 */
export function warnIfPosthogKeyUnset(): void {
	if (process.env.NODE_ENV !== 'production') return
	if (process.env.POSTHOG_API_KEY?.trim()) return
	logger.warn('POSTHOG_API_KEY is unset in production — all backend analytics events are dropped')
}

/**
 * Best-effort PostHog capture from the backend.
 *
 * Why this exists instead of `posthog-node`: there is exactly one call site
 * today (the Slack send path) and adding a queueing client for a single
 * fire-and-forget event is more rope than it earns. A raw fetch against
 * PostHog's `/i/v0/e/` ingestion endpoint is enough.
 *
 * Privacy: an event that carries a `workspace_id` property follows that
 * workspace's Privacy & data settings, as the web does. Share-usage off sends
 * nothing; anonymise on hashes the distinct id and drops names and emails. If the
 * setting cannot be read the event is dropped (fail closed). Events with no
 * `workspace_id` (billing customers, install telemetry) have no workspace
 * setting to honour and are sent as before.
 *
 * Contract: never throws, never blocks the caller. If `POSTHOG_API_KEY` is
 * unset (local dev, CI without analytics), we log once at debug and return.
 * If the request fails, we log at warn — the agent's Slack post still
 * succeeded, the analytics gap is a follow-up.
 */
export async function capturePosthogEvent(
	event: string,
	distinctId: string,
	properties: PosthogEventProps,
): Promise<void> {
	const apiKey = process.env.POSTHOG_API_KEY?.trim()
	if (!apiKey) {
		logger.debug('PostHog capture skipped — POSTHOG_API_KEY unset', { event, distinctId })
		return
	}
	// PostHog silently DROPS events with an empty distinct id — the ingestion
	// endpoint still answers 2xx, so the request looks successful and nothing is
	// logged. A caller that can produce an empty id (e.g. `POST /mcp` with
	// neither an API key nor a workspace header, where both default to '') would
	// otherwise read as traced while its rows never exist. Skip the guaranteed
	// no-op and say so.
	if (!distinctId.trim()) {
		logger.debug('PostHog capture skipped — empty distinct id', { event })
		return
	}
	const host = process.env.POSTHOG_HOST?.trim() || DEFAULT_POSTHOG_HOST

	let outId = distinctId
	let outProps = properties
	try {
		const workspaceId = properties.workspace_id
		if (typeof workspaceId === 'string' && workspaceId.trim()) {
			const privacy = await cachedPrivacy(workspaceId)
			if (!privacy.shareUsage) {
				logger.debug('PostHog capture skipped — workspace share-usage is off', { event })
				return
			}
			if (privacy.anonymize) {
				outId = hashDistinctId(distinctId)
				outProps = stripIdentifiers(properties)
			}
		}
	} catch (err) {
		logger.warn('PostHog capture skipped — workspace privacy setting unreadable', {
			event,
			error: String(err),
		})
		return
	}

	const body = {
		api_key: apiKey,
		event,
		distinct_id: outId,
		properties: outProps,
		timestamp: new Date().toISOString(),
	}

	try {
		const res = await fetch(`${host.replace(/\/$/, '')}/i/v0/e/`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(CAPTURE_TIMEOUT_MS),
		})
		if (!res.ok) {
			logger.warn('PostHog capture non-2xx', { event, distinctId, status: res.status })
		}
	} catch (err) {
		logger.warn('PostHog capture failed', { event, distinctId, error: String(err) })
	}
}
