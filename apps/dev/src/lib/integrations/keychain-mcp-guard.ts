import { KEYCHAIN_ENV_PREFIX } from './keychain-env'

// Matches $KEYCHAIN_X and ${KEYCHAIN_X}, the two forms envsubst expands.
const KEYCHAIN_REFERENCE = new RegExp(`\\$\\{?(${KEYCHAIN_ENV_PREFIX}[A-Za-z0-9_]*)`, 'g')

export type DroppedMcpReason = 'stdio_command_in_keychain_session' | 'http_names_keychain_key'

export interface DroppedMcpEntry {
	/** The server's key in the session config, for example session-mcp-1. Never a value. */
	name: string
	reason: DroppedMcpReason
}

/** The KEYCHAIN_ env var names a config entry refers to. Names only, never values. */
export function keychainReferences(entry: unknown): string[] {
	const names = new Set<string>()
	for (const match of JSON.stringify(entry ?? null).matchAll(KEYCHAIN_REFERENCE)) {
		names.add(match[1] as string)
	}
	return [...names]
}

function isHttpEntry(entry: unknown): boolean {
	if (typeof entry !== 'object' || entry === null) return false
	const e = entry as Record<string, unknown>
	// A stdio entry may carry a url too (mcp-remote); the command wins, as in the schema.
	return typeof e.command !== 'string' && (e.type === 'http' || typeof e.url === 'string')
}

/**
 * The session-level MCP entries (session-mcp-N, from the session's own config) that
 * may launch in a session that was given Keychain keys. Run only when at least one
 * KEYCHAIN_ value was injected: a stdio entry is a command the session's caller
 * chose, and it could print its own env, so every one is dropped. An http entry is
 * dropped only if it names a KEYCHAIN_ variable, because that would send the key to
 * a server the caller chose.
 *
 * Takes the session-level list on purpose. Servers the platform adds itself
 * (autoInjectedMcpServers: the per-owner GitHub servers, integration servers) never
 * pass through here, and the agent's own tool config is where a reference belongs.
 */
export function stripSessionLevelMcps(mcps: Array<Record<string, unknown>>): {
	kept: Record<string, unknown>
	dropped: DroppedMcpEntry[]
} {
	const kept: Record<string, unknown> = {}
	const dropped: DroppedMcpEntry[] = []
	for (const [i, mcp] of mcps.entries()) {
		const name = `session-mcp-${i}`
		if (!isHttpEntry(mcp)) {
			dropped.push({ name, reason: 'stdio_command_in_keychain_session' })
		} else if (keychainReferences(mcp).length > 0) {
			dropped.push({ name, reason: 'http_names_keychain_key' })
		} else {
			kept[name] = mcp
		}
	}
	return { kept, dropped }
}

/**
 * KEYCHAIN_ references in the given server configs that the launch env does not
 * hold, so the container's envsubst would expand them to an empty string. One
 * result per server and name.
 */
export function findUnresolvedKeychainReferences(
	servers: Record<string, unknown>,
	env: Record<string, string>,
): Array<{ server: string; envName: string }> {
	const unresolved: Array<{ server: string; envName: string }> = []
	for (const [server, entry] of Object.entries(servers)) {
		for (const envName of keychainReferences(entry)) {
			if (!env[envName]) unresolved.push({ server, envName })
		}
	}
	return unresolved
}
