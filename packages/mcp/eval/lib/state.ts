import { createRequire } from 'node:module'
import type { Sql } from './telemetry'
import type { EdgeRow, ObjectRow, SessionRow, StagingState } from './types'

/**
 * Opens a read-only connection to the staging stack's Postgres. The postgres
 * driver is borrowed from the stack's own checkout (packages/db) so the harness
 * adds no dependency for it.
 */
export function openReadOnlySql(
	databaseUrl: string,
	repoRoot: string,
): Sql & { end(): Promise<void> } {
	const require = createRequire(`${repoRoot}/packages/db/package.json`)
	const postgres = require('postgres')
	return postgres(databaseUrl, {
		max: 1,
		connection: { default_transaction_read_only: true },
	})
}

export function createSqlState(sql: Sql, workspaceId: string): StagingState {
	return {
		async objectsByTitle(title) {
			const rows = (await sql`
				select id, type, title, status, content, driver
				from objects
				where workspace_id = ${workspaceId} and title = ${title}
				order by created_at
			`) as ObjectRow[]
			return rows
		},
		async edgesInvolving(objectId) {
			const rows = (await sql`
				select source_id as "sourceId", target_id as "targetId", type
				from relationships
				where source_id = ${objectId} or target_id = ${objectId}
			`) as EdgeRow[]
			return rows
		},
		async skillContent(name) {
			const rows = (await sql`
				select content from workspace_skills
				where workspace_id = ${workspaceId} and name = ${name}
			`) as { content: string }[]
			return rows[0]?.content ?? null
		},
		async sessionsInitiatedFrom(objectId) {
			const rows = (await sql`
				select id, actor_id as "actorId", initiated_from_object_id as "initiatedFromObjectId",
					action_prompt as "actionPrompt"
				from sessions
				where workspace_id = ${workspaceId} and initiated_from_object_id = ${objectId}
				order by created_at
			`) as SessionRow[]
			return rows
		},
	}
}
