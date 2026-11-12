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

const UP = '0148_send_permissions_default_always_allow.sql'
const DOWN = 'down/0148_send_permissions_default_always_allow_down.sql'

// A workspace with the rows 0131 wrote for it, plus one a person edited and one agent row.
async function seed() {
	const human = getTestActorId()
	const ws = await insertWorkspace(db, human)
	const agent = await insertActor(db, { type: 'agent' })
	await sql`DELETE FROM send_permissions WHERE workspace_id = ${ws.id}`
	await sql`
		INSERT INTO send_permissions (workspace_id, agent_id, kind, mode, updated_by) VALUES
		(${ws.id}, NULL, 'email', 'ask_first', NULL),
		(${ws.id}, NULL, 'linkedin_message', 'ask_first', NULL),
		(${ws.id}, NULL, 'linkedin_connection_request', 'ask_first', NULL),
		(${ws.id}, NULL, 'linkedin_inmail', 'ask_first', ${human}),
		(${ws.id}, NULL, 'slack_message', 'deny', NULL),
		(${ws.id}, ${agent.id}, 'email', 'ask_first', NULL)`
	return { ws, agent }
}

const modes = async (workspaceId: string) => {
	const rows = await sql<{ agent_id: string | null; kind: string; mode: string }[]>`
		SELECT agent_id, kind, mode FROM send_permissions WHERE workspace_id = ${workspaceId}`
	const key = (r: { agent_id: string | null; kind: string }) =>
		`${r.agent_id ? 'agent' : 'default'}:${r.kind}`
	return Object.fromEntries(rows.map((r) => [key(r), r.mode]))
}

describe('migration 0148_send_permissions_default_always_allow (Integration)', () => {
	it('flips the four untouched workspace defaults and leaves every other row alone', async () => {
		const s = await seed()

		await runSqlFile(UP)

		expect(await modes(s.ws.id)).toEqual({
			'default:email': 'always_allow',
			'default:linkedin_message': 'always_allow',
			'default:linkedin_connection_request': 'always_allow',
			// A person edited this default (updated_by set), so it stays ask first.
			'default:linkedin_inmail': 'ask_first',
			'default:slack_message': 'deny',
			// A per-agent Ask first is the person's own choice and stays.
			'agent:email': 'ask_first',
		})
	})

	it('rolls back the same untouched rows to ask first', async () => {
		const s = await seed()
		await runSqlFile(UP)

		await runSqlFile(DOWN)

		expect(await modes(s.ws.id)).toMatchObject({
			'default:email': 'ask_first',
			'default:linkedin_message': 'ask_first',
			'default:linkedin_connection_request': 'ask_first',
			'default:slack_message': 'deny',
			'agent:email': 'ask_first',
		})
		// Leave the data as the other tests expect it.
		await runSqlFile(UP)
	})
})
