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
