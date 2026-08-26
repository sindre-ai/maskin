import { trackIntegrationSyncCompleted } from '../../analytics/integration-events'
import { logger } from '../../logger'

// Shared entry point every provider's sync loop wraps its actual work in.
// The framework owns the `integration_sync_completed` emit — success and
// error branches both fire — so GSC (task 2), GA (#2), Ads (#3), and any
// future provider get the ship-metric event without adding their own
// PostHog call. `work()` throws propagate to the caller so retry / backoff
// logic elsewhere still triggers.

export interface RunIntegrationSyncContext {
	provider: string
	workspaceId: string
	// True for the initial post-connect backfill run (e.g. GSC's 16-month
	// window), false for every subsequent delta append. Providers pass this
	// explicitly per run rather than tracking state here — the shared runner
	// has no schedule of its own.
	isBackfill: boolean
}

export interface IntegrationSyncOutcome {
	recordsWritten: number
}

export async function runIntegrationSync(
	ctx: RunIntegrationSyncContext,
	work: () => Promise<IntegrationSyncOutcome>,
): Promise<IntegrationSyncOutcome> {
	try {
		const outcome = await work()
		void trackIntegrationSyncCompleted({
			provider: ctx.provider,
			workspaceId: ctx.workspaceId,
			recordsWritten: outcome.recordsWritten,
			syncStatus: 'success',
			isBackfill: ctx.isBackfill,
		}).catch((err) => {
			logger.warn('integration_sync_completed emit failed (success branch)', {
				provider: ctx.provider,
				workspace_id: ctx.workspaceId,
				error: err instanceof Error ? err.message : String(err),
			})
		})
		return outcome
	} catch (err) {
		void trackIntegrationSyncCompleted({
			provider: ctx.provider,
			workspaceId: ctx.workspaceId,
			recordsWritten: 0,
			syncStatus: 'error',
			isBackfill: ctx.isBackfill,
		}).catch((emitErr) => {
			logger.warn('integration_sync_completed emit failed (error branch)', {
				provider: ctx.provider,
				workspace_id: ctx.workspaceId,
				error: emitErr instanceof Error ? emitErr.message : String(emitErr),
			})
		})
		throw err
	}
}
