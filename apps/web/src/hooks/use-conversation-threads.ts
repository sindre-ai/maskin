import { flattenMessagesOldestFirst, useConversationMessages } from '@/hooks/use-conversation'
import type { SpawnedSession } from '@/lib/api'
import { useMemo } from 'react'

export interface ConversationThread extends SpawnedSession {
	/** The assistant message whose handoff spawned this session; null until one carries it. */
	messageId: number | null
	/** Every session of the thread, the first first: follow-ups the person started carry on in it. */
	sessionIds: string[]
	/** What the person wrote to start each follow-up, in order. */
	followUps: { id: string; actionPrompt: string; createdAt: string | null }[]
	/** The newest session: the one a message goes into, and whose state the thread shows. */
	latestId: string
}

/**
 * Every sub-session handed off from a chat, newest state wins, oldest first.
 * Derived from the `spawned_sessions` embed on the already-loaded messages, so
 * it adds no request and stays live with the transcript (the SSE
 * `session.state_changed` frame patches that same cache).
 */
export function useConversationThreads(workspaceId: string, conversationId: string) {
	const { data } = useConversationMessages(conversationId, workspaceId)
	return useMemo(() => {
		const byId = new Map<string, ConversationThread>()
		for (const message of flattenMessagesOldestFirst(data)) {
			for (const session of message.spawned_sessions ?? []) {
				byId.set(session.id, {
					...session,
					messageId: message.id,
					sessionIds: [session.id],
					followUps: [],
					latestId: session.id,
				})
			}
		}
		// Handoffs no message carries yet (the agent started them and has not
		// narrated them). Only the newest page carries them, and `pages[0]` is it.
		for (const session of data?.pages[0]?.pending_handoffs ?? []) {
			if (!byId.has(session.id))
				byId.set(session.id, {
					...session,
					messageId: null,
					sessionIds: [session.id],
					followUps: [],
					latestId: session.id,
				})
		}
		// A follow-up the person wrote to a helper that had ended carries on in that helper's
		// thread: it is folded into the first session, which then shows the newest state.
		const original = new Map(byId)
		const rootOf = (t: ConversationThread): ConversationThread => {
			const from = t.continues_session_id ? original.get(t.continues_session_id) : undefined
			return from ? rootOf(from) : t
		}
		const followUps = Array.from(byId.values()).filter(
			(t) => t.continues_session_id && original.has(t.continues_session_id),
		)
		for (const f of followUps.sort((a, b) =>
			(a.createdAt ?? '').localeCompare(b.createdAt ?? ''),
		)) {
			const root = byId.get(rootOf(f).id) ?? rootOf(f)
			byId.delete(f.id)
			byId.set(root.id, {
				...root,
				status: f.status,
				result: f.result,
				completedAt: f.completedAt,
				durationMs: f.durationMs,
				currentActivity: f.currentActivity,
				awaiting: f.awaiting,
				sessionIds: [...root.sessionIds, f.id],
				followUps: [
					...root.followUps,
					{ id: f.id, actionPrompt: f.actionPrompt, createdAt: f.createdAt },
				],
				latestId: f.id,
			})
		}
		return Array.from(byId.values())
	}, [data])
}
