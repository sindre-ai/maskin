import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { splitStatements } from '@maskin/db/migrate-utils'
import { conversations, integrations } from '@maskin/db/schema'
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

const UP = '0096_agent_grants_levels_and_chat_scope.sql'
const DOWN = 'down/0096_agent_grants_levels_and_chat_scope_down.sql'

async function seed() {
	const human = getTestActorId()
	const ws = await insertWorkspace(db, human)
	const agent = await insertActor(db, { type: 'agent' })
	const other = await insertActor(db, { type: 'agent' })
	const [slack] = await db
		.insert(integrations)
		.values({
			workspaceId: ws.id,
			provider: 'slack',
			status: 'active',
			credentials: 'x',
			createdBy: human,
		})
		.returning()
	return { human, ws, agent, other, slack }
}

describe('migration 0096_agent_grants_levels_and_chat_scope (Integration)', () => {
	it('turns write into read & write, and accepts an explicit none', async () => {
		const s = await seed()
		// Back to the shape before 0096, where write still existed.
		await runSqlFile(DOWN)
		await sql`
			INSERT INTO agent_grants (workspace_id, integration_id, actor_id, access)
			VALUES (${s.ws.id}, ${s.slack.id}, ${s.agent.id}, 'write'), (${s.ws.id}, ${s.slack.id}, ${s.other.id}, 'read')
		`
		await runSqlFile(UP)

		const rows = await sql<{ actor_id: string; access: string }[]>`
			SELECT actor_id::text, access FROM agent_grants WHERE integration_id = ${s.slack.id}
		`
		const byActor = Object.fromEntries(rows.map((r) => [r.actor_id, r.access]))
		expect(byActor[s.agent.id]).toBe('read_write')
		expect(byActor[s.other.id]).toBe('read')

		await sql`UPDATE agent_grants SET access = 'none' WHERE actor_id = ${s.other.id}`
		await expect(
			sql`UPDATE agent_grants SET access = 'write' WHERE actor_id = ${s.other.id}`,
		).rejects.toThrow(/agent_grants_access_enum/)
	})

	it('removes chat grants with their conversation and with their integration', async () => {
		const s = await seed()
		const [chat] = await db
			.insert(conversations)
			.values({ workspaceId: s.ws.id, title: 'Chat', createdBy: s.human })
			.returning()
		const [other] = await db
			.insert(conversations)
			.values({ workspaceId: s.ws.id, title: 'Other', createdBy: s.human })
			.returning()
		await sql`
			INSERT INTO agent_chat_grants (workspace_id, integration_id, actor_id, conversation_id)
			VALUES (${s.ws.id}, ${s.slack.id}, ${s.agent.id}, ${chat.id}),
				(${s.ws.id}, ${s.slack.id}, ${s.agent.id}, ${other.id})
		`
		// One per (credential, agent, chat).
		await expect(
			sql`INSERT INTO agent_chat_grants (workspace_id, integration_id, actor_id, conversation_id)
				VALUES (${s.ws.id}, ${s.slack.id}, ${s.agent.id}, ${chat.id})`,
		).rejects.toThrow(/agent_chat_grants_uniq/)

		await sql`DELETE FROM conversations WHERE id = ${chat.id}`
		const left = await sql`SELECT 1 FROM agent_chat_grants WHERE integration_id = ${s.slack.id}`
		expect(left).toHaveLength(1)

		await sql`DELETE FROM integrations WHERE id = ${s.slack.id}`
		expect(
			await sql`SELECT 1 FROM agent_chat_grants WHERE integration_id = ${s.slack.id}`,
		).toHaveLength(0)
	})

	it('rolls back: drops chat grants and explicit none rows, restores the old levels', async () => {
		const s = await seed()
		await sql`
			INSERT INTO agent_grants (workspace_id, integration_id, actor_id, access)
			VALUES (${s.ws.id}, ${s.slack.id}, ${s.agent.id}, 'none'), (${s.ws.id}, ${s.slack.id}, ${s.other.id}, 'read_write')
		`
		await runSqlFile(DOWN)
		const rows = await sql<{ access: string }[]>`
			SELECT access FROM agent_grants WHERE integration_id = ${s.slack.id}
		`
		expect(rows.map((r) => r.access)).toEqual(['read_write'])
		expect(
			await sql`SELECT 1 FROM information_schema.tables WHERE table_name = 'agent_chat_grants'`,
		).toHaveLength(0)
		await runSqlFile(UP)
		await runSqlFile(UP)
	})
})
