import type { Database } from '@maskin/db'
import type { Context, Hono } from 'hono'
import { isLinkedInIntegrationError } from '../lib/integrations/providers/linkedin-unipile/errors'
import {
	replyToLinkedInThread,
	sendLinkedInMessage,
} from '../lib/integrations/providers/linkedin-unipile/operations'

/**
 * Test-only. The HTTP routes that sent a LinkedIn message or reply with the caller's own text
 * are gone: a send is held for a person's approval, and only the MCP tools carry that out. The
 * operations underneath (error classes, retries, the idempotency ledger, response shapes) still
 * need their tests, so these suites call them directly and get the response the old route gave.
 */

/** The response the old route returned: the result as JSON, or the error class with its status. */
export async function operationResponse(run: () => Promise<unknown>): Promise<Response> {
	try {
		return Response.json(await run())
	} catch (err) {
		if (!isLinkedInIntegrationError(err)) throw err
		return Response.json(
			{ error: { code: err.code, message: err.message } },
			{ status: err.httpStatus },
		)
	}
}

/** Serves send-message and reply under `prefix` by calling the operations directly. Never mount this in the app. */
export function mountLinkedInOperationRoutes(app: Hono, prefix: string): void {
	const serve =
		(op: typeof sendLinkedInMessage | typeof replyToLinkedInThread) => async (c: Context) => {
			const workspaceId = c.req.header('x-workspace-id') ?? ''
			const body = await c.req.json()
			return operationResponse(() =>
				op(
					{
						db: c.get('db' as never) as Database,
						actorId: c.get('actorId' as never) as string,
						workspaceId,
					},
					body,
				),
			)
		}
	app.post(`${prefix}/send-message`, serve(sendLinkedInMessage))
	app.post(`${prefix}/reply`, serve(replyToLinkedInThread))
}
