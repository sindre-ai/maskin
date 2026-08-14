import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

export function createDb(url: string) {
	const client = postgres(url, { prepare: false })
	return drizzle(client, { schema })
}

export type Database = ReturnType<typeof createDb>

/** The `tx` parameter inside a `db.transaction(async (tx) => { ... })` callback. */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]
