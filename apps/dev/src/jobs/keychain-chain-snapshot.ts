import type { Database } from '@maskin/db'
import { WormSnapshotStore } from '@maskin/storage'
import { Cron } from 'croner'
import { sql } from 'drizzle-orm'
import { capturePosthogEvent } from '../lib/analytics/posthog'
import { verifyCredentialAccessChain } from '../lib/integrations/credential-audit'
import { logger } from '../lib/logger'

/**
 * Daily snapshot of every workspace's audit-chain head into the write-once bucket,
 * plus the verifier that checks the chain against it.
 *
 * Why: the hash chain proves the log was not edited row by row, but someone with
 * database write access could rewrite the whole chain consistently. A head hash
 * held in a store they cannot rewrite closes that: the verifier recomputes the chain
 * from genesis and confirms the latest snapshot's row still exists with the same
 * hash.
 *
 * Per workspace, in this order:
 *   1. Walk the chain from genesis (paged). If it is broken, fire the failure event
 *      and write NOTHING: a tampered head must not be locked into a bucket that
 *      cannot delete it.
 *   2. Check the latest snapshot: its row id must exist in the chain with the same
 *      row_hash. If not, fire the failure event and write nothing.
 *   3. If the chain has grown since that snapshot, write one object,
 *      snapshots/<workspace id>/<UTC date>.json, holding the maximum
 *      credential_access_log id, its row_hash and the date. An unchanged chain writes
 *      nothing.
 *
 * Write safety (production is Compliance mode for 24 months, versioned, and nothing
 * here can delete, so a duplicate or wrong object is permanent): the key is looked up
 * first with ListObjectsV2 using the key as the prefix (see WormSnapshotStore.exists);
 * an exact match means skip; any lookup error, 403 included, fails the workspace and
 * is never read as "absent"; nothing retries; and the PUT itself is conditional
 * (If-None-Match: *), so two runs cannot both land. The runtime role has PutObject,
 * ListBucket and GetObject on snapshots/ only and no PutObjectRetention: the bucket
 * default retention does the locking.
 *
 * Inert unless KEYCHAIN_WORM_BUCKET is set, so a deployment with no bucket yet runs
 * as before. The chain is the Keychain's own: read_at is hashed as one canonical
 * microsecond text form (never a JavaScript Date), which the verifier reuses.
 */
const CRON_EXPRESSION = '31 2 * * *'
export const WORM_BUCKET_ENV = 'KEYCHAIN_WORM_BUCKET'
export const VERIFICATION_FAILED_EVENT = 'keychain_chain_verification_failed'

export type WorkspaceSnapshotOutcome =
	| 'written'
	| 'unchanged'
	| 'already_written'
	| 'chain_broken'
	| 'snapshot_mismatch'
	| 'failed'

export interface ChainSnapshotResult {
	enabled: boolean
	workspaces: number
	written: number
	skipped: number
	/** Chain broken or snapshot mismatch: the integrity signal. */
	verificationFailures: number
	/** Lookup, read or write errors on the bucket or database. */
	errors: number
}

export interface SnapshotBody {
	max_id: string
	row_hash: string
	date: string
}

export const snapshotKey = (workspaceId: string, date: string) =>
	`snapshots/${workspaceId}/${date}.json`

const utcDate = (d: Date) => d.toISOString().slice(0, 10)

export class ChainSnapshotJob {
	private job: Cron | null = null
	private running = false

	constructor(
		private db: Database,
		private store: WormSnapshotStore | null = bucketStoreFromEnv(),
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
			enabled: false,
			workspaces: 0,
			written: 0,
			skipped: 0,
			verificationFailures: 0,
			errors: 0,
		}
		if (!this.store) {
			logger.info('Chain snapshot skipped, no bucket configured', { env: WORM_BUCKET_ENV })
			return result
		}
		if (this.running) return result
		this.running = true
		result.enabled = true
		try {
			const rows = (await this.db.execute(
				sql`SELECT DISTINCT workspace_id::text AS workspace_id FROM credential_access_log ORDER BY 1`,
			)) as unknown as Array<{ workspace_id: string }>
			result.workspaces = rows.length
			for (const { workspace_id: workspaceId } of rows) {
				const outcome = await this.snapshotWorkspace(this.store, workspaceId)
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

	async snapshotWorkspace(
		store: WormSnapshotStore,
		workspaceId: string,
	): Promise<WorkspaceSnapshotOutcome> {
		try {
			const chain = await verifyCredentialAccessChain(this.db, workspaceId)
			if (!chain.ok) {
				this.fail(workspaceId, 'chain_broken', chain.reason, chain.brokenAtId)
				return 'chain_broken'
			}
			if (chain.headId === null || chain.headHash === null) return 'unchanged'

			const prefix = `snapshots/${workspaceId}/`
			const keys = (await store.list(prefix)).filter((k) => k.endsWith('.json'))
			const latestKey = keys.length ? keys.reduce((a, b) => (a > b ? a : b)) : null
			if (latestKey) {
				const latest = await this.readSnapshot(store, latestKey)
				const [row] = (await this.db.execute(sql`
					SELECT row_hash FROM credential_access_log
					WHERE workspace_id = ${workspaceId} AND credential_access_log.id = ${latest.max_id}::bigint
				`)) as unknown as Array<{ row_hash: string }>
				if (!row || row.row_hash !== latest.row_hash) {
					this.fail(
						workspaceId,
						'snapshot_mismatch',
						row ? 'row_hash differs from the snapshot' : 'snapshot row is missing from the chain',
						latest.max_id,
					)
					return 'snapshot_mismatch'
				}
				if (latest.max_id === chain.headId) return 'unchanged'
			}

			const date = utcDate(this.now())
			const key = snapshotKey(workspaceId, date)
			if (await store.exists(key)) return 'already_written'
			const body: SnapshotBody = { max_id: chain.headId, row_hash: chain.headHash, date }
			const wrote = await store.putIfAbsent(key, JSON.stringify(body))
			return wrote ? 'written' : 'already_written'
		} catch (err) {
			logger.error('Chain snapshot failed for a workspace', {
				workspaceId,
				error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
			})
			return 'failed'
		}
	}

	private async readSnapshot(store: WormSnapshotStore, key: string): Promise<SnapshotBody> {
		const text = await store.get(key)
		if (text === null) throw new Error(`snapshot ${key} was listed but could not be read`)
		const parsed = JSON.parse(text) as Partial<SnapshotBody>
		if (
			typeof parsed.max_id !== 'string' ||
			!/^\d+$/.test(parsed.max_id) ||
			typeof parsed.row_hash !== 'string'
		) {
			throw new Error(`snapshot ${key} is not in the expected shape`)
		}
		return parsed as SnapshotBody
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

function bucketStoreFromEnv(env: Record<string, string | undefined> = process.env) {
	const bucket = env[WORM_BUCKET_ENV]?.trim()
	return bucket ? new WormSnapshotStore({ bucket, region: env.AWS_REGION?.trim() || undefined }) : null
}
