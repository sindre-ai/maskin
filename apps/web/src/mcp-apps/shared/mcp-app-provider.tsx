import { type App, useApp } from '@modelcontextprotocol/ext-apps/react'
import { type ReactNode, createContext, useCallback, useContext, useRef, useState } from 'react'

interface ToolResult {
	content?: Array<{ type: string; text?: string; [key: string]: unknown }>
	[key: string]: unknown
}

interface ToolResultPayload {
	toolName: string
	result: ToolResult
	input: Record<string, unknown> | null
	/** Public Maskin web app base URL (no trailing slash). Set when the server
	 * passes `_meta.webAppBaseUrl`; absent in unit tests / when the env var
	 * isn't configured. Used by `web-app-link` to build deep links. */
	webAppBaseUrl: string | null
	/** Workspace the tool ran against. Used by `web-app-link` to scope URLs. */
	workspaceId: string | null
}

interface McpAppContextValue {
	isConnected: boolean
	toolResult: ToolResultPayload | null
	callTool: (name: string, args: Record<string, unknown>) => Promise<ToolResult>
}

const McpAppContext = createContext<McpAppContextValue | null>(null)

function pickString(meta: Record<string, unknown> | undefined, key: string): string | null {
	const v = meta?.[key]
	return typeof v === 'string' && v.length > 0 ? v : null
}

export function McpAppProvider({
	name,
	version = '1.0.0',
	children,
}: {
	name: string
	version?: string
	children: ReactNode
}) {
	const [toolResult, setToolResult] = useState<ToolResultPayload | null>(null)
	const toolInputRef = useRef<Record<string, unknown> | null>(null)

	const { app, isConnected } = useApp({
		appInfo: { name, version },
		capabilities: {},
		onAppCreated: (createdApp: App) => {
			createdApp.ontoolinput = (params: { arguments?: Record<string, unknown> }) => {
				toolInputRef.current = params.arguments ?? null
			}
			createdApp.ontoolresult = (result: unknown) => {
				const r = result as Record<string, unknown>
				const meta = r._meta as Record<string, unknown> | undefined
				const toolName = (meta?.toolName as string) ?? 'unknown'
				setToolResult({
					toolName,
					result: r as ToolResult,
					input: toolInputRef.current,
					webAppBaseUrl: pickString(meta, 'webAppBaseUrl'),
					workspaceId: pickString(meta, 'workspaceId'),
				})
			}
		},
	})

	const callTool = useCallback(
		async (name: string, args: Record<string, unknown>): Promise<ToolResult> => {
			if (!app) throw new Error('App not connected')
			const result = await app.callServerTool({ name, arguments: args })
			return result as unknown as ToolResult
		},
		[app],
	)

	return (
		<McpAppContext.Provider value={{ isConnected, toolResult, callTool }}>
			{children}
		</McpAppContext.Provider>
	)
}

export function useMcpApp() {
	const ctx = useContext(McpAppContext)
	if (!ctx) throw new Error('useMcpApp must be used within McpAppProvider')
	return ctx
}

export function useToolResult() {
	const { toolResult } = useMcpApp()
	return toolResult
}

export function useCallTool() {
	const { callTool } = useMcpApp()
	return callTool
}

/**
 * Returns the workspace context the current MCP card is rendering in. `null`
 * when neither the server-supplied `_meta.webAppBaseUrl` nor `_meta.workspaceId`
 * is available — caller should hide the deep-link affordance in that case.
 */
export function useWebAppContext(): { baseUrl: string; workspaceId: string } | null {
	const tr = useToolResult()
	if (!tr?.webAppBaseUrl || !tr.workspaceId) return null
	return { baseUrl: tr.webAppBaseUrl, workspaceId: tr.workspaceId }
}
