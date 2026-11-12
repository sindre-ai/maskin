import { createHash } from 'node:crypto'
import type { Database } from '@maskin/db'
import { actors, workspaces } from '@maskin/db/schema'
import { featureAreaForEvent } from '@maskin/shared'
import { eq } from 'drizzle-orm'
import { logger } from '../logger'
import { admitPosthogEvent } from './event-budget'
import { isPayingWorkspace } from './paying-workspace'
import {
	__resetTeamMemberForTesting,
	configureTeamMember,
	isInternalWorkspace,
	isTeamActor,
} from './team-member'

const DEFAULT_POSTHOG_HOST = 'https://eu.i.posthog.com'
const CAPTURE_TIMEOUT_MS = 2_000

// One level of plain values is allowed as an object, for PostHog's own `$set` and
// `$group_set` property bags.
type PosthogScalar = string | number | boolean | null
export type PosthogEventProps = Record<
	string,
	PosthogScalar | undefined | string[] | number[] | Record<string, PosthogScalar>
>

export interface WorkspacePrivacy {
	shareUsage: boolean
	anonymize: boolean
	// Whether the workspace has an active paid plan. Read in the same row as the
	// privacy settings, so it costs no extra query.
	paying: boolean
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
 * Who an event is about. 'human' keeps the value the web and the saved insights
 * already use (actor_type = 'human' on file_saved and object_updated).
 */
export type PosthogActorType = 'human' | 'agent' | 'trigger' | 'system'

const ACTOR_TYPES: readonly string[] = ['human', 'agent', 'trigger', 'system']
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// An actor never changes type, so a long window is safe; the cap bounds memory.
const ACTOR_TYPE_CACHE_TTL_MS = 10 * 60_000
const ACTOR_TYPE_CACHE_CAP = 2_000

type ActorTypeReader = (actorId: string) => Promise<PosthogActorType>
type ActorTypeEntry = { expiresAt: number; value: Promise<PosthogActorType> }

let readActorType: ActorTypeReader | null = null
const actorTypeCache = new Map<string, ActorTypeEntry>()

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
			paying: isPayingWorkspace(row.settings),
		}
	}
	actorTypeCache.clear()
	readActorType = async (actorId) => {
		const [row] = await db
			.select({ type: actors.type })
			.from(actors)
			.where(eq(actors.id, actorId))
			.limit(1)
		if (row?.type === 'human' || row?.type === 'agent') return row.type
		return 'system'
	}
	configureTeamMember(db)
}

/** Test-only: drops the lookups and their caches. */
export function __resetPosthogPrivacyForTesting(): void {
	readPrivacy = null
	privacyCache.clear()
	readActorType = null
	actorTypeCache.clear()
	__resetTeamMemberForTesting()
}

/**
 * The actor type of an event: what the caller set, else 'trigger' for trigger_*
 * events, else the type of the actor the distinct id names. A distinct id that
 * is not an actor (a workspace, a session, a customer) is the system.
 */
async function resolveActorType(
	event: string,
	distinctId: string,
	properties: PosthogEventProps,
): Promise<PosthogActorType> {
	const given = properties.actor_type
	if (typeof given === 'string' && ACTOR_TYPES.includes(given)) return given as PosthogActorType
	if (event.startsWith('trigger_')) return 'trigger'
	const reader = readActorType
	if (!reader || !UUID_RE.test(distinctId)) return 'system'
	const now = Date.now()
	let entry = actorTypeCache.get(distinctId)
	if (!entry || entry.expiresAt <= now) {
		const created: ActorTypeEntry = {
			expiresAt: now + ACTOR_TYPE_CACHE_TTL_MS,
			value: reader(distinctId),
		}
		entry = created
		actorTypeCache.set(distinctId, created)
		// A failed read must not be served for the rest of the window.
		created.value.catch(() => {
			if (actorTypeCache.get(distinctId) === created) actorTypeCache.delete(distinctId)
		})
		if (actorTypeCache.size > ACTOR_TYPE_CACHE_CAP) {
			for (const [k, e] of actorTypeCache) {
				if (e.expiresAt <= now) actorTypeCache.delete(k)
			}
		}
	}
	try {
		return await entry.value
	} catch {
		// Sent as the system: no profile is created for a type we could not read.
		return 'system'
	}
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

const WORKSPACE_GROUP_TYPE = 'workspace'

/**
 * The properties that tie an event to its account and its product area: the
 * `workspace` group when the event names a workspace, and `feature_area` when the
 * event belongs to one. A value the caller set wins.
 */
function sharedAccountProperties(event: string, properties: PosthogEventProps): PosthogEventProps {
	const out: PosthogEventProps = {}
	const workspaceId = properties.workspace_id
	if (typeof workspaceId === 'string' && UUID_RE.test(workspaceId) && !properties.$groups) {
		out.$groups = { [WORKSPACE_GROUP_TYPE]: workspaceId }
	}
	if (properties.feature_area === undefined) {
		const area = featureAreaForEvent(event)
		if (area) out.feature_area = area
	}
	return out
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
 * Volume: each event name is sampled or capped per UTC day, see
 * `event-budget.ts`; tier 1 events are never touched.
 *
 * Shared properties: every event carries `surface: 'backend'`, an `actor_type`
 * (human, agent, trigger or system) and `is_team` (a plain boolean, true only for
 * a human member of our own workspace, see `team-member.ts`). It also carries two
 * plain booleans about the workspace: `internal` (the workspace is one of ours) and
 * `paying` (it has an active paid plan). An event with no `workspace_id`, or whose
 * workspace cannot be read, is sent with both false. Events whose actor
 * is not a human are sent with the person-profile flag off, so only people get a
 * profile. An event with a `workspace_id` is attached to that workspace's `workspace`
 * group, and one that belongs to a product area (see `featureAreaForEvent`) carries
 * `feature_area`; a caller that sets either itself keeps its value.
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
	const admission = admitPosthogEvent(event)
	if (!admission.send) return
	const host = process.env.POSTHOG_HOST?.trim() || DEFAULT_POSTHOG_HOST

	let outId = distinctId
	let paying = false
	let outProps: PosthogEventProps = admission.sampleRate
		? { ...properties, sample_rate: admission.sampleRate }
		: properties
	try {
		const workspaceId = properties.workspace_id
		if (typeof workspaceId === 'string' && workspaceId.trim()) {
			const privacy = await cachedPrivacy(workspaceId)
			if (!privacy.shareUsage) {
				logger.debug('PostHog capture skipped — workspace share-usage is off', { event })
				return
			}
			paying = privacy.paying
			if (privacy.anonymize) {
				outId = hashDistinctId(distinctId)
				outProps = stripIdentifiers(outProps)
			}
		}
	} catch (err) {
		logger.warn('PostHog capture skipped — workspace privacy setting unreadable', {
			event,
			error: String(err),
		})
		return
	}

	// Every event says where it came from and who acted. Only people get a
	// profile: an agent, trigger or system id as the person is one profile each.
	const actorType = await resolveActorType(event, distinctId, properties)
	outProps = {
		...outProps,
		surface: 'backend',
		actor_type: actorType,
		is_team: await isTeamActor(distinctId, actorType),
		internal: isInternalWorkspace(
			typeof properties.workspace_id === 'string' ? properties.workspace_id : null,
		),
		paying,
		...sharedAccountProperties(event, properties),
		...(actorType === 'human' ? {} : { $process_person_profile: false }),
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
