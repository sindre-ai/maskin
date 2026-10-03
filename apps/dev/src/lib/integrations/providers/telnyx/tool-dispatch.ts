import type { Database } from '@maskin/db'
import type { CallClientState } from './client'

export interface ToolInvocationContext {
	db: Database
	callId: string
	toolName: string
	toolInput: Record<string, unknown>
	/** contact_id / workspace_id / dial_attempt_n stamped on the call. */
	clientState: CallClientState
	/** Call endpoints as Telnyx reports them on the invocation (outbound call: from is our number, to the prospect). */
	from?: string
	to?: string
}

/** Returns the JSON object Telnyx feeds back to the assistant in the 200 body. */
export type ToolHandler = (ctx: ToolInvocationContext) => Promise<unknown>

let handler: ToolHandler | null = null

/**
 * Seam for the tool router (providers/telnyx/tools.ts). The
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
