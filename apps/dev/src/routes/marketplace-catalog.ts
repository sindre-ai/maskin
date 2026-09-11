import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { actors, integrations, workspaceMembers } from '@maskin/db/schema'
import { and, eq, sql } from 'drizzle-orm'
import { createApiError, validationFailureHook } from '../lib/errors'
import { logger } from '../lib/logger'
import { errorSchema } from '../lib/openapi-schemas'
import { isWorkspaceMember } from '../lib/workspace-auth'
import {
	type InstalledItemRef,
	type RecommendationBundle,
	type WorkspaceState,
	evaluateRecommendation,
} from '../services/marketplace-recommendation'

type Env = {
	Variables: {
		db: Database
		actorId: string
	}
}

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

// ── Enums (spec §5.1 team taxonomy, §6.1 item_kind) ──────────────────────────

const TEAM_VALUES = [
	'product',
	'engineering',
	'revenue',
	'marketing',
	'growth',
	'customer',
	'finance_ops',
	'shared',
] as const

const ITEM_KIND_VALUES = ['loop', 'agent', 'skill', 'mcp_server'] as const

const teamSchema = z.enum(TEAM_VALUES)
const itemKindSchema = z.enum(ITEM_KIND_VALUES)

// ── Response shapes (spec §6.1 CatalogItemCard) ──────────────────────────────

const requiresSchema = z
	.object({
		integrations: z.array(z.string()).optional(),
		mcp_installations: z.array(z.string()).optional(),
	})
	.partial()

const loopSummarySchema = z.object({
	steps_summary: z.string(),
	ins: z.array(z.string()),
	outs: z.array(z.string()),
	cadence: z.string(),
})

const agentSummarySchema = z.object({
	skills_count: z.number(),
	triggers_count: z.number(),
})

const catalogItemCardSchema = z.object({
	item_kind: itemKindSchema,
	catalog_id: z.string().uuid(),
	slug: z.string(),
	display_name: z.string(),
	outcome_line: z.string(),
	team: teamSchema,
	requires: requiresSchema,
	installed_installation_id: z.string().uuid().optional(),
	install_count: z.number(),
	why_line: z.string().optional(),
	loop_summary: loopSummarySchema.optional(),
	agent_summary: agentSummarySchema.optional(),
})

const catalogListResponseSchema = z.object({
	bands: z.object({
		recommended: z.array(catalogItemCardSchema),
		popular_loops: z.array(catalogItemCardSchema),
		top_agents: z.array(catalogItemCardSchema),
		most_installed_tools: z.array(catalogItemCardSchema),
	}),
	team_grid: z.array(catalogItemCardSchema),
	next_cursor: z.string().nullable(),
})

const catalogItemDetailResponseSchema = catalogItemCardSchema.extend({
	description: z.string(),
	requires_status: z.object({
		integrations: z.array(
			z.object({ slug: z.string(), connected: z.boolean() }),
		),
		mcp_installations: z.array(
			z.object({ slug: z.string(), installed: z.boolean() }),
		),
	}),
})

type CatalogItemCard = z.infer<typeof catalogItemCardSchema>

// ── Raw catalog row (shape of the UNION-ALL) ─────────────────────────────────
//
// The read reaches into three tables plus the marketplace_mcp_servers view
// (spec §2.3), all of which are landed by Marketplace PR #1. This handler
// consumes them via a raw SQL UNION rather than four separate typed selects
// because (a) the response is a single flat CatalogItemCard[] regardless of
// kind and (b) the three-table UNION-ALL is the exact query shape §2.3
// specifies. Column names below match §2.2 / §2.3 exactly.

interface RawCatalogRow {
	item_kind: 'loop' | 'agent' | 'skill' | 'mcp_server'
	catalog_id: string
	slug: string
	display_name: string
	outcome_line: string
	description: string
	team: string
	requires: unknown
	recommendation: unknown
	status: string
	sort_weight: number
	install_count: number
	loop_definition: unknown
	skill_slugs: unknown
	trigger_seeds: unknown
}

