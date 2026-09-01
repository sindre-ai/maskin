import { type Database, actors, integrations, toolGrants, workspaceMembers } from '@maskin/db'
import { and, eq } from 'drizzle-orm'
import { getProvider } from '../integrations/registry'
import { logger } from '../logger'
import { integrationRefFor } from './session'

// ---------------------------------------------------------------------------
// Make a workspace's FIRST grant safe.
//
// Enforcement begins the moment a workspace has any grant row, because an empty
// allow-list and an absent policy are otherwise indistinguishable. That is the
// right rule, and it has one sharp edge: granting Slack to the Outreach agent
// would, on its own, strip every other agent of everything it had.
//
// So the first grant seeds the status quo for everyone else. After that, the
// workspace is governed by grants and narrowing is a deliberate act.
//
// This runs in TypeScript rather than the migration on purpose: the refs depend
// on which providers auto-inject and on each GitHub installation's owner login,
// both of which live in the provider registry and in JSON config. A SQL backfill
// would have to hardcode that list and would rot the first time it changed.
// ---------------------------------------------------------------------------

/**
 * The integration refs a workspace's agents can currently reach.
 *
 * Mirrors what `buildLaunchSpec` injects: an auto-inject provider becomes
 * `integration-<provider>`, and each GitHub installation becomes
 * `github-<owner>`. A provider that is not auto-injected reaches agents only via
 * their own `tools.mcpServers`, which is already per-agent and is not governed
 * here.
 */
export const currentIntegrationRefs = async (
	db: Database,
	workspaceId: string,
): Promise<string[]> => {
	const rows = await db
		.select()
		.from(integrations)
		.where(and(eq(integrations.workspaceId, workspaceId), eq(integrations.status, 'active')))

	const refs = new Set<string>()
	for (const row of rows) {
		if (row.provider === 'github') {
			const config = (row.config ?? {}) as { owner_login?: unknown }
			if (typeof config.owner_login === 'string' && config.owner_login) {
				refs.add(integrationRefFor.githubOwner(config.owner_login))
			}
			continue
		}
		try {
			const resolved = getProvider(row.provider)
			if (resolved.config.mcp?.autoInject) refs.add(integrationRefFor.provider(row.provider))
		} catch {
			// An unknown provider cannot be injected either, so it needs no grant.
		}
	}
	return [...refs]
}

/**
 * Seed grants matching today's behaviour, if this workspace has none.
 *
 * Idempotent and a no-op once any grant exists — the caller runs it immediately
 * before writing the first one.
 */
export const seedGrantsIfFirstAdoption = async (
	db: Database,
	workspaceId: string,
): Promise<{ seeded: number }> => {
	const [existing] = await db
		.select({ id: toolGrants.id })
		.from(toolGrants)
		.where(eq(toolGrants.workspaceId, workspaceId))
		.limit(1)
	if (existing) return { seeded: 0 }

	const refs = await currentIntegrationRefs(db, workspaceId)
	if (refs.length === 0) return { seeded: 0 }

	const agentRows = await db
		.select({ id: actors.id })
		.from(workspaceMembers)
		.innerJoin(actors, eq(actors.id, workspaceMembers.actorId))
		.where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(actors.type, 'agent')))

	if (agentRows.length === 0) return { seeded: 0 }

	const values = agentRows.flatMap((agent) =>
		refs.map((ref) => ({
			workspaceId,
			actorId: agent.id,
			integrationRef: ref,
			mode: 'all' as const,
			tools: [] as string[],
		})),
	)

	// `onConflictDoNothing` rather than a transaction guard: two admins opening
	// the page at once should both succeed, and the rows are identical either way.
	await db.insert(toolGrants).values(values).onConflictDoNothing()

	logger.info('Seeded tool grants on first adoption', {
		workspaceId,
		agents: agentRows.length,
		integrations: refs.length,
	})

	return { seeded: values.length }
}
