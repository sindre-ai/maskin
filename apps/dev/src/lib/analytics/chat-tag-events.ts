import type { Database } from '@maskin/db'
import { actors } from '@maskin/db/schema'
import { inArray } from 'drizzle-orm'
import { logger } from '../logger'
import { capturePosthogEvent } from './posthog'

export const MESSAGE_SENT_TAGGED = 'message_sent_tagged'
export const MESSAGE_EDITED_WITH_TAGS = 'message_edited_with_tags'

// 'web' and 'ios' are the two composers the inline-tags outcome check tells apart; anything else
// (MCP, an agent, a missing header) is 'other' so it never pads either count.
export type ChatTagClient = 'web' | 'ios' | 'other'

/**
 * Maps the X-Client-Source header onto a closed label. The web UI sends 'ui', the iOS app 'ios'.
 * The header is self-reported, so the output is one of three fixed values and nothing the caller
 * typed reaches analytics.
 */
export function resolveChatTagClient(clientSource: string | undefined): ChatTagClient {
	const source = clientSource?.trim().toLowerCase()
	if (source === 'ui') return 'web'
	if (source === 'ios') return 'ios'
	return 'other'
}

/**
 * True when every tagged actor's "@name" appears in the message text. A message sent with the
 * old pill row carries the ids but not the names, so it reads false. Case-insensitive.
 */
export function tagsAreInText(content: string, taggedNames: readonly string[]): boolean {
	if (taggedNames.length === 0) return false
	const text = content.toLowerCase()
	return taggedNames.every((name) => text.includes(`@${name.toLowerCase()}`))
}

/**
 * Fires for each new chat message that carries at least one tagged id. Best-effort: a capture
 * failure, or a failed name lookup, never blocks the send.
 */
export async function trackMessageSentTagged(
	db: Database,
	p: {
		workspaceId: string
		actorId: string
		conversationId: string
		client: ChatTagClient
		content: string
		taggedIds: readonly string[]
	},
): Promise<void> {
	try {
		const rows = await db
			.select({ name: actors.name })
			.from(actors)
			.where(inArray(actors.id, [...p.taggedIds]))
		await capturePosthogEvent(MESSAGE_SENT_TAGGED, p.actorId, {
			workspace_id: p.workspaceId,
			conversation_id: p.conversationId,
			tag_in_text: tagsAreInText(
				p.content,
				rows.map((r) => r.name),
			),
			client: p.client,
		})
	} catch (err) {
		logger.warn('Failed to emit message_sent_tagged', { error: String(err) })
	}
}

/**
 * Fires when a saved edit adds at least one tagged id. `addedCount` is the number of ids that
 * were not on the message before. Best-effort, like the send event.
 */
export async function trackMessageEditedWithTags(p: {
	workspaceId: string
	actorId: string
	conversationId: string
	client: ChatTagClient
	addedCount: number
}): Promise<void> {
	try {
		await capturePosthogEvent(MESSAGE_EDITED_WITH_TAGS, p.actorId, {
			workspace_id: p.workspaceId,
			conversation_id: p.conversationId,
			added_count: p.addedCount,
			client: p.client,
		})
	} catch (err) {
		logger.warn('Failed to emit message_edited_with_tags', { error: String(err) })
	}
}
