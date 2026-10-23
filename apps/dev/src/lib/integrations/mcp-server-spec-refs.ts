import type { McpServerSpec } from './types'

/**
 * True when a provider's MCP server spec references its own envKey via
 * `${ENV_KEY}` placeholder — i.e. the container's envsubst pass at start
 * substitutes a per-provider token into the server config.
 *
 * Session-manager reads this to decide whether an auto-injected server
 * genuinely needs a token resolved. Providers whose HTTP MCP authenticates
 * on the Maskin API key (linkedin-unipile, in-process Slack MCP) reference
 * `${MASKIN_API_KEY}` in their server spec instead of their own envKey — for
 * these, a failure to resolve a per-provider token (e.g. linkedin-unipile's
 * credential blob carries `{ account_id }` and no accessToken at all) must
 * NOT block auto-injection: the server can authenticate without it.
 */
export function serverSpecReferencesEnvKey(spec: McpServerSpec, envKey: string): boolean {
	const needle = `\${${envKey}}`
	if (spec.type === 'http') {
		if (spec.url.includes(needle)) return true
		if (spec.headers) {
			for (const value of Object.values(spec.headers)) {
				if (typeof value === 'string' && value.includes(needle)) return true
			}
		}
		return false
	}
	// stdio
	if (spec.command.includes(needle)) return true
	if (spec.args.some((a) => a.includes(needle))) return true
	if (spec.env) {
		for (const value of Object.values(spec.env)) {
			if (typeof value === 'string' && value.includes(needle)) return true
		}
	}
	return false
}

/**
 * True when any server in an agent- or session-level MCP map references
 * `envKey` via `${ENV_KEY}`. Session-manager uses this as the "meant to use
 * this integration" test: an agent whose own tools config names a provider's
 * token variable gets that token injected; every other agent does not.
 *
 * The maps come from stored JSON, so entries are not trusted to match
 * McpServerSpec: anything that is not an object is ignored, a missing `type`
 * is read as http when there is a `url` and stdio otherwise, and missing
 * `args` count as empty.
 */
export function mcpServersReferenceEnvKey(servers: unknown, envKey: string): boolean {
	if (!servers || typeof servers !== 'object') return false
	for (const entry of Object.values(servers as Record<string, unknown>)) {
		if (entryReferencesEnvKey(entry, envKey)) return true
	}
	return false
}

/** One stored entry's version of {@link mcpServersReferenceEnvKey}'s test. */
export function entryReferencesEnvKey(entry: unknown, envKey: string): boolean {
	if (!entry || typeof entry !== 'object') return false
	const raw = entry as Record<string, unknown>
	const spec: McpServerSpec =
		typeof raw.url === 'string'
			? {
					type: 'http',
					url: raw.url,
					headers: (raw.headers as Record<string, string> | undefined) ?? undefined,
				}
			: {
					type: 'stdio',
					command: typeof raw.command === 'string' ? raw.command : '',
					args: Array.isArray(raw.args) ? (raw.args as string[]) : [],
					env: (raw.env as Record<string, string> | undefined) ?? undefined,
				}
	return serverSpecReferencesEnvKey(spec, envKey)
}
