import type { Database } from '@maskin/db'
import { Cron } from 'croner'
import { sql } from 'drizzle-orm'
import { capturePosthogEvent } from '../lib/analytics/posthog'
import { verifyCredentialAccessChain } from '../lib/integrations/credential-audit'
import { logger } from '../lib/logger'

/**
 * Daily snapshot of every workspace's audit-chain head into credential_chain_snapshots,
 * plus the verifier that checks the chain against it.
 *
 * Why: the hash chain proves the log was not edited row by row. A snapshot row holds
 * the head hash as of an earlier day, so a chain that was later rewritten from some
 * point on no longer matches it. The table is append-only (a trigger rejects UPDATE
 * and DELETE), so the app and anyone who is not a database owner cannot edit a
 * snapshot. It lives in the same database, so an owner who drops the trigger can
 * still rewrite both; that is the accepted limit of keeping this in Postgres.
 *
 * Per workspace, in this order:
 *   1. Walk the chain from genesis (paged). If it is broken, fire the failure event
 *      and write nothing: a tampered head must not become the new anchor.
 *   2. Check the latest snapshot: its row id must exist in the chain with the same
 *      row_hash. If not, fire the failure event and write nothing.
 *   3. If the chain has grown since that snapshot, insert one row for today's UTC date
 *      (ON CONFLICT DO NOTHING, so two runs cannot both land). An unchanged chain
 *      writes nothing.
 *
 * read_at is hashed as one canonical microsecond text form (never a JavaScript Date),
 * which the verifier reuses.
 */
const CRON_EXPRESSION = '31 2 * * *'
export const VERIFICATION_FAILED_EVENT = 'keychain_chain_verification_failed'

export type WorkspaceSnapshotOutcome =
	| 'written'
	| 'unchanged'
	| 'already_written'
	| 'chain_broken'
	| 'snapshot_mismatch'
	| 'failed'

export interface ChainSnapshotResult {
	workspaces: number
	written: number
	skipped: number
	/** Chain broken or snapshot mismatch: the integrity signal. */
	verificationFailures: number
	/** Database errors. */
	errors: number
}

const utcDate = (d: Date) => d.toISOString().slice(0, 10)

export class ChainSnapshotJob {
	private job: Cron | null = null
	private running = false

	constructor(
		private db: Database,
		private now: () => Date = () => new Date(),
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

	/** Swallowed-error wrapper for the scheduler. */
	async tick(): Promise<void> {
		try {
			await this.run()
		} catch (err) {
			logger.error('Chain snapshot run failed', {
				error: err instanceof Error ? err.message : String(err),
			})
		}
	}

	async run(): Promise<ChainSnapshotResult> {
		const result: ChainSnapshotResult = {
			workspaces: 0,
			written: 0,
			skipped: 0,
			verificationFailures: 0,
			errors: 0,
		}
		if (this.running) return result
		this.running = true
		try {
			const rows = (await this.db.execute(
				sql`SELECT DISTINCT workspace_id::text AS workspace_id FROM credential_access_log ORDER BY 1`,
			)) as unknown as Array<{ workspace_id: string }>
			result.workspaces = rows.length
			for (const { workspace_id: workspaceId } of rows) {
				const outcome = await this.snapshotWorkspace(workspaceId)
				if (outcome === 'written') result.written++
				else if (outcome === 'unchanged' || outcome === 'already_written') result.skipped++
				else if (outcome === 'failed') result.errors++
				else result.verificationFailures++
			}
			logger.info('Chain snapshot run', { ...result })
			return result
		} finally {
			this.running = false
		}
	}

	async snapshotWorkspace(workspaceId: string): Promise<WorkspaceSnapshotOutcome> {
		try {
			const chain = await verifyCredentialAccessChain(this.db, workspaceId)
			if (!chain.ok) {
				this.fail(workspaceId, 'chain_broken', chain.reason, chain.brokenAtId)
				return 'chain_broken'
			}
			if (chain.headId === null || chain.headHash === null) return 'unchanged'

			const [latest] = (await this.db.execute(sql`
				SELECT s.max_id::text AS max_id, s.row_hash AS snapshot_hash, c.row_hash AS chain_hash
				FROM credential_chain_snapshots s
				LEFT JOIN credential_access_log c ON c.id = s.max_id AND c.workspace_id = s.workspace_id
				WHERE s.workspace_id = ${workspaceId}
				ORDER BY s.snapshot_date DESC
				LIMIT 1
			`)) as unknown as Array<{ max_id: string; snapshot_hash: string; chain_hash: string | null }>
			if (latest) {
				if (latest.chain_hash !== latest.snapshot_hash) {
					this.fail(
						workspaceId,
						'snapshot_mismatch',
						latest.chain_hash
							? 'row_hash differs from the snapshot'
							: 'snapshot row is missing from the chain',
						latest.max_id,
					)
					return 'snapshot_mismatch'
				}
				if (latest.max_id === chain.headId) return 'unchanged'
			}

			const inserted = (await this.db.execute(sql`
				INSERT INTO credential_chain_snapshots (workspace_id, snapshot_date, max_id, row_hash)
				VALUES (${workspaceId}, ${utcDate(this.now())}::date, ${chain.headId}::bigint, ${chain.headHash})
				ON CONFLICT (workspace_id, snapshot_date) DO NOTHING
				RETURNING 1
			`)) as unknown as unknown[]
			return inserted.length > 0 ? 'written' : 'already_written'
		} catch (err) {
			logger.error('Chain snapshot failed for a workspace', {
				workspaceId,
				error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
			})
			return 'failed'
		}
	}

	private fail(workspaceId: string, kind: string, reason: string, atId: string) {
		logger.error('Keychain audit chain verification failed', { workspaceId, kind, reason, atId })
		void capturePosthogEvent(VERIFICATION_FAILED_EVENT, `workspace:${workspaceId}`, {
			workspace_id: workspaceId,
			kind,
			reason,
			at_id: atId,
		})
	}
}
