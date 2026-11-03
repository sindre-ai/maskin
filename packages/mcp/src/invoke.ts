import {
	type McpConfig,
	type McpToolHandler,
	createMcpServer,
	getServerHandlers,
} from './server.js'

/**
 * Identity of the caller for a tool dispatch. `actorId` names the Maskin actor
 * (agent or human) invoking the tool; `workspaceId` scopes it. Both are
 * forwarded to the tool handler under the same `extra` bag the stdio transport
 * uses, so the handler cannot tell whether the call came from stdio, the HTTP
 * transport, or the voice tool-proxy.
 */
export interface InvokeContext {
	actorId: string
	workspaceId: string
}

/**
 * Thrown when `invokeTool` (or the factory returned by `createInvokeTool`) is
 * called with a name that isn't registered. Distinct class so callers — the
 * voice tool-proxy in Task 3, tests here — can catch this specifically and
 * map it to a stable error surface (e.g. "unknown_tool") without swallowing
 * every other throw.
 */
export class UnknownToolError extends Error {
	readonly toolName: string
	constructor(name: string) {
		super(`Unknown MCP tool: ${name}`)
		this.name = 'UnknownToolError'
		this.toolName = name
	}
}

/**
 * Callable shape for a single-tool dispatch. Same wrapped handler stdio and
 * HTTP transports get — telemetry, token-cap and mutation classification all
 * apply — just addressable by tool name instead of by an MCP request.
 */
export type InvokeTool = (name: string, args: unknown, ctx: InvokeContext) => Promise<unknown>

/**
 * Build an `invokeTool` bound to a given MCP config. Internally builds the
 * same server object stdio uses (via `createMcpServer`), then dispatches by
 * tool name against the wrapped handler map. Zero behaviour change for the
 * stdio path — it uses the same `createMcpServer` result.
 *
 * Meant to be built once per config (per voice session, or per process for
 * stdio) and reused; each call re-registers every tool with the SDK, which is
 * cheap but not free.
 */
export function createInvokeTool(config: McpConfig): InvokeTool {
	const server = createMcpServer(config)
	const handlers = getServerHandlers(server)

	return async function invoke(name, args, ctx) {
		const handler: McpToolHandler | undefined = handlers.get(name)
		if (!handler) throw new UnknownToolError(name)
		// The stdio transport passes an `extra` bag carrying the request
		// context; the wrapped handler in server.ts reads nothing from it
		// today (workspace id is threaded through `args`), but we forward
		// InvokeContext under the same shape so a handler that later reads
		// actor/workspace identity sees the same key on every transport.
		return handler(args, ctx)
	}
}

/**
 * Lazily-initialised, process-scoped invoker. Reads the same env vars as
 * the stdio CLI's `main()` in server.ts on first call (`API_BASE_URL`,
 * `API_KEY`, `WORKSPACE_ID` / `DEFAULT_WORKSPACE_ID`) so a single-process
 * consumer can call `invokeTool(name, args, ctx)` without threading a
 * config object through.
 *
 * Consumers that mint multiple configs at runtime (the voice tool-proxy
 * per session, tests exercising different credentials) should call
 * `createInvokeTool(config)` directly and hold onto the returned
 * function. This module-level helper exists so the stdio surface and the
 * "one process, one config" shape stay ergonomic.
 */
let _cachedInvoke: InvokeTool | null = null
export const invokeTool: InvokeTool = (name, args, ctx) => {
	if (!_cachedInvoke) {
		_cachedInvoke = createInvokeTool({
			apiBaseUrl: process.env.API_BASE_URL || 'http://localhost:3000',
			apiKey: process.env.API_KEY || '',
			defaultWorkspaceId: process.env.DEFAULT_WORKSPACE_ID || process.env.WORKSPACE_ID || '',
		})
	}
	return _cachedInvoke(name, args, ctx)
}

/**
 * Reset the cached invoker. Test-only: lets a suite re-parse env vars
 * between cases without spawning a fresh process. Never called at runtime.
 */
export function _resetInvokeToolForTests(): void {
	_cachedInvoke = null
}
