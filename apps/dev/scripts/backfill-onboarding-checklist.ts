// One-shot backfill: stamp `metadata.seed_slug` onto Vaerksted's existing
// onboarding-checklist knowledge object so future re-bootstraps recognise it
// as the seeded row and skip re-inserting.
//
// Scope decision (Magnus 2026-09-02, on parent bet 9d519ef8): seed-only rollout
// + Vaerksted-only backfill. Other live workspaces catch the new template on
// their next agent-template update; no data backfill for them.
//
// The checklist itself predates DEFAULT_WORKSPACE_KNOWLEDGE — Chief of Staff
// hand-built it in Vaerksted during the manual onboarding sweep. Deleting +
// re-inserting would lose the populated content (Sebastian's confirmations,
// Researcher drafts, north-star entry). We update in place: set
// metadata.seed_slug on the existing row, preserve everything else.
//
// Run:
//   DATABASE_URL=... pnpm --filter @maskin/dev exec tsx scripts/backfill-onboarding-checklist.ts
//
// Idempotency: re-running is a no-op with a log line once the slug is set.
// This script targets a single hard-coded object id in a single hard-coded
// workspace by design — it is not a general backfill runner. If Vaerksted's
// checklist id ever changes (e.g. deleted + recreated), update the constant
// below rather than parameterising.

import { pathToFileURL } from 'node:url'
import { type Database, createDb } from '@maskin/db'
import { events, objects } from '@maskin/db/schema'
import { ONBOARDING_CHECKLIST_SEED_SLUG } from '@maskin/shared'
import { eq } from 'drizzle-orm'

export const VAERKSTED_WORKSPACE_ID = 'e2877e32-2c11-489e-96c8-a76200908ed4'
export const VAERKSTED_CHECKLIST_OBJECT_ID = '0f98bf02-d7de-4d96-bb45-0eccecb0564d'

export type BackfillResult =
	| { kind: 'stamped'; previous: unknown }
	| { kind: 'no-op-already-set' }
	| { kind: 'error-not-found' }
	| { kind: 'error-wrong-workspace'; actualWorkspaceId: string }
	| { kind: 'error-different-slug'; currentSlug: string }

/**
 * The core backfill — split from the CLI so integration tests can exercise it
 * against a seeded row and assert the mutation shape, not just the side effect
 * of `process.exit`. Pass a caller-scoped `Database` handle for the same
 * reason.
 */
export async function backfillOnboardingChecklist(db: Database): Promise<BackfillResult> {
	const [existing] = await db
		.select({
			id: objects.id,
			workspaceId: objects.workspaceId,
			type: objects.type,
			title: objects.title,
			metadata: objects.metadata,
			createdBy: objects.createdBy,
		})
		.from(objects)
		.where(eq(objects.id, VAERKSTED_CHECKLIST_OBJECT_ID))
		.limit(1)

	if (!existing) return { kind: 'error-not-found' }

	if (existing.workspaceId !== VAERKSTED_WORKSPACE_ID) {
		return { kind: 'error-wrong-workspace', actualWorkspaceId: existing.workspaceId }
	}

	const currentMetadata =
		existing.metadata && typeof existing.metadata === 'object' && !Array.isArray(existing.metadata)
			? (existing.metadata as Record<string, unknown>)
			: {}
	const currentSlug = currentMetadata.seed_slug

	if (currentSlug === ONBOARDING_CHECKLIST_SEED_SLUG) {
		return { kind: 'no-op-already-set' }
	}

	if (typeof currentSlug === 'string' && currentSlug.length > 0) {
		return { kind: 'error-different-slug', currentSlug }
	}

	const nextMetadata = { ...currentMetadata, seed_slug: ONBOARDING_CHECKLIST_SEED_SLUG }

	await db.transaction(async (tx) => {
		await tx
			.update(objects)
			.set({ metadata: nextMetadata })
			.where(eq(objects.id, VAERKSTED_CHECKLIST_OBJECT_ID))

		await tx.insert(events).values({
			workspaceId: VAERKSTED_WORKSPACE_ID,
			actorId: existing.createdBy,
			action: 'updated',
			entityType: 'knowledge',
			entityId: VAERKSTED_CHECKLIST_OBJECT_ID,
			data: {
				field: 'metadata.seed_slug',
				previous: currentSlug ?? null,
				next: ONBOARDING_CHECKLIST_SEED_SLUG,
			},
		})
	})

	return { kind: 'stamped', previous: currentSlug ?? null }
}

export async function main() {
	const databaseUrl = process.env.DATABASE_URL
	if (!databaseUrl) {
		console.error('DATABASE_URL is required.')
		process.exit(1)
	}

	const db = createDb(databaseUrl)
	const result = await backfillOnboardingChecklist(db)

	switch (result.kind) {
		case 'stamped':
			console.log(
				`Stamped seed_slug="${ONBOARDING_CHECKLIST_SEED_SLUG}" onto Vaerksted checklist ${VAERKSTED_CHECKLIST_OBJECT_ID}. Original content preserved.`,
			)
			process.exit(0)
			return
		case 'no-op-already-set':
			console.log(
				`Vaerksted checklist ${VAERKSTED_CHECKLIST_OBJECT_ID} already has seed_slug="${ONBOARDING_CHECKLIST_SEED_SLUG}" — no-op.`,
			)
			process.exit(0)
			return
		case 'error-not-found':
			console.error(
				`Onboarding-checklist object ${VAERKSTED_CHECKLIST_OBJECT_ID} not found. If Vaerksted's checklist was recreated, update VAERKSTED_CHECKLIST_OBJECT_ID in this script.`,
			)
			process.exit(1)
			return
		case 'error-wrong-workspace':
			console.error(
				`Object ${VAERKSTED_CHECKLIST_OBJECT_ID} is in workspace ${result.actualWorkspaceId}, not Vaerksted (${VAERKSTED_WORKSPACE_ID}). Refusing to touch a wrong-workspace row.`,
			)
			process.exit(1)
			return
		case 'error-different-slug':
			console.error(
				`Vaerksted checklist already has a different seed_slug ("${result.currentSlug}"). Refusing to overwrite; investigate before re-running.`,
			)
			process.exit(1)
			return
	}
}

const invokedDirectly =
	typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
	main().catch((err) => {
		console.error(err instanceof Error ? err.stack || err.message : err)
		process.exit(1)
	})
}
