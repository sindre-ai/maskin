import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { splitStatements } from '@maskin/db/migrate-utils'
import { actors } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { insertActor } from '../factories'
import { db, sql } from './global-setup'

/**
 * Migration 0088 rewrites agents that still carry the leaked Exa key to the
 * AGENT_SECRET_EXA_API_KEY placeholder. The real key must never appear in this
 * repo, so the test swaps the digest in the migration text for the digest of a
 * fixture key and runs the otherwise unchanged SQL against three rows: the
 * "leaked" fixture key, a different literal key, and an existing placeholder.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', '..', '..', 'packages', 'db', 'drizzle')
const MIGRATION_FILE = '0088_repoint_leaked_exa_key_to_env.sql'

const PLACEHOLDER = '${AGENT_SECRET_EXA_API_KEY}'
const ENV_NAME = 'AGENT_SECRET_EXA_API_KEY'
const FIXTURE_LEAKED_KEY = 'fixture-leaked-exa-key'
const FIXTURE_OTHER_KEY = 'fixture-customer-exa-key'

const migrationSql = readFileSync(join(MIGRATIONS_DIR, MIGRATION_FILE), 'utf-8')
const shippedDigest = migrationSql.match(/'([0-9a-f]{64})'/)?.[1] as string
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

async function runMigration() {
	const testSql = migrationSql.replace(shippedDigest, sha256(FIXTURE_LEAKED_KEY))
	for (const statement of splitStatements(testSql)) {
		await sql.unsafe(statement)
	}
}

function exaTools(headerValue: unknown, extra: Record<string, unknown> = {}) {
	return {
		mcpServers: {
			maskin: { type: 'http', url: '${MASKIN_API_URL}/mcp' },
			exa: { type: 'http', url: 'https://mcp.exa.ai/mcp', headers: { 'x-api-key': headerValue } },
		},
		...extra,
	}
}

async function toolsOf(id: string) {
	const [row] = await db.select({ tools: actors.tools }).from(actors).where(eq(actors.id, id))
	return row.tools as Record<string, unknown>
}

describe('migration 0088_repoint_leaked_exa_key_to_env (integration)', () => {
	it('embeds a sha256 digest and no key material', () => {
		expect(shippedDigest).toMatch(/^[0-9a-f]{64}$/)
		expect(migrationSql).not.toMatch(/x-api-key['"]?\s*[:=]\s*['"][^$'"]/)
	})

	it('rewrites only the row whose key matches the digest, and a second run changes nothing', async () => {
		const otherTools = exaTools(FIXTURE_OTHER_KEY, { envFrom: ['AGENT_SECRET_OTHER'] })
		const placeholderTools = exaTools(PLACEHOLDER, { envFrom: [ENV_NAME] })
		const leakedTools = exaTools(FIXTURE_LEAKED_KEY, { browser: { enabled: true } })

		const leaked = await insertActor(db, { type: 'agent', tools: leakedTools })
		const other = await insertActor(db, { type: 'agent', tools: otherTools })
		const placeholder = await insertActor(db, { type: 'agent', tools: placeholderTools })

		await runMigration()

		const leakedAfter = await toolsOf(leaked.id)
		expect(leakedAfter).toEqual({
			...leakedTools,
			mcpServers: {
				...leakedTools.mcpServers,
				exa: { ...leakedTools.mcpServers.exa, headers: { 'x-api-key': PLACEHOLDER } },
			},
			envFrom: [ENV_NAME],
		})
		expect(await toolsOf(other.id)).toEqual(otherTools)
		expect(await toolsOf(placeholder.id)).toEqual(placeholderTools)

		const snapshot = await toolsOf(leaked.id)
		await runMigration()
		expect(await toolsOf(leaked.id)).toEqual(snapshot)
		expect(await toolsOf(other.id)).toEqual(otherTools)
		expect(await toolsOf(placeholder.id)).toEqual(placeholderTools)

		const remaining = await sql`
			SELECT id FROM actors
			WHERE encode(sha256(convert_to(tools->'mcpServers'->'exa'->'headers'->>'x-api-key', 'UTF8')), 'hex') = ${sha256(FIXTURE_LEAKED_KEY)}
		`
		expect(remaining).toHaveLength(0)
	})

	it('appends to an existing envFrom without duplicating or dropping entries', async () => {
		const withEnv = await insertActor(db, {
			type: 'agent',
			tools: exaTools(FIXTURE_LEAKED_KEY, { envFrom: ['AGENT_SECRET_OTHER'] }),
		})
		const alreadyListed = await insertActor(db, {
			type: 'agent',
			tools: exaTools(FIXTURE_LEAKED_KEY, { envFrom: [ENV_NAME] }),
		})

		await runMigration()

		expect((await toolsOf(withEnv.id)).envFrom).toEqual(['AGENT_SECRET_OTHER', ENV_NAME])
		expect((await toolsOf(alreadyListed.id)).envFrom).toEqual([ENV_NAME])
	})

	it('leaves agents without an exa header or with no tools untouched', async () => {
		const noExa = await insertActor(db, {
			type: 'agent',
			tools: { mcpServers: { maskin: { type: 'http', url: 'x' } } },
		})
		const noTools = await insertActor(db, { type: 'agent', tools: null })

		await runMigration()

		expect(await toolsOf(noExa.id)).toEqual({
			mcpServers: { maskin: { type: 'http', url: 'x' } },
		})
		expect((await db.select().from(actors).where(eq(actors.id, noTools.id)))[0].tools).toBeNull()
	})
})
