import type {
	ExtensionAttempted,
	ExtensionResponse,
	ExtensionTool,
	ExtensionToolEffect,
	ExtensionToolGrant,
} from '@/lib/api'

/** Effect of a stored grant value; the object form's expiry is not enforced yet. */
export function grantEffect(grant: ExtensionToolGrant): ExtensionToolEffect {
	return typeof grant === 'string' ? grant : grant.effect
}

/** The tools the extension's MCP config declares, with their read / write kind. */
export function declaredTools(ext: Pick<ExtensionResponse, 'mcpConfig'>): ExtensionTool[] {
	const raw = (ext.mcpConfig as { tools?: unknown } | null)?.tools
	if (!Array.isArray(raw)) return []
	return raw.filter(
		(t): t is ExtensionTool =>
			!!t &&
			typeof t === 'object' &&
			typeof (t as ExtensionTool).name === 'string' &&
			((t as ExtensionTool).kind === 'read' || (t as ExtensionTool).kind === 'write'),
	)
}

/** Declared tools the agent is currently allowed to call. */
export function allowedToolNames(
	ext: Pick<ExtensionResponse, 'mcpConfig' | 'toolGrants'>,
	agentId: string,
): string[] {
	const grants = ext.toolGrants[agentId]
	if (!grants) return []
	return declaredTools(ext)
		.map((t) => t.name)
		.filter((name) => {
			const grant = grants[name]
			return grant !== undefined && grantEffect(grant) === 'allow'
		})
}

/** Tools the agent tried in the last 30 days that it still cannot call. */
export function blockedAttempts(
	ext: Pick<ExtensionResponse, 'mcpConfig' | 'toolGrants'>,
	agentId: string,
	attempted: ExtensionAttempted | undefined,
): { tools: string[]; lastAttemptedAt: string } | null {
	const entry = attempted?.agents.find((a) => a.agentId === agentId)
	if (!entry) return null
	const allowed = new Set(allowedToolNames(ext, agentId))
	const tools = entry.tools.filter((name) => !allowed.has(name))
	return tools.length > 0 ? { tools, lastAttemptedAt: entry.lastAttemptedAt } : null
}

/** Starting point for the grant modal: the agent's current choices, or each tool's kind default. */
export function initialSelection(
	ext: Pick<ExtensionResponse, 'mcpConfig' | 'toolGrants'>,
	agentId: string,
): Record<string, boolean> {
	const grants = ext.toolGrants[agentId]
	const out: Record<string, boolean> = {}
	for (const t of declaredTools(ext)) {
		const stored = grants?.[t.name]
		out[t.name] = stored !== undefined ? grantEffect(stored) === 'allow' : t.kind === 'read'
	}
	return out
}
