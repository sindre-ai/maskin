/**
 * chat-retry-notice.ts — §7.8 chat-resume interim message.
 *
 * When a chat session ends on a Claude usage limit and a retry is scheduled,
 * settleSession posts this note into the conversation right away, so the
 * person sees when the answer will come instead of a silent gap. It is a
 * 'system' message (a divider in the chat): it wakes no agent and is not
 * mirrored onto an object as a comment.
 */

import type { Database } from '@maskin/db'

import { CHAT_RESUME_INTERIM_MESSAGE_ENABLED } from '../config/chat-resume'
import { logger } from '../lib/logger'
import { insertConversationMessage } from './conversation-messages'

const DAY_MS = 24 * 60 * 60 * 1000

/** "17:30 UTC" within a day, "Oct 31, 14:00 UTC" further out. */
export function buildRetryNotice(retryAt: Date, now: Date = new Date()): string {
	const hhmm = retryAt.toISOString().slice(11, 16)
	const when =
		retryAt.getTime() - now.getTime() > DAY_MS
			? `${retryAt.toLocaleString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}, ${hhmm} UTC`
			: `${hhmm} UTC`
	return `Claude is at its usage limit. Your last message will be tried again at ${when}.`
}

/** Best-effort: a failed note must never fail the settle that called it. */
export async function postRetryNotice(
	db: Database,
	args: { conversationId: string; workspaceId: string; actorId: string; retryAt: Date },
): Promise<void> {
	if (!CHAT_RESUME_INTERIM_MESSAGE_ENABLED) return
	try {
		await insertConversationMessage(db, {
			conversationId: args.conversationId,
			workspaceId: args.workspaceId,
			actorId: args.actorId,
			content: buildRetryNotice(args.retryAt),
			metadata: null,
			sessionId: null,
			kind: 'system',
		})
	} catch (err) {
		logger.warn('Failed to post retry notice to chat', {
			conversationId: args.conversationId,
			error: String(err),
		})
	}
}
