import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { splitStatements } from '@maskin/db/migrate-utils'
import { describe, expect, it } from 'vitest'
import { insertActor, insertWorkspace } from '../factories'
import { db, getTestActorId, sql } from './global-setup'

const here = dirname(fileURLToPath(import.meta.url))
const drizzleDir = join(here, '..', '..', '..', '..', '..', 'packages', 'db', 'drizzle')

async function runSqlFile(relativePath: string) {
	const content = readFileSync(join(drizzleDir, relativePath), 'utf-8')
	await sql.begin(async (tx) => {
		for (const statement of splitStatements(content)) await tx.unsafe(statement)
	})
}

const UP = '0095_agent_grants.sql'
const DOWN = 'down/0095_agent_grants_down.sql'

async function columnNames() {
	const rows = await sql<{ column_name: string }[]>`
		SELECT column_name FROM information_schema.columns
		WHERE table_schema = 'public' AND table_name = 'integrations'
	`
	return new Set(rows.map((r) => r.column_name))
}

async function insertOld(
	workspaceId: string,
	createdBy: string,
	row: { provider: string; mode: string; displayName?: string; grants: unknown[] },
) {
	const [out] = await sql<{ id: string }[]>`
		INSERT INTO integrations (workspace_id, provider, status, credentials, created_by, provider_mode, display_name, scope_grants)
		VALUES (${workspaceId}, ${row.provider}, 'active', 'x', ${createdBy}, ${row.mode},
			${row.displayName ?? null}, ${sql.json(row.grants as never)})
		RETURNING id
	`
	return out.id
}

describe('migration 0095_agent_grants (Integration)', () => {
	it('carries actor grants over, drops workspace and loop grants, and keeps Keychain credentials explicit', async () => {
		const human = getTestActorId()
		const workspace = await insertWorkspace(db, human)
		const agentX = await insertActor(db, { type: 'agent' })
		const agentY = await insertActor(db, { type: 'agent' })
		const gone = crypto.randomUUID()

		// Back to the shape before 0095, so there is old data to migrate.
		await runSqlFile(DOWN)
		expect(await columnNames()).toContain('scope_grants')

		const slack = await insertOld(workspace.id, human, {
			provider: 'slack',
			mode: 'registered',
			grants: [{ kind: 'actor', actorId: agentX.id }, { kind: 'workspace' }],
		})
		const meet = await insertOld(workspace.id, human, {
			provider: 'google-meet',
			mode: 'registered',
			grants: [{ kind: 'workspace' }],
		})
		const loopOnly = await insertOld(workspace.id, human, {
			provider: 'linear',
			mode: 'registered',
			grants: [{ kind: 'loop', loopId: crypto.randomUUID() }],
		})
		const key = await insertOld(workspace.id, human, {
			provider: 'custom',
			mode: 'byo_apikey',
			displayName: 'Coolify',
			grants: [
				{ kind: 'actor', actorId: agentY.id },
				{ kind: 'actor', actorId: gone },
				{ kind: 'actor', actorId: agentY.id },
			],
		})
		const unassigned = await insertOld(workspace.id, human, {
			provider: 'custom',
			mode: 'byo_login',
			displayName: 'e-conomic',
			grants: [],
		})

		await runSqlFile(UP)

		expect(await columnNames()).not.toContain('scope_grants')
		const grants = await sql<{ integration_id: string; actor_id: string; access: string }[]>`
			SELECT integration_id::text, actor_id::text, access FROM agent_grants
			WHERE workspace_id = ${workspace.id} ORDER BY integration_id, actor_id
		`
		const byIntegration = (id: string) => grants.filter((g) => g.integration_id === id)
		// An actor grant survives as read & write.
		expect(byIntegration(slack).map((g) => [g.actor_id, g.access])).toEqual([
			[agentX.id, 'read_write'],
		])
		// Workspace and loop grants are dropped: those providers follow the default.
		expect(byIntegration(meet)).toEqual([])
		expect(byIntegration(loopOnly)).toEqual([])
		// A grant naming an actor that no longer exists is skipped, and a repeat is stored once.
		expect(byIntegration(key).map((g) => [g.actor_id, g.access])).toEqual([
			[agentY.id, 'read_write'],
		])
		expect(byIntegration(unassigned)).toEqual([])

		const defaults = await sql<{ id: string; default_agent_access: string }[]>`
			SELECT id::text, default_agent_access FROM integrations WHERE workspace_id = ${workspace.id}
		`
		const defaultOf = (id: string) => defaults.find((d) => d.id === id)?.default_agent_access
		// Ordinary integrations read by default; saved keys and logins stay off.
		expect(defaultOf(slack)).toBe('read')
		expect(defaultOf(meet)).toBe('read')
		expect(defaultOf(key)).toBe('none')
		expect(defaultOf(unassigned)).toBe('none')
	})

	it('rolls back to a scope_grants list from the grant rows, and rolls forward again', async () => {
		const human = getTestActorId()
		const workspace = await insertWorkspace(db, human)
		const agent = await insertActor(db, { type: 'agent' })
		const [row] = await sql<{ id: string }[]>`
			INSERT INTO integrations (workspace_id, provider, status, credentials, created_by)
			VALUES (${workspace.id}, 'slack', 'active', 'x', ${human}) RETURNING id
		`
		await sql`
			INSERT INTO agent_grants (workspace_id, integration_id, actor_id, access)
			VALUES (${workspace.id}, ${row.id}, ${agent.id}, 'read')
		`

		await runSqlFile(DOWN)
		const [old] = await sql<{ scope_grants: unknown }[]>`
			SELECT scope_grants FROM integrations WHERE id = ${row.id}
		`
		expect(old.scope_grants).toEqual([{ kind: 'actor', actorId: agent.id }])
		const tables =
			await sql`SELECT 1 FROM information_schema.tables WHERE table_name = 'agent_grants'`
		expect(tables).toHaveLength(0)

		await runSqlFile(UP)
		const [back] = await sql<{ access: string }[]>`
			SELECT access FROM agent_grants WHERE integration_id = ${row.id}
		`
		// The level is not kept on the way down, so it comes back as read & write.
		expect(back.access).toBe('read_write')
	})

	it('is safe to run twice', async () => {
		await runSqlFile(UP)
		expect(await columnNames()).not.toContain('scope_grants')
	})
})