const CATALOG_UNION_SQL = sql`
	SELECT
		'loop'::text AS item_kind,
		id AS catalog_id,
		slug,
		name AS display_name,
		COALESCE(NULLIF(use_case, ''), description) AS outcome_line,
		description,
		team,
		requires,
		recommendation,
		status,
		sort_weight,
		install_count,
		definition AS loop_definition,
		NULL::jsonb AS skill_slugs,
		NULL::jsonb AS trigger_seeds
	FROM marketplace_loops
	WHERE status = 'published' AND workspace_id IS NULL

	UNION ALL

	SELECT
		'agent'::text AS item_kind,
		id AS catalog_id,
		slug,
		display_name,
		outcome_line,
		description,
		team,
		requires,
		recommendation,
		status,
		sort_weight,
		install_count,
		NULL::jsonb AS loop_definition,
		skill_slugs,
		trigger_seeds
	FROM marketplace_agents
	WHERE status = 'published' AND workspace_id IS NULL

	UNION ALL

	SELECT
		'skill'::text AS item_kind,
		id AS catalog_id,
		slug,
		display_name,
		outcome_line,
		description,
		team,
		requires,
		recommendation,
		status,
		sort_weight,
		install_count,
		NULL::jsonb AS loop_definition,
		NULL::jsonb AS skill_slugs,
		NULL::jsonb AS trigger_seeds
	FROM marketplace_skills
	WHERE status = 'published' AND workspace_id IS NULL

	UNION ALL

	SELECT
		'mcp_server'::text AS item_kind,
		id AS catalog_id,
		slug,
		display_name,
		outcome_line,
		description,
		team,
		requires,
		recommendation,
		status,
		sort_weight,
		install_count,
		NULL::jsonb AS loop_definition,
		NULL::jsonb AS skill_slugs,
		NULL::jsonb AS trigger_seeds
	FROM marketplace_mcp_servers
	WHERE status = 'published'
`

// ── Helpers ──────────────────────────────────────────────────────────────────

async function loadWorkspaceState(
	db: Database,
	workspaceId: string,
): Promise<WorkspaceState & { installations: Map<string, string> }> {
	// One-pass fetch of everything the evaluator needs, plus the installed_
	// installation_id lookup the CatalogItemCard exposes for the frontend's
	// "Installed" state (spec §6.1). Each SELECT is small (<200 rows in any
	// real workspace, per §4.3), so parallelising with Promise.all keeps
	// wall-clock under the 50ms budget the spec sets.
	const [intRows, humanCountRow, installRows] = await Promise.all([
		db
			.select({ provider: integrations.provider })
			.from(integrations)
			.where(
				and(eq(integrations.workspaceId, workspaceId), eq(integrations.status, 'connected')),
			),
		db
			.select({ n: sql<number>`count(*)::int` })
			.from(actors)
			.innerJoin(workspaceMembers, eq(workspaceMembers.actorId, actors.id))
			.where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(actors.type, 'human'))),
		db.execute(sql`
			SELECT
				mi.id AS installation_id,
				mi.item_kind,
				mi.catalog_slug,
				COALESCE(
					(SELECT name FROM marketplace_loops WHERE id = mi.catalog_id),
					(SELECT display_name FROM marketplace_agents WHERE id = mi.catalog_id),
					(SELECT display_name FROM marketplace_skills WHERE id = mi.catalog_id),
					mi.catalog_slug
				) AS display_name
			FROM marketplace_installations mi
			WHERE mi.workspace_id = ${workspaceId}
			  AND mi.uninstalled_at IS NULL
		`),
	])

	const integrationSet = new Set<string>(intRows.map((r) => r.provider))
	const humanCount = humanCountRow[0]?.n ?? 0

	const installedLoops = new Map<string, InstalledItemRef>()
	const installedAgents = new Map<string, InstalledItemRef>()
	const installedSkills = new Map<string, InstalledItemRef>()
	// installed_installation_id lookup: `${item_kind}:${catalog_slug}` → uuid.
	const installations = new Map<string, string>()

	// Drizzle's `db.execute` on node-postgres returns `{ rows: T[] }`; on the
	// query-builder path it returns the array directly. Handle both so the
	// helper doesn't care which driver the caller wired up.
	const rows: Array<{
		installation_id: string
		item_kind: string
		catalog_slug: string
		display_name: string
	}> = Array.isArray(installRows)
		? (installRows as never)
		: ((installRows as { rows?: unknown[] }).rows ?? []) as never

	for (const row of rows) {
		const ref: InstalledItemRef = { slug: row.catalog_slug, display_name: row.display_name }
		if (row.item_kind === 'loop') installedLoops.set(row.catalog_slug, ref)
		else if (row.item_kind === 'agent') installedAgents.set(row.catalog_slug, ref)
		else if (row.item_kind === 'skill') installedSkills.set(row.catalog_slug, ref)
		installations.set(`${row.item_kind}:${row.catalog_slug}`, row.installation_id)
	}

	return {
		integrations: integrationSet,
		installedLoops,
		installedAgents,
		installedSkills,
		humanCount,
		installations,
	}
}

