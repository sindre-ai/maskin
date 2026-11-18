import type { Database } from '@maskin/db'
import { conversationParticipants, conversations } from '@maskin/db/schema'
import { SIGNUP_ONBOARDING_DELIVERY_KIND } from '../lib/analytics/onboarding-events'
import { recordEvent } from '../lib/events/record-event'
import { logger } from '../lib/logger'
import { resolveAgentIdByName } from '../lib/onboarding/signup-welcome'
import { insertConversationMessage } from './conversation-messages'

const CHIEF_OF_STAFF_NAME = 'Chief of Staff'

/**
 * The Chief of Staff's first message, as the new person reads it at the top of the chat. It is
 * message 1 of the approved first-chat script: plain words, the job described by its result,
 * and one question to answer. No tech words (the bakery-owner test).
 */
export function buildSignupWelcomeMessage(displayName: string, organization?: string): string {
	const aboutYou = organization ? `you and ${organization}` : 'you and your business'
	return [
		`Hi ${displayName}, welcome. I'm your Chief of Staff. My job is making sure nothing in your business slips through the cracks.`,
		"Here's how it works. You tell me the jobs you're tired of doing yourself, like chasing late invoices or answering the same customer questions. I set up a digital employee for each one. It does the job every day, and I show you the numbers you care about, like how many invoices got paid this week.",
		`I'm reading up on ${aboutYou} right now, so I don't ask what I can find out myself.`,
		'To start: which 1 to 3 jobs would you most like taken off your hands?',
	].join('\n\n')
}

/**
 * What the Chief of Staff is told about this chat. It is not drawn
 * (`hidden_from_chat`) but it is part of the history the agent reads when the
 * person replies, so the reply is answered as onboarding rather than as a chat
 * that came from nowhere.
 */
export function buildSignupOnboardingContext(ctx: {
	name?: string
	organization?: string
	role?: string
	knowledgeObjectId: string
}): string {
	const facts = [
		`name: ${ctx.name || 'unknown'}`,
		`organization: ${ctx.organization || 'unknown'}`,
		`role: ${ctx.role || 'unknown'}`,
	].join(', ')
	return [
		'This is the onboarding chat. I just signed up and this is my first conversation in Maskin; you opened it with the welcome message below, and it ends with a question for me.',
		'',
		`What I gave at sign-up — ${facts}.`,
		`Researcher is putting together a first look at me and my organization. It is filed on my signup-context knowledge object (id: ${ctx.knowledgeObjectId}), and anything I tell you here that looks like context about me or my organization should be folded into that same object.`,
		'',
		'When I reply, follow the first-chat script: answer what I ask, ask one question at a time, and describe everything by the result it gives me. Never use technical words. If I pick a ready-made routine, give me an install link; do not offer to install it from the chat. Suggest before you change anything.',
	].join('\n')
}

export interface StartSignupWelcomeChatInput {
	db: Database
	workspaceId: string
	/** The human who just signed up. */
	humanActorId: string
	knowledgeObjectId: string
	metadata: { name?: string; organization?: string; role?: string }
}

/**
 * Opens the new person's first chat: just them and the Chief of Staff, with the
 * welcome already in it as the Chief of Staff's own message.
 *
 * Nothing wakes an agent here — the Chief of Staff has already spoken, and the
 * next turn is the person's. The chat has two people in it, so each reply they send
 * wakes the Chief of Staff and is answered in this same chat (the direct-chat path
 * in conversation-responder.ts). The welcome carries no `mentions` and no session, so
 * it raises no notification and no For You card.
 *
 * Best effort: the sign-up has already committed, so a missing Chief of Staff or a
 * failure here is logged and returns null, and the caller falls back to New Chat.
 */
export async function startSignupWelcomeChat(
	input: StartSignupWelcomeChatInput,
): Promise<{ conversationId: string } | null> {
	const { db, workspaceId, humanActorId, knowledgeObjectId, metadata } = input

	const chiefOfStaffId = await resolveAgentIdByName(db, workspaceId, CHIEF_OF_STAFF_NAME)
	if (!chiefOfStaffId || chiefOfStaffId === humanActorId) {
		logger.info('Skipping signup welcome chat — no Chief of Staff to open it', {
			workspaceId,
			knowledgeObjectId,
		})
		return null
	}

	const name = metadata.name?.trim()
	const [conversation] = await db
		.insert(conversations)
		.values({ workspaceId, title: 'Welcome to Maskin', createdBy: humanActorId })
		.returning()
	if (!conversation) throw new Error('Failed to create signup welcome chat')

	await db.insert(conversationParticipants).values(
		[humanActorId, chiefOfStaffId].map((actorId) => ({
			conversationId: conversation.id,
			actorId,
			addedBy: humanActorId,
		})),
	)
	await recordEvent(db, {
		workspaceId,
		actorId: humanActorId,
		action: 'conversation_created',
		entityType: 'conversation',
		entityId: conversation.id,
		data: { participant_actor_ids: [humanActorId, chiefOfStaffId] },
	})

	// Context first, welcome second: history is read oldest-first, so the agent
	// sees why the chat exists before it sees what it said.
	const context = await insertConversationMessage(db, {
		conversationId: conversation.id,
		workspaceId,
		actorId: humanActorId,
		content: buildSignupOnboardingContext({
			name,
			organization: metadata.organization?.trim(),
			role: metadata.role?.trim(),
			knowledgeObjectId,
		}),
		metadata: {
			hidden_from_chat: true,
			delivery: {
				kind: SIGNUP_ONBOARDING_DELIVERY_KIND,
				object_id: knowledgeObjectId,
			},
		},
		sessionId: null,
	})
	if (!context) throw new Error('Failed to post signup onboarding context')

	const welcome = await insertConversationMessage(db, {
		conversationId: conversation.id,
		workspaceId,
		actorId: chiefOfStaffId,
		content: buildSignupWelcomeMessage(name || 'there', metadata.organization?.trim()),
		metadata: null,
		sessionId: null,
	})
	if (!welcome) throw new Error('Failed to post signup welcome message')

	return { conversationId: conversation.id }
}
