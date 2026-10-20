import { AGENT_ACCESS_EFFECT, AGENT_ACCESS_LABELS } from '@maskin/shared'
import type { ActorIntegrationAccess, AgentAccess } from './agent-access'
import { getProvider } from './registry'

const LEVEL_TEXT: Record<AgentAccess, string> = {
	read_write: `${AGENT_ACCESS_LABELS.read_write} (${AGENT_ACCESS_EFFECT.read_write})`,
	read: `${AGENT_ACCESS_LABELS.read} (${AGENT_ACCESS_EFFECT.read})`,
	write: `${AGENT_ACCESS_LABELS.write} (${AGENT_ACCESS_EFFECT.write})`,
	none: AGENT_ACCESS_LABELS.none,
}

// Strongest first, so a mixed provider lists its best level first.
const LEVEL_ORDER: AgentAccess[] = ['read_write', 'read', 'write', 'none']

export function providerLabel(provider: string): string {
	try {
		return getProvider(provider)?.config.displayName ?? provider
	} catch {
		return provider
	}
}

/**
 * The block of the system prompt that tells an agent what it may do with each connected
 * integration, so it does not have to find out by failing. Saved keys and logins are left
 * out: they are either in the environment or they are not. Empty when nothing is
 * connected, so a workspace with no integrations adds no text.
 */
export function buildAccessPreamble(rows: ActorIntegrationAccess[]): string {
	const byProvider = new Map<string, Set<AgentAccess>>()
	for (const row of rows) {
		if (row.providerMode !== 'registered') continue
		const levels = byProvider.get(row.provider) ?? new Set<AgentAccess>()
		levels.add(row.access)
		byProvider.set(row.provider, levels)
	}
	if (byProvider.size === 0) return ''

	const lines = [...byProvider.entries()]
		.map(([provider, levels]) => ({ label: providerLabel(provider), levels }))
		.sort((a, b) => a.label.localeCompare(b.label))
		.map(({ label, levels }) => {
			const ordered = LEVEL_ORDER.filter((l) => levels.has(l)).map((l) => LEVEL_TEXT[l])
			const text =
				ordered.length === 1
					? ordered[0]
					: `${ordered.slice(0, -1).join(', ')} on some accounts and ${ordered[ordered.length - 1]} on others`
			return `- ${label}: ${text}`
		})

	return [
		'## Integration access',
		'A person sets what each connected integration lets you do. This is what you have:',
		...lines,
		'If a tool is refused because of access, do not retry or look for a workaround. Tell the person which integration and what level you need; a workspace admin can change it under Settings → Integrations.',
	]
		.join('\n')
		.concat('\n\n')
}
