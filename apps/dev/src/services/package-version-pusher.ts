import type { Database } from '@maskin/db'
import {
	events,
	actors,
	agentFiles,
	catalogPackageItems,
	catalogPackages,
	files,
	imports,
	installedPackages,
	integrations,
	notifications,
	objects,
	readState,
	relationships,
	sessionLogs,
	sessions,
	subscriptions,
	triggers,
	workspaceMembers,
	workspaceSkills,
	workspaces,
} from '@maskin/db/schema'
import { and, eq, inArray, ne, or, sql } from 'drizzle-orm'
import { logger } from '../lib/logger'
import {
	buildActorInsert,
	buildIntegrationInsert,
	buildSkillInsert,
	buildTriggerInsert,
	installMetadata,
	rewriteWiring,
} from './package-provisioning'

// The install endpoint and this cron must build element rows identically, so
// the insert builders + wiring helpers live in `package-provisioning` and are
// shared. Re-exported so the existing test importing `rewriteWiring` from this
// module keeps working.
export { rewriteWiring }

const TICK_MS = 60 * 60 * 1000 // 1h
const STARTUP_DELAY_MS = 90_000 // run once shortly after boot

const NOTIFICATION_TYPE = 'package_update_available'

type ItemType = 'actor' | 'trigger' | 'skill' | 'integration'

interface CatalogItem {
	id: string
	sourceItemId: string
	itemType: ItemType
	itemSnapshot: Record<string, unknown>
}

interface InstalledRow {
	id: string
	sourceItemId: string | null
	type: ItemType
	snapshot: Record<string, unknown>
}

/**
 * Background loop that pushes catalog version updates to installed packages.
 *
 * Runs every hour. For each `installed_packages` row whose `installed_version`
 * no longer matches `catalog_packages.version`:
 *
 * - Locked installs (`is_locked = true`) get re-provisioned: the current
 *   `catalog_package_items` set is diffed against the elements provisioned
 *   into the workspace (matched by `metadata.installed_package_id` +
 *   `metadata.source_item_id`); missing items are inserted, mismatched ones
 *   are updated to the new snapshot, and items no longer in the catalog are
 *   deleted. `installed_packages.installed_version` is bumped on success.
 *
 * - Forked installs (`is_locked = false`) are left alone — the workspace owns
 *   them now. A `package_update_available` notification is inserted (deduped
 *   per (installed_package_id, target_version)) so the UI banner (T9) can
 *   surface the update.
 *
 * Idempotent: re-running the cron after a successful push finds no
 * version mismatches and does nothing; re-running after a partial failure
 * resumes from whatever state is on disk.
 */
export class PackageVersionPusher {
	private timer: NodeJS.Timeout | null = null
	private startupTimer: NodeJS.Timeout | null = null
	private running = false

	constructor(
		private db: Database,
		private tickMs: number = TICK_MS,
	) {}

