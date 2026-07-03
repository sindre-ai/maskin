import type { ImportMapping } from '@maskin/shared'
import { capturePosthogEvent } from './posthog'

// Server-side emitter for the bulk-import-dedup ship metric. The bet's success
// gate (≥80% of bulk imports executed with ≥1 explicit dedup key) is read off
// `bulk_import_executed` in PostHog 191282 — without this event the bet runs
// unmeasurable. Fired from `runImportInBackground` after `executeImport`
// returns and the import row is updated with final counts, so matched_count /
// created_count / skipped_count are authoritative (the frontend cannot know
// them at click time until T4 wires preview-driven counts; even after T4 this
// server-side mirror stays as the backup the brief calls for).

interface BulkImportExecutedProps {
	mapping: ImportMapping
	matchedCount: number
	createdCount: number
	skippedCount: number
	totalRows: number
	workspaceId: string
	actorId: string
}

export async function trackBulkImportExecuted(p: BulkImportExecutedProps): Promise<void> {
	const typeMappings = p.mapping.typeMappings ?? []
	// Sum dedup keys across every typeMapping — multi-type imports are rare
	// but the bet's posthog_query treats this as a single scalar. Zero when
	// the user took the "create all as new" escape hatch on every typeMapping.
	const dedupKeysCount = typeMappings.reduce((sum, tm) => sum + (tm.dedupKeys?.length ?? 0), 0)
	// True iff every typeMapping opted into the escape hatch with no keys —
	// matches the bet's "user took the escape-hatch path" definition.
	const usedCreateAllAsNew =
		typeMappings.length > 0 &&
		typeMappings.every((tm) => (tm.dedupKeys?.length ?? 0) === 0 && tm.createAllAsNew === true)
	// Recommended `target_type`: join unique object types so a multi-type
	// import is still legible in the PostHog event detail without dropping
	// information.
	const targetType =
		Array.from(new Set(typeMappings.map((tm) => tm.objectType).filter(Boolean))).join('+') || null

	await capturePosthogEvent('bulk_import_executed', p.workspaceId, {
		dedup_keys_count: dedupKeysCount,
		matched_count: p.matchedCount,
		created_count: p.createdCount,
		skipped_count: p.skippedCount,
		used_create_all_as_new: usedCreateAllAsNew,
		workspace_id: p.workspaceId,
		actor_id: p.actorId,
		target_type: targetType,
		total_rows: p.totalRows,
	})
}
