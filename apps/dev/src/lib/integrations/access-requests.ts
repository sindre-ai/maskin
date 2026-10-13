import type { Database } from '@maskin/db'
import {
	INTEGRATION_STATUS_ACTIVE,
	type AccessRequest,
	type CredentialTier,
	accessRequests,
	actors,
	integrations,
	sessions,
	workspaceMembers,
} from '@maskin/db/schema'
import { and, count, desc, eq, sql } from 'drizzle-orm'
import { writeGrantAuditRow } from './grant-audit'
import { hasWorkspaceGrant, liveActorGrants } from './grants'

// Slice A of the access-request bet: an agent files a request for a credential it
// cannot read, and the server either files it (Tier 1) or refuses it. Every rule
// here is decided from the stored credential record and the caller's own identity.
// The reason text and the session id are stored and never read back into a decision.

export const MAX_OPEN_REQUESTS_PER_AGENT = 3
export const MAX_OPEN_REQUESTS_PER_WORKSPACE = 10
export const REQUEST_COOLDOWN_HOURS = 24
/** Agent-approved grants run one session or at most seven days. */
export const MAX_DURATION_HOURS = 7 * 24

export const TIER_REFUSAL_MESSAGE = 'Ask a human to mark this credential Tier 1.'

/** Unset counts as Tier 2, which Slice A refuses. */
export function effectiveTier(tier: number | null | undefined): CredentialTier {
	return tier === 1 || tier === 2 || tier === 3 ? tier : 2
}

export type ParsedDuration =
	| { ok: true; normalized: string; kind: 'session' }
	| { ok: true; normalized: string; kind: 'timed'; hours: number }
	| { ok: false; reason: 'form' | 'too_long' }

