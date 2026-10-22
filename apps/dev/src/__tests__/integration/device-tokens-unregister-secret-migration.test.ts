import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { splitStatements } from '@maskin/db/migrate-utils'
import { deviceTokens } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { insertActor } from '../factories'
import { db, sql } from './global-setup'

const here = dirname(fileURLToPath(import.meta.url))
const drizzleDir = join(here, '..', '..', '..', '..', '..', 'packages', 'db', 'drizzle')

async function runSqlFile(relativePath: string) {
	const content = readFileSync(join(drizzleDir, relativePath), 'utf-8')
	await sql.begin(async (tx) => {
		for (const statement of splitStatements(content)) await tx.unsafe(statement)
	})
}

const UP = '0108_device_tokens_unregister_secret.sql'
const DOWN = 'down/0108_device_tokens_unregister_secret_down.sql'

const hasColumn = async () =>
	(
		await sql<{ n: number }[]>`
			SELECT count(*)::int AS n FROM information_schema.columns
			WHERE table_name = 'device_tokens' AND column_name = 'unregister_secret_hash'`
	)[0]?.n === 1

describe('migration 0108_device_tokens_unregister_secret (Integration)', () => {
	it('adds a nullable hash column, keeps existing rows, and is safe to run twice', async () => {
		const actor = (await insertActor(db))?.id as string
		const token = 'a'.repeat(64)
		try {
			await runSqlFile(DOWN)
			expect(await hasColumn()).toBe(false)
			// A row registered before the migration.
			await sql`INSERT INTO device_tokens (actor_id, platform, apns_token, environment)
				VALUES (${actor}, 'ios', ${token}, 'sandbox')`

			await runSqlFile(UP)
			await runSqlFile(UP)

			expect(await hasColumn()).toBe(true)
			const [row] = await db.select().from(deviceTokens).where(eq(deviceTokens.apnsToken, token))
			expect(row?.actorId).toBe(actor)
			expect(row?.unregisterSecretHash).toBeNull()
		} finally {
			if (!(await hasColumn())) await runSqlFile(UP)
			await sql`DELETE FROM device_tokens WHERE apns_token = ${token}`
		}
	})

	it('rolls back by dropping only the hash column', async () => {
		const actor = (await insertActor(db))?.id as string
		const token = 'b'.repeat(64)
		try {
			await runSqlFile(UP)
			await sql`INSERT INTO device_tokens (actor_id, platform, apns_token, environment, unregister_secret_hash)
				VALUES (${actor}, 'ios', ${token}, 'sandbox', 'x')`

			await runSqlFile(DOWN)
			await runSqlFile(DOWN)

			expect(await hasColumn()).toBe(false)
			const rows = await sql`SELECT id FROM device_tokens WHERE apns_token = ${token}`
			expect(rows).toHaveLength(1)
		} finally {
			// Leave the schema as the other tests expect it.
			await runSqlFile(UP)
			await sql`DELETE FROM device_tokens WHERE apns_token = ${token}`
		}
	})
})
