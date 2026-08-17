/**
 * Providers surfaced to `connectors_connected`. Kept in sync with
 * `apps/dev/src/lib/integrations/registry.ts` — new provider added there,
 * add the token(s) here. Duplicated (not imported) because `packages/mcp`
 * cannot depend on `apps/dev`.
 */

export type KnownProvider = {
	/** Canonical provider name — matches the integration registry key. */
	name: string
	/** Case-insensitive tokens searched in system prompts / action prompts / configs. */
	tokens: readonly string[]
}

export const KNOWN_PROVIDERS: readonly KnownProvider[] = [
	{ name: 'github', tokens: ['github'] },
	{ name: 'linear', tokens: ['linear'] },
	{ name: 'slack', tokens: ['slack'] },
	{ name: 'gmail', tokens: ['gmail'] },
	{ name: 'google-calendar', tokens: ['google-calendar', 'google calendar', 'gcal'] },
	{ name: 'posthog', tokens: ['posthog'] },
	{ name: 'skjald', tokens: ['skjald'] },
]

/**
 * Scan a text blob for any known-provider token (case-insensitive), returning
 * the canonical provider names found. Word-boundary matched so `slackline`
 * doesn't trip the `slack` provider.
 */
export function findMentionedProviders(text: string): string[] {
	if (!text) return []
	const lower = text.toLowerCase()
	const found = new Set<string>()
	for (const provider of KNOWN_PROVIDERS) {
		for (const token of provider.tokens) {
			const escaped = token.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
			const boundary = new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`)
			if (boundary.test(lower)) {
				found.add(provider.name)
				break
			}
		}
	}
	return Array.from(found)
}
