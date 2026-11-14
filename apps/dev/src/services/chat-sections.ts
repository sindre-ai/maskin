import type { Database } from '@maskin/db'
import {
	chatSectionItems,
	chatSections,
	conversationParticipants,
	conversations,
} from '@maskin/db/schema'
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm'

/**
 * A person's own sections, read and written only for that person. Every function takes the caller
 * and filters on it; none takes an owner from a request. See the chat_sections table in the schema.
 */

export type SectionView = {
	id: string
	name: string
	position: number
	collapsed: boolean
	/** Chats in the section the person can still see in the list, newest message first. */
	conversationIds: string[]
}

/**
 * The caller's sections in this workspace, in order, each with its chats. A chat only counts when
 * the caller is still in it and has not archived it, so a chat they lost access to drops out
 * without an error. Its row stays, and the chat comes back if they are added again.
 */
export async function loadSections(
	db: Database,
	workspaceId: string,
	callerId: string,
): Promise<SectionView[]> {
	const sections = await db
		.select()
		.from(chatSections)
		.where(and(eq(chatSections.workspaceId, workspaceId), eq(chatSections.actorId, callerId)))
		.orderBy(asc(chatSections.position), asc(chatSections.createdAt), asc(chatSections.id))
	if (sections.length === 0) return []

	const items = await db
		.select({
			sectionId: chatSectionItems.sectionId,
			conversationId: chatSectionItems.conversationId,
		})
		.from(chatSectionItems)
		.innerJoin(conversations, eq(conversations.id, chatSectionItems.conversationId))
		.innerJoin(
			conversationParticipants,
			and(
				eq(conversationParticipants.conversationId, conversations.id),
				eq(conversationParticipants.actorId, callerId),
			),
		)
		.where(
			and(
				eq(chatSectionItems.actorId, callerId),
				inArray(
					chatSectionItems.sectionId,
					sections.map((s) => s.id),
				),
				eq(conversations.workspaceId, workspaceId),
				isNull(conversationParticipants.leftAt),
				eq(conversationParticipants.archived, false),
			),
		)
		.orderBy(desc(conversations.lastMessageAt), desc(conversations.id))

	const bySection = new Map<string, string[]>()
	for (const item of items) {
		const list = bySection.get(item.sectionId) ?? []
		list.push(item.conversationId)
		bySection.set(item.sectionId, list)
	}
	return sections.map((s) => ({
		id: s.id,
		name: s.name,
		position: s.position,
		collapsed: s.collapsed,
		conversationIds: bySection.get(s.id) ?? [],
	}))
}

/** One of the caller's sections, or null when it does not exist or is somebody else's. */
export async function loadSection(
	db: Database,
	workspaceId: string,
	callerId: string,
	sectionId: string,
): Promise<SectionView | null> {
	const sections = await loadSections(db, workspaceId, callerId)
	return sections.find((s) => s.id === sectionId) ?? null
}

/** For each chat the caller put in a section, which one. Chats in none are left out of the map. */
export async function loadSectionIdsByConversation(
	db: Database,
	callerId: string,
	conversationIds: string[],
): Promise<Map<string, string>> {
	if (conversationIds.length === 0) return new Map()
	const rows = await db
		.select({
			conversationId: chatSectionItems.conversationId,
			sectionId: chatSectionItems.sectionId,
		})
		.from(chatSectionItems)
		.where(
			and(
				eq(chatSectionItems.actorId, callerId),
				inArray(chatSectionItems.conversationId, conversationIds),
			),
		)
	return new Map(rows.map((r) => [r.conversationId, r.sectionId]))
}
