import type { CallClientState } from './client'

export interface ToolInvocationContext {
	callId: string
	toolName: string
	toolInput: Record<string, unknown>
	/** contact_id / workspace_id / dial_attempt_n stamped on the call. */
	clientState: CallClientState
}

/** Returns the JSON object Telnyx feeds back to the assistant in the 200 body. */
export type ToolHandler = (ctx: ToolInvocationContext) => Promise<unknown>

let handler: ToolHandler | null = null

/**
 * Seam for the tool router (providers/telnyx/tools.ts, separate task). The
 * webhook route calls dispatchToolInvocation for every assistant.tool_invocation;
 * until a router registers itself the answer is an unhandled acknowledgement.
 */
export function registerToolHandler(next: ToolHandler | null): void {
	handler = next
}

export async function dispatchToolInvocation(ctx: ToolInvocationContext): Promise<unknown> {
	if (!handler) return { ok: true, handled: false }
	return handler(ctx)
}
