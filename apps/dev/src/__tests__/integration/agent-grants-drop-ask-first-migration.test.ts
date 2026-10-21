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

const UP = '0107_agent_grants_drop_ask_first.sql'
const DOWN = 'down/0107_agent_grants_drop_ask_first_down.sql'
// The rollback is what allows ask_first again; the full migration chain has already removed it.
const ALLOW_ASK_FIRST = 'down/0107_agent_grants_drop_ask_first_down.sql'

async function seed() {
	const human = getTestActorId()
	const ws = await insertWorkspace(db, human)
	const agent = await insertActor(db, { type: 'agent' })
	const other = await insertActor(db, { type: 'agent' })
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
	return { ws, agent, other, gmail, slack }
}

const accessOf = async (integrationId: string, actorId: string) =>
	(
		await sql<{ access: string }[]>`
			SELECT access FROM agent_grants WHERE integration_id = ${integrationId} AND actor_id = ${actorId}`
	)[0]?.access

describe('migration 0107_agent_grants_drop_ask_first (Integration)', () => {
	it('turns every ask_first grant into read_write and leaves the rest alone', async () => {
		const s = await seed()
		// Put the schema back to the state before 0107, where ask_first was allowed.
		await runSqlFile(ALLOW_ASK_FIRST)
		await sql`
			INSERT INTO agent_grants (workspace_id, integration_id, actor_id, access) VALUES
			(${s.ws.id}, ${s.gmail.id}, ${s.agent.id}, 'ask_first'),
			(${s.ws.id}, ${s.gmail.id}, ${s.other.id}, 'read'),
			(${s.ws.id}, ${s.slack.id}, ${s.agent.id}, 'none')`

		await runSqlFile(UP)

		expect(await accessOf(s.gmail.id, s.agent.id)).toBe('read_write')
		expect(await accessOf(s.gmail.id, s.other.id)).toBe('read')
		expect(await accessOf(s.slack.id, s.agent.id)).toBe('none')
	})

	it('rejects ask_first afterwards, and still accepts the three real levels', async () => {
		const s = await seed()
		await runSqlFile(UP)

		await expect(
			sql`INSERT INTO agent_grants (workspace_id, integration_id, actor_id, access)
				VALUES (${s.ws.id}, ${s.gmail.id}, ${s.agent.id}, 'ask_first')`,
		).rejects.toThrow(/agent_grants_access_enum/)
		for (const [i, level] of (['none', 'read', 'read_write'] as const).entries()) {
			const actor = i === 0 ? s.agent : i === 1 ? s.other : await insertActor(db, { type: 'agent' })
			await sql`INSERT INTO agent_grants (workspace_id, integration_id, actor_id, access)
				VALUES (${s.ws.id}, ${s.gmail.id}, ${actor.id}, ${level})`
		}
	})

	it('rolls back by putting Gmail agents back on ask_first, so none starts sending on its own', async () => {
		const s = await seed()
		await runSqlFile(UP)
		await sql`
			INSERT INTO agent_grants (workspace_id, integration_id, actor_id, access) VALUES
			(${s.ws.id}, ${s.gmail.id}, ${s.agent.id}, 'read_write'),
			(${s.ws.id}, ${s.slack.id}, ${s.agent.id}, 'read_write')`

		await runSqlFile(DOWN)

		expect(await accessOf(s.gmail.id, s.agent.id)).toBe('ask_first')
		expect(await accessOf(s.slack.id, s.agent.id)).toBe('read_write')
		// Leave the schema as the other tests expect it.
		await runSqlFile(UP)
	})
})
