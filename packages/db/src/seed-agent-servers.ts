import { sql } from 'drizzle-orm'
import { createDb } from './connection'
import { agentServers } from './schema'

// Idempotent deploy-time seed for the agent-server pool. Reads URL + secret
// from env vars so the bearer-token secret never lands in git or migrations.
// Re-run after rotating the secret or changing the capacity — `ON CONFLICT
// (url) DO UPDATE` keeps the row stable.

const url = process.env.AGENT_SERVER_FINLAND_URL
const secret = process.env.AGENT_SERVER_FINLAND_SECRET
const maxConcurrentSessions = Number(process.env.AGENT_SERVER_FINLAND_MAX_SESSIONS ?? '50')

if (!url) {
	throw new Error('AGENT_SERVER_FINLAND_URL is required')
}
if (!secret) {
	throw new Error('AGENT_SERVER_FINLAND_SECRET is required')
}
if (!Number.isFinite(maxConcurrentSessions) || maxConcurrentSessions <= 0) {
	throw new Error(
		`AGENT_SERVER_FINLAND_MAX_SESSIONS must be a positive integer, got: ${process.env.AGENT_SERVER_FINLAND_MAX_SESSIONS}`,
	)
}

// biome-ignore lint/style/noNonNullAssertion: required env var for CLI
const db = createDb(process.env.POSTGRES_URL || process.env.DATABASE_URL!)

const [row] = await db
	.insert(agentServers)
	.values({
		url,
		secret,
		maxConcurrentSessions,
		status: 'active',
	})
	.onConflictDoUpdate({
		target: agentServers.url,
		set: {
			secret: sql`excluded.secret`,
			maxConcurrentSessions: sql`excluded.max_concurrent_sessions`,
			status: sql`excluded.status`,
		},
	})
	.returning({
		id: agentServers.id,
		url: agentServers.url,
		status: agentServers.status,
		maxConcurrentSessions: agentServers.maxConcurrentSessions,
	})

if (!row) throw new Error('Seed failed: agent_servers upsert returned no rows')

console.log(
	`Seeded agent_servers row id=${row.id} url=${row.url} status=${row.status} max_concurrent_sessions=${row.maxConcurrentSessions}`,
)
process.exit(0)
