import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { splitStatements } from '@maskin/db/migrate-utils'
import { actors } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { insertActor } from '../factories'
import { db, sql } from './global-setup'

const here = dirname(fileURLToPath(import.meta.url))
const drizzleDir = join(here, '..', '..', '..', '..', '..', 'packages', 'db', 'drizzle')
const UP = '0108_remove_exa_from_actor_tools.sql'

async function runMigration() {
	const content = readFileSync(join(drizzleDir, UP), 'utf-8')
	for (const statement of splitStatements(content)) await sql.unsafe(statement)
}

const ENV_NAME = 'AGENT_SECRET_EXA_API_KEY'
const maskin = { type: 'http', url: '${MASKIN_API_URL}/mcp' }
const exa = {
	type: 'http',
	url: 'https://mcp.exa.ai/mcp',
	headers: { 'x-api-key': '${AGENT_SECRET_EXA_API_KEY}' },
}

async function toolsOf(id: string) {
	const [row] = await db.select({ tools: actors.tools }).from(actors).where(eq(actors.id, id))
	return row?.tools
}

describe('migration 0108_remove_exa_from_actor_tools (Integration)', () => {
	it('removes exa and its env name, leaves rows without exa alone, and a second run changes nothing', async () => {
		const withExa = await insertActor(db, {
			type: 'agent',
			tools: {
				mcpServers: { maskin, exa },
				envFrom: ['AGENT_SECRET_OTHER', ENV_NAME, 'AGENT_SECRET_LAST'],
				browser: { enabled: true },
			},
		})
		const withoutExaTools = {
			mcpServers: { maskin },
			envFrom: ['AGENT_SECRET_OTHER'],
		}
		const withoutExa = await insertActor(db, { type: 'agent', tools: withoutExaTools })
		const noTools = await insertActor(db, { type: 'agent', tools: null })

		await runMigration()

		expect(await toolsOf(withExa.id)).toEqual({
			mcpServers: { maskin },
			envFrom: ['AGENT_SECRET_OTHER', 'AGENT_SECRET_LAST'],
			browser: { enabled: true },
		})
		expect(await toolsOf(withoutExa.id)).toEqual(withoutExaTools)
		expect(await toolsOf(noTools.id)).toBeNull()

		const before = await sql<{ id: string; tools: unknown }[]>`
			SELECT id, tools FROM actors WHERE id IN (${withExa.id}, ${withoutExa.id}, ${noTools.id})
			ORDER BY id`
		await runMigration()
		const after = await sql<{ id: string; tools: unknown }[]>`
			SELECT id, tools FROM actors WHERE id IN (${withExa.id}, ${withoutExa.id}, ${noTools.id})
			ORDER BY id`
		expect(after).toEqual(before)

		const remaining = await sql`
			SELECT id FROM actors
			WHERE jsonb_typeof(tools->'mcpServers'->'exa') IS NOT NULL
				OR (jsonb_typeof(tools->'envFrom') = 'array'
					AND tools->'envFrom' @> jsonb_build_array(${ENV_NAME}::text))`
		expect(remaining).toHaveLength(0)
	})

	it('handles exa without envFrom, and the env name without exa', async () => {
		const exaOnly = await insertActor(db, {
			type: 'agent',
			tools: { mcpServers: { maskin, exa } },
		})
		const envOnly = await insertActor(db, {
			type: 'agent',
			tools: { mcpServers: { maskin }, envFrom: [ENV_NAME] },
		})

		await runMigration()

		expect(await toolsOf(exaOnly.id)).toEqual({ mcpServers: { maskin } })
		expect(await toolsOf(envOnly.id)).toEqual({ mcpServers: { maskin }, envFrom: [] })
	})
})
