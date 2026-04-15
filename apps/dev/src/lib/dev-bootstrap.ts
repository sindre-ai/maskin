import { generateApiKey } from '@maskin/auth'
import type { Database } from '@maskin/db'
import { actors, workspaceMembers, workspaces } from '@maskin/db/schema'
import { sql } from 'drizzle-orm'

export interface DevBootstrapResult {
	apiKey: string
	workspaceId: string
	actorName: string
	actorEmail: string
	workspaceName: string
}

/**
 * Idempotently create a default actor + workspace + API key for local dev,
 * so a fresh `pnpm dev` is one MCP command away from a working setup.
 *
 * Skipped if any actor already exists, or in production, or when explicitly
 * disabled via MASKIN_AUTO_BOOTSTRAP=false.
 */
export async function maybeBootstrapDev(db: Database): Promise<DevBootstrapResult | null> {
	if (process.env.NODE_ENV === 'production') return null
	if (process.env.MASKIN_AUTO_BOOTSTRAP === 'false') return null

	const rows = await db.select({ count: sql<number>`count(*)::int` }).from(actors)
	if ((rows[0]?.count ?? 0) > 0) return null

	const { key } = generateApiKey()
	const [actor] = await db
		.insert(actors)
		.values({
			type: 'human',
			name: 'You',
			email: 'dev@local',
			apiKey: key,
		})
		.returning()

	if (!actor) throw new Error('dev bootstrap: failed to create actor')

	const [workspace] = await db
		.insert(workspaces)
		.values({
			name: 'My Workspace',
			createdBy: actor.id,
		})
		.returning()

	if (!workspace) throw new Error('dev bootstrap: failed to create workspace')

	await db.insert(workspaceMembers).values({
		workspaceId: workspace.id,
		actorId: actor.id,
		role: 'owner',
	})

	return {
		apiKey: key,
		workspaceId: workspace.id,
		actorName: actor.name ?? 'You',
		actorEmail: actor.email ?? 'dev@local',
		workspaceName: workspace.name,
	}
}
