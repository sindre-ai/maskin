import { createDb } from './connection'
import { readAgentServerConfigs, syncAgentServersFromEnv } from './sync-agent-servers'

// Idempotent deploy-time CLI for syncing the agent-server pool from env vars.
// Set AGENT_SERVER_1_URL + AGENT_SERVER_1_SECRET (and optionally _2_, _3_, …)
// then run: pnpm --filter=@maskin/db tsx src/seed-agent-servers.ts
// Re-run after rotating secrets or changing capacity — the upsert is idempotent.

const configs = readAgentServerConfigs(process.env)
if (configs.length === 0) {
	console.error(
		'No agent servers configured. Set AGENT_SERVER_1_URL and AGENT_SERVER_1_SECRET (and optionally _2_, _3_, …).',
	)
	process.exit(1)
}

// biome-ignore lint/style/noNonNullAssertion: required env var for CLI
const db = createDb(process.env.POSTGRES_URL || process.env.DATABASE_URL!)

const synced = await syncAgentServersFromEnv(db, process.env)
for (const s of synced) {
	console.log(`Synced: url=${s.url} max_sessions=${s.maxConcurrentSessions}`)
}
process.exit(0)