/** 'session', or a whole number of hours or days such as 2h or 3d. At most 7d. */
export function parseAccessDuration(input: string): ParsedDuration {
	const text = input.trim().toLowerCase()
	if (text === 'session') return { ok: true, normalized: 'session', kind: 'session' }
	const match = /^([1-9][0-9]{0,3})([hd])$/.exec(text)
	if (!match) return { ok: false, reason: 'form' }
	const hours = Number(match[1]) * (match[2] === 'd' ? 24 : 1)
	if (hours > MAX_DURATION_HOURS) return { ok: false, reason: 'too_long' }
	return { ok: true, normalized: `${match[1]}${match[2]}`, kind: 'timed', hours }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type FileRequestResult =
	| { outcome: 'filed'; request: AccessRequest }
	| { outcome: 'existing'; request: AccessRequest }
	| { outcome: 'refused_tier'; request: AccessRequest }
	| { outcome: 'cooldown' }
	| { outcome: 'cap_agent' }
	| { outcome: 'cap_workspace' }
	| { outcome: 'not_found' }

export interface FileRequestInput {
	workspaceId: string
	requesterActorId: string
	integrationId: string
	/** Already parsed with parseAccessDuration. */
	duration: string
	/** Stored as text. Never interpreted. */
	reason: string
	/** The X-Maskin-Session-Id header as received. A hint: it can only be stored, never decide. */
	sessionHint?: string | null
}

/**
 * Files one request, or refuses it. One transaction per workspace at a time (an
 * advisory lock), so the caps, the duplicate check and the cooldown cannot be
 * raced past by parallel calls. Order: duplicate, cooldown, tier, caps.
 *
 * A refusal by the route itself is stored as a denied request with no approver, so
 * the cooldown covers it and a stuck loop writes one row a day. A refusal writes
 * nothing to the audit chain; a filed request writes one grant_requested row.
 */
export async function fileAccessRequest(
	db: Database,
	input: FileRequestInput,
): Promise<FileRequestResult> {
	return db.transaction(async (tx) => {
		await tx.execute(
			sql`SELECT pg_advisory_xact_lock(hashtextextended(${`access_requests:${input.workspaceId}`}, 0))`,
		)

		// The tier is read from the credential record now. Nothing the caller sent decides it.
		const [credential] = await tx
			.select({ id: integrations.id, tier: integrations.tier, source: integrations.source })
			.from(integrations)
			.where(
				and(
					eq(integrations.id, input.integrationId),
					eq(integrations.workspaceId, input.workspaceId),
					eq(integrations.status, INTEGRATION_STATUS_ACTIVE),
				),
			)
			.limit(1)
		if (!credential) return { outcome: 'not_found' }

		const pair = and(
			eq(accessRequests.requesterActorId, input.requesterActorId),
			eq(accessRequests.integrationId, input.integrationId),
		)

		const [open] = await tx
			.select()
			.from(accessRequests)
			.where(and(pair, eq(accessRequests.status, 'requested')))
			.limit(1)
		if (open) return { outcome: 'existing', request: open }

		// A deny, a timeout (expired) or an error (stored as denied) opens a cooldown for this pair.
		const [recent] = await tx
			.select({ id: accessRequests.id })
			.from(accessRequests)
			.where(
				and(
					pair,
					sql`${accessRequests.status} IN ('denied', 'expired')`,
					sql`coalesce(${accessRequests.decidedAt}, ${accessRequests.createdAt}) > now() - make_interval(hours => ${REQUEST_COOLDOWN_HOURS})`,
				),
			)
			.limit(1)
		if (recent) return { outcome: 'cooldown' }

		const tier = effectiveTier(credential.tier)
		const sessionId = await resolveSessionHint(tx, input)
		const base = {
			workspaceId: input.workspaceId,
			requesterActorId: input.requesterActorId,
			integrationId: input.integrationId,
			tier,
			requestedDuration: input.duration,
			reason: input.reason,
			sessionId,
		}

		if (tier !== 1) {
			const [refused] = await tx
				.insert(accessRequests)
				.values({ ...base, status: 'denied', decidedAt: sql`now()` })
				.returning()
			if (!refused) throw new Error('access request insert returned no row')
			return { outcome: 'refused_tier', request: refused }
		}

		const openRows = await tx
			.select({ requester: accessRequests.requesterActorId, n: count() })
			.from(accessRequests)
			.where(
				and(
					eq(accessRequests.workspaceId, input.workspaceId),
					eq(accessRequests.status, 'requested'),
				),
			)
			.groupBy(accessRequests.requesterActorId)
		const forAgent = openRows.find((r) => r.requester === input.requesterActorId)?.n ?? 0
		const forWorkspace = openRows.reduce((sum, r) => sum + r.n, 0)
		if (forAgent >= MAX_OPEN_REQUESTS_PER_AGENT) return { outcome: 'cap_agent' }
		if (forWorkspace >= MAX_OPEN_REQUESTS_PER_WORKSPACE) return { outcome: 'cap_workspace' }

		const [filed] = await tx.insert(accessRequests).values(base).returning()
		if (!filed) throw new Error('access request insert returned no row')
		// A filed request is the first grant event on the chain. The refusals above write none.
		await writeGrantAuditRow(tx, {
			action: 'grant_requested',
			workspaceId: input.workspaceId,
			integrationId: input.integrationId,
			actorId: input.requesterActorId,
			source: credential.source,
			requestId: `access-request:${filed.id}:requested`,
			tier,
		})
		return { outcome: 'filed', request: filed }
	})
}

/**
 * The blocked run, stored for the sibling tasks that re-run it. Kept only when it
 * is a real session of this requester in this workspace; anything else is dropped
 * to null rather than rejected, because no decision may depend on it.
 */
async function resolveSessionHint(
	tx: Pick<Database, 'select'>,
	input: FileRequestInput,
): Promise<string | null> {
	const hint = input.sessionHint?.trim()
	if (!hint || !UUID.test(hint)) return null
	const [row] = await tx
		.select({ id: sessions.id })
		.from(sessions)
		.where(
			and(
				eq(sessions.id, hint.toLowerCase()),
				eq(sessions.workspaceId, input.workspaceId),
				eq(sessions.actorId, input.requesterActorId),
			),
		)
		.limit(1)
	return row?.id ?? null
}

export interface RequestableCredential {
	id: string
	name: string
	tier: CredentialTier
	requestable: boolean
	description: string
}

/**
 * What an agent can ask for: the active credentials in the workspace it cannot
 * already read. Name, tier and a one-line description. Never a value, a wrapped
 * key, a grant list or an approver.
 */
export async function listRequestableAccess(
	db: Database,
	workspaceId: string,
	actorId: string,
): Promise<RequestableCredential[]> {
	const rows = await db
		.select({
			id: integrations.id,
			provider: integrations.provider,
			providerMode: integrations.providerMode,
			displayName: integrations.displayName,
			tier: integrations.tier,
			scopeGrants: integrations.scopeGrants,
		})
		.from(integrations)
		.where(
			and(
				eq(integrations.workspaceId, workspaceId),
				eq(integrations.status, INTEGRATION_STATUS_ACTIVE),
			),
		)
		.orderBy(integrations.createdAt)

	return rows
		.filter((r) => !holdsGrant(r.scopeGrants, actorId))
		.map((r) => {
			const tier = effectiveTier(r.tier)
			return {
				id: r.id,
				name: r.displayName ?? r.provider,
				tier,
				requestable: tier === 1,
				description:
					r.providerMode === 'registered'
						? `${r.provider} connection`
						: `${r.provider} key (bring your own)`,
			}
		})
}

/** True when the actor, or the whole workspace, holds a grant that has not expired. */
function holdsGrant(grants: unknown, actorId: string): boolean {
	return hasWorkspaceGrant(grants) || liveActorGrants(grants, actorId, new Date()).length > 0
}

/** The workspace's CTO agent, the default Tier 1 approver. Null when there is none. */
export async function findDefaultApproverId(
	db: Pick<Database, 'select'>,
	workspaceId: string,
): Promise<string | null> {
	const [row] = await db
		.select({ id: actors.id })
		.from(actors)
		.innerJoin(workspaceMembers, eq(workspaceMembers.actorId, actors.id))
		.where(
			and(
				eq(workspaceMembers.workspaceId, workspaceId),
				eq(actors.type, 'agent'),
				sql`lower(${actors.name}) = 'cto'`,
			),
		)
		.orderBy(desc(actors.createdAt))
		.limit(1)
	return row?.id ?? null
}
