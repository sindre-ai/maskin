import { entryReferencesEnvKey } from './mcp-server-spec-refs'
import type { McpEntryOwner, McpServerSpec, ProviderConfig } from './types'

/**
 * Recognises the `actors.tools.mcpServers` entries one provider connection put
 * on agents. Pure and driven entirely by the provider's own `config.ts`
 * (`mcp.server`, `mcp.envKey`, `mcp.entry`): there is no per-provider list
 * here, so a provider cannot declare an entry this file cannot recognise
 * without the contract test (`mcp-entries.contract.test.ts`) failing.
 *
 * Entries are matched on what they point at, never on the key an agent filed
 * them under. The key is user-editable; the URL (or the token variable) is what
 * determines where calls go. That also leaves alone a hand-written server that
 * merely shares a name, or one that shares an external URL but authenticates
 * with its own key rather than the provider's token variable.
 */

export type EntryMatcher = (entry: unknown) => boolean

/** The placeholder a provider's own-API MCP url starts with. */
const API_ORIGIN_PLACEHOLDER = '${MASKIN_API_URL}'

/**
 * The path segment after `urlPath`: '' for the bare endpoint, the instance slug
 * for `urlPath/{slug}`, null when the url is some other endpoint (including
 * `urlPath` followed by more name, e.g. `/mcpx`).
 */
export function instanceSlugOf(url: string, urlPath: string): string | null {
	const at = url.indexOf(urlPath)
	if (at === -1) return null
	const rest = url.slice(at + urlPath.length).split(/[?#]/)[0] ?? ''
	if (rest === '' || rest === '/') return ''
	if (!rest.startsWith('/')) return null
	return rest.slice(1).replace(/\/+$/, '')
}

function urlOf(entry: unknown): string | null {
	if (!entry || typeof entry !== 'object') return null
	const url = (entry as { url?: unknown }).url
	return typeof url === 'string' ? url : null
}

/** The api path of a spec this API serves itself, or null for an external server. */
export function ownApiPathOf(spec: McpServerSpec): string | null {
	if (spec.type !== 'http' || !spec.url.startsWith(API_ORIGIN_PLACEHOLDER)) return null
	return spec.url.slice(API_ORIGIN_PLACEHOLDER.length)
}

function sharedMatcher(server: McpServerSpec, envKey: string): EntryMatcher {
	const apiPath = ownApiPathOf(server)
	if (apiPath) {
		return (entry) => {
			const url = urlOf(entry)
			return url !== null && instanceSlugOf(url, apiPath) === ''
		}
	}
	if (server.type === 'http') {
		const target = server.url.replace(/\/+$/, '')
		return (entry) => {
			const url = urlOf(entry)
			return (
				url !== null && url.replace(/\/+$/, '') === target && entryReferencesEnvKey(entry, envKey)
			)
		}
	}
	return (entry) => {
		if (!entry || typeof entry !== 'object' || urlOf(entry) !== null) return false
		const { command, args } = entry as { command?: unknown; args?: unknown }
		return (
			command === server.command &&
			Array.isArray(args) &&
			args.length === server.args.length &&
			args.every((a, i) => a === server.args[i])
		)
	}
}

/**
 * The matcher for the entries `owner`'s connection is responsible for, or null
 * when nothing may be removed: the provider declares no MCP surface, or another
 * active connection still needs the entry.
 *
 * `others` are the OTHER active connections of the same provider in the same
 * workspace. When in doubt an entry is kept: a dead entry is the safer miss
 * than deleting a live one.
 */
export function entryMatcherFor(
	config: ProviderConfig,
	owner: McpEntryOwner,
	others: McpEntryOwner[],
): EntryMatcher | null {
	const mcp = config.mcp
	if (!mcp) return null
	const decl = mcp.entry ?? { kind: 'shared' as const }

	if (decl.kind === 'shared') {
		// One entry serves every connection of the provider (Slack has a single
		// `/api/integrations/slack/mcp` however many teams are connected), so it
		// goes only with the last one.
		if (others.length > 0 || !mcp.server) return null
		return sharedMatcher(mcp.server, mcp.envKey)
	}

	if (decl.kind === 'per-installation') {
		const own = decl.envKey(owner)
		if (!own || others.some((o) => decl.envKey(o) === own)) return null
		return (entry) => entryReferencesEnvKey(entry, own)
	}

	const own = decl.slugPrefix(owner)
	const otherPrefixes = others.map((o) => decl.slugPrefix(o)).filter((p): p is string => p !== null)
	return (entry) => {
		const url = urlOf(entry)
		const slug = url === null ? null : instanceSlugOf(url, decl.urlPath)
		if (slug === null) return false
		// The bare endpoint is the deprecated aggregate: it exposes no tools for
		// any identity, so it is dead as soon as any credential goes.
		if (slug === '') return true
		if (!own || !slug.startsWith(own)) return false
		// `linkedin-magnus-` is a prefix of `linkedin-magnus-noeddegaard-personal`
		// too. When another live credential claims the slug with a longer prefix,
		// it is theirs.
		return !otherPrefixes.some((other) => other.length > own.length && slug.startsWith(other))
	}
}
