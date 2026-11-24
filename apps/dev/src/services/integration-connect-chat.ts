import type { Database } from '@maskin/db'
import { actors, conversationParticipants, conversations } from '@maskin/db/schema'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { recordEvent } from '../lib/events/record-event'
import { FLAGS, isFlagEnabled } from '../lib/feature-flags'
import { getProvider } from '../lib/integrations/registry'
import { logger } from '../lib/logger'
import { shouldSkipOnboardingKickoff } from '../lib/onboarding/chief-of-staff-kickoff'
import { resolveAgentIdByName } from '../lib/onboarding/signup-welcome'
import { insertConversationMessage } from './conversation-messages'
import { evaluateAndRespond } from './conversation-responder'
import type { SessionManager } from './session-manager'

const CHIEF_OF_STAFF_NAME = 'Chief of Staff'
const CHECKLIST_SKILL = 'integration-connect-checklist'

export type IntegrationConnectType = 'new' | 'reconnect'

/**
 * The first message of the chat. Names the provider, the integration id and the connect type, and
 * points at the skill instead of repeating its steps, so the skill stays the one place that says what
 * to do after a connect. Ids and names only: never a token, key or password.
 */
export function buildIntegrationConnectPrompt(p: {
	label: string
	provider: string
	integrationId: string
	connectType: IntegrationConnectType
}): string {
	return [
		`I just connected ${p.label} (provider ${p.provider}, integration id ${p.integrationId}, connect type ${p.connectType}).`,
		'',
		`Run your ${CHECKLIST_SKILL} skill for this integration now.`,
	].join('\n')
}

export interface StartIntegrationConnectChatInput {
	db: Database
	sessionManager: SessionManager
	workspaceId: string
	/** The person who connected it. */
	actorId: string
	integrationId: string
	provider: string
	/** What the person sees the integration called. Falls back to the provider's display name. */
	label?: string
	connectType?: IntegrationConnectType
}

function labelFor(provider: string, label?: string): string {
	if (label?.trim()) return label.trim()
	try {
		return getProvider(provider).config.displayName ?? provider
	} catch {
		return provider
	}
}

/**
 * After an integration connects, opens a chat between the person who connected it and the Chief of
 * Staff and wakes the Chief of Staff to work the connect checklist. If that person already has an
 * open chat about the same integration with the Chief of Staff, the message goes into it instead.
 *
 * Best effort and never throws: the connect has already committed, so a missing Chief of Staff or any
 * failure here is logged and nothing reaches the caller. Safe to call as `void startIntegrationConnectChat(...)`.
 * Off unless the integration-connect-chat flag is on for the person, and in E2E stacks (no LLM credentials).
 */
export async function startIntegrationConnectChat(
	input: StartIntegrationConnectChatInput,
): Promise<{ conversationId: string } | null> {
	const { db, sessionManager, workspaceId, actorId, integrationId, provider } = input
	try {
		if (!isFlagEnabled(actorId, FLAGS.INTEGRATION_CONNECT_CHAT)) return null
		if (shouldSkipOnboardingKickoff()) return null

		const [person] = await db
			.select({ type: actors.type })
			.from(actors)
			.where(eq(actors.id, actorId))
			.limit(1)
		// An agent that connects something has no chat to open with itself.
		if (person?.type !== 'human') return null

		const chiefOfStaffId = await resolveAgentIdByName(db, workspaceId, CHIEF_OF_STAFF_NAME)
		if (!chiefOfStaffId) {
			logger.info('Skipping integration connect chat: no Chief of Staff', { workspaceId, provider })
			return null
		}

		const label = labelFor(provider, input.label)
		const title = `Connect ${label}`
		const content = buildIntegrationConnectPrompt({
			label,
			provider,
			integrationId,
			connectType: input.connectType ?? 'new',
		})

		const { conversationId, messageId } = await db.transaction(async (tx) => {
			// Two connects of the same integration at once must not open two chats.
			await tx.execute(
				sql`SELECT pg_advisory_xact_lock(hashtext(${`${workspaceId}:connect-chat:${actorId}:${title}`}))`,
			)

			// Open means: a plain chat (no subject, not a direct message) this person started with the
			// Chief of Staff under the same title, that they have not archived or left.
			const [existing] = await tx
				.select({ id: conversations.id })
				.from(conversations)
				.innerJoin(
					conversationParticipants,
					and(
						eq(conversationParticipants.conversationId, conversations.id),
						eq(conversationParticipants.actorId, actorId),
						isNull(conversationParticipants.leftAt),
						eq(conversationParticipants.archived, false),
					),
				)
				.where(
					and(
						eq(conversations.workspaceId, workspaceId),
						eq(conversations.title, title),
						eq(conversations.createdBy, actorId),
						isNull(conversations.subjectId),
						isNull(conversations.directPairKey),
						sql`EXISTS (
							SELECT 1 FROM conversation_participants cos
							WHERE cos.conversation_id = ${conversations.id}
								AND cos.actor_id = ${chiefOfStaffId}
								AND cos.left_at IS NULL
						)`,
					),
				)
				.orderBy(desc(conversations.lastMessageAt))
				.limit(1)

			let id = existing?.id
			if (!id) {
				const [created] = await tx
					.insert(conversations)
					.values({ workspaceId, title, createdBy: actorId })
					.returning({ id: conversations.id })
				if (!created) throw new Error('Failed to create integration connect chat')
				id = created.id
				await tx.insert(conversationParticipants).values(
					[actorId, chiefOfStaffId].map((participantId) => ({
						conversationId: id as string,
						actorId: participantId,
						addedBy: actorId,
					})),
				)
				await recordEvent(tx, {
					workspaceId,
					actorId,
					action: 'conversation_created',
					entityType: 'conversation',
					entityId: id,
					data: { participant_actor_ids: [actorId, chiefOfStaffId] },
				})
			}

			// Hidden from the chat, like the loop personalization nudge: the person reads the Chief of
			// Staff's reply first, not a message they never typed.
			const message = await insertConversationMessage(tx, {
				conversationId: id,
				workspaceId,
				actorId,
				content,
				metadata: { mentions: [chiefOfStaffId], hidden_from_chat: true },
				sessionId: null,
			})
			if (!message) throw new Error('Failed to post integration connect prompt')
			return { conversationId: id, messageId: message.id }
		})

		await evaluateAndRespond({ db, sessionManager, workspaceId, conversationId, messageId })
		return { conversationId }
	} catch (err) {
		logger.error('Failed to start integration connect chat', {
			workspaceId,
			provider,
			integrationId,
			error: err instanceof Error ? err.message : String(err),
		})
		return null
	}
}
