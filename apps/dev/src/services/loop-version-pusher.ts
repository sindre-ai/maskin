import { randomUUID } from 'node:crypto'
import type { Database } from '@maskin/db'
import {
	events,
	actors,
	agentFiles,
	agentSkills,
	conversationParticipants,
	files,
	imports,
	installedLoops,
	integrations,
	marketplaceLoopItems,
	marketplaceLoops,
	messages,
	notifications,
	objects,
	orphanThreadDetections,
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
import type { StorageProvider } from '@maskin/storage'
import { and, eq, inArray, ne, or, sql } from 'drizzle-orm'
import { recordEvent } from '../lib/events/record-event'
import { logger } from '../lib/logger'
import { loopSettingsPatch, readLoopSettings } from '../lib/marketplace-loops/loop-settings'
import { LLM_CONFIG_ALLOWLIST, dropLegacyBrowserFlag } from '../lib/marketplace-loops/loop-snapshot'
import { type AgentStorageManager, workspaceSkillKey } from './agent-storage'
import {
	buildActorInsert,
	buildIntegrationInsert,
	buildSkillInsert,
	buildTriggerInsert,
	findProvisionedActorBySourceItem,
	findProvisionedSkillBySourceItem,
	findWorkspaceSkillByName,
	installMetadata,
	partitionProvisionedActors,
	partitionProvisionedSkills,
	rewriteWiring,
} from './loop-provisioning'
import {
	type ViewSyncCounts,
	deleteViewFileBytes,
	syncLoopViews,
	toViewItems,
} from './loop-views-provisioning'
import {
	type CapturedLiveSession,
	captureLiveSessions,
	stopCapturedSandboxes,
} from './session-cleanup'
import { createWorkspaceDesktopService, removeDesktopsForActors } from './workspace-desktop'

// The install endpoint and this cron must build element rows identically, so
// the insert builders + wiring helpers live in `loop-provisioning` and are
// shared.

const TICK_MS = 60 * 60 * 1000 // 1h
const STARTUP_DELAY_MS = 90_000 // run once shortly after boot

const NOTIFICATION_TYPE = 'loop_update_available'

type ItemType = 'actor' | 'trigger' | 'skill' | 'integration'

interface MarketplaceItem {
	id: string
	sourceItemId: string
	itemType: ItemType
	itemSnapshot: Record<string, unknown>
}

export interface PushCounts {
	adds: number
	updates: number
	removes: number
	reuses: number
}

interface InstalledRow {
	id: string
	sourceItemId: string | null
	type: ItemType
	snapshot: Record<string, unknown>
}

/**
 * Background loop that pushes marketplace loop version updates to installed loops.
 *
 * Runs every hour. For each `installed_loops` row whose `installed_version`
 * no longer matches `marketplace_loops.version`:
 *
 * - Locked installs (`is_locked = true`) get re-provisioned: the current
 *   `marketplace_loop_items` set is diffed against the elements provisioned
 *   into the workspace (matched by `metadata.installed_loop_id` +
 *   `metadata.source_item_id`); missing items are inserted, mismatched ones
 *   are updated to the new snapshot, and items no longer in the marketplace
 *   loop are deleted. `installed_loops.installed_version` is bumped on
 *   success. Any newly-inserted trigger also gets appended to the linked
 *   `objects.type = 'loop'` row's `metadata.trigger_ids` (see
 *   `installed-loops.ts` for where that Loop object is first created).
 *
 * - Forked installs (`is_locked = false`) are left alone — the workspace owns
 *   them now. A `loop_update_available` notification is inserted (deduped
 *   per (installed_loop_id, target_version)) so the UI banner (T9) can
 *   surface the update.
 *
 * Idempotent: re-running the cron after a successful push finds no
 * version mismatches and does nothing; re-running after a partial failure
 * resumes from whatever state is on disk.
 */
export class LoopVersionPusher {
	private timer: NodeJS.Timeout | null = null
	private startupTimer: NodeJS.Timeout | null = null
	private running = false

	constructor(
		private db: Database,
		private agentStorage: AgentStorageManager,
		private tickMs: number = TICK_MS,
		// Where the pages of a loop's custom views are written. Only needed for
		// loops that publish views; a push that finds views without it fails and
		// retries on the next tick.
		private storage?: StorageProvider,
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
					install: installedLoops,
					targetVersion: marketplaceLoops.version,
				})
				.from(installedLoops)
				.innerJoin(marketplaceLoops, eq(marketplaceLoops.id, installedLoops.sourceLoopId))
				.where(ne(installedLoops.installedVersion, marketplaceLoops.version))

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
					logger.error('Loop version push failed for install', {
						installId: row.install.id,
						sourceLoopId: row.install.sourceLoopId,
						fromVersion: row.install.installedVersion,
						toVersion: row.targetVersion,
						error: err instanceof Error ? err.message : String(err),
					})
				}
			}

			logger.info('Loop version pusher tick', {
				scanned: pending.length,
				locked,
				forked,
				failed,
			})
		} catch (err) {
			logger.error('Loop version pusher tick failed', {
				error: err instanceof Error ? err.message : String(err),
			})
		} finally {
			this.running = false
		}
	}

	/**
	 * "Update now" for one locked install: the same re-provision the hourly tick
	 * runs, started by a person. `callerActorId` is who the audit event is
	 * attributed to. Returns `current` when the install is already at the
	 * catalog version (nothing is written), `forked` when the workspace owns the
	 * install (never touched), and `updated` with the item counts otherwise.
	 */
	async updateInstallNow(
		installId: string,
		callerActorId: string,
	): Promise<
		| { status: 'not_found' }
		| { status: 'forked'; install: typeof installedLoops.$inferSelect }
		| { status: 'current'; install: typeof installedLoops.$inferSelect; version: string }
		| {
				status: 'updated'
				install: typeof installedLoops.$inferSelect
				fromVersion: string
				toVersion: string
				items: PushCounts
		  }
	> {
		const [row] = await this.db
			.select({ install: installedLoops, targetVersion: marketplaceLoops.version })
			.from(installedLoops)
			.innerJoin(marketplaceLoops, eq(marketplaceLoops.id, installedLoops.sourceLoopId))
			.where(eq(installedLoops.id, installId))
			.limit(1)
		if (!row) return { status: 'not_found' }
		if (!row.install.isLocked) return { status: 'forked', install: row.install }
		if (row.install.installedVersion === row.targetVersion) {
			return { status: 'current', install: row.install, version: row.targetVersion }
		}

		const items = await this.pushLockedInstall(row.install, row.targetVersion, callerActorId)
		const [fresh] = await this.db
			.select()
			.from(installedLoops)
			.where(eq(installedLoops.id, installId))
			.limit(1)
		if (!items) {
			// A concurrent push (the hourly tick) got there first.
			return { status: 'current', install: fresh ?? row.install, version: row.targetVersion }
		}
		return {
			status: 'updated',
			install: fresh ?? row.install,
			fromVersion: row.install.installedVersion,
			toVersion: row.targetVersion,
			items,
		}
	}

	// Returns the item counts, or null when a concurrent push had already brought
	// the install to `targetVersion` by the time this one held the row lock.
	private async pushLockedInstall(
		install: typeof installedLoops.$inferSelect,
		targetVersion: string,
		actingActorId?: string,
	): Promise<PushCounts | null> {
		const loopItemRows = await this.db
			.select()
			.from(marketplaceLoopItems)
			.where(eq(marketplaceLoopItems.loopId, install.sourceLoopId))

		// Views are not rows in the workspace like the other items; they are synced
		// to the loop object's tabs separately below.
		const loopItems: MarketplaceItem[] = loopItemRows
			.filter((r) => r.itemType !== 'view')
			.map((r) => ({
				id: r.id,
				sourceItemId: r.sourceItemId,
				itemType: r.itemType as ItemType,
				itemSnapshot: (r.itemSnapshot as Record<string, unknown>) ?? {},
			}))

		const installed = await this.loadInstalledRows(install.id)

		const loopItemsBySourceId = new Map<string, MarketplaceItem>()
		for (const item of loopItems) {
			loopItemsBySourceId.set(item.sourceItemId, item)
		}
		const installedBySourceId = new Map<string, InstalledRow>()
		for (const row of installed) {
			if (row.sourceItemId) installedBySourceId.set(row.sourceItemId, row)
		}

		// Pre-compute the source→local id map for intra-loop wiring rewrites.
		// For adds, the local id doesn't exist yet — we patch the map after each
		// insert below before any later snapshot that might reference it.
		const sourceToLocal = new Map<string, string>()
		for (const row of installed) {
			if (row.sourceItemId) sourceToLocal.set(row.sourceItemId, row.id)
		}

		// The cron has no request actor, so provisioned rows — and the audit event
		// below — are attributed to a workspace actor (system actor if present,
		// else any member). Always resolved: adds/actor-removes need it for FK
		// attribution, and the events row always needs a non-null actorId.
		// An on-demand update is attributed to the person who asked for it.
		const createdBy = actingActorId ?? (await this.resolveWorkspaceActor(install.workspaceId))

		let adds = 0
		let updates = 0
		let removes = 0
		// Actors the dedup guard matched instead of inserting — a separate bucket
		// so the audit trail tells newly-created rows apart from reused ones.
		let reuses = 0
		// Ids of workspace_skills rows deleted by the "removes" pass below,
		// cleaned up from S3 after the tx commits (see the post-commit loop).
		const removedSkillIds: string[] = []
		// Live sessions belonging to agents this push removes. Captured inside the
		// tx (only there is the kept-vs-removed actor split known) and stopped
		// once it commits — see session-cleanup.ts. Otherwise their sandboxes run
		// on as agents the loop no longer defines, holding agent-server capacity
		// until the 2h timeout and streaming logs at a deleted session row.
		const strandedSessions: CapturedLiveSession[] = []
		// Agents this push deletes; their computers are removed once it commits.
		const deletedActorIds: string[] = []
		// Newly-inserted / removed trigger ids this tick — folded into the linked
		// Loop object's `metadata.trigger_ids` after the transaction's per-item
		// work finishes (see below).
		const newTriggerIds: string[] = []
		const removedTriggerIds: string[] = []

		// Skill → source-actor-id bindings, resolved to agent_skills rows once
		// the add/update/remove passes below finish (mirrors the install route's
		// pass-1.5 — see installed-loops.ts).
		const skillActorBindings: Array<{ sourceSkillId: string; sourceActorIds: string[] }> = []

		let viewCounts: ViewSyncCounts | null = null
		let alreadyCurrent = false
		await this.db.transaction(async (tx) => {
			// Serialise with any other push of this install (the hourly tick or a
			// second "update now"): hold the row lock, then re-check the version.
			// A push that finished while this one was reading has already moved
			// installed_version, so this one stops before writing anything.
			const [locked] = await tx
				.select({ installedVersion: installedLoops.installedVersion })
				.from(installedLoops)
				.where(eq(installedLoops.id, install.id))
				.for('update')
			if (!locked || locked.installedVersion === targetVersion) {
				alreadyCurrent = true
				return
			}

			// Adds + updates — iterate the marketplace loop so adds happen in a stable order.
			for (const item of loopItems) {
				const existing = installedBySourceId.get(item.sourceItemId)
				const rewritten = rewriteWiring(item.itemSnapshot, sourceToLocal)
				const metadata = installMetadata(install.id, item.sourceItemId, rewritten)
				if (item.itemType === 'skill') {
					const attachedActorIds = Array.isArray(item.itemSnapshot.attachedActorIds)
						? (item.itemSnapshot.attachedActorIds as string[])
						: []
					if (attachedActorIds.length > 0) {
						skillActorBindings.push({
							sourceSkillId: item.sourceItemId,
							sourceActorIds: attachedActorIds,
						})
					}
				}
				if (existing) {
					if (snapshotsEqual(existing.snapshot, metadata.snapshot)) continue
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
							// Existing row keeps its own workspace-scoped storageKey — only the
							// bytes at that key need refreshing.
							await this.agentStorage.putWorkspaceSkill(
								install.workspaceId,
								existing.id,
								(rewritten.content as string) ?? '',
							)
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
					let wasReused = false
					switch (item.itemType) {
						case 'actor': {
							// Dedup guard — mirrors the install endpoint: this workspace may
							// already hold the agent from another loop that bundles it, so
							// reuse instead of cloning (a join on workspace_members guarantees
							// the reused actor is already bound to this workspace).
							const existing = await findProvisionedActorBySourceItem(
								tx,
								install.workspaceId,
								item.sourceItemId,
							)
							if (existing) {
								// Re-snapshot the reused agent to the version being pushed and
								// re-stamp its metadata to this install. A reused agent keeps the
								// config the creating loop pinned; without this write, this
								// install's UI reports its own version while the agent runs frozen
								// divergence. Stamping `installed_loop_id` also ends the per-tick
								// phantom add — the next tick diffs this row as owned.
								await tx
									.update(actors)
									.set({ ...buildActorUpdate(rewritten), metadata, updatedAt: new Date() })
									.where(eq(actors.id, existing.id))
								newId = existing.id
								wasReused = true
								reuses++
								break
							}
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
							if (newId) newTriggerIds.push(newId)
							break
						}
						case 'skill': {
							// Dedup guard — mirrors the actor case above: this workspace may
							// already hold the skill from another loop that bundles it (skills
							// have a `(workspace_id, name)` unique index, so a bare insert would
							// collide). Reuse instead of cloning.
							const existingSkill = await findProvisionedSkillBySourceItem(
								tx,
								install.workspaceId,
								item.sourceItemId,
							)
							if (existingSkill) {
								// Re-snapshot + re-stamp, exactly as the actor reuse path does —
								// keeps the reused skill's content in sync with the version being
								// pushed and ends the per-tick phantom-add (next tick diffs this
								// row as owned by this install).
								await tx
									.update(workspaceSkills)
									.set({ ...buildSkillUpdate(rewritten), metadata, updatedAt: new Date() })
									.where(eq(workspaceSkills.id, existingSkill.id))
								await this.agentStorage.putWorkspaceSkill(
									install.workspaceId,
									existingSkill.id,
									(rewritten.content as string) ?? '',
								)
								newId = existingSkill.id
								wasReused = true
								reuses++
								break
							}
							// Fallback dedup guard, mirroring installed-loops.ts: two loops
							// published independently (different `source_item_id`s) can still
							// bundle a skill with the same name. Reuse the existing row as-is
							// rather than 500ing the whole push on the unique-index collision —
							// unlike the source-item match above, don't overwrite its content,
							// since it isn't necessarily "the same" item.
							const skillName = (rewritten.name as string) ?? 'untitled-skill'
							const existingByName = await findWorkspaceSkillByName(
								tx,
								install.workspaceId,
								skillName,
							)
							if (existingByName) {
								newId = existingByName.id
								wasReused = true
								reuses++
								break
							}
							// Fresh id + workspace-scoped S3 key — never reuse the publisher's
							// storageKey (see buildSkillInsert). Mirrors installed-loops.ts.
							const skillId = randomUUID()
							const storageKey = workspaceSkillKey(install.workspaceId, skillId)
							let row: { id: string } | undefined
							try {
								;[row] = await tx
									.insert(workspaceSkills)
									.values(
										buildSkillInsert(
											install.workspaceId,
											skillId,
											storageKey,
											rewritten,
											metadata,
											createdBy,
										),
									)
									.returning({ id: workspaceSkills.id })
							} catch (err) {
								const cause = (err as { cause?: { code?: string; table_name?: string } }).cause
								if (cause?.code === '23505' && cause.table_name === 'workspace_skills') {
									// Lost a race against a concurrent push/install that just
									// created the same-named row — reuse it instead of failing.
									const reconciled = await findWorkspaceSkillByName(
										tx,
										install.workspaceId,
										skillName,
									)
									if (reconciled) {
										newId = reconciled.id
										wasReused = true
										reuses++
										break
									}
								}
								throw err
							}
							newId = row?.id
							if (newId) {
								await this.agentStorage.putWorkspaceSkill(
									install.workspaceId,
									skillId,
									(rewritten.content as string) ?? '',
								)
							}
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
					if (!wasReused) adds++
				}
			}

			// Removes — installed elements whose source_item_id is no longer in the
			// marketplace loop. Collect actor rows so they can be kept (shared with
			// another installed loop) or cascade-deleted as a batch after the
			// non-actor items are gone; a bare DELETE actors would violate FK
			// constraints and would take down a shared agent's triggers with it.
			const removedActorRows: Array<{ id: string; sourceItemId: string | null }> = []
			const removedSkillRows: Array<{ id: string; sourceItemId: string | null; name: string }> = []
			for (const row of installed) {
				if (row.sourceItemId && loopItemsBySourceId.has(row.sourceItemId)) continue
				switch (row.type) {
					case 'actor':
						removedActorRows.push({ id: row.id, sourceItemId: row.sourceItemId })
						break
					case 'trigger':
						await tx.delete(triggers).where(eq(triggers.id, row.id))
						removedTriggerIds.push(row.id)
						break
					case 'skill':
						removedSkillRows.push({
							id: row.id,
							sourceItemId: row.sourceItemId,
							name: (row.snapshot.name as string) ?? 'untitled-skill',
						})
						break
					case 'integration':
						await tx.delete(integrations).where(eq(integrations.id, row.id))
						break
				}
				removes++
			}

			// Ownership-aware partition, same rationale as actors below: a skill
			// this install drops but another live install still bundles survives
			// the push, rehomed under that install. Only the unreferenced
			// remainder is deleted.
			const { deleted: deletedSkillIds, kept: keptSkillRefs } = await partitionProvisionedSkills(
				tx,
				install.workspaceId,
				install.id,
				removedSkillRows,
			)
			removes -= removedSkillRows.length - deletedSkillIds.length
			if (deletedSkillIds.length > 0) {
				await tx.delete(workspaceSkills).where(inArray(workspaceSkills.id, deletedSkillIds))
			}
			removedSkillIds.push(...deletedSkillIds)
			if (keptSkillRefs.length > 0) {
				logger.info('Kept shared skill on version push — another installed loop still bundles it', {
					installId: install.id,
					workspaceId: install.workspaceId,
					keptSkillIds: keptSkillRefs.map((k) => k.id),
				})
			}

			// Ownership-aware partition (mirrors the uninstall route): an agent this
			// install drops but another live install still references survives the
			// push, rehomed under that install, so its triggers keep firing. Only the
			// unreferenced remainder is cascade-deleted below.
			const { deleted: removedActorIds } = await partitionProvisionedActors(
				tx,
				install.workspaceId,
				install.id,
				removedActorRows,
			)
			// Actors kept because another live loop still references them were not
			// removed — don't let them inflate the audit trail's removes bucket.
			removes -= removedActorRows.length - removedActorIds.length

			if (removedActorIds.length > 0) {
				strandedSessions.push(...(await captureLiveSessions(tx, removedActorIds)))
				deletedActorIds.push(...removedActorIds)

				if (!createdBy) {
					throw new Error(
						`cannot remove actors for install ${install.id}: no workspace actor to reassign their content to`,
					)
				}

				// Delete triggers targeting or created by removed actors. This covers both
				// marketplace-managed triggers that reference a removed actor AND any
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
				await tx
					.update(sessions)
					.set({ createdBy })
					.where(inArray(sessions.createdBy, removedActorIds))
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
				// conversation_participants.actor_id/added_by are RESTRICT FKs to
				// actors.id with no cascade — null out added_by on surviving rows,
				// then drop the removed actors' own participant rows.
				await tx
					.update(conversationParticipants)
					.set({ addedBy: null })
					.where(inArray(conversationParticipants.addedBy, removedActorIds))
				await tx
					.delete(conversationParticipants)
					.where(inArray(conversationParticipants.actorId, removedActorIds))
				await tx
					.delete(orphanThreadDetections)
					.where(inArray(orphanThreadDetections.expectedReplyActorId, removedActorIds))
				await tx
					.update(objects)
					.set({ driver: null })
					.where(inArray(objects.driver, removedActorIds))
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
				// messages.actor_id is NOT NULL with no cascade — reassign authorship
				// rather than deleting message history.
				await tx
					.update(messages)
					.set({ actorId: createdBy })
					.where(inArray(messages.actorId, removedActorIds))
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

			// Bind each new/updated skill to the actor(s) it's attached to in the
			// source workspace, now that every actor/skill this tick touched has a
			// resolved local id. Source actor ids removed above are skipped — their
			// local row no longer exists, so a bind would violate the FK. Already-
			// bound pairs are a no-op (onConflictDoNothing).
			for (const { sourceSkillId, sourceActorIds } of skillActorBindings) {
				const localSkillId = sourceToLocal.get(sourceSkillId)
				if (!localSkillId) continue
				for (const sourceActorId of sourceActorIds) {
					const localActorId = sourceToLocal.get(sourceActorId)
					if (!localActorId || removedActorIds.includes(localActorId)) continue
					await tx
						.insert(agentSkills)
						.values({ actorId: localActorId, workspaceSkillId: localSkillId })
						.onConflictDoNothing()
				}
			}

			// Custom views (tabs on the loop page): write the pages the new version
			// brings and drop the ones it no longer publishes. A loop with no views
			// costs no queries here. A version that drops every view leaves the
			// install's tabs until a later version publishes one (see
			// loop-views-provisioning.ts).
			const viewItems = toViewItems(loopItemRows)
			if (install.objectId && viewItems.length > 0) {
				if (!this.storage) {
					throw new Error(
						`cannot sync views for install ${install.id}: the version pusher has no file storage`,
					)
				}
				if (!createdBy) {
					throw new Error(
						`cannot sync views for install ${install.id}: no workspace actor to attribute the pages to`,
					)
				}
				viewCounts = await syncLoopViews({
					db: tx,
					storage: this.storage,
					workspaceId: install.workspaceId,
					loopObjectId: install.objectId,
					actorId: createdBy,
					items: viewItems,
				})
			}

			// Fold this tick's trigger adds/removes into the linked Loop object's
			// `metadata.trigger_ids` (see installed-loops.ts for where that object is
			// first created at install time). Agent association on `GET /api/loops`
			// derives automatically from each trigger's `targetActorId` — no separate
			// agent bookkeeping needed here.
			if (install.objectId && (newTriggerIds.length > 0 || removedTriggerIds.length > 0)) {
				const [loopObject] = await tx
					.select({ metadata: objects.metadata })
					.from(objects)
					.where(eq(objects.id, install.objectId))
					.limit(1)
				const existingTriggerIds = Array.isArray(
					(loopObject?.metadata as Record<string, unknown> | null)?.trigger_ids,
				)
					? ((loopObject?.metadata as Record<string, unknown>).trigger_ids as string[])
					: []
				const removedSet = new Set(removedTriggerIds)
				const mergedTriggerIds = Array.from(
					new Set([...existingTriggerIds.filter((id) => !removedSet.has(id)), ...newTriggerIds]),
				)
				await tx
					.update(objects)
					.set({
						metadata: sql`jsonb_set(coalesce(${objects.metadata}, '{}'::jsonb), '{trigger_ids}', ${JSON.stringify(mergedTriggerIds)}::jsonb)`,
						updatedAt: new Date(),
					})
					.where(eq(objects.id, install.objectId))
			}

			// Loop-page settings (entry and close condition, tags, starter targets). A
			// field a workspace has edited is kept; see loopSettingsPatch.
			if (install.objectId) {
				const [source] = await tx
					.select({ loopSettings: marketplaceLoops.loopSettings })
					.from(marketplaceLoops)
					.where(eq(marketplaceLoops.id, install.sourceLoopId))
					.limit(1)
				const [loopObject] = await tx
					.select({ metadata: objects.metadata })
					.from(objects)
					.where(eq(objects.id, install.objectId))
					.limit(1)
				if (loopObject) {
					const patch = loopSettingsPatch(
						readLoopSettings(source?.loopSettings),
						loopObject.metadata as Record<string, unknown> | null,
					)
					if (Object.keys(patch).length > 0) {
						await tx
							.update(objects)
							.set({
								metadata: sql`coalesce(${objects.metadata}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`,
								updatedAt: new Date(),
							})
							.where(eq(objects.id, install.objectId))
					}
				}
			}

			await tx
				.update(installedLoops)
				.set({ installedVersion: targetVersion, updatedAt: new Date() })
				.where(eq(installedLoops.id, install.id))

			if (createdBy) {
				await recordEvent(tx, {
					workspaceId: install.workspaceId,
					actorId: createdBy,
					action: 'updated',
					entityType: 'installed_loop',
					entityId: install.id,
					data: {
						source_loop_id: install.sourceLoopId,
						from_version: install.installedVersion,
						to_version: targetVersion,
						items: { adds, updates, removes, reuses },
						...(viewCounts ? { views: viewCountsForEvent(viewCounts) } : {}),
						trigger: actingActorId ? 'manual' : 'cron',
					},
				})
			} else {
				logger.warn('No workspace actor available to attribute loop version push event', {
					installId: install.id,
					workspaceId: install.workspaceId,
				})
			}
		})

		if (alreadyCurrent) return null

		await stopCapturedSandboxes(this.db, strandedSessions)
		await removeDesktopsForActors(
			install.workspaceId,
			deletedActorIds,
			createWorkspaceDesktopService(this.db),
		)

		// The tx has committed, so a failure here cannot undo the delete: log it and
		// carry on with the other agents. The actor ids are only known inside the tx,
		// which is why this is not done up front the way DELETE /actors/:id does it.
		for (const deletedActorId of deletedActorIds) {
			try {
				await this.agentStorage.deleteAllAgentFiles(deletedActorId, install.workspaceId)
			} catch (err) {
				logger.error('Failed to delete agent files from storage (orphan objects left)', {
					workspaceId: install.workspaceId,
					actorId: deletedActorId,
					error: String(err),
				})
			}
		}

		for (const skillId of removedSkillIds) {
			try {
				await this.agentStorage.deleteWorkspaceSkill(install.workspaceId, skillId)
			} catch (err) {
				logger.error('Failed to delete workspace skill from storage (orphan object left)', {
					workspaceId: install.workspaceId,
					skillId,
					error: String(err),
				})
			}
		}

		const syncedViews = viewCounts as ViewSyncCounts | null
		if (syncedViews && this.storage) {
			await deleteViewFileBytes(this.storage, install.workspaceId, syncedViews.removedFileIds)
		}

		logger.info('Re-provisioned locked install', {
			installId: install.id,
			workspaceId: install.workspaceId,
			fromVersion: install.installedVersion,
			toVersion: targetVersion,
			adds,
			updates,
			removes,
			reuses,
			...(syncedViews ? { views: viewCountsForEvent(syncedViews) } : {}),
		})
		return { adds, updates, removes, reuses }
	}

	private async loadInstalledRows(installId: string): Promise<InstalledRow[]> {
		const out: InstalledRow[] = []

		const actorRows = await this.db
			.select({ id: actors.id, metadata: actors.metadata })
			.from(actors)
			.where(sql`${actors.metadata}->>'installed_loop_id' = ${installId}`)
		for (const r of actorRows) {
			out.push(toInstalledRow(r.id, 'actor', r.metadata))
		}

		const triggerRows = await this.db
			.select({ id: triggers.id, metadata: triggers.metadata })
			.from(triggers)
			.where(sql`${triggers.metadata}->>'installed_loop_id' = ${installId}`)
		for (const r of triggerRows) {
			out.push(toInstalledRow(r.id, 'trigger', r.metadata))
		}

		const skillRows = await this.db
			.select({ id: workspaceSkills.id, metadata: workspaceSkills.metadata })
			.from(workspaceSkills)
			.where(sql`${workspaceSkills.metadata}->>'installed_loop_id' = ${installId}`)
		for (const r of skillRows) {
			out.push(toInstalledRow(r.id, 'skill', r.metadata))
		}

		const integrationRows = await this.db
			.select({ id: integrations.id, metadata: integrations.metadata })
			.from(integrations)
			.where(sql`${integrations.metadata}->>'installed_loop_id' = ${installId}`)
		for (const r of integrationRows) {
			out.push(toInstalledRow(r.id, 'integration', r.metadata))
		}

		return out
	}

	private async notifyForkedInstall(
		install: typeof installedLoops.$inferSelect,
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
					sql`${notifications.metadata}->>'installed_loop_id' = ${install.id}`,
					sql`${notifications.metadata}->>'to_version' = ${targetVersion}`,
				),
			)
			.limit(1)
		if (existing.length > 0) return

		const sourceActorId = await this.resolveWorkspaceActor(install.workspaceId)
		if (!sourceActorId) {
			logger.warn('No source actor available for loop_update_available notification', {
				installId: install.id,
				workspaceId: install.workspaceId,
			})
			return
		}

		await this.db.insert(notifications).values({
			workspaceId: install.workspaceId,
			type: NOTIFICATION_TYPE,
			title: 'Loop update available',
			content: `Version ${targetVersion} is available for a forked install.`,
			sourceActorId,
			status: 'pending',
			metadata: {
				installed_loop_id: install.id,
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
	// provisioned-row `created_by`). Prefers a system actor (e.g. Workspace Coach) that is
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

function viewCountsForEvent(counts: ViewSyncCounts) {
	return {
		adds: counts.adds,
		updates: counts.updates,
		removes: counts.removes,
		kept: counts.kept,
	}
}

function toInstalledRow(id: string, type: ItemType, metadata: unknown): InstalledRow {
	const meta = (metadata as Record<string, unknown>) ?? {}
	return {
		id,
		sourceItemId: typeof meta.source_item_id === 'string' ? meta.source_item_id : null,
		type,
		snapshot: (meta.snapshot as Record<string, unknown>) ?? {},
	}
}

// Key order must not matter: the stored snapshot comes back from a jsonb column
// (keys reordered, shorter first), while the catalog copy is rebuilt in code.
function canonicalJson(value: unknown): string {
	return JSON.stringify(value, (_key, v) =>
		v && typeof v === 'object' && !Array.isArray(v)
			? Object.fromEntries(Object.entries(v).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)))
			: v,
	)
}

export function snapshotsEqual(a: unknown, b: unknown): boolean {
	return canonicalJson(a) === canonicalJson(b)
}

function buildActorUpdate(snapshot: Record<string, unknown>): Partial<typeof actors.$inferInsert> {
	return {
		name: (snapshot.name as string) ?? 'Untitled agent',
		description: (snapshot.description as string) ?? null,
		systemPrompt: (snapshot.systemPrompt as string) ?? (snapshot.system_prompt as string) ?? null,
		llmProvider: (snapshot.llmProvider as string) ?? (snapshot.llm_provider as string) ?? null,
		...mergeLlmConfig(snapshot),
		// Same handling as buildActorInsert — see its comment.
		tools: (dropLegacyBrowserFlag(snapshot.tools) as Record<string, unknown>) ?? null,
	}
}

// The agent's llm_config holds the workspace's own provider credential, which a
// catalog snapshot never carries. An update merges provider and model over the
// existing config instead of replacing it, so the workspace's key and any other
// keys it set survive. Only the allowlisted keys are read from the snapshot, so
// an old published snapshot that still holds a key cannot write it here.
function mergeLlmConfig(snapshot: Record<string, unknown>): Partial<typeof actors.$inferInsert> {
	const source = (snapshot.llmConfig ?? snapshot.llm_config) as Record<string, unknown> | null
	if (source === null || typeof source !== 'object' || Array.isArray(source)) return {}
	const picked: Record<string, unknown> = {}
	for (const key of LLM_CONFIG_ALLOWLIST) {
		if (key in source) picked[key] = source[key]
	}
	if (Object.keys(picked).length === 0) return {}
	return {
		llmConfig: sql`coalesce(${actors.llmConfig}, '{}'::jsonb) || ${JSON.stringify(picked)}::jsonb`,
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

// storageKey is deliberately omitted — the existing row keeps its own
// workspace-scoped S3 key. The caller re-uploads the new content to that key
// via agentStorage.putWorkspaceSkill() alongside this update.
function buildSkillUpdate(
	snapshot: Record<string, unknown>,
): Partial<typeof workspaceSkills.$inferInsert> {
	const content = (snapshot.content as string) ?? ''
	return {
		description: (snapshot.description as string) ?? null,
		content,
		sizeBytes: Buffer.byteLength(content, 'utf-8'),
		isValid: typeof snapshot.isValid === 'boolean' ? snapshot.isValid : true,
	}
}

function buildIntegrationUpdate(
	snapshot: Record<string, unknown>,
): Partial<typeof integrations.$inferInsert> {
	// status and credentials are runtime state owned by the install workspace —
	// never restore them from a marketplace snapshot. Honoring snapshot.status here
	// would flip a freshly-installed integration to 'active' even though its
	// credentials column is empty, causing decrypt() to crash on first access.
	// (Same rationale as buildIntegrationInsert forcing status='inactive'.)
	return {
		provider: (snapshot.provider as string) ?? 'unknown',
		externalId: (snapshot.externalId as string) ?? (snapshot.external_id as string) ?? null,
		config: (snapshot.config as Record<string, unknown>) ?? {},
	}
}
