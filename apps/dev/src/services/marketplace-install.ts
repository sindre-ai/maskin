import type { Database, Transaction } from '@maskin/db'
import {
	events,
	actors,
	agentSkills,
	installedLoops,
	integrations,
	marketplaceAgents,
	marketplaceInstallations,
	marketplaceLoops,
	marketplaceSkills,
	triggers,
	workspaceMembers,
	workspaceSkills,
} from '@maskin/db/schema'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { logger } from '../lib/logger'

/**
 * Marketplace install path — implements the state machine from Marketplace
 * tech spec §3.2 and §6.3 for all four `item_kind`s (loop / agent / skill /
 * mcp_server). Route-layer HTTP mapping lives in
 * apps/dev/src/routes/marketplace-installations.ts; this service returns a
 * discriminated result the route translates into 201 / 200 / 409 / 424 / 404.
 *
 * Idempotency is enforced by the partial unique index on
 * `marketplace_installations (workspace_id, item_kind, catalog_slug)
 * WHERE uninstalled_at IS NULL`. A concurrent install of the same slug hits
 * the constraint (23505) and the service resolves it by returning the
 * already-live row with `status: 'already_installed'`.
 */

export type ItemKind = 'loop' | 'agent' | 'skill' | 'mcp_server'

export interface InstallInput {
	itemKind: ItemKind
	catalogId: string
	workspaceId: string
	installedByActorId: string
	source?: 'marketplace' | 'seed' | 'api'
}

export interface RequiresManifest {
	integrations?: string[]
	mcp_installations?: string[]
}

export type InstallResult =
	| {
			status: 'installed'
			installation: typeof marketplaceInstallations.$inferSelect
	  }
	| {
			status: 'already_installed'
			installation: typeof marketplaceInstallations.$inferSelect
	  }
	| {
			status: 'requires_not_met'
			missing: RequiresManifest
	  }
	| {
			status: 'not_found'
	  }
	| {
			status: 'mcp_registry_unavailable'
	  }

/**
 * Public entry point for the install path. The route layer calls this after
 * authenticating the caller and checking `assertMember(actor, workspaceId)`.
 * See §3.2 for the flow; §6.3 for the HTTP mapping.
 */
