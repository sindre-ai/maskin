import type { Database } from '@maskin/db'
import { conversationParticipants, conversations } from '@maskin/db/schema'
import { recordEvent } from '../lib/events/record-event'
import { logger } from '../lib/logger'
import { resolveAgentIdByName } from '../lib/onboarding/signup-welcome'
import { insertConversationMessage } from './conversation-messages'
import { evaluateAndRespond } from './conversation-responder'
import type { SessionManager } from './session-manager'

const CHIEF_OF_STAFF_NAME = 'Chief of Staff'

/**
 * What the installer "asks" the Chief of Staff. It is a nudge the chat does not
 * draw (`hidden_from_chat`), so the person reads the Chief of Staff's suggestions
 * as the first thing in the chat rather than a message they never typed.
 *
 * Suggest-only is the point: the first reply must not change anything. The person
 * decides which suggestions to act on.
 */
export function buildLoopPersonalizationPrompt(loop: {
	name: string
	description?: string | null
}): string {
	const about = loop.description ? ` (${loop.description})` : ''
	return [
		`I just installed the "${loop.name}" loop${about} from the marketplace.`,
		'',
		'Do you have recommendations for tailoring it to my workspace? Look at what it set up (its agents, skills and triggers) against what you know about me and this workspace: my knowledge, my integrations, my existing agents and loops.',
		'',
		'Reply with suggestions only. Do not change anything yet — no edits to agents, skills, triggers or settings. I will tell you which suggestions to go ahead with.',
	].join('\n')
}

export interface StartLoopPersonalizationChatInput {
	db: Database
	sessionManager: SessionManager
	workspaceId: string
	/** The human who installed the loop. */
	installerId: string
	installedLoopId: string
	loop: { name: string; description?: string | null }
}

/**
 * Opens a chat between the installer and the Chief of Staff, about the loop that was
 * just installed, and wakes the Chief of Staff to suggest how to personalize it.
 *
 * Best effort: the install has already committed, so a missing Chief of Staff or a
 * failure here is logged and never surfaces to the installer.
 */
export async function startLoopPersonalizationChat(
	input: StartLoopPersonalizationChatInput,
): Promise<{ conversationId: string } | null> {
	const { db, sessionManager, workspaceId, installerId, installedLoopId, loop } = input

	const chiefOfStaffId = await resolveAgentIdByName(db, workspaceId, CHIEF_OF_STAFF_NAME)
	if (!chiefOfStaffId || chiefOfStaffId === installerId) {
		logger.info('Skipping loop personalization chat — no Chief of Staff to ask', {
			workspaceId,
			installedLoopId,
		})
		return null
	}

	const [conversation] = await db
		.insert(conversations)
		.values({
			workspaceId,
			title: `Personalize ${loop.name}`,
			createdBy: installerId,
			subjectType: 'loop',
			subjectId: installedLoopId,
		})
		.returning()
	if (!conversation) throw new Error('Failed to create personalization chat')

	await db.insert(conversationParticipants).values(
		[installerId, chiefOfStaffId].map((actorId) => ({
			conversationId: conversation.id,
			actorId,
			addedBy: installerId,
		})),
	)
	await recordEvent(db, {
		workspaceId,
		actorId: installerId,
		action: 'conversation_created',
		entityType: 'conversation',
		entityId: conversation.id,
		data: {
			participant_actor_ids: [installerId, chiefOfStaffId],
			subject: { type: 'loop', id: installedLoopId },
		},
	})

	const message = await insertConversationMessage(db, {
		conversationId: conversation.id,
		workspaceId,
		actorId: installerId,
		content: buildLoopPersonalizationPrompt(loop),
		metadata: { mentions: [chiefOfStaffId], hidden_from_chat: true },
		sessionId: null,
	})
	if (!message) throw new Error('Failed to post personalization prompt')

	await evaluateAndRespond({
		db,
		sessionManager,
		workspaceId,
		conversationId: conversation.id,
		messageId: message.id,
	})

	return { conversationId: conversation.id }
}
