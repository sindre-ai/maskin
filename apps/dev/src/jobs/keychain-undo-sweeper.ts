import type { Database } from '@maskin/db'
import { Cron } from 'croner'
import { sql } from 'drizzle-orm'
import { capturePosthogEvent } from '../lib/analytics/posthog'
import { recordEvents } from '../lib/events/record-event'
import { logger } from '../lib/logger'

/**
 * Keychain pending-undo sweeper.
 *
 * A key captured in chat lands as status = 'pending_undo' with undo_expires_at a
 * few minutes out. Once that moment passes the undo window is closed, so this job
 * flips the row to 'active' and clears undo_expires_at.
 *
 * It is one UPDATE and nothing else touches the row: no key use and no DEK
 * re-wrap, because the envelope was written at capture time and does not change
 * when the status does. The statement spells out status = 'pending_undo' as a
 * literal so Postgres can prove the partial index integrations_undo_sweeper_idx
 * applies; a bound parameter would not let it. The window is judged by the
 * database clock, the same clock the undo endpoint uses (undo_expires_at > now()),
 * so a row is either still undoable or swept, never both.
 *
 * Idempotent: a second run finds no pending_undo row past its window, changes
 * nothing, writes no event and sends no PostHog event.
 *
 * Scheduler: croner, same as purge-idempotency. A five-field expression fires at
 * second 0 of every minute, which is the 60 second interval the task asks for, so
 * no safety margin is needed on the window. A row inserted with undo_expires_at two
 * minutes out is swept on the first run after that moment: active within three.
 *
 * events rows belong to one workspace, so the batched audit row is written once per
 * workspace touched in a run, not once per integration. Its actor and entity are
 * the first swept integration of that workspace and its creator; the full id list
 * is in data.
 */
const CRON_EXPRESSION = '* * * * *'

export const SWEEP_ACTION = 'keychain_pending_undo_activated'
export const SWEEP_POSTHOG_EVENT = 'keychain_credential_sweeper_activated'
const POSTHOG_DISTINCT_ID = 'keychain-sweeper'

export interface SweptRow {
	id: string
	workspace_id: string
	created_by: string
}

/** The one statement. Exported so the EXPLAIN test inspects exactly what runs. */
export const sweepStatement = sql`
	UPDATE integrations
	SET status = 'active', undo_expires_at = NULL, updated_at = now()
	WHERE status = 'pending_undo' AND undo_expires_at <= now()
	RETURNING id::text AS id, workspace_id::text AS workspace_id, created_by::text AS created_by
`

export class KeychainUndoSweeperJob {
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

	/** Returns the number of rows activated. Never throws. */
	async tick(): Promise<number> {
		if (this.running) return 0
		this.running = true
		try {
			const swept = await this.db.transaction(async (tx) => {
				const rows = (await tx.execute(sweepStatement)) as unknown as SweptRow[]
				if (rows.length === 0) return rows
				const byWorkspace = new Map<string, [SweptRow, ...SweptRow[]]>()
				for (const row of rows) {
					const list = byWorkspace.get(row.workspace_id)
					if (list) list.push(row)
					else byWorkspace.set(row.workspace_id, [row])
				}
				await recordEvents(
					tx,
					[...byWorkspace.entries()].map(([workspaceId, list]) => ({
						workspaceId,
						actorId: list[0].created_by,
						action: SWEEP_ACTION,
						entityType: 'integration',
						entityId: list[0].id,
						data: { rows_activated: list.length, integration_ids: list.map((r) => r.id) },
					})),
				)
				return rows
			})
			if (swept.length > 0) {
				logger.info('Keychain undo sweeper tick', { rows_activated: swept.length })
				void capturePosthogEvent(SWEEP_POSTHOG_EVENT, POSTHOG_DISTINCT_ID, {
					rows_activated: swept.length,
					workspace_count: new Set(swept.map((r) => r.workspace_id)).size,
				})
			}
			return swept.length
		} catch (err) {
			logger.error('Keychain undo sweeper tick failed', {
				error: err instanceof Error ? err.message : String(err),
			})
			return 0
		} finally {
			this.running = false
		}
	}
}