export async function installMarketplaceItem(
	db: Database,
	input: InstallInput,
): Promise<InstallResult> {
	const catalog = await loadCatalogRow(db, input.itemKind, input.catalogId)
	if (!catalog) return { status: 'not_found' }

	const missing = await checkRequires(db, input.workspaceId, catalog.requires)
	if (missing) return { status: 'requires_not_met', missing }

	// mcp_server install delegates to the MCP Registry install path per §2.3.
	// Registry is a separate bet and is not shipped yet — the route returns 501
	// until that lands, so this path is a compile-time reminder rather than a
	// runtime call. Once Registry ships, wire the Registry client here and set
	// `mcpInstallationId` on the audit row.
	if (input.itemKind === 'mcp_server') {
		return { status: 'mcp_registry_unavailable' }
	}

	try {
		const installation = await db.transaction(async (tx) => {
			return await materializeInstall(tx, input, catalog)
		})

		await emitInstallEvent(db, installation, input)
		await incrementInstallCount(db, input.itemKind, input.catalogId).catch((err) => {
			// Best-effort denorm — §3.2 explicitly allows this to fail silently.
			logger.warn('Failed to increment marketplace install_count', {
				error: err instanceof Error ? err.message : String(err),
				item_kind: input.itemKind,
				catalog_id: input.catalogId,
			})
		})

		return { status: 'installed', installation }
	} catch (err: unknown) {
		// Drizzle wraps the underlying PostgresError inside DrizzleQueryError, so
		// the driver-level `code` may live on the wrapper's `.cause` rather than
		// the top-level error. Read both so the 23505 catch fires either way.
		const code =
			(err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code
		if (code === '23505') {
			// Partial unique index conflict — someone raced us to install the same
			// slug. Read the live row and hand it back as an idempotent success.
			const existing = await findLiveInstallation(
				db,
				input.workspaceId,
				input.itemKind,
				catalog.slug,
			)
			if (existing) return { status: 'already_installed', installation: existing }
		}
		throw err
	}
}

// ── Catalog reads ──────────────────────────────────────────────────────────

interface CatalogRow {
	id: string
	slug: string
	requires: RequiresManifest
	// Per-kind payload for materialization.
	loop?: typeof marketplaceLoops.$inferSelect
	agent?: typeof marketplaceAgents.$inferSelect
	skill?: typeof marketplaceSkills.$inferSelect
}

async function loadCatalogRow(
	db: Database,
	itemKind: ItemKind,
	catalogId: string,
): Promise<CatalogRow | null> {
	if (itemKind === 'loop') {
		const [row] = await db
			.select()
			.from(marketplaceLoops)
			.where(eq(marketplaceLoops.id, catalogId))
			.limit(1)
		if (!row) return null
		return { id: row.id, slug: row.slug, requires: row.requires as RequiresManifest, loop: row }
	}
	if (itemKind === 'agent') {
		const [row] = await db
			.select()
			.from(marketplaceAgents)
			.where(eq(marketplaceAgents.id, catalogId))
			.limit(1)
		if (!row || row.status === 'deprecated') return null
		return { id: row.id, slug: row.slug, requires: row.requires as RequiresManifest, agent: row }
	}
	if (itemKind === 'skill') {
		const [row] = await db
			.select()
			.from(marketplaceSkills)
			.where(eq(marketplaceSkills.id, catalogId))
			.limit(1)
		if (!row || row.status === 'deprecated') return null
		return { id: row.id, slug: row.slug, requires: row.requires as RequiresManifest, skill: row }
	}
	// mcp_server: catalog rows live in mcp_registry_entries (Registry bet). We
	// never load them here in v1 — the install path returns 501 before this
	// function is reached for that kind.
	return { id: catalogId, slug: '', requires: {} }
}

// ── Requires check ────────────────────────────────────────────────────────

async function checkRequires(
	db: Database,
	workspaceId: string,
	requires: RequiresManifest,
): Promise<RequiresManifest | null> {
	const wanted = requires.integrations ?? []
	if (
		wanted.length === 0 &&
		!(requires.mcp_installations && requires.mcp_installations.length > 0)
	) {
		return null
	}

	const missing: RequiresManifest = {}

	if (wanted.length > 0) {
		const connected = await db
			.select({ provider: integrations.provider })
			.from(integrations)
			.where(
				and(
					eq(integrations.workspaceId, workspaceId),
					eq(integrations.status, 'connected'),
					inArray(integrations.provider, wanted),
				),
			)
		const have = new Set(connected.map((r) => r.provider))
		const missingIntegrations = wanted.filter((p) => !have.has(p))
		if (missingIntegrations.length > 0) missing.integrations = missingIntegrations
	}

	// mcp_installations requirement is validated once Registry ships; for now,
	// pass any non-empty list through as-missing so the route surfaces the ask.
	if (requires.mcp_installations && requires.mcp_installations.length > 0) {
		missing.mcp_installations = requires.mcp_installations
	}

	if (Object.keys(missing).length === 0) return null
	return missing
}

// ── Per-item_kind materialization ─────────────────────────────────────────

async function materializeInstall(
	tx: Transaction,
	input: InstallInput,
	catalog: CatalogRow,
): Promise<typeof marketplaceInstallations.$inferSelect> {
	if (input.itemKind === 'loop' && catalog.loop) {
		return await materializeLoopInstall(tx, input, catalog.loop)
	}
	if (input.itemKind === 'agent' && catalog.agent) {
		return await materializeAgentInstall(tx, input, catalog.agent)
	}
	if (input.itemKind === 'skill' && catalog.skill) {
		return await materializeSkillInstall(tx, input, catalog.skill)
	}
	throw new Error(`Unsupported install materialization for item_kind ${input.itemKind}`)
}

async function materializeLoopInstall(
	tx: Transaction,
	input: InstallInput,
	loop: typeof marketplaceLoops.$inferSelect,
): Promise<typeof marketplaceInstallations.$inferSelect> {
	const [installedLoop] = await tx
		.insert(installedLoops)
		.values({
			workspaceId: input.workspaceId,
			sourceLoopId: loop.id,
			installedVersion: loop.version,
		})
		.returning()
	if (!installedLoop) throw new Error('installed_loops insert returned no row')

	const [installation] = await tx
		.insert(marketplaceInstallations)
		.values({
			workspaceId: input.workspaceId,
			itemKind: 'loop',
			catalogId: loop.id,
			catalogSlug: loop.slug,
			installedLoopId: installedLoop.id,
			triggerIds: [],
			source: input.source ?? 'marketplace',
			installedByActorId: input.installedByActorId,
		})
		.returning()
	if (!installation) throw new Error('marketplace_installations insert returned no row')

	return installation
}

async function materializeAgentInstall(
	tx: Transaction,
	input: InstallInput,
	agent: typeof marketplaceAgents.$inferSelect,
): Promise<typeof marketplaceInstallations.$inferSelect> {
	const [actor] = await tx
		.insert(actors)
		.values({
			type: 'agent',
			name: agent.displayName,
			apiKey: `mkp_${agent.slug}_${input.workspaceId.slice(0, 8)}_${Date.now()}`,
			description: agent.outcomeLine,
			systemPrompt: agent.systemPrompt,
			createdBy: input.installedByActorId,
			metadata: { installed_from_marketplace: agent.slug },
		})
		.returning()
	if (!actor) throw new Error('actors insert returned no row')

	// Bind the actor as a workspace member so it is discoverable via
	// workspace-scoped listings. Role `member` matches the pattern used by
	// workspace-bootstrap for seeded agents.
	await tx.insert(workspaceMembers).values({
		workspaceId: input.workspaceId,
		actorId: actor.id,
		role: 'member',
	})

	// Attach requested skills via agentSkills join. Skills must already exist in
	// the target workspace — auto-installing missing skills as sub-installs is
	// deferred to PR #3 (the frontend selects skill installs explicitly).
	const skillSlugs = Array.isArray(agent.skillSlugs) ? (agent.skillSlugs as string[]) : []
	if (skillSlugs.length > 0) {
		const rows = await tx
			.select({ id: workspaceSkills.id })
			.from(workspaceSkills)
			.where(
				and(
					eq(workspaceSkills.workspaceId, input.workspaceId),
					inArray(workspaceSkills.name, skillSlugs),
				),
			)
		if (rows.length > 0) {
			await tx
				.insert(agentSkills)
				.values(rows.map((s) => ({ actorId: actor.id, workspaceSkillId: s.id })))
		}
	}

	const triggerIds: string[] = []
	const seeds = Array.isArray(agent.triggerSeeds)
		? (agent.triggerSeeds as Array<{
				name: string
				type: string
				config: Record<string, unknown>
				actionPrompt: string
			}>)
		: []
	for (const seed of seeds) {
		const [trigger] = await tx
			.insert(triggers)
			.values({
				workspaceId: input.workspaceId,
				name: seed.name,
				type: seed.type,
				config: seed.config,
				actionPrompt: seed.actionPrompt,
				targetActorId: actor.id,
				createdBy: input.installedByActorId,
				metadata: { installed_from_marketplace_agent: agent.slug },
			})
			.returning()
		if (!trigger) throw new Error('triggers insert returned no row')
		triggerIds.push(trigger.id)
	}

	const [installation] = await tx
		.insert(marketplaceInstallations)
		.values({
			workspaceId: input.workspaceId,
			itemKind: 'agent',
			catalogId: agent.id,
			catalogSlug: agent.slug,
			actorId: actor.id,
			triggerIds,
			source: input.source ?? 'marketplace',
			installedByActorId: input.installedByActorId,
		})
		.returning()
	if (!installation) throw new Error('marketplace_installations insert returned no row')

	return installation
}

async function materializeSkillInstall(
	tx: Transaction,
	input: InstallInput,
	skill: typeof marketplaceSkills.$inferSelect,
): Promise<typeof marketplaceInstallations.$inferSelect> {
	const [workspaceSkill] = await tx
		.insert(workspaceSkills)
		.values({
			workspaceId: input.workspaceId,
			name: skill.slug,
			description: skill.outcomeLine,
			content: skill.content,
			storageKey: `marketplace/${skill.slug}/${Date.now()}`,
			sizeBytes: skill.content.length,
			createdBy: input.installedByActorId,
			metadata: { installed_from_marketplace: skill.slug },
		})
		.returning()
	if (!workspaceSkill) throw new Error('workspace_skills insert returned no row')

	const [installation] = await tx
		.insert(marketplaceInstallations)
		.values({
			workspaceId: input.workspaceId,
			itemKind: 'skill',
			catalogId: skill.id,
			catalogSlug: skill.slug,
			workspaceSkillId: workspaceSkill.id,
			triggerIds: [],
			source: input.source ?? 'marketplace',
			installedByActorId: input.installedByActorId,
		})
		.returning()
	if (!installation) throw new Error('marketplace_installations insert returned no row')

	return installation
}

// ── Event emission ────────────────────────────────────────────────────────

/**
 * Stub event emitter — writes the append-only `events` row per architecture
 * ADR-005 with a placeholder action name. Full PostHog payloads
 * (marketplace_item_installed, agent/skill/tool_installed, loop_installed
 * source extension) are wired in Marketplace PR #5 per Marketplace tech spec
 * §8.2 and §12. Kept as its own helper so PR #5 replaces this in one spot.
 */
async function emitInstallEvent(
	db: Database,
	installation: typeof marketplaceInstallations.$inferSelect,
	input: InstallInput,
): Promise<void> {
	await db.insert(events).values({
		workspaceId: installation.workspaceId,
		actorId: input.installedByActorId,
		action: 'marketplace.item_installed',
		entityType: 'marketplace_installation',
		entityId: installation.id,
		data: {
			item_kind: installation.itemKind,
			catalog_slug: installation.catalogSlug,
			catalog_id: installation.catalogId,
			source: installation.source,
		},
	})
}

// ── Denormalized counters ─────────────────────────────────────────────────

async function incrementInstallCount(
	db: Database,
	itemKind: ItemKind,
	catalogId: string,
): Promise<void> {
	// marketplace_loops.install_count is not part of PR #1's landed shape yet
	// (that extension is in PR #1's marketplace_loops_extend migration), so
	// only bump the columns we shipped in this PR: agents + skills.
	if (itemKind === 'agent') {
		await db
			.update(marketplaceAgents)
			.set({ installCount: sql`${marketplaceAgents.installCount} + 1` })
			.where(eq(marketplaceAgents.id, catalogId))
	} else if (itemKind === 'skill') {
		await db
			.update(marketplaceSkills)
			.set({ installCount: sql`${marketplaceSkills.installCount} + 1` })
			.where(eq(marketplaceSkills.id, catalogId))
	}
}

// ── Helpers reused by uninstall + list ────────────────────────────────────

export async function findLiveInstallation(
	db: Database,
	workspaceId: string,
	itemKind: ItemKind,
	catalogSlug: string,
): Promise<typeof marketplaceInstallations.$inferSelect | undefined> {
	const [row] = await db
		.select()
		.from(marketplaceInstallations)
		.where(
			and(
				eq(marketplaceInstallations.workspaceId, workspaceId),
				eq(marketplaceInstallations.itemKind, itemKind),
				eq(marketplaceInstallations.catalogSlug, catalogSlug),
				isNull(marketplaceInstallations.uninstalledAt),
			),
		)
		.limit(1)
	return row
}

export async function listLiveInstallations(
	db: Database,
	workspaceId: string,
): Promise<(typeof marketplaceInstallations.$inferSelect)[]> {
	return await db
		.select()
		.from(marketplaceInstallations)
		.where(
			and(
				eq(marketplaceInstallations.workspaceId, workspaceId),
				isNull(marketplaceInstallations.uninstalledAt),
			),
		)
}
