import { createManagedSSE } from './lib/managed-sse.js'
import { parseLogFrame } from './session-log-subscriptions.js'

interface WaitConfig {
	apiBaseUrl: string
	apiKey: string
}

export type WaitOutcome =
	| { reason: 'done'; status: string }
	| { reason: 'timeout' }
	| { reason: 'stream_end'; status?: string }
	| { reason: 'auth_error' }
	| { reason: 'terminal_status' }

// Opens an SSE connection to /api/sessions/:id/logs/stream and resolves when
// the backend sends a terminal `done` frame (or when the overall timeout
// elapses). Reuses the managed-sse client so we inherit reconnect,
// Last-Event-ID resumption, and abort cleanup.
export function waitForSessionTerminal(
	config: WaitConfig,
	workspaceId: string,
	sessionId: string,
	timeoutMs: number,
): Promise<WaitOutcome> {
	return new Promise((resolve) => {
		let settled = false
		let timer: ReturnType<typeof setTimeout> | null = null

		const stream = createManagedSSE({
			url: `${config.apiBaseUrl}/api/sessions/${sessionId}/logs/stream`,
			headers: () => ({
				Authorization: `Bearer ${config.apiKey}`,
				'X-Workspace-Id': workspaceId,
				Accept: 'text/event-stream',
			}),
			parseFrame: parseLogFrame,
			onItem: async (item) => {
				if (item.kind !== 'done' || settled) return
				settled = true
				if (timer) clearTimeout(timer)
				resolve({ reason: 'done', status: item.status })
				void stream.stop()
			},
			onWarn: async () => {},
			onTerminal: (reason) => {
				if (settled) return
				settled = true
				if (timer) clearTimeout(timer)
				resolve({ reason })
			},
			replayCap: 500,
			logTag: `wait session ${sessionId}`,
		})

		stream.addRef('wait')

		timer = setTimeout(() => {
			if (settled) return
			settled = true
			void stream.stop()
			resolve({ reason: 'timeout' })
		}, timeoutMs)
	})
}
