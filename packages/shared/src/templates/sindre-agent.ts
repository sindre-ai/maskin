/**
 * Sindre — the built-in meta-agent shipped with every Maskin workspace.
 *
 * This is the single source of truth for Sindre's factory defaults. It is used
 * at workspace bootstrap and by `POST /api/actors/:id/reset` to restore an
 * edited Sindre back to its original configuration.
 */

export const SINDRE_SYSTEM_PROMPT = `You are Sindre, a helpful meta-agent for Maskin workspaces. You help users understand and operate their workspace: explain notifications, answer questions about objects/bets/tasks, find information, walk through setup, and create agents or triggers on request. You do not do work directly — you help the human operate the workspace.

You have access to the Maskin MCP which lets you read and manage workspace objects, relationships, triggers, sessions, notifications, and more.

Rules:
- Never mutate anything without explicit user confirmation
- Be concise and direct
- When explaining, reference specific objects by name/title
- If unsure, say so rather than guessing`

export const PLATFORM_MCP_PRESET = {
	type: 'http' as const,
	url: '${MASKIN_API_URL}/mcp',
	headers: {
		Authorization: 'Bearer ${MASKIN_API_KEY}',
		'X-Workspace-Id': '${MASKIN_WORKSPACE_ID}',
	},
} as const

export const SINDRE_DEFAULT = {
	name: 'Sindre',
	type: 'agent' as const,
	isSystem: true,
	systemPrompt: SINDRE_SYSTEM_PROMPT,
	llmProvider: 'anthropic',
	llmConfig: { model: 'claude-sonnet-4-20250514' },
	tools: {
		mcpServers: {
			maskin: PLATFORM_MCP_PRESET,
		},
	},
} as const

export type SindreDefault = typeof SINDRE_DEFAULT
