import { randomUUID } from 'node:crypto'
// Source imports, not the package entry points: both `@maskin/db` and
// `@maskin/shared` resolve `default` to ./dist, so importing the package name
// would evaluate the last build instead of the working tree - the stale-dist
// trap in .claude/rules/known-pitfalls.md. See tools.ts for the same reasoning.
import { createDb } from '../../../packages/db/src/connection'
import { workspaceMembers, workspaces } from '../../../packages/db/src/schema'
import { type ActorListItem, type LoopSummary, createEvalActor, listActors, listLoops } from './api'

/** Everything one trajectory attempt needs to act and to be graded. */
export interface Fixture {
	actorId: string
	apiKey: string
	workspaceId: string
	/** Read the workspace back, for final-state assertions. */
	agents(): Promise<ActorListItem[]>
	loops(): Promise<LoopSummary[]>
}

let cachedDb: ReturnType<typeof createDb> | null = null

function db(): ReturnType<typeof createDb> {
	if (cachedDb) return cachedDb
	const url = process.env.DATABASE_URL
	if (!url) {
		throw new Error(
			'DATABASE_URL is not set. Trajectory evals seed a workspace directly, ' +
				'because every HTTP path that creates one also provisions default agents and loops.',
		)
	}
	cachedDb = createDb(url)
	return cachedDb
}

/** Release the pooled connections the fixture opened. Safe to call twice. */
export async function closeFixtureDb(): Promise<void> {
	if (!cachedDb) return
	const client = cachedDb.$client
	cachedDb = null
	await client.end()
}

/**
 * Stand up one throwaway actor and one genuinely empty workspace.
 *
 * The workspace row is inserted directly rather than through
 * POST /api/workspaces, and this is the whole point of the file: every HTTP
 * path that creates a workspace runs provisionWorkspace(), which seeds the
 * default agent roster, workspace skills, triggers, *default loops*, and a
 * Chief of Staff kickoff session. An eval that asks "did the model build a
 * loop" cannot start in a workspace that already contains loops and agents,
 * and CI has no business spawning a container session on the side.
 *
 * One fixture per attempt, never shared. That makes attempts independent, so
 * --concurrency is safe and a failure is reproducible in isolation.
 */
export async function createFixture(label: string): Promise<Fixture> {
	const suffix = randomUUID()
	const actor = await createEvalActor(`Eval ${label}`, `eval-${suffix}@evals.maskin.local`)

	const [workspace] = await db()
		.insert(workspaces)
		.values({
			name: `Eval ${label} ${suffix.slice(0, 8)}`,
			settings: {},
			createdBy: actor.id,
		})
		.returning()
	if (!workspace) throw new Error('workspace insert returned no row')

	await db().insert(workspaceMembers).values({
		workspaceId: workspace.id,
		actorId: actor.id,
		role: 'owner',
	})

	return {
		actorId: actor.id,
		apiKey: actor.api_key,
		workspaceId: workspace.id,
		agents: async () =>
			(await listActors(actor.api_key, workspace.id)).filter((a) => a.type === 'agent'),
		loops: () => listLoops(actor.api_key, workspace.id),
	}
}