function extractLoopSummary(loopDefinition: unknown): CatalogItemCard['loop_summary'] {
	if (!loopDefinition || typeof loopDefinition !== 'object') return undefined
	const d = loopDefinition as Record<string, unknown>
	const stepsSummary =
		typeof d.steps_summary === 'string'
			? d.steps_summary
			: Array.isArray(d.steps)
				? `${(d.steps as unknown[]).length} steps`
				: ''
	const ins = Array.isArray(d.ins) ? (d.ins as unknown[]).map(String) : []
	const outs = Array.isArray(d.outs) ? (d.outs as unknown[]).map(String) : []
	const cadence = typeof d.cadence === 'string' ? d.cadence : ''
	if (!stepsSummary && ins.length === 0 && outs.length === 0 && !cadence) return undefined
	return { steps_summary: stepsSummary, ins, outs, cadence }
}

function extractAgentSummary(
	skillSlugs: unknown,
	triggerSeeds: unknown,
): CatalogItemCard['agent_summary'] {
	if (skillSlugs === null && triggerSeeds === null) return undefined
	return {
		skills_count: Array.isArray(skillSlugs) ? (skillSlugs as unknown[]).length : 0,
		triggers_count: Array.isArray(triggerSeeds) ? (triggerSeeds as unknown[]).length : 0,
	}
}

function isTeam(value: string): value is (typeof TEAM_VALUES)[number] {
	return (TEAM_VALUES as readonly string[]).includes(value)
}

function toCard(
	row: RawCatalogRow,
	state: WorkspaceState & { installations: Map<string, string> },
): CatalogItemCard & { _sortWeight: number; _matched: boolean } {
	const evaluated = evaluateRecommendation(row.recommendation as RecommendationBundle | null, state)
	const installationId = state.installations.get(`${row.item_kind}:${row.slug}`)
	const team = isTeam(row.team) ? row.team : 'shared'
	const requires = (row.requires ?? {}) as CatalogItemCard['requires']

	return {
		item_kind: row.item_kind,
		catalog_id: row.catalog_id,
		slug: row.slug,
		display_name: row.display_name,
		outcome_line: row.outcome_line,
		team,
		requires,
		installed_installation_id: installationId,
		install_count: row.install_count,
		why_line: evaluated.why_line,
		loop_summary:
			row.item_kind === 'loop' ? extractLoopSummary(row.loop_definition) : undefined,
		agent_summary:
			row.item_kind === 'agent'
				? extractAgentSummary(row.skill_slugs, row.trigger_seeds)
				: undefined,
		_sortWeight: row.sort_weight + evaluated.score_boost,
		_matched: evaluated.matched,
	}
}

function stripInternal(card: CatalogItemCard & { _sortWeight: number; _matched: boolean }): CatalogItemCard {
	// biome-ignore lint/correctness/noUnusedVariables: destructuring to drop sort keys
	const { _sortWeight, _matched, ...rest } = card
	return rest
}

