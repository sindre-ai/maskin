// E2E Marketplace catalog fixture — decoupled from the production catalog
// per tech spec §9.4 so specs are stable across curation churn.
//
// Reifies a known-good set of catalog rows before Playwright runs, cleans
// them up after. Every spec that needs Marketplace items grabs one of the
// slugs below rather than referencing a production slug — that way a
// content edit on the customer_feedback loop doesn't break the golden-path
// spec.
//
// The fixture writes directly through @maskin/db (same pattern as
// seed-marketplace.ts) so it works against the local dev database the
// Playwright webServer boots. It intentionally does NOT reuse the
// production seed manifest — the test catalog is a fresh set of
// slug-prefixed rows the reify function inserts alongside real seed data.
//
// Ordering: this fixture depends on PR #1's schema (marketplace_loops
// extended columns, marketplace_agents/skills tables, marketplace_installations
// audit table) being present in the local dev database at spec-run time.
// It uses raw SQL against the tables directly so it does NOT need PR #1's
// Drizzle schema exports — the tables just need to exist at runtime.

import { createDb } from '@maskin/db'
import { sql } from 'drizzle-orm'

// Every E2E catalog slug starts with this prefix so cleanup can safely
// delete the whole set without touching production rows.
export const E2E_CATALOG_SLUG_PREFIX = 'e2e-mp-'

export interface E2ECatalogLoop {
	slug: string
	displayName: string
	description: string
	team: string
	requiresIntegrations: string[]
	// A recommendation rule that always fires so the recommended band renders
	// the WHY line in every fresh-workspace spec.
	whyLine: string
}

export interface E2ECatalogAgent {
	slug: string
	displayName: string
	outcomeLine: string
	description: string
	team: string
}

export interface E2ECatalogSkill {
	slug: string
	displayName: string
	outcomeLine: string
	description: string
	team: string
}

// Curated fixtures — one per relevant spec path.
//
// * goldenPath        — no requires, always-fire recommendation, powers
//                       marketplace-golden-path.spec.ts.
// * requiresGithub    — declares integration_requires: ['github'] so the
//                       requires-not-met flow fires 424 in
//                       marketplace-requires-flow.spec.ts.
// * uninstall         — same shape as goldenPath but a distinct slug so
//                       marketplace-uninstall.spec.ts can install /
//                       uninstall without touching the golden-path row.
export const E2E_CATALOG: {
	loops: {
		goldenPath: E2ECatalogLoop
		requiresGithub: E2ECatalogLoop
		uninstall: E2ECatalogLoop
	}
	agent: E2ECatalogAgent
	skill: E2ECatalogSkill
} = {
	loops: {
		goldenPath: {
			slug: `${E2E_CATALOG_SLUG_PREFIX}golden-path-loop`,
			displayName: 'E2E Golden Path Loop',
			description: 'Test loop with no requires, always-fire WHY line.',
			team: 'shared',
			requiresIntegrations: [],
			whyLine: 'this loop is safe to install in every workspace — E2E fixture',
		},
		requiresGithub: {
			slug: `${E2E_CATALOG_SLUG_PREFIX}requires-github-loop`,
			displayName: 'E2E Requires GitHub Loop',
			description: 'Test loop requiring the GitHub integration.',
			team: 'engineering',
			requiresIntegrations: ['github'],
			whyLine: 'connect GitHub to run this loop against your PRs — E2E fixture',
		},
		uninstall: {
			slug: `${E2E_CATALOG_SLUG_PREFIX}uninstall-loop`,
			displayName: 'E2E Uninstall Loop',
			description: 'Test loop the uninstall spec installs then removes.',
			team: 'shared',
			requiresIntegrations: [],
			whyLine: 'this loop supports the uninstall E2E spec — remove after install',
		},
	},
	agent: {
		slug: `${E2E_CATALOG_SLUG_PREFIX}test-agent`,
		displayName: 'E2E Test Agent',
		outcomeLine: 'Runs the agent-install E2E path.',
		description: 'Fixture agent for the compact-card install-state assertion.',
		team: 'shared',
	},
	skill: {
		slug: `${E2E_CATALOG_SLUG_PREFIX}test-skill`,
		displayName: 'E2E Test Skill',
		outcomeLine: 'Runs the skill-install E2E path.',
		description: 'Fixture skill for the compact-card install-state assertion.',
		team: 'shared',
	},
}

