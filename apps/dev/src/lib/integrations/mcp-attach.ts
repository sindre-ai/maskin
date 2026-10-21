/**
 * Helpers for attaching an integration's MCP server to an agent at launch, because the
 * agent has been granted access to it (not because someone opened the agent and added it).
 */

/** The entry for one LinkedIn identity, the same shape the agent's Quick Add button writes. */
export function linkedInIdentityServer(instanceSlug: string): Record<string, unknown> {
	return {
		type: 'http',
		url: `\${MASKIN_API_URL}/api/integrations/linkedin-unipile/mcp/${instanceSlug}`,
		headers: {
			Authorization: 'Bearer ${MASKIN_API_KEY}',
			'X-Workspace-Id': '${MASKIN_WORKSPACE_ID}',
		},
	}
}

function urlOf(entry: unknown): string | null {
	const url = (entry as { url?: unknown } | null)?.url
	return typeof url === 'string' && url.length > 0 ? url.trim().replace(/\/+$/, '') : null
}

/**
 * Drops an attached entry when the agent (or the session) already carries a server at the
 * same URL under another name. Without this an agent that added Linear by hand and was then
 * granted Linear would see every tool twice, once per name.
 */
export function dropAlreadyConfigured(
	attached: Record<string, unknown>,
	attachedKeys: ReadonlySet<string>,
	existing: ReadonlyArray<Record<string, unknown> | null | undefined>,
): { servers: Record<string, unknown>; dropped: string[] } {
	const taken = new Set<string>()
	for (const map of existing) {
		for (const entry of Object.values(map ?? {})) {
			const url = urlOf(entry)
			if (url) taken.add(url)
		}
	}
	const servers: Record<string, unknown> = {}
	const dropped: string[] = []
	for (const [key, entry] of Object.entries(attached)) {
		const url = urlOf(entry)
		if (attachedKeys.has(key) && url && taken.has(url)) dropped.push(key)
		else servers[key] = entry
	}
	return { servers, dropped }
}