// ── GET /api/marketplace/catalog ─────────────────────────────────────────────

const listQuerySchema = z.object({
	team: teamSchema.optional(),
	item_kind: itemKindSchema.optional(),
	include_recommended: z
		.enum(['true', 'false'])
		.optional()
		.transform((v) => v !== 'false'),
	limit: z.coerce.number().int().min(1).max(200).optional().default(60),
	cursor: z.string().optional(),
})

const catalogListRoute = createRoute({
	method: 'get',
	path: '/catalog',
	tags: ['Marketplace'],
	summary: 'Catalog list — bands + team_grid for the Marketplace page',
	request: {
		query: listQuerySchema,
		headers: z.object({ 'x-workspace-id': z.string().uuid() }),
	},
	responses: {
		200: {
			description: 'Catalog payload — spec §6.1',
			content: { 'application/json': { schema: catalogListResponseSchema } },
		},
		400: { description: 'Validation error', content: { 'application/json': { schema: errorSchema } } },
		403: {
			description: 'Not a member of the workspace',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(catalogListRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const workspaceId = c.req.header('x-workspace-id')
	if (!workspaceId) {
		return c.json(createApiError('BAD_REQUEST', 'X-Workspace-Id header required'), 400)
	}
	if (!(await isWorkspaceMember(db, actorId, workspaceId))) {
		return c.json(createApiError('FORBIDDEN', 'You are not a member of the workspace'), 403)
	}

	const { team, item_kind, include_recommended, limit, cursor } = c.req.valid('query')

	const state = await loadWorkspaceState(db, workspaceId)

	const rawResult = await db.execute<RawCatalogRow>(CATALOG_UNION_SQL)
	const rawRows: RawCatalogRow[] = Array.isArray(rawResult)
		? (rawResult as never)
		: (((rawResult as { rows?: unknown[] }).rows ?? []) as never)

	const allCards = rawRows.map((row) => toCard(row, state))

	// team_grid — spec §5.1: team filter is `team = $1 OR team = 'shared'`.
	// item_kind filter narrows the tab (Loops / Agents / Skills / Tools).
	// Cards are ranked by (sort_weight + score_boost, install_count) desc.
	let grid = allCards.slice()
	if (team) grid = grid.filter((c) => c.team === team || c.team === 'shared')
	if (item_kind) grid = grid.filter((c) => c.item_kind === item_kind)
	grid.sort((a, b) => b._sortWeight - a._sortWeight || b.install_count - a.install_count)

	// Simple offset cursor — the catalog is a few hundred rows at launch (spec
	// §4.3), so a keyset seek buys little. Cursor is base64(offset).
	const startOffset = cursor ? Number.parseInt(Buffer.from(cursor, 'base64').toString('utf8'), 10) : 0
	const safeOffset = Number.isFinite(startOffset) && startOffset >= 0 ? startOffset : 0
	const pageEnd = safeOffset + limit
	const teamGridPage = grid.slice(safeOffset, pageEnd)
	const nextCursor =
		pageEnd < grid.length ? Buffer.from(String(pageEnd), 'utf8').toString('base64') : null

	// Bands are computed off the FULL catalog (not the filtered grid) so
	// "Recommended for you" doesn't collapse when a team chip is picked.
	// Popular / Top / Most-installed are ordered by install_count.
	const recommended = include_recommended
		? allCards
				.filter((c) => c._matched)
				.sort((a, b) => b._sortWeight - a._sortWeight || b.install_count - a.install_count)
				.slice(0, 6)
		: []
	const byInstalls = <T extends { install_count: number }>(a: T, b: T) => b.install_count - a.install_count
	const popularLoops = allCards
		.filter((c) => c.item_kind === 'loop')
		.sort(byInstalls)
		.slice(0, 6)
	const topAgents = allCards
		.filter((c) => c.item_kind === 'agent')
		.sort(byInstalls)
		.slice(0, 6)
	const mostInstalledTools = allCards
		.filter((c) => c.item_kind === 'mcp_server')
		.sort(byInstalls)
		.slice(0, 6)

	logger.info('marketplace catalog listed', {
		workspaceId,
		totalRows: allCards.length,
		gridSize: grid.length,
		matched: recommended.length,
		team,
		itemKind: item_kind,
	})

	const response: z.infer<typeof catalogListResponseSchema> = {
		bands: {
			recommended: recommended.map(stripInternal),
			popular_loops: popularLoops.map(stripInternal),
			top_agents: topAgents.map(stripInternal),
			most_installed_tools: mostInstalledTools.map(stripInternal),
		},
		team_grid: teamGridPage.map(stripInternal),
		next_cursor: nextCursor,
	}
	return c.json(response)
}) as RouteHandler<typeof catalogListRoute, Env>)

// ── GET /api/marketplace/items/{item_kind}/{catalog_id} ──────────────────────

const detailParamSchema = z.object({
	item_kind: itemKindSchema,
	catalog_id: z.string().uuid(),
})

const catalogItemDetailRoute = createRoute({
	method: 'get',
	path: '/items/{item_kind}/{catalog_id}',
	tags: ['Marketplace'],
	summary: 'Catalog item detail — spec §6.2',
	request: {
		params: detailParamSchema,
		headers: z.object({ 'x-workspace-id': z.string().uuid() }),
	},
	responses: {
		200: {
			description: 'Catalog item detail',
			content: { 'application/json': { schema: catalogItemDetailResponseSchema } },
		},
		400: { description: 'Validation error', content: { 'application/json': { schema: errorSchema } } },
		403: {
			description: 'Not a member of the workspace',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: { description: 'Item not found', content: { 'application/json': { schema: errorSchema } } },
	},
})

app.openapi(catalogItemDetailRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const workspaceId = c.req.header('x-workspace-id')
	if (!workspaceId) {
		return c.json(createApiError('BAD_REQUEST', 'X-Workspace-Id header required'), 400)
	}
	if (!(await isWorkspaceMember(db, actorId, workspaceId))) {
		return c.json(createApiError('FORBIDDEN', 'You are not a member of the workspace'), 403)
	}
	const { item_kind, catalog_id } = c.req.valid('param')

	const state = await loadWorkspaceState(db, workspaceId)

	const detailResult = await db.execute<RawCatalogRow>(sql`
		SELECT * FROM (${CATALOG_UNION_SQL}) AS c
		WHERE c.item_kind = ${item_kind} AND c.catalog_id = ${catalog_id}
		LIMIT 1
	`)
	const detailRows: RawCatalogRow[] = Array.isArray(detailResult)
		? (detailResult as never)
		: (((detailResult as { rows?: unknown[] }).rows ?? []) as never)

	const row = detailRows[0]
	if (!row) {
		return c.json(createApiError('NOT_FOUND', 'Marketplace item not found'), 404)
	}

	const card = toCard(row, state)

	// Requires rendering — spec §6.2: caller wants "already-connected vs
	// missing" split so the modal can show a checkmark next to what's
	// already there and a Connect CTA next to what's not.
	const requires = card.requires
	const requiredIntegrations = requires.integrations ?? []
	const requiredMcp = requires.mcp_installations ?? []
	const mcpInstalled = new Set<string>()
	for (const key of state.installations.keys()) {
		if (key.startsWith('mcp_server:')) mcpInstalled.add(key.slice('mcp_server:'.length))
	}

	const response: z.infer<typeof catalogItemDetailResponseSchema> = {
		...stripInternal(card),
		description: row.description ?? '',
		requires_status: {
			integrations: requiredIntegrations.map((slug) => ({
				slug,
				connected: state.integrations.has(slug),
			})),
			mcp_installations: requiredMcp.map((slug) => ({
				slug,
				installed: mcpInstalled.has(slug),
			})),
		},
	}
	return c.json(response)
}) as RouteHandler<typeof catalogItemDetailRoute, Env>)

export default app