function alwaysFireRecommendation(whyLine: string): object {
	// A rule with an empty `when` block matches every workspace — used only
	// on E2E fixtures so specs can rely on the WHY line rendering without
	// having to seed workspace state to satisfy a real predicate.
	return {
		rules: [{ when: {}, why: whyLine }],
		score_boost: 100,
	}
}

function requiresIntegrationsBlock(providers: string[]): object {
	if (providers.length === 0) return {}
	return { integrations: providers }
}

// Reify: insert all E2E catalog rows. Safe to call multiple times — every
// insert is ON CONFLICT (slug) DO UPDATE so re-running against the same
// dev DB refreshes the fixture rows rather than duplicating them.
export async function reifyE2EMarketplaceCatalog(dbUrl: string): Promise<void> {
	const db = createDb(dbUrl)

	for (const loop of Object.values(E2E_CATALOG.loops)) {
		await db.execute(sql`
			INSERT INTO marketplace_loops (
				name, slug, description, version, use_case,
				team, recommendation, requires, status, sort_weight, install_count
			) VALUES (
				${loop.displayName},
				${loop.slug},
				${loop.description},
				'e2e',
				${loop.description},
				${loop.team},
				${JSON.stringify(alwaysFireRecommendation(loop.whyLine))}::jsonb,
				${JSON.stringify(requiresIntegrationsBlock(loop.requiresIntegrations))}::jsonb,
				'published',
				0,
				0
			)
			ON CONFLICT (slug) DO UPDATE SET
				name = EXCLUDED.name,
				description = EXCLUDED.description,
				team = EXCLUDED.team,
				recommendation = EXCLUDED.recommendation,
				requires = EXCLUDED.requires,
				status = 'published'
		`)
	}

	const agent = E2E_CATALOG.agent
	await db.execute(sql`
		INSERT INTO marketplace_agents (
			slug, display_name, outcome_line, description, icon_url,
			system_prompt, skill_slugs, trigger_seeds,
			team, recommendation, requires, status, sort_weight, install_count
		) VALUES (
			${agent.slug},
			${agent.displayName},
			${agent.outcomeLine},
			${agent.description},
			NULL,
			'You are the E2E test agent. Reply "ok".',
			'[]'::jsonb,
			'[]'::jsonb,
			${agent.team},
			${JSON.stringify(alwaysFireRecommendation('E2E agent fixture'))}::jsonb,
			'{}'::jsonb,
			'published',
			0,
			0
		)
		ON CONFLICT (workspace_id, slug) WHERE workspace_id IS NULL DO UPDATE SET
			display_name = EXCLUDED.display_name,
			outcome_line = EXCLUDED.outcome_line,
			description = EXCLUDED.description,
			status = 'published'
	`)

	const skill = E2E_CATALOG.skill
	await db.execute(sql`
		INSERT INTO marketplace_skills (
			slug, display_name, outcome_line, description, content,
			team, recommendation, requires, status, sort_weight, install_count
		) VALUES (
			${skill.slug},
			${skill.displayName},
			${skill.outcomeLine},
			${skill.description},
			'# E2E test skill\n\nFixture body.',
			${skill.team},
			${JSON.stringify(alwaysFireRecommendation('E2E skill fixture'))}::jsonb,
			'{}'::jsonb,
			'published',
			0,
			0
		)
		ON CONFLICT (workspace_id, slug) WHERE workspace_id IS NULL DO UPDATE SET
			display_name = EXCLUDED.display_name,
			outcome_line = EXCLUDED.outcome_line,
			description = EXCLUDED.description,
			status = 'published'
	`)
}

// Cleanup: delete only rows whose slug carries the E2E prefix, so production
// rows are never touched. Deletes install-audit rows first so the FK-cascade
// on marketplace_installations doesn't hold onto stale rows between runs.
export async function cleanupE2EMarketplaceCatalog(dbUrl: string): Promise<void> {
	const db = createDb(dbUrl)
	const prefixLike = `${E2E_CATALOG_SLUG_PREFIX}%`
	await db.execute(sql`
		DELETE FROM marketplace_installations
		WHERE catalog_slug LIKE ${prefixLike}
	`)
	await db.execute(sql`
		DELETE FROM marketplace_loops WHERE slug LIKE ${prefixLike}
	`)
	await db.execute(sql`
		DELETE FROM marketplace_agents WHERE slug LIKE ${prefixLike}
	`)
	await db.execute(sql`
		DELETE FROM marketplace_skills WHERE slug LIKE ${prefixLike}
	`)
}
