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
	const max = Number(env.AGENT_SERVER_MAX_SESSIONS ?? '50')
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
		if (!secret) throw new Error(`AGENT_SERVERS entry ${i + 1} has an empty secret`)
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
					maxConcurrentSessions: sql`excluded.max_concurrent_sessions`,
					status: sql`excluded.status`,
				},
			})
	}
	return configs
}
