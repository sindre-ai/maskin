import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { workspaces } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { insertWorkspace } from '../factories'
import { db, getTestActorId, sql } from './global-setup'

const MIGRATION = readFileSync(
	join(
		dirname(fileURLToPath(import.meta.url)),
		'../../../../../packages/db/drizzle/0089_knowledge_customer_facing_field.sql',
	),
	'utf8',
)

const STORED = [
	{ name: 'doc_type', type: 'enum', values: ['note'] },
	{ name: 'summary', type: 'text', required: true },
	{ name: 'team_custom', type: 'text' },
]

async function knowledgeFields(workspaceId: string): Promise<unknown> {
	const [row] = await db
		.select({ settings: workspaces.settings })
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId))
	return (row?.settings as { field_definitions?: { knowledge?: unknown } } | null)
		?.field_definitions?.knowledge
}

describe('knowledge customer_facing field migration (0089)', () => {
	it('appends customer_facing once, keeps every stored entry in order, and a second run changes nothing', async () => {
		const ws = await insertWorkspace(db, getTestActorId(), {
			settings: {
				field_definitions: { knowledge: STORED, contact: [{ name: 'email', type: 'text' }] },
			},
		})
		await sql.unsafe(MIGRATION)
		const first = await knowledgeFields(ws.id)
		expect(first).toEqual([...STORED, { name: 'customer_facing', type: 'boolean' }])
		await sql.unsafe(MIGRATION)
		expect(await knowledgeFields(ws.id)).toEqual(first)
	})

	it('only touches workspaces whose stored knowledge fields lack customer_facing', async () => {
		const has = [...STORED, { name: 'customer_facing', type: 'boolean', required: false }]
		const alreadyHas = await insertWorkspace(db, getTestActorId(), {
			settings: { field_definitions: { knowledge: has } },
		})
		const noList = await insertWorkspace(db, getTestActorId(), {
			settings: { field_definitions: { contact: [{ name: 'email', type: 'text' }] } },
		})
		const noFieldDefs = await insertWorkspace(db, getTestActorId(), { settings: {} })
		await sql.unsafe(MIGRATION)
		expect(await knowledgeFields(alreadyHas.id)).toEqual(has)
		expect(await knowledgeFields(noList.id)).toBeUndefined()
		expect(await knowledgeFields(noFieldDefs.id)).toBeUndefined()
	})
})