	start(): void {
		if (this.timer) return
		this.timer = setInterval(() => {
			void this.tick()
		}, this.tickMs)
		this.startupTimer = setTimeout(() => {
			void this.tick()
		}, STARTUP_DELAY_MS)
		this.startupTimer.unref?.()
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer)
			this.timer = null
		}
		if (this.startupTimer) {
			clearTimeout(this.startupTimer)
			this.startupTimer = null
		}
	}

	async tick(): Promise<void> {
		if (this.running) return
		this.running = true
		try {
			const pending = await this.db
				.select({
					install: installedPackages,
					targetVersion: catalogPackages.version,
				})
				.from(installedPackages)
				.innerJoin(catalogPackages, eq(catalogPackages.id, installedPackages.sourcePackageId))
				.where(ne(installedPackages.installedVersion, catalogPackages.version))

			if (pending.length === 0) return

			let locked = 0
			let forked = 0
			let failed = 0

			for (const row of pending) {
				try {
					if (row.install.isLocked) {
						await this.pushLockedInstall(row.install, row.targetVersion)
						locked++
					} else {
						await this.notifyForkedInstall(row.install, row.targetVersion)
						forked++
					}
				} catch (err) {
					failed++
					logger.error('Package version push failed for install', {
						installId: row.install.id,
						sourcePackageId: row.install.sourcePackageId,
						fromVersion: row.install.installedVersion,
						toVersion: row.targetVersion,
						error: err instanceof Error ? err.message : String(err),
					})
				}
			}

			logger.info('Package version pusher tick', {
				scanned: pending.length,
				locked,
				forked,
				failed,
			})
		} catch (err) {
			logger.error('Package version pusher tick failed', {
				error: err instanceof Error ? err.message : String(err),
			})
		} finally {
			this.running = false
		}
	}

	private async pushLockedInstall(
		install: typeof installedPackages.$inferSelect,
		targetVersion: string,
	): Promise<void> {
		const catalogRows = await this.db
			.select()
			.from(catalogPackageItems)
			.where(eq(catalogPackageItems.packageId, install.sourcePackageId))

		const catalogItems: CatalogItem[] = catalogRows.map((r) => ({
			id: r.id,
			sourceItemId: r.sourceItemId,
			itemType: r.itemType as ItemType,
			itemSnapshot: (r.itemSnapshot as Record<string, unknown>) ?? {},
		}))

		const installed = await this.loadInstalledRows(install.id)

		const catalogBySourceId = new Map<string, CatalogItem>()
		for (const item of catalogItems) {
			catalogBySourceId.set(item.sourceItemId, item)
		}
		const installedBySourceId = new Map<string, InstalledRow>()
		for (const row of installed) {
			if (row.sourceItemId) installedBySourceId.set(row.sourceItemId, row)
		}

		// Pre-compute the source→local id map for intra-package wiring rewrites.
		// For adds, the local id doesn't exist yet — we patch the map after each
		// insert below before any later snapshot that might reference it.
		const sourceToLocal = new Map<string, string>()
		for (const row of installed) {
			if (row.sourceItemId) sourceToLocal.set(row.sourceItemId, row.id)
		}

		// The cron has no request actor, so provisioned rows are attributed to a
		// workspace actor (system actor if present, else any member). Resolved
		// when there are adds (triggers/integrations require a NOT NULL created_by)
		// or actor removes (cascade reassigns FK references on objects/files/etc.).
		const hasActorRemoves = installed.some(
			(row) =>
				row.type === 'actor' && !(row.sourceItemId && catalogBySourceId.has(row.sourceItemId)),
		)
		const needsCreatedBy =
			hasActorRemoves || catalogItems.some((item) => !installedBySourceId.has(item.sourceItemId))
		const createdBy = needsCreatedBy ? await this.resolveWorkspaceActor(install.workspaceId) : null

		let adds = 0
		let updates = 0
		let removes = 0

		await this.db.transaction(async (tx) => {
			// Adds + updates — iterate the catalog so adds happen in a stable order.
			for (const item of catalogItems) {
				const existing = installedBySourceId.get(item.sourceItemId)
				const rewritten = rewriteWiring(item.itemSnapshot, sourceToLocal)
				const metadata = installMetadata(install.id, item.sourceItemId, rewritten)
				if (existing) {
					if (snapshotsEqual(existing.snapshot, rewritten)) continue
					switch (item.itemType) {
						case 'actor':
							await tx
								.update(actors)
								.set({ ...buildActorUpdate(rewritten), metadata, updatedAt: new Date() })
								.where(eq(actors.id, existing.id))
							break
						case 'trigger':
							await tx
								.update(triggers)
								.set({ ...buildTriggerUpdate(rewritten), metadata, updatedAt: new Date() })
								.where(eq(triggers.id, existing.id))
							break
						case 'skill':
							await tx
								.update(workspaceSkills)
								.set({ ...buildSkillUpdate(rewritten), metadata, updatedAt: new Date() })
								.where(eq(workspaceSkills.id, existing.id))
							break
						case 'integration':
							await tx
								.update(integrations)
								.set({
									...buildIntegrationUpdate(rewritten),
									metadata,
									updatedAt: new Date(),
								})
								.where(eq(integrations.id, existing.id))
							break
					}
					updates++
				} else {
					let newId: string | undefined
					switch (item.itemType) {
						case 'actor': {
							const [row] = await tx
								.insert(actors)
								.values(buildActorInsert(rewritten, metadata, createdBy))
								.returning({ id: actors.id })
							newId = row?.id
							// Bind the freshly-minted actor to the workspace, exactly as the
							// install endpoint does. Without a workspace_members row the agent
							// is orphaned — it never appears in the workspace agent list and its
							// own X-Workspace-Id calls 403 in authMiddleware, so a trigger
							// targeting it could never run.
							if (newId) {
								await tx.insert(workspaceMembers).values({
									workspaceId: install.workspaceId,
									actorId: newId,
									role: 'member',
								})
							}
							break
						}
						case 'trigger': {
							if (!createdBy) {
								throw new Error(
									`cannot provision trigger ${item.sourceItemId} for install ${install.id}: no workspace actor to attribute it to`,
								)
							}
							const [row] = await tx
								.insert(triggers)
								.values(buildTriggerInsert(install.workspaceId, rewritten, metadata, createdBy))
								.returning({ id: triggers.id })
							newId = row?.id
							break
						}
						case 'skill': {
							const [row] = await tx
								.insert(workspaceSkills)
								.values(buildSkillInsert(install.workspaceId, rewritten, metadata, createdBy))
								.returning({ id: workspaceSkills.id })
							newId = row?.id
							break
						}
						case 'integration': {
							if (!createdBy) {
								throw new Error(
									`cannot provision integration ${item.sourceItemId} for install ${install.id}: no workspace actor to attribute it to`,
								)
							}
							const [row] = await tx
								.insert(integrations)
								.values(buildIntegrationInsert(install.workspaceId, rewritten, metadata, createdBy))
								.returning({ id: integrations.id })
							newId = row?.id
							break
						}
					}
					if (!newId) {
						throw new Error(`insert returned no row for ${item.itemType} ${item.sourceItemId}`)
					}
					sourceToLocal.set(item.sourceItemId, newId)
					adds++
				}
			}

			// Removes — installed elements whose source_item_id is no longer in catalog.
			// Collect actor IDs so they can be cascade-deleted as a batch after the
			// non-actor items are gone; a bare DELETE actors would violate FK constraints.
			const removedActorIds: string[] = []
			for (const row of installed) {
				if (row.sourceItemId && catalogBySourceId.has(row.sourceItemId)) continue
				switch (row.type) {
					case 'actor':
						removedActorIds.push(row.id)
						break
					case 'trigger':
						await tx.delete(triggers).where(eq(triggers.id, row.id))
						break
					case 'skill':
						await tx.delete(workspaceSkills).where(eq(workspaceSkills.id, row.id))
						break
					case 'integration':
						await tx.delete(integrations).where(eq(integrations.id, row.id))
						break
				}
				removes++
			}

			if (removedActorIds.length > 0) {
				// Delete triggers targeting or created by removed actors. This covers both
				// catalog-managed triggers that reference a removed actor AND any
				// user-created triggers pointing at the same agent.
				await tx
					.delete(triggers)
					.where(
						or(
							inArray(triggers.targetActorId, removedActorIds),
							inArray(triggers.createdBy, removedActorIds),
						),
					)

				// Full cascade mirroring the uninstall route — must stay in sync.
				const actorSessions = await tx
					.select({ id: sessions.id })
					.from(sessions)
					.where(inArray(sessions.actorId, removedActorIds))
				const sessionIds = actorSessions.map((s) => s.id)
				if (sessionIds.length > 0) {
					await tx.delete(sessionLogs).where(inArray(sessionLogs.sessionId, sessionIds))
				}
				await tx.delete(sessions).where(inArray(sessions.actorId, removedActorIds))
				if (createdBy) {
					await tx
						.update(sessions)
						.set({ createdBy })
						.where(inArray(sessions.createdBy, removedActorIds))
				}
				await tx.delete(agentFiles).where(inArray(agentFiles.actorId, removedActorIds))
				await tx
					.delete(notifications)
					.where(
						or(
							inArray(notifications.sourceActorId, removedActorIds),
							inArray(notifications.targetActorId, removedActorIds),
						),
					)
				await tx.delete(events).where(inArray(events.actorId, removedActorIds))
				await tx.delete(relationships).where(inArray(relationships.createdBy, removedActorIds))
				await tx.delete(subscriptions).where(inArray(subscriptions.actorId, removedActorIds))
				await tx.delete(readState).where(inArray(readState.actorId, removedActorIds))
				await tx
					.update(objects)
					.set({ driver: null })
					.where(inArray(objects.driver, removedActorIds))
				if (createdBy) {
					await tx
						.update(objects)
						.set({ createdBy })
						.where(inArray(objects.createdBy, removedActorIds))
					await tx.update(files).set({ createdBy }).where(inArray(files.createdBy, removedActorIds))
					await tx
						.update(imports)
						.set({ createdBy })
						.where(inArray(imports.createdBy, removedActorIds))
					await tx
						.update(integrations)
						.set({ createdBy })
						.where(inArray(integrations.createdBy, removedActorIds))
				}
				await tx
					.update(workspaceSkills)
					.set({ createdBy: null })
					.where(inArray(workspaceSkills.createdBy, removedActorIds))
				await tx
					.update(workspaces)
					.set({ createdBy: null })
					.where(inArray(workspaces.createdBy, removedActorIds))
				for (const aid of removedActorIds) {
					await tx.update(actors).set({ createdBy: null }).where(eq(actors.createdBy, aid))
				}
				await tx.delete(workspaceMembers).where(inArray(workspaceMembers.actorId, removedActorIds))
				await tx.delete(actors).where(inArray(actors.id, removedActorIds))
			}

			await tx
				.update(installedPackages)
				.set({ installedVersion: targetVersion, updatedAt: new Date() })
				.where(eq(installedPackages.id, install.id))
		})

		logger.info('Re-provisioned locked install', {
			installId: install.id,
			workspaceId: install.workspaceId,
			fromVersion: install.installedVersion,
			toVersion: targetVersion,
			adds,
			updates,
			removes,
		})
	}

	private async loadInstalledRows(installId: string): Promise<InstalledRow[]> {
		const out: InstalledRow[] = []

		const actorRows = await this.db
			.select({ id: actors.id, metadata: actors.metadata })
			.from(actors)
			.where(sql`${actors.metadata}->>'installed_package_id' = ${installId}`)
		for (const r of actorRows) {
			out.push(toInstalledRow(r.id, 'actor', r.metadata))
		}

		const triggerRows = await this.db
			.select({ id: triggers.id, metadata: triggers.metadata })
			.from(triggers)
			.where(sql`${triggers.metadata}->>'installed_package_id' = ${installId}`)
		for (const r of triggerRows) {
			out.push(toInstalledRow(r.id, 'trigger', r.metadata))
		}

		const skillRows = await this.db
			.select({ id: workspaceSkills.id, metadata: workspaceSkills.metadata })
			.from(workspaceSkills)
			.where(sql`${workspaceSkills.metadata}->>'installed_package_id' = ${installId}`)
		for (const r of skillRows) {
			out.push(toInstalledRow(r.id, 'skill', r.metadata))
		}

		const integrationRows = await this.db
			.select({ id: integrations.id, metadata: integrations.metadata })
			.from(integrations)
			.where(sql`${integrations.metadata}->>'installed_package_id' = ${installId}`)
		for (const r of integrationRows) {
			out.push(toInstalledRow(r.id, 'integration', r.metadata))
		}

		return out
	}

	private async notifyForkedInstall(
		install: typeof installedPackages.$inferSelect,
		targetVersion: string,
	): Promise<void> {
		// Dedupe: don't pile up notifications for the same install + target version.
		const existing = await this.db
			.select({ id: notifications.id })
			.from(notifications)
			.where(
				and(
					eq(notifications.workspaceId, install.workspaceId),
					eq(notifications.type, NOTIFICATION_TYPE),
					eq(notifications.status, 'pending'),
					sql`${notifications.metadata}->>'installed_package_id' = ${install.id}`,
					sql`${notifications.metadata}->>'to_version' = ${targetVersion}`,
				),
			)
			.limit(1)
		if (existing.length > 0) return

		const sourceActorId = await this.resolveWorkspaceActor(install.workspaceId)
		if (!sourceActorId) {
			logger.warn('No source actor available for package_update_available notification', {
				installId: install.id,
				workspaceId: install.workspaceId,
			})
			return
		}

		await this.db.insert(notifications).values({
			workspaceId: install.workspaceId,
			type: NOTIFICATION_TYPE,
			title: 'Package update available',
			content: `Version ${targetVersion} is available for a forked install.`,
			sourceActorId,
			status: 'pending',
			metadata: {
				installed_package_id: install.id,
				from_version: install.installedVersion,
				to_version: targetVersion,
			},
		})

		logger.info('Notified forked install of available update', {
			installId: install.id,
			workspaceId: install.workspaceId,
			fromVersion: install.installedVersion,
			toVersion: targetVersion,
		})
	}

	// Resolve an actor to attribute cron-side writes to (notification source,
	// provisioned-row `created_by`). Prefers a system actor (e.g. Sindre) that is
	// a member of this workspace, then falls back to any member at all.
	private async resolveWorkspaceActor(workspaceId: string): Promise<string | null> {
		const systemMember = await this.db
			.select({ id: actors.id })
			.from(workspaceMembers)
			.innerJoin(actors, eq(actors.id, workspaceMembers.actorId))
			.where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(actors.isSystem, true)))
			.limit(1)
		if (systemMember[0]) return systemMember[0].id

		const anyMember = await this.db
			.select({ id: workspaceMembers.actorId })
			.from(workspaceMembers)
			.where(eq(workspaceMembers.workspaceId, workspaceId))
			.limit(1)
		return anyMember[0]?.id ?? null
	}
}

