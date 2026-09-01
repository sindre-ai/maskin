import { type Database, workspaceToolBrokers, workspaces } from '@maskin/db'
import type { ToolBrokerClient } from '@maskin/tool-broker'
import { and, eq } from 'drizzle-orm'
import { logger } from '../logger'
import type { ResolvedGrant } from './resolve'

// ---------------------------------------------------------------------------
// The agent's own toolkit — where per-TOOL scoping is actually enforced.
//
// Our MCP proxy cannot do this job. A code-mode call arrives as `execute` with
// the integration named only inside agent-authored JavaScript, which `search`
// can discover dynamically and `resume` can continue from code the proxy never
// saw. Filtering there is a hint.
//
// A toolkit is different: default-deny, and membership is matched per tool at
// execution time. Measured against the running backend — admitting one of
// DeepWiki's three tools left the other two returning `tool_blocked`, and
// `tools.search` returned only the admitted one. An ungranted tool is
// undiscoverable, not merely uncallable.
// ---------------------------------------------------------------------------

/**
 * How a connection is addressed in a tool path.
 *
 * A tool address is `<slug>.<owner>.<connection>.<name>`. Workspace-shared
 * connections are `org`/`shared` — the pair this code writes today. A personal
 * connection would differ, which is why they are named rather than baked into a
 * template string: a wrong pair produces a pattern that matches nothing, and the
 * failure looks like "the agent has no tools" rather than an error.
 */
const SHARED_CONNECTION = { owner: 'org', connection: 'shared' } as const

/**
 * Give this agent a toolkit admitting exactly what it was granted.
 *
 * Returns the toolkit slug the proxy should route to, or null when the agent has
 * no grants at all — in which case the caller falls back to the workspace
 * default and behaviour is unchanged.
 */
export const ensureAgentToolkit = async (
	db: Database,
	client: ToolBrokerClient,
	input: {
		workspaceId: string
		actorId: string
		apiKey: string
		grants: readonly ResolvedGrant[]
		/** Which refs are broker integrations; container-side ones are not toolkit members. */
		brokerRefs: ReadonlySet<string>
	},
): Promise<string | null> => {
	const brokerGrants = input.grants.filter((g) => input.brokerRefs.has(g.integrationRef))
	if (brokerGrants.length === 0) return null

	const [existing] = await db
		.select()
		.from(workspaceToolBrokers)
		.where(
			and(
				eq(workspaceToolBrokers.workspaceId, input.workspaceId),
				eq(workspaceToolBrokers.actorId, input.actorId),
			),
		)
		.limit(1)

	if (existing) return existing.toolkitSlug

	const [workspace] = await db
		.select({ name: workspaces.name })
		.from(workspaces)
		.where(eq(workspaces.id, input.workspaceId))
		.limit(1)

	const toolkit = await client.ensureToolkit(input.apiKey, {
		workspaceId: input.workspaceId,
		actorId: input.actorId,
		name: `${workspace?.name ?? 'Workspace'} — agent`,
	})

	// A fresh toolkit admits NOTHING, so membership must be written before the
	// agent uses it. Doing this after the insert would leave a window where the
	// toolkit exists and denies everything.
	for (const grant of brokerGrants) {
		try {
			await client.admitIntegration(input.apiKey, {
				toolkitId: toolkit.id,
				integrationSlug: grant.integrationRef,
				// `all` admits the whole integration; the other modes name tools.
				// Passing an empty list would admit nothing, which is why `all` must
				// not be flattened into "every known tool" upstream of here.
				tools: grant.mode === 'all' ? undefined : { ...SHARED_CONNECTION, names: grant.tools },
			})
		} catch (error) {
			// One integration failing to admit must not cost the agent the rest.
			logger.warn('Could not admit an integration into the agent toolkit', {
				actorId: input.actorId,
				integrationRef: grant.integrationRef,
				error: error instanceof Error ? error.message : String(error),
			})
		}
	}

	await db
		.insert(workspaceToolBrokers)
		.values({
			workspaceId: input.workspaceId,
			actorId: input.actorId,
			toolkitSlug: toolkit.slug,
			toolkitId: toolkit.id,
			connectedNames: brokerGrants.map((g) => g.integrationRef),
		})
		.onConflictDoNothing()

	return toolkit.slug
}
