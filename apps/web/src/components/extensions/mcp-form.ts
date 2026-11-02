import type { ExtensionMcpConfig, ExtensionResponse, ExtensionTool } from '@/lib/api'
import {
	MAX_EXTENSION_TOOLS,
	classifyToolKind,
	mcpRemoteServer,
	mcpRemoteUrl,
} from '@maskin/shared'

export { MAX_EXTENSION_TOOLS }

export type McpAuth = 'api-key' | 'none'

export interface McpToolRow extends ExtensionTool {
	selected: boolean
}

export interface McpFormState {
	serverUrl: string
	auth: McpAuth
	/** Only held while typing; blank on an existing extension means "keep the stored key". */
	apiKey: string
	/** Edit mode: the stored key stays masked until the owner chooses to replace it. */
	replaceKey: boolean
}

export type McpFormErrors = Partial<Record<'serverUrl' | 'apiKey', string>>

export function emptyMcpForm(serverUrl = ''): McpFormState {
	return { serverUrl, auth: 'api-key', apiKey: '', replaceKey: true }
}

/** The saved config as a form: URL read back out of the stored mcp-remote server. */
export function formFromMcpConfig(
	ext: Pick<ExtensionResponse, 'mcpConfig' | 'hasMcpKey'>,
): McpFormState {
	const cfg = ext.mcpConfig as ExtensionMcpConfig | null
	const url = cfg?.server.type === 'stdio' ? mcpRemoteUrl(cfg.server) : null
	return {
		serverUrl: url ?? '',
		auth: cfg?.server.type === 'stdio' && cfg.server.envFromCredential ? 'api-key' : 'none',
		apiKey: '',
		replaceKey: !ext.hasMcpKey,
	}
}

export function validateMcpForm(form: McpFormState, opts: { editing: boolean }): McpFormErrors {
	const errors: McpFormErrors = {}
	const url = form.serverUrl.trim()
	try {
		if (new URL(url).protocol !== 'https:') throw new Error('not https')
	} catch {
		errors.serverUrl = 'Enter a full https:// address.'
	}
	if (form.auth === 'api-key' && (form.replaceKey || !opts.editing) && !form.apiKey.trim()) {
		errors.apiKey = 'Paste the vendor API key.'
	}
	return errors
}

/** Tools the server listed, first 20 alphabetically ticked when there are more than 20. */
export function rowsFromProbe(tools: ExtensionTool[]): McpToolRow[] {
	const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name))
	return sorted.map((t, i) => ({ ...t, selected: i < MAX_EXTENSION_TOOLS }))
}

/** Saved tools shown again for editing: all of them ticked. */
export function rowsFromSaved(tools: ExtensionTool[]): McpToolRow[] {
	return tools.map((t) => ({ ...t, selected: true }))
}

const TOOL_NAME_RE = /^[A-Za-z0-9_.:-]{1,64}$/

/** Tool names typed by hand, one per line or comma separated. Kind defaults come from the name. */
export function rowsFromDeclared(text: string): { rows: McpToolRow[]; invalid: string[] } {
	const names = text
		.split(/[\n,]+/)
		.map((n) => n.trim())
		.filter(Boolean)
	const invalid = names.filter((n) => !TOOL_NAME_RE.test(n))
	const rows = [...new Set(names.filter((n) => TOOL_NAME_RE.test(n)))].map((name) => ({
		name,
		kind: classifyToolKind(name),
		selected: true,
	}))
	return { rows, invalid }
}

export function selectedTools(rows: McpToolRow[]): ExtensionTool[] {
	return rows
		.filter((r) => r.selected)
		.map(({ name, kind, description }) => ({ name, kind, ...(description ? { description } : {}) }))
}

export function capMessage(count: number): string | null {
	return count > MAX_EXTENSION_TOOLS
		? `This extension exposes ${count} tools. Cap is ${MAX_EXTENSION_TOOLS} to keep session context tight. Untick the tools you don't need.`
		: null
}

export function buildMcpConfig(args: {
	slug: string
	serverUrl: string
	auth: McpAuth
	tools: ExtensionTool[]
}): ExtensionMcpConfig {
	const server = mcpRemoteServer(args.serverUrl.trim(), args.auth === 'api-key')
	return {
		envKey: server.envFromCredential ?? '',
		server,
		autoInject: true,
		credentialProvider: `extension-mcp:${args.slug}`,
		tools: args.tools,
	}
}

/** Whether the extension has a working MCP half: a config, and a stored key when it needs one. */
export function mcpReady(ext: Pick<ExtensionResponse, 'mcpConfig' | 'hasMcpKey' | 'mcpLastError'>) {
	const cfg = ext.mcpConfig as ExtensionMcpConfig | null
	if (!cfg || ext.mcpLastError) return false
	const needsKey = cfg.server.type === 'stdio' && !!cfg.server.envFromCredential
	return !needsKey || ext.hasMcpKey
}

export function mcpToolCount(ext: Pick<ExtensionResponse, 'mcpConfig'>): number {
	return ((ext.mcpConfig as ExtensionMcpConfig | null)?.tools ?? []).length
}
