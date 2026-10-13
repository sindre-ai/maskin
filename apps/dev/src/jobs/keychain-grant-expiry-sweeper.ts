import type { Database } from '@maskin/db'
import { Cron } from 'croner'
import { sql } from 'drizzle-orm'
import { insertCredentialAccessLog } from '../lib/integrations/credential-audit'
import { formatCredentialLogDetail } from '../lib/integrations/credential-log-detail'
import { logger } from '../lib/logger'

/**
 * Keychain grant expiry sweeper.
 *
 * Expiry itself needs no job: getCredential and the launch-time env build each
 * ignore an actor grant whose expiresAt has passed (see isGrantExpired). This job
 * only puts the end of each grant on the audit chain, as one grant_expired row.
 * It never edits scope_grants, so the expired entry stays in place as the record.
 *
 * One row per expired grant, never twice. Each grant is written in its own
 * transaction that first takes an advisory lock keyed on the grant id and then
 * re-checks the log for a grant_expired row naming that grant, so two overlapping
 * runs, or two app instances, cannot both write it. A run that finds nothing
 * new writes nothing.
 *
 * Only entries that carry both expiresAt and grantId are swept: the grant id is
 * how the row is tied to its grant. Entries made by an access request always
 * carry both.
 *
 * The detail text comes from the single canonical writer. approver and tier come
 * from the access request that made the grant, when there is one.
 *
 * Scheduler: croner, same as the pending-undo sweeper. The sweeper judges expiry by
 * the database clock, so a row can trail expiresAt by up to a minute. An expiresAt
 * that does not parse is refused at read time (isGrantExpired fails closed) but is
 * never logged here, because it has no time to log.
 */
const CRON_EXPRESSION = '* * * * *'
const BATCH_LIMIT = 200

export const GRANT_EXPIRED_ACTION = 'grant_expired'

// An entry whose ids are not uuids could never be written to the log. Leaving it out of
// the query keeps one damaged entry from being retried, and from holding a batch slot, forever.
const UUID_RE = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'

interface Candidate extends Record<string, unknown> {
	workspace_id: string
	integration_id: string
	source: string
	actor_id: string
	grant_id: string
}

/** True when the log already holds a grant_expired row for this grant. */
const alreadyLoggedPredicate = sql`
	EXISTS (
		SELECT 1 FROM credential_access_log l
		WHERE l.integration_id = i.id
			AND l.action = 'grant_expired'
			AND position(';grant=' || lower(g.entry->>'grantId') || ';' in l.detail) > 0
	)
`

/** Actor grants that carry expiresAt and grantId, are expired by the database clock, and are not yet on the chain. */
export const candidateStatement = sql`
	SELECT i.workspace_id::text AS workspace_id, i.id::text AS integration_id, i.source AS source,
		g.entry->>'actorId' AS actor_id, g.entry->>'grantId' AS grant_id
	FROM integrations i
	CROSS JOIN LATERAL jsonb_array_elements(i.scope_grants) AS g(entry)
	WHERE g.entry->>'kind' = 'actor'
		AND g.entry->>'grantId' ~* ${UUID_RE}
		AND g.entry->>'actorId' ~* ${UUID_RE}
		AND jsonb_path_exists(
			g.entry,
			'$ ? (@.expiresAt.datetime() <= $now.datetime())',
			jsonb_build_object('now', to_jsonb(now()))
		)
		AND NOT ${alreadyLoggedPredicate}
	ORDER BY i.id, g.entry->>'grantId'
	LIMIT ${BATCH_LIMIT}
`

export class KeychainGrantExpirySweeperJob {
	private job: Cron | null = null
	private running = false

	constructor(
		private db: Database,
		private cronExpression: string = CRON_EXPRESSION,
	) {}

	start(): void {
		if (this.job) return
		this.job = new Cron(this.cronExpression, { timezone: 'UTC' }, async () => {
			await this.tick()
		})
	}

	stop(): void {
		if (this.job) {
			this.job.stop()
			this.job = null
		}
	}

	/** Returns the number of grant_expired rows written. Never throws. */
	async tick(): Promise<number> {
		if (this.running) return 0
		this.running = true
		let written = 0
		try {
			const candidates = (await this.db.execute(candidateStatement)) as unknown as Candidate[]
			for (const c of candidates) {
				try {
					if (await this.logExpiry(c)) written++
				} catch (err) {
					logger.error('Keychain grant expiry row failed', {
						integrationId: c.integration_id,
						grantId: c.grant_id,
						error: err instanceof Error ? err.message : String(err),
					})
				}
			}
			if (written > 0) logger.info('Keychain grant expiry sweeper tick', { rows_written: written })
			return written
		} catch (err) {
			logger.error('Keychain grant expiry sweeper tick failed', {
				error: err instanceof Error ? err.message : String(err),
			})
			return written
		} finally {
			this.running = false
		}
	}

	/** Writes the row for one grant. False when it was already on the chain. */
	private async logExpiry(c: Candidate): Promise<boolean> {
		return this.db.transaction(async (tx) => {
			await tx.execute(
				sql`SELECT pg_advisory_xact_lock(hashtextextended(${`grant_expired:${c.grant_id}`}, 0))`,
			)
			const [logged] = (await tx.execute(sql`
				SELECT 1 AS one FROM credential_access_log l
				WHERE l.integration_id = ${c.integration_id}::uuid
					AND l.action = 'grant_expired'
					AND position(${`;grant=${c.grant_id.toLowerCase()};`} in l.detail) > 0
				LIMIT 1
			`)) as unknown as { one: number }[]
			if (logged) return false

			const [request] = (await tx.execute(sql`
				SELECT approver_actor_id::text AS approver, tier::int AS tier
				FROM access_requests
				WHERE grant_id = ${c.grant_id}::uuid AND workspace_id = ${c.workspace_id}::uuid
				LIMIT 1
			`)) as unknown as { approver: string | null; tier: 1 | 2 | 3 }[]

			await insertCredentialAccessLog(tx, {
				workspaceId: c.workspace_id,
				integrationId: c.integration_id,
				actorId: c.actor_id,
				action: GRANT_EXPIRED_ACTION,
				source: c.source,
				requestId: `grant_expired:${c.grant_id}`,
				detail: formatCredentialLogDetail({
					approver: request?.approver ?? null,
					grant: c.grant_id,
					tier: request?.tier ?? null,
				}),
			})
			return true
		})
	}
}
