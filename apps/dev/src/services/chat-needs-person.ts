import type { Database, Transaction } from '@maskin/db'
import { conversationParticipants } from '@maskin/db/schema'
import { REQUEST_CARD_METADATA_KEYS } from '@maskin/shared'
import { and, eq, isNull } from 'drizzle-orm'

// What makes a chat message need a person: a question, a request card or a failed-turn notice.
// Kept apart from chat-attention.ts (which reads the list's data) so the message insert can use it
// without pulling the list code in.

export type TurnMetadata = {
	source?: string
	credit_balance_low?: boolean
	question?: unknown
	final_output?: {
		is_error?: boolean
		error_kind?: string
		error_detail?: string
		retry?: string
		pseudo_tool_calls?: unknown
		empty_completion?: unknown
	}
}

export const USAGE_LIMIT_TEXT =
	/hit your (?:session |weekly |Opus )?limit|usage limit|credit balance is too low/i

/**
 * The marker of an auto-posted end-of-turn message that is a failure notice, not a reply. The same
 * markers the chat's notifications read to tell the two apart (chat-notifications.ts).
 */
export function failureOf(metadata: unknown): NonNullable<TurnMetadata['final_output']> | null {
	const meta = (metadata ?? null) as TurnMetadata | null
	if (meta?.source !== 'final_output') return null
	const f = meta.final_output
	if (!f) return null
	return f.is_error || f.error_kind || f.retry || f.pseudo_tool_calls || f.empty_completion
		? f
		: null
}

/**
 * A message that puts the chat on the person's list the moment it lands: an agent question, a
 * request card, or the notice of a failed turn.
 */
export function messageNeedsPerson(metadata: unknown): boolean {
	const meta = (metadata ?? null) as Record<string, unknown> | null
	if (!meta) return false
	if (meta.question != null) return true
	if (REQUEST_CARD_METADATA_KEYS.some((key) => meta[key] != null)) return true
	return failureOf(meta) !== null
}

/**
 * A chat marked Done (archived) comes back for everyone who marked it when a message arrives that
 * needs them: left archived, the chat would wait on a person from a list they cannot see. Later
 * needs nothing here, since any new message already ends it. Only the Done flag is cleared.
 */
export async function reopenArchivedChat(db: Database | Transaction, conversationId: string) {
	await db
		.update(conversationParticipants)
		.set({ archived: false, updatedAt: new Date() })
		.where(
			and(
				eq(conversationParticipants.conversationId, conversationId),
				eq(conversationParticipants.archived, true),
				isNull(conversationParticipants.leftAt),
			),
		)
}
