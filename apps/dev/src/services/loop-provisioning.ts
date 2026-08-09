import { generateApiKey } from '@maskin/auth'
import type { Database, Transaction } from '@maskin/db'
import {
	actors,
	installedLoops,
	type integrations,
	marketplaceLoopItems,
	triggers,
	workspaceMembers,
	type workspaceSkills,
} from '@maskin/db/schema'
import { and, desc, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm'

/**
 * Shared provisioning helpers for the marketplace. Both the install endpoint
 * (`POST /api/installed-loops`) and the version-push cron (`LoopVersionPusher`)
 * build element rows from `marketplace_loop_items` snapshots — they must
 * produce identical rows or the cron will overwrite installs with subtly
 * different shapes on the next tick.
 */

export type MarketplaceItemType = 'actor' | 'trigger' | 'skill' | 'integration'

type DbHandle = Database | Transaction

/**
 * Find an actor the workspace already has that was provisioned from a given
 * marketplace source entity: an `actors.metadata` row whose `key` equals
 * `value`, scoped to `workspaceId` through the workspace_members join. Actors
 * are global identities, so membership is what keeps the match per-workspace —
 * a copy provisioned into another workspace must never be reused here.
 *
 * Which metadata key to pass is the caller's intent:
 *  - `source_item_id` — the loop install/version-push dedup identity: the
 *    source item id from the publishing workspace. This is the key the partial
 *    unique index `actors_ws_source_item_uniq` backstops in Postgres.
 *  - `marketplace_item_id` — the individual-item install route's marker.
 *
 * Rows are ordered newest-first so the `.limit(1)` is deterministic: repeated
 * overlapping installs (which, before the unique index shipped, could leave
 * several rows for one source item) resolve to the most recent row.
 */
export async function findProvisionedActorByMetadataKey(
	db: DbHandle,
	workspaceId: string,
	key: string,
	value: string,
): Promise<{ id: string } | undefined> {
	const [row] = await db
		.select({ id: actors.id })
		.from(actors)
		.innerJoin(workspaceMembers, eq(workspaceMembers.actorId, actors.id))
		.where(
			and(
				eq(workspaceMembers.workspaceId, workspaceId),
				sql`${actors.metadata}->>'${sql.raw(key)}' = ${value}`,
			),
		)
		.orderBy(desc(actors.updatedAt))
		.limit(1)
	return row
}

/**
 * Claim-first insert for an install-provisioned actor. The INSERT is the
 * claim; if the workspace already holds an actor for the same source item —
 * the partial unique index `actors_ws_source_item_uniq` on (workspace_id,
 * metadata->>'source_item_id') fires — the row stays, and this call returns
 * `{ id, created: false }` with the id of the winner instead. The caller
 * decides what a lost claim means: reuse (loop install / version push) or 409
 * (individual-item install).
 *
 * This closes the TOCTOU race in the old reuse check, which was
 * SELECT-then-INSERT: two concurrent installs of loops that share an agent
 * could both miss the SELECT and each clone the actor. The INSERT is the
 * claim; exactly one concurrent caller wins it. A caller that loses reads the
 * winner back with findProvisionedActorByMetadataKey — at READ COMMITTED the
 * follow-up SELECT in the same transaction sees the winner's committed row, so
 * the loser can never claim-then-clone.
 *
 * The pre-check SELECT comes first on purpose. The partial unique index only
 * covers rows stamped with `workspace_id`, which installs set from this change
 * onward — rows provisioned before the column existed (migration 0052) carry
 * NULL and are invisible to it, so a claim INSERT against one never conflicts
 * and a repeat install would clone the agent. The pre-check scopes through the
 * workspace_members join (membership predates the column), so those older rows
 * are found and reused here. A miss leaves the claim INSERT as the arbiter, so
 * the concurrent guarantee is unchanged for rows the index does cover.
 *
 * No conflict target is passed to ON CONFLICT on purpose: Drizzle 0.45's
 * onConflictDoNothing target only accepts plain PgColumns (not index
 * expressions), and no-target DO NOTHING is still arbiter-gated — Postgres
 * uses a partial unique index as the arbiter only when the proposed row
 * satisfies its predicate, which a claim row always does (workspace_id is
 * set). The table's other unique constraints can't be hit by a claim: api_key
 * is always a fresh generated key and email is null.
 */
export async function claimProvisionedActor(
	tx: DbHandle,
	workspaceId: string,
	sourceItemId: string,
	snapshot: Record<string, unknown>,
	metadata: Record<string, unknown>,
	createdBy: string | null,
): Promise<{ id: string; created: boolean }> {
	const existing = await findProvisionedActorByMetadataKey(
		tx,
		workspaceId,
		'source_item_id',
		sourceItemId,
	)
	if (existing) return { id: existing.id, created: false }
	const rows = await tx
		.insert(actors)
		.values(
			buildActorInsert(
				workspaceId,
				snapshot,
				{ ...metadata, source_item_id: sourceItemId },
				createdBy,
			),
		)
		.onConflictDoNothing()
		.returning({ id: actors.id })
	if (rows[0]) return { id: rows[0].id, created: true }
	const winner = await findProvisionedActorByMetadataKey(
		tx,
		workspaceId,
		'source_item_id',
		sourceItemId,
	)
	if (!winner) {
		// A conflict was reported but no winner is visible in our transaction.
		// Resolve loudly rather than cloning the actor to paper over it.
		throw new Error(
			`claimProvisionedActor: lost claim for source_item_id ${sourceItemId} in workspace ${workspaceId} but no existing actor found`,
		)
	}
	return { id: winner.id, created: false }
}

export function sourceItemIdOf(metadata: unknown): string | null {
	const meta = (metadata as Record<string, unknown> | null) ?? {}
	return typeof meta.source_item_id === 'string' ? meta.source_item_id : null
}

export type ProvisionedActorRef = {
	id: string
	sourceItemId: string | null
}

/**
 * Ownership-aware partitioning of an install's provisioned actors, shared by
 * the full-uninstall route and the version-push cron's removes pass.
 *
 * The dedup guard makes one actor row shareable by several installed loops,
 * but the actor's `metadata.installed_loop_id` only names the loop that first
 * provisioned it — so removing that loop (uninstall or publisher dropping the
 * agent from the next version) must not cascade-delete a row another live loop
 * still references. An actor is KEPT when any other currently-installed loop in
 * the workspace references it: by bundling the same `source_item_id` (the
 * dedup identity) or by running a provisioned trigger whose `targetActorId` is
 * the local row. Kept actors are rehomed to one of those referencing installs
 * (`installed_loop_id` transferred, `forked_from_installed_loop_id` cleared) so
 * a later removal of *that* install can still retire the actor once no
 * references remain. The caller cascade-deletes `deleted` only; the rehome
 * update is applied here inside `tx` before this returns.
 */
export async function partitionProvisionedActors(
	tx: DbHandle,
	workspaceId: string,
	installId: string,
	actorsToPartition: ProvisionedActorRef[],
): Promise<{ deleted: string[]; kept: Array<{ id: string; rehomedTo: string }> }> {
	const deleted: string[] = []
	const kept: Array<{ id: string; rehomedTo: string }> = []

	if (actorsToPartition.length === 0) return { deleted, kept }

	const sourceItemIds = actorsToPartition
		.map((a) => a.sourceItemId)
		.filter((s): s is string => s !== null)
	const bundleRefs = await findReferencingInstalls(tx, workspaceId, installId, sourceItemIds)
	const triggerRefs = await findTriggerReferencingInstalls(
		tx,
		workspaceId,
		installId,
		actorsToPartition.map((a) => a.id),
	)

	for (const actor of actorsToPartition) {
		const liveInstallIds = new Set([
			...(actor.sourceItemId ? (bundleRefs.get(actor.sourceItemId) ?? []) : []),
			...(triggerRefs.get(actor.id) ?? []),
		])
		const [rehomeTo] = [...liveInstallIds]
		if (!rehomeTo) {
			deleted.push(actor.id)
			continue
		}
		await rehomeActorOwnership(tx, actor.id, rehomeTo)
		kept.push({ id: actor.id, rehomedTo: rehomeTo })
	}

	return { deleted, kept }
}

/**
 * Installed loops (other than `installId`) in `workspaceId` whose source loop
 * bundles any of `sourceItemIds` — the marketplace side of the dedup identity.
 * A loop that still bundles the item would reach for the same actor row on its
 * next install/push, so the row must survive this install's removal.
 */
async function findReferencingInstalls(
	db: DbHandle,
	workspaceId: string,
	installId: string,
	sourceItemIds: string[],
): Promise<Map<string, string[]>> {
	const refs = new Map<string, string[]>()
	if (sourceItemIds.length === 0) return refs
	const rows = await db
		.select({
			sourceItemId: marketplaceLoopItems.sourceItemId,
			installId: installedLoops.id,
		})
		.from(installedLoops)
		.innerJoin(marketplaceLoopItems, eq(marketplaceLoopItems.loopId, installedLoops.sourceLoopId))
		.where(
			and(
				eq(installedLoops.workspaceId, workspaceId),
				ne(installedLoops.id, installId),
				inArray(marketplaceLoopItems.sourceItemId, sourceItemIds),
			),
		)
	for (const row of rows) {
		const list = refs.get(row.sourceItemId) ?? []
		list.push(row.installId)
		refs.set(row.sourceItemId, list)
	}
	return refs
}

/**
 * Installed loops (other than `installId`) in `workspaceId` that run a
 * provisioned trigger targeting any of `actorIds` — a live dependency on the
 * local rows even when the referencing loop does not re-bundle the same source
 * item (e.g. a fork kept its trigger, or a loop whose agent list changed).
 */
async function findTriggerReferencingInstalls(
	db: DbHandle,
	workspaceId: string,
	installId: string,
	actorIds: string[],
): Promise<Map<string, string[]>> {
	const refs = new Map<string, string[]>()
	if (actorIds.length === 0) return refs
	const rows = await db
		.select({
			actorId: triggers.targetActorId,
			installId: sql<string>`${triggers.metadata}->>'installed_loop_id'`,
		})
		.from(triggers)
		.where(
			and(
				inArray(triggers.targetActorId, actorIds),
				isNotNull(sql`${triggers.metadata}->>'installed_loop_id'`),
			),
		)
	const installIds = [...new Set(rows.map((r) => r.installId))]
	if (installIds.length === 0) return refs
	const live = await db
		.select({ id: installedLoops.id })
		.from(installedLoops)
		.where(
			and(
				eq(installedLoops.workspaceId, workspaceId),
				ne(installedLoops.id, installId),
				inArray(installedLoops.id, installIds),
			),
		)
	const liveSet = new Set(live.map((r) => r.id))
	for (const row of rows) {
		if (!liveSet.has(row.installId)) continue
		const list = refs.get(row.actorId) ?? []
		list.push(row.installId)
		refs.set(row.actorId, list)
	}
	return refs
}

/** Transfer an actor's managed-install ownership to `newInstallId`. */
async function rehomeActorOwnership(
	db: DbHandle,
	actorId: string,
	newInstallId: string,
): Promise<void> {
	await db
		.update(actors)
		.set({
			metadata: sql`(${actors.metadata} - 'forked_from_installed_loop_id') || jsonb_build_object('installed_loop_id', ${newInstallId}::text)`,
		})
		.where(eq(actors.id, actorId))
}

/**
 * Build the per-row metadata for an install-provisioned element. Carries the
 * install id + source item id (so the cron finds the row again next push) plus
 * the snapshot itself (so we can diff against the marketplace loop without
 * scraping the row's structured columns — which differ per element type).
 */
export function installMetadata(
	installId: string,
	sourceItemId: string,
	snapshot: Record<string, unknown>,
): Record<string, unknown> {
	return {
		installed_loop_id: installId,
		source_item_id: sourceItemId,
		snapshot,
	}
}

/**
 * Rewrite intra-loop wiring in a snapshot. Any string value in the snapshot
 * that matches a known `source_item_id` is replaced with the local id it was
 * provisioned into. Used so a trigger's `target_actor_id` (which points at the
 * publisher's actor id) becomes the installed actor's id.
 */
export function rewriteWiring(
	snapshot: Record<string, unknown>,
	sourceToLocal: Map<string, string>,
): Record<string, unknown> {
	if (sourceToLocal.size === 0) return snapshot
	return walk(snapshot, sourceToLocal) as Record<string, unknown>
}

// Only UUID-format strings are candidates for intra-loop ID rewriting.
// This prevents systemPrompt / actionPrompt / config text from being silently
// rewritten if it happens to contain a string that coincides with a source ID.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function walk(value: unknown, sourceToLocal: Map<string, string>): unknown {
	if (typeof value === 'string') {
		if (UUID_RE.test(value)) {
			const local = sourceToLocal.get(value)
			return local ?? value
		}
		return value
	}
	if (Array.isArray(value)) {
		return value.map((v) => walk(v, sourceToLocal))
	}
	if (value && typeof value === 'object') {
		const out: Record<string, unknown> = {}
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			out[k] = walk(v, sourceToLocal)
		}
		return out
	}
	return value
}