// ── helpers ────────────────────────────────────────────────────────────────

function toInstalledRow(id: string, type: ItemType, metadata: unknown): InstalledRow {
	const meta = (metadata as Record<string, unknown>) ?? {}
	return {
		id,
		sourceItemId: typeof meta.source_item_id === 'string' ? meta.source_item_id : null,
		type,
		snapshot: (meta.snapshot as Record<string, unknown>) ?? {},
	}
}

function snapshotsEqual(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b)
}

function buildActorUpdate(snapshot: Record<string, unknown>): Partial<typeof actors.$inferInsert> {
	return {
		name: (snapshot.name as string) ?? 'Untitled agent',
		description: (snapshot.description as string) ?? null,
		systemPrompt: (snapshot.systemPrompt as string) ?? (snapshot.system_prompt as string) ?? null,
		llmProvider: (snapshot.llmProvider as string) ?? (snapshot.llm_provider as string) ?? null,
		llmConfig:
			(snapshot.llmConfig as Record<string, unknown>) ??
			(snapshot.llm_config as Record<string, unknown>) ??
			null,
		tools: (snapshot.tools as Record<string, unknown>) ?? null,
	}
}

function buildTriggerUpdate(
	snapshot: Record<string, unknown>,
): Partial<typeof triggers.$inferInsert> {
	return {
		name: (snapshot.name as string) ?? 'Untitled trigger',
		type: (snapshot.type as string) ?? 'cron',
		config: (snapshot.config as Record<string, unknown>) ?? {},
		actionPrompt: (snapshot.actionPrompt as string) ?? (snapshot.action_prompt as string) ?? '',
		targetActorId: (snapshot.targetActorId as string) ?? (snapshot.target_actor_id as string) ?? '',
		enabled: typeof snapshot.enabled === 'boolean' ? snapshot.enabled : true,
	}
}

