import { randomUUID } from 'node:crypto'
import type { CredentialReadContext } from './lookup'

/**
 * Read context for a caller that has no session header: a human REST call, or
 * an MCP route that is not the platform /mcp endpoint. The actor must be the
 * real authenticated caller. The session id stays null (never invented) and
 * every read gets its own request id for the audit row.
 */
export function readContextFor(
	requestingActorId: string,
	outboundTarget?: string,
): CredentialReadContext {
	return {
		requestingActorId,
		sessionId: null,
		requestId: randomUUID(),
		...(outboundTarget ? { outboundTarget } : {}),
	}
}
