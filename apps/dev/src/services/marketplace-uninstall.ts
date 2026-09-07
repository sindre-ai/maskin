import type { Database, Transaction } from '@maskin/db'
import {
	actors,
	agentSkills,
	events,
	installedLoops,
	marketplaceAgents,
	marketplaceInstallations,
	marketplaceSkills,
	triggers,
	workspaceSkills,
} from '@maskin/db/schema'
import { and, eq, inArray, ne, sql } from 'drizzle-orm'
import { logger } from '../lib/logger'

/**
 * Marketplace uninstall path — implements Marketplace tech spec §3.3 and §6.4
 * for all four `item_kind`s. Uninstall is a soft-delete on the install-audit
 * row (`uninstalled_at = now()`) plus per-kind cleanup of the workspace-scoped
 * rows created at install:
 *
 *   loop        → hard-delete the installed_loops row
 *   agent       → set actors.status = 'archived' (NOT hard-delete — audit
 *                 trail preservation, §3.3)
 *   skill       → fan-out check against agent_skills joins BEFORE delete;
 *                 delete only the joins created by THIS install
 *   mcp_server  → delegate to Registry uninstall (deferred until Registry
 *                 ships; current stub returns registry_unavailable)
 *
 * The soft-delete is what lets the partial unique index on
 * `marketplace_installations (workspace_id, item_kind, catalog_slug) WHERE
 * uninstalled_at IS NULL` release the slug for a fresh re-install without
 * losing the historical install row.
 */

export type UninstallResult =
	| {
			status: 'uninstalled'
			installation: typeof marketplaceInstallations.$inferSelect
	}
	| {
			status: 'not_found'
	}
	| {
			status: 'already_uninstalled'
	}
	| {
			status: 'not_owned'
	}
	| {
			status: 'mcp_registry_unavailable'
	}

export interface UninstallInput {
	installationId: string
	workspaceId: string
	uninstalledByActorId: string
}

export async function uninstallMarketplaceItem(
	db: Database,
	input: UninstallInput,
): Promise<UninstallResult> {
	const [row] = await db
		.select()
		.from(marketplaceInstallations)
		.where(eq(marketplaceInstallations.id, input.installationId))
		.limit(1)

	if (!row) return { status: 'not_found' }
	if (row.workspaceId !== input.workspaceId) return { status: 'not_owned' }
	if (row.uninstalledAt) return { status: 'already_uninstalled' }

	if (row.itemKind === 'mcp_server') {
		// Registry uninstall is deferred until MCP Registry ships. See §2.3.
		return { status: 'mcp_registry_unavailable' }
	}

	const updated = await db.transaction(async (tx) => {
		await teardownWorkspaceRows(tx, row)
		const [soft] = await tx
			.update(marketplaceInstallations)
			.set({ uninstalledAt: new Date() })
			.where(eq(marketplaceInstallations.id, row.id))
			.returning()
		return soft
	})

	await emitUninstallEvent(db, updated, input)
	await decrementInstallCount(db, row.itemKind as UninstallItemKind, row.catalogId).catch((err) => {
		logger.warn('Failed to decrement marketplace install_count', {
			error: err instanceof Error ? err.message : String(err),
			item_kind: row.itemKind,
			catalog_id: row.catalogId,
		})
	})

	return { status: 'uninstalled', installation: updated }
}

type UninstallItemKind = 'loop' | 'agent' | 'skill' | 'mcp_server'

async function teardownWorkspaceRows(
	tx: Transaction,
	row: typeof marketplaceInstallations.$inferSelect,
): Promise<void> {
	// Delete triggers first — nothing else references them and the per-kind
	// paths below may cascade-hit them through target_actor_id if we don't.
	const triggerIds = Array.isArray(row.triggerIds) ? (row.triggerIds as string[]) : []
	if (triggerIds.length > 0) {
		await tx.delete(triggers).where(inArray(triggers.id, triggerIds))
	}

	if (row.itemKind === 'loop' && row.installedLoopId) {
		await tx.delete(installedLoops).where(eq(installedLoops.id, row.installedLoopId))
		return
	}

	if (row.itemKind === 'agent' && row.actorId) {
		// Audit-trail preservation per §3.3: an agent may have authored objects,
		// comments, and sessions. Hard-delete would cascade into history.
		// Archive is the reversible primitive — mention lists filter archived
		// actors out but the actor row and its historical graph survive.
		await tx
			.update(actors)
			.set({ agentState: 'idle', metadata: sql`COALESCE(${actors.metadata}, '{}'::jsonb) || '{"status":"archived"}'::jsonb` })
			.where(eq(actors.id, row.actorId))
		// Note: actors table has no `status` column today; the archived flag
		// lives on metadata. PR #1's schema extension adds a proper `status`
		// column — this service switches to that when it lands.
		return
	}

	if (row.itemKind === 'skill' && row.workspaceSkillId) {
		// Fan-out check per §3.3: only delete the workspace_skills row when
		// nothing else references it. Two installs can legitimately bundle the
		// same shared skill (e.g. a common "consult-knowledge" skill), and one
		// uninstall must not rip it out from under the sibling install.
		await deleteSkillIfUnused(tx, row.workspaceSkillId, row.actorId ?? null)
		return
	}
}

async function deleteSkillIfUnused(
	tx: Transaction,
	workspaceSkillId: string,
	thisInstallActorId: string | null,
): Promise<void> {
	// Drop the fan-out joins created by THIS install first. In the current
	// install shape, a skill install (item_kind='skill') does not itself insert
	// agent_skills joins — those come from agent installs that name the skill.
	// So the join-delete is a no-op for pure skill installs but is safe.
	if (thisInstallActorId) {
		await tx
			.delete(agentSkills)
			.where(
				and(
					eq(agentSkills.workspaceSkillId, workspaceSkillId),
					eq(agentSkills.actorId, thisInstallActorId),
				),
			)
	}

	// Check whether any live agents still reference this skill via agent_skills.
	// If so, keep the workspace_skills row — it is co-owned. If not, delete it.
	const [other] = await tx
		.select({ actorId: agentSkills.actorId })
		.from(agentSkills)
		.where(eq(agentSkills.workspaceSkillId, workspaceSkillId))
		.limit(1)

	if (!other) {
		await tx.delete(workspaceSkills).where(eq(workspaceSkills.id, workspaceSkillId))
	}
}

async function emitUninstallEvent(
	db: Database,
	installation: typeof marketplaceInstallations.$inferSelect,
	input: UninstallInput,
): Promise<void> {
	// Stub event — full PostHog payload lands in Marketplace PR #5 (§8.2).
	await db.insert(events).values({
		workspaceId: installation.workspaceId,
		actorId: input.uninstalledByActorId,
		action: 'marketplace.item_uninstalled',
		entityType: 'marketplace_installation',
		entityId: installation.id,
		data: {
			item_kind: installation.itemKind,
			catalog_slug: installation.catalogSlug,
			catalog_id: installation.catalogId,
		},
	})
}

async function decrementInstallCount(
	db: Database,
	itemKind: UninstallItemKind,
	catalogId: string,
): Promise<void> {
	if (itemKind === 'agent') {
		await db
			.update(marketplaceAgents)
			.set({
				installCount: sql`GREATEST(${marketplaceAgents.installCount} - 1, 0)`,
			})
			.where(eq(marketplaceAgents.id, catalogId))
	} else if (itemKind === 'skill') {
		await db
			.update(marketplaceSkills)
			.set({
				installCount: sql`GREATEST(${marketplaceSkills.installCount} - 1, 0)`,
			})
			.where(eq(marketplaceSkills.id, catalogId))
	}
}
