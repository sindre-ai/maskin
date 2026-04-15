import { type App, useApp } from '@modelcontextprotocol/ext-apps/react'
import { type ReactNode, createContext, useCallback, useContext, useRef, useState } from 'react'

interface ToolResult {
	structuredContent?: Record<string, unknown>
	content?: Array<{ type: string; text?: string; [key: string]: unknown }>
	[key: string]: unknown
}

/**
 * Extract data from a tool result, preferring structuredContent (MCP 2025-11-25 spec).
 * Falls back to parsing JSON from text content blocks.
 */
export function parseToolData(result: ToolResult): unknown {
	// Prefer structuredContent
	if (result.structuredContent != null) return result.structuredContent
	// Fall back to parsing JSON text — try last text block first (raw JSON), then earlier ones
	const texts = (result.content ?? [])
		.filter((c) => c.type === 'text' && c.text)
		.map((c) => c.text as string)
	for (let i = texts.length - 1; i >= 0; i--) {
		try {
			return JSON.parse(texts[i])
		} catch {
			// not JSON, try next
		}
	}
	return null
}

interface ToolResultPayload {
	toolName: string
	result: ToolResult
	input: Record<string, unknown> | null
}

interface McpAppContextValue {
	isConnected: boolean
	toolResult: ToolResultPayload | null
	callTool: (name: string, args: Record<string, unknown>) => Promise<ToolResult>
}

const McpAppContext = createContext<McpAppContextValue | null>(null)

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
				setToolResult({ toolName, result: r as ToolResult, input: toolInputRef.current })
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