/**
 * Inserts (used by the install endpoint and the cron's "add" branch when
 * re-provisioning a locked install picks up a marketplace item that isn't yet
 * installed). Defaults are conservative — the snapshot may have been taken
 * from a workspace with a different column shape, so each accessor tolerates
 * both camelCase and snake_case keys.
 */
export function buildActorInsert(
	workspaceId: string,
	snapshot: Record<string, unknown>,
	metadata: Record<string, unknown>,
	createdBy: string | null,
): typeof actors.$inferInsert {
	// Always mint a fresh apiKey. The snapshot is untrusted input from the
	// publishing workspace — honoring `snapshot.apiKey` would either copy the
	// publisher's bearer token into the installer's workspace (auth leak) or
	// collide on the unique index. apiKey is a real auth credential; it must
	// be generated locally via the cryptographically-secure helper.
	return {
		type: (snapshot.type as string) ?? 'agent',
		name: (snapshot.name as string) ?? 'Untitled agent',
		description: (snapshot.description as string) ?? null,
		systemPrompt: (snapshot.systemPrompt as string) ?? (snapshot.system_prompt as string) ?? null,
		llmProvider: (snapshot.llmProvider as string) ?? (snapshot.llm_provider as string) ?? null,
		llmConfig:
			(snapshot.llmConfig as Record<string, unknown>) ??
			(snapshot.llm_config as Record<string, unknown>) ??
			null,
		tools: (snapshot.tools as Record<string, unknown>) ?? null,
		apiKey: generateApiKey().key,
		// The per-workspace dedup anchor: the unique index
		// actors_ws_source_item_uniq is scoped on this column, so only installs
		// stamp it. Signup and other workspace-created actors leave it NULL.
		workspaceId,
		metadata,
		createdBy,
	}
}

