import type { Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { PgEvent, PgNotifyBridge } from './notify'

export function createSSEHandler(bridge: PgNotifyBridge) {
	return (c: Context) => {
		const workspaceId = c.req.query('workspace_id')

		return streamSSE(c, async (stream) => {
			const handler = (event: PgEvent) => {
				if (workspaceId && event.workspace_id !== workspaceId) return

				stream.writeSSE({
					id: event.event_id,
					event: event.action,
					data: JSON.stringify(event),
				})
			}

			bridge.on('event', handler)

			stream.onAbort(() => {
				bridge.off('event', handler)
			})

			// Keep connection alive
			while (true) {
				await stream.sleep(30000)
			}
		})
	}
}
