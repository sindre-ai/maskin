import {
	DEFAULT_WORKSPACE_AGENTS,
	DEFAULT_WORKSPACE_LOOPS,
	FOR_YOU_FORMAT_SKILL,
	MARKETPLACE_CATALOG_AGENTS,
	MARKETPLACE_CATALOG_LOOPS,
	MARKETPLACE_CATALOG_SKILLS,
	MASKIN_WAY_OF_WORKING_SKILL,
	SHAPED_BET_FORMAT_SKILL,
	CONTINUOUS_ONBOARDING_SKILL,
} from '@maskin/shared'
import { marketplaceAgents, marketplaceLoops, marketplaceSkills } from '@maskin/db/schema'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from './global-setup'

/**
 * Seed-overlap surface — Marketplace tech spec §3.4, §9.2.
 *
 * The marketplace catalog is a SUPERSET of DEFAULT_WORKSPACE_LOOPS /
 * AGENTS in default-workspace-agents.ts: every item seeded into new
 * workspaces by workspace-bootstrap.ts is also discoverable from the
 * Marketplace, plus room for hand-curated additions.
 *
 * This test pins that guarantee for the workspace-bootstrap side of §3.4
 * (which will layer marketplace_installations rows with source='seed' onto
 * seeded rows once that wiring lands — deliberately out of scope for
 * PR #1 per Planner). The overlap the seed reify migration is required to
 * cover is:
 *
 *   1. Every $id in DEFAULT_WORKSPACE_LOOPS has a matching global row in
 *      marketplace_loops keyed by slug = kebab-cased $id.
 *   2. Every $id in DEFAULT_WORKSPACE_AGENTS has a matching global row in
 *      marketplace_agents keyed by slug = kebab-cased $id.
 *   3. Every skill name shipped in packages/shared/src/templates/default-
 *      workspace-agents.ts (FOR_YOU_FORMAT_SKILL, SHAPED_BET_FORMAT_SKILL,
 *      MASKIN_WAY_OF_WORKING_SKILL, CONTINUOUS_ONBOARDING_SKILL) has a
 *      matching global row in marketplace_skills.
 */

function kebab(id: string): string {
	return id.replaceAll('_', '-')
}

describe('marketplace seed overlap — catalog is a superset of DEFAULT_WORKSPACE_*', () => {
	it('every DEFAULT_WORKSPACE_LOOPS $id is present in marketplace_loops as a global row', async () => {
		const expected = DEFAULT_WORKSPACE_LOOPS.map((l) => kebab(l.$id))
		const rows = await db
			.select({ slug: marketplaceLoops.slug })
			.from(marketplaceLoops)
			.where(inArray(marketplaceLoops.slug, expected))
		const present = new Set(rows.map((r) => r.slug))
		const missing = expected.filter((slug) => !present.has(slug))
		expect(missing).toEqual([])
	})

	it('every DEFAULT_WORKSPACE_AGENTS $id is present in marketplace_agents as a global row', async () => {
		const expected = DEFAULT_WORKSPACE_AGENTS.map((a) => kebab(a.$id))
		const rows = await db
			.select({ slug: marketplaceAgents.slug })
			.from(marketplaceAgents)
			.where(
				and(isNull(marketplaceAgents.workspaceId), inArray(marketplaceAgents.slug, expected)),
			)
		const present = new Set(rows.map((r) => r.slug))
		const missing = expected.filter((slug) => !present.has(slug))
		expect(missing).toEqual([])
	})

	it('every seeded skill (for-you / shaped-bet / way-of-working / onboarding) is present in marketplace_skills', async () => {
		const expected = [
			FOR_YOU_FORMAT_SKILL.name,
			SHAPED_BET_FORMAT_SKILL.name,
			MASKIN_WAY_OF_WORKING_SKILL.name,
			CONTINUOUS_ONBOARDING_SKILL.name,
		]
		const rows = await db
			.select({ slug: marketplaceSkills.slug })
			.from(marketplaceSkills)
			.where(
				and(isNull(marketplaceSkills.workspaceId), inArray(marketplaceSkills.slug, expected)),
			)
		const present = new Set(rows.map((r) => r.slug))
		const missing = expected.filter((slug) => !present.has(slug))
		expect(missing).toEqual([])
	})

	it('marketplace-catalog.ts manifest slugs are exactly what the DB reify produced (in-sync)', async () => {
		// Manifest is the authoring surface (§7). Migration is the reify.
		// A drift here means someone edited one without the other — flag it
		// loudly so the next curator PR notices before shipping.
		const [dbLoops, dbAgents, dbSkills] = await Promise.all([
			db.select({ slug: marketplaceLoops.slug }).from(marketplaceLoops),
			db
				.select({ slug: marketplaceAgents.slug })
				.from(marketplaceAgents)
				.where(isNull(marketplaceAgents.workspaceId)),
			db
				.select({ slug: marketplaceSkills.slug })
				.from(marketplaceSkills)
				.where(isNull(marketplaceSkills.workspaceId)),
		])
		const manifestLoops = MARKETPLACE_CATALOG_LOOPS.map((l) => l.slug).sort()
		const manifestAgents = MARKETPLACE_CATALOG_AGENTS.map((a) => a.slug).sort()
		const manifestSkills = MARKETPLACE_CATALOG_SKILLS.map((s) => s.slug).sort()
		expect(dbLoops.map((r) => r.slug).sort()).toEqual(manifestLoops)
		expect(dbAgents.map((r) => r.slug).sort()).toEqual(manifestAgents)
		expect(dbSkills.map((r) => r.slug).sort()).toEqual(manifestSkills)
	})
})