export function buildTriggerInsert(
	workspaceId: string,
	snapshot: Record<string, unknown>,
	metadata: Record<string, unknown>,
	createdBy: string,
): typeof triggers.$inferInsert {
	return {
		workspaceId,
		name: (snapshot.name as string) ?? 'Untitled trigger',
		type: (snapshot.type as string) ?? 'cron',
		config: (snapshot.config as Record<string, unknown>) ?? {},
		actionPrompt: (snapshot.actionPrompt as string) ?? (snapshot.action_prompt as string) ?? '',
		targetActorId: (snapshot.targetActorId as string) ?? (snapshot.target_actor_id as string) ?? '',
		enabled: typeof snapshot.enabled === 'boolean' ? snapshot.enabled : true,
		createdBy,
		metadata,
	}
}

// skillId/storageKey are caller-provided (minted via randomUUID() +
// workspaceSkillKey()) rather than derived from the snapshot — every
// provisioned skill gets its own fresh, workspace-scoped S3 object instead of
// pointing at the publisher's copy. The caller is responsible for writing the
// content to that storageKey (see workspace-skills.ts's POST route for the
// atomic DB-insert-then-S3-put pattern this mirrors).
export function buildSkillInsert(
	workspaceId: string,
	skillId: string,
	storageKey: string,
	snapshot: Record<string, unknown>,
	metadata: Record<string, unknown>,
	createdBy: string | null,
): typeof workspaceSkills.$inferInsert {
	const content = (snapshot.content as string) ?? ''
	return {
		id: skillId,
		workspaceId,
		name: (snapshot.name as string) ?? 'untitled-skill',
		description: (snapshot.description as string) ?? null,
		content,
		storageKey,
		sizeBytes: Buffer.byteLength(content, 'utf-8'),
		isValid: typeof snapshot.isValid === 'boolean' ? snapshot.isValid : true,
		metadata,
		createdBy,
	}
}

export function buildIntegrationInsert(
	workspaceId: string,
	snapshot: Record<string, unknown>,
	metadata: Record<string, unknown>,
	createdBy: string,
): typeof integrations.$inferInsert {
	// Always force status='inactive' on install. Snapshots cannot carry real
	// credentials (those are workspace-scoped encrypted tokens), so the only
	// usable post-install state is "needs reconnect" — the user re-runs OAuth
	// from the installer workspace. Honoring snapshot.status could leave a
	// fresh install marked 'active' with an empty credentials string, which
	// would 500 the first decrypt() the moment anything reads it.
	return {
		workspaceId,
		provider: (snapshot.provider as string) ?? 'unknown',
		status: 'inactive',
		externalId: (snapshot.externalId as string) ?? (snapshot.external_id as string) ?? null,
		credentials: '',
		config: (snapshot.config as Record<string, unknown>) ?? {},
		createdBy,
		metadata,
	}
}
