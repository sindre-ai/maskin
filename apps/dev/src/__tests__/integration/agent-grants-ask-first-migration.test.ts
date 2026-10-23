import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { splitStatements } from '@maskin/db/migrate-utils'
import { integrations } from '@maskin/db/schema'
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

const UP = '0100_agent_grants_ask_first.sql'
const DOWN = 'down/0100_agent_grants_ask_first_down.sql'

async function seed() {
	const human = getTestActorId()
	const ws = await insertWorkspace(db, human)
	const writer = await insertActor(db, { type: 'agent' })
	const reader = await insertActor(db, { type: 'agent' })
	const connect = async (provider: string) =>
		(
			await db
				.insert(integrations)
				.values({
					workspaceId: ws.id,
					provider,
					status: 'active',
					credentials: 'x',
					createdBy: human,
				})
				.returning()
		)[0]
	const gmail = await connect('gmail')
	const slack = await connect('slack')
	if (!gmail || !slack) throw new Error('seed failed')
	return { ws, writer, reader, gmail, slack }
}

const accessOf = async (integrationId: string, actorId: string) =>
	(
		await sql<{ access: string }[]>`
			SELECT access FROM agent_grants WHERE integration_id = ${integrationId} AND actor_id = ${actorId}`
	)[0]?.access

describe('migration 0100_agent_grants_ask_first (Integration)', () => {
	it('moves existing Gmail read & write to ask first, and leaves everything else alone', async () => {
		const s = await seed()
		await sql`
			INSERT INTO agent_grants (workspace_id, integration_id, actor_id, access) VALUES
			(${s.ws.id}, ${s.gmail.id}, ${s.writer.id}, 'read_write'),
			(${s.ws.id}, ${s.gmail.id}, ${s.reader.id}, 'read'),
			(${s.ws.id}, ${s.slack.id}, ${s.writer.id}, 'read_write')`

		await runSqlFile(UP)

		expect(await accessOf(s.gmail.id, s.writer.id)).toBe('ask_first')
		expect(await accessOf(s.gmail.id, s.reader.id)).toBe('read')
		// Slack's "write" always meant act on your own, and still does.
		expect(await accessOf(s.slack.id, s.writer.id)).toBe('read_write')
	})

	it('accepts ask_first and still rejects any other level', async () => {
		const s = await seed()
		await runSqlFile(UP)

		await sql`INSERT INTO agent_grants (workspace_id, integration_id, actor_id, access)
			VALUES (${s.ws.id}, ${s.gmail.id}, ${s.writer.id}, 'ask_first')`
		await expect(
			sql`INSERT INTO agent_grants (workspace_id, integration_id, actor_id, access)
				VALUES (${s.ws.id}, ${s.gmail.id}, ${s.reader.id}, 'always')`,
		).rejects.toThrow(/agent_grants_access_enum/)
	})

	it('rolls back to read & write, which is what those agents had before sending existed', async () => {
		const s = await seed()
		await runSqlFile(UP)
		await sql`INSERT INTO agent_grants (workspace_id, integration_id, actor_id, access)
			VALUES (${s.ws.id}, ${s.gmail.id}, ${s.writer.id}, 'ask_first')`

		await runSqlFile(DOWN)

		expect(await accessOf(s.gmail.id, s.writer.id)).toBe('read_write')
		await expect(
			sql`UPDATE agent_grants SET access = 'ask_first' WHERE actor_id = ${s.writer.id}`,
		).rejects.toThrow(/agent_grants_access_enum/)
		// Leave the schema as the other tests expect it: 0107 is the later migration, so ask_first is gone.
		await runSqlFile('0107_agent_grants_drop_ask_first.sql')
	})
})
