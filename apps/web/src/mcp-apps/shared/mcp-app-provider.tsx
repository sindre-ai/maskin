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

export interface HistoryEntry {
	id: number
	toolName: string
	input: Record<string, unknown> | null
	resultCount: number
	timestamp: number
}

export interface McpAppContextValue {
	isConnected: boolean
	toolResult: ToolResultPayload | null
	toolHistory: HistoryEntry[]
	callTool: (name: string, args: Record<string, unknown>) => Promise<ToolResult>
}

export const McpAppContext = createContext<McpAppContextValue | null>(null)

function pickString(meta: Record<string, unknown> | undefined, key: string): string | null {
	const v = meta?.[key]
	return typeof v === 'string' && v.length > 0 ? v : null
}

function countResultItems(result: ToolResult): number {
	if ((result as Record<string, unknown>).isError === true) return 0
	const content = result.content
	if (!Array.isArray(content)) return 0
	for (const item of content) {
		if (item.type === 'text' && typeof item.text === 'string') {
			try {
				const parsed: unknown = JSON.parse(item.text)
				if (Array.isArray(parsed)) return parsed.length
				if (parsed !== null && typeof parsed === 'object') return 1
			} catch {
				// not JSON — skip and continue scanning
			}
		}
	}
	return 0
}

const MAX_HISTORY = 20

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
	const [toolHistory, setToolHistory] = useState<HistoryEntry[]>([])
	const callCounterRef = useRef(0)
	const pendingInputsRef = useRef<Map<number, Record<string, unknown> | null>>(new Map())
	const entryIdRef = useRef(0)

	const { app, isConnected } = useApp({
		appInfo: { name, version },
		capabilities: {},
		onAppCreated: (createdApp: App) => {
			createdApp.ontoolinput = (params: { arguments?: Record<string, unknown> }) => {
				const id = ++callCounterRef.current
				pendingInputsRef.current.set(id, params.arguments ?? null)
			}
			createdApp.ontoolresult = (result: unknown) => {
				const inputKeys = [...pendingInputsRef.current.keys()].sort((a, b) => b - a)
				const latestKey = inputKeys[0]
				const input = latestKey != null ? (pendingInputsRef.current.get(latestKey) ?? null) : null
				for (const k of inputKeys) pendingInputsRef.current.delete(k)

				const r = result as Record<string, unknown>
				const meta = r._meta as Record<string, unknown> | undefined
				const toolName = (meta?.toolName as string) ?? 'unknown'
				const toolResultPayload: ToolResultPayload = {
					toolName,
					result: r as ToolResult,
					input,
					webAppBaseUrl: pickString(meta, 'webAppBaseUrl'),
					workspaceId: pickString(meta, 'workspaceId'),
				}
				setToolResult(toolResultPayload)

				const resultCount = countResultItems(r as ToolResult)
				const entry: HistoryEntry = {
					id: ++entryIdRef.current,
					toolName,
					input,
					resultCount,
					timestamp: Date.now(),
				}
				setToolHistory((prev) => [...prev, entry].slice(-MAX_HISTORY))
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
		<McpAppContext.Provider value={{ isConnected, toolResult, toolHistory, callTool }}>
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

export function useToolHistory() {
	const { toolHistory } = useMcpApp()
	return toolHistory
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
