import type { Database } from '@maskin/db'
import type { CallClientState } from './client'

export interface ToolInvocationContext {
	db: Database
	callId: string
	toolName: string
	toolInput: Record<string, unknown>
	/** The contact and workspace the call belongs to: from client_state, or from the call id on the plain-POST path. */
	clientState: Pick<CallClientState, 'contact_id' | 'workspace_id'>
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
