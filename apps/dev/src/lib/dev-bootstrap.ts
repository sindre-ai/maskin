import { generateApiKey } from '@maskin/auth'
import type { Database } from '@maskin/db'
import { actors, workspaceMembers, workspaces } from '@maskin/db/schema'
import { and, eq, isNotNull } from 'drizzle-orm'

export interface DevBootstrapResult {
	apiKey: string
	workspaceId: string
	actorName: string
	actorEmail: string
	workspaceName: string
	/** True when this run actually created the records (fresh DB). */
	created: boolean
}

/**
 * Returns ready-to-run dev credentials:
 * - On an empty database, creates a default actor + workspace + API key.
 * - On an existing database, looks up the first actor that has an API key and
 *   a workspace they're a member of, so the startup banner can still show a
 *   working `claude mcp add` command without the user hunting in the UI.
 *
 * Skipped in production or when MASKIN_AUTO_BOOTSTRAP=false.
 */
export async function maybeBootstrapDev(db: Database): Promise<DevBootstrapResult | null> {
	if (process.env.NODE_ENV === 'production') return null
	if (process.env.MASKIN_AUTO_BOOTSTRAP === 'false') return null

	const existing = await findExistingCredentials(db)
	if (existing) return existing

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
		created: true,
	}
}

async function findExistingCredentials(db: Database): Promise<DevBootstrapResult | null> {
	const [row] = await db
		.select({
			apiKey: actors.apiKey,
			actorName: actors.name,
			actorEmail: actors.email,
			workspaceId: workspaces.id,
			workspaceName: workspaces.name,
		})
		.from(actors)
		.innerJoin(workspaceMembers, eq(workspaceMembers.actorId, actors.id))
		.innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
		.where(and(isNotNull(actors.apiKey), eq(actors.type, 'human')))
		.limit(1)

	if (!row || !row.apiKey) return null
	return {
		apiKey: row.apiKey,
		workspaceId: row.workspaceId,
		actorName: row.actorName ?? 'You',
		actorEmail: row.actorEmail ?? 'dev@local',
		workspaceName: row.workspaceName,
		created: false,
	}
}
