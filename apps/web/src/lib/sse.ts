import { fetchEventSource } from '@microsoft/fetch-event-source'
import { getApiKey } from './auth'
import { API_BASE } from './constants'

export interface SSEEvent {
	id: string
	action: string
	workspace_id: string
	actor_id: string
	entity_type: string
	entity_id: string
	event_id: string
}

const LAST_EVENT_ID_KEY = 'ai-native-last-event-id'

function getLastEventId(workspaceId: string): string | undefined {
	return sessionStorage.getItem(`${LAST_EVENT_ID_KEY}-${workspaceId}`) ?? undefined
}

function setLastEventId(workspaceId: string, id: string) {
	sessionStorage.setItem(`${LAST_EVENT_ID_KEY}-${workspaceId}`, id)
}

export type SSEStatus = 'connecting' | 'connected' | 'disconnected'

export interface SSECallbacks {
	onEvent: (event: SSEEvent) => void
	onError?: (err: unknown) => void
	onStatusChange?: (status: SSEStatus) => void
}

export function connectSSE(workspaceId: string, callbacks: SSECallbacks): AbortController {
	const controller = new AbortController()
	const apiKey = getApiKey()
	const lastEventId = getLastEventId(workspaceId)

	fetchEventSource(`${API_BASE}/events`, {
		signal: controller.signal,
		headers: {
			Authorization: `Bearer ${apiKey}`,
			'X-Workspace-Id': workspaceId,
			...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}),
		},
		async onopen() {
			callbacks.onStatusChange?.('connected')
		},
		onmessage(msg) {
			if (!msg.data) return

			let parsed: SSEEvent
			try {
				parsed = JSON.parse(msg.data) as SSEEvent
			} catch {
				// Ignore malformed JSON from server
				return
			}

			parsed.id = msg.id
			parsed.action = msg.event || parsed.action

			if (msg.id) {
				setLastEventId(workspaceId, msg.id)
			}

			callbacks.onEvent(parsed)
		},
		onerror(err) {
			callbacks.onStatusChange?.('disconnected')
			callbacks.onError?.(err)
		},
		openWhenHidden: true,
	})

	return controller
}