function buildSkillUpdate(
	snapshot: Record<string, unknown>,
): Partial<typeof workspaceSkills.$inferInsert> {
	return {
		description: (snapshot.description as string) ?? null,
		content: (snapshot.content as string) ?? '',
		storageKey: (snapshot.storageKey as string) ?? (snapshot.storage_key as string) ?? '',
		sizeBytes:
			typeof snapshot.sizeBytes === 'number'
				? snapshot.sizeBytes
				: typeof snapshot.size_bytes === 'number'
					? (snapshot.size_bytes as number)
					: 0,
		isValid: typeof snapshot.isValid === 'boolean' ? snapshot.isValid : true,
	}
}

function buildIntegrationUpdate(
	snapshot: Record<string, unknown>,
): Partial<typeof integrations.$inferInsert> {
	// status and credentials are runtime state owned by the install workspace —
	// never restore them from a catalog snapshot. Honoring snapshot.status here
	// would flip a freshly-installed integration to 'active' even though its
	// credentials column is empty, causing decrypt() to crash on first access.
	// (Same rationale as buildIntegrationInsert forcing status='inactive'.)
	return {
		provider: (snapshot.provider as string) ?? 'unknown',
		externalId: (snapshot.externalId as string) ?? (snapshot.external_id as string) ?? null,
		config: (snapshot.config as Record<string, unknown>) ?? {},
	}
}
