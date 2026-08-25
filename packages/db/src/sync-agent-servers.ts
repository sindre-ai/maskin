import { sql } from 'drizzle-orm'
import type { Database } from './connection'
import { agentServers } from './schema'

export interface AgentServerConfig {
	url: string
	secret: string
	maxConcurrentSessions: number
}

// Parses AGENT_SERVERS=url1|secret1,url2|secret2
export function readAgentServerConfigs(
	env: Record<string, string | undefined>,
): AgentServerConfig[] {
	const raw = env.AGENT_SERVERS
	if (!raw?.trim()) return []
	// Seed value only. Each agent-server overwrites its own row's
	// max_concurrent_sessions on boot with a figure derived from its actual
	// cores and RAM (apps/agent-server/src/lib/capacity.ts → the `capacity`
	// field on POST /api/internal/agent-servers/reconcile), so this number just
	// has to be safe for the window between registration and that first report.
	// Deliberately conservative for that reason — the old default of 50 promised
	// 200 GiB of session memory on a box that might have 62 GiB.
	const max = Number(env.AGENT_SERVER_MAX_SESSIONS ?? '4')
	if (!Number.isFinite(max) || max <= 0) {
		throw new Error(
			`AGENT_SERVER_MAX_SESSIONS must be a positive integer, got: ${env.AGENT_SERVER_MAX_SESSIONS}`,
		)
	}
	return raw.split(',').map((entry, i) => {
		const pipe = entry.indexOf('|')
		if (pipe === -1)
			throw new Error(`AGENT_SERVERS entry ${i + 1} must be url|secret, got: ${entry}`)
		const url = entry.slice(0, pipe).trim()
		const secret = entry.slice(pipe + 1).trim()
		if (!url) throw new Error(`AGENT_SERVERS entry ${i + 1} has an empty URL`)
		try {
			new URL(url)
		} catch {
			throw new Error(`AGENT_SERVERS entry ${i + 1} has an invalid URL: ${url}`)
		}
		if (!secret) throw new Error(`AGENT_SERVERS entry ${i + 1} has an empty secret`)
		if (secret.length < 16)
			throw new Error(`AGENT_SERVERS entry ${i + 1} secret must be at least 16 characters`)
		return { url, secret, maxConcurrentSessions: max }
	})
}

export async function syncAgentServersFromEnv(
	db: Database,
	env: Record<string, string | undefined> = process.env,
): Promise<AgentServerConfig[]> {
	const configs = readAgentServerConfigs(env)
	for (const config of configs) {
		await db
			.insert(agentServers)
			.values({
				url: config.url,
				secret: config.secret,
				maxConcurrentSessions: config.maxConcurrentSessions,
				status: 'active',
			})
			.onConflictDoUpdate({
				target: agentServers.url,
				set: {
					secret: sql`excluded.secret`,
					status: sql`excluded.status`,
					// max_concurrent_sessions is deliberately NOT updated here. The
					// agent-server owns that value once it has reported its own
					// hardware-derived capacity on boot; re-applying the env seed on
					// every apps/dev restart would silently stamp a real 10 back down
					// to the seed default until the box next restarted. To re-seed a
					// row on purpose, restart the agent-server — it reports again.
				},
			})
	}
	return configs
}
