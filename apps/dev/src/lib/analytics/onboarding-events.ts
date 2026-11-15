import type { Database } from '@maskin/db'
import { events, messages, objects } from '@maskin/db/schema'
import { SIGNUP_CAPTURE_SOURCE } from '@maskin/shared'
import { and, count, eq, sql } from 'drizzle-orm'
import { logger } from '../logger'
import { capturePosthogEvent } from './posthog'

/** The delivery kind stamped on the hidden briefing that opens a sign-up chat. */
export const SIGNUP_ONBOARDING_DELIVERY_KIND = 'signup_onboarding'

export const ONBOARDING_SECOND_MESSAGE_EVENT = 'onboarding_second_message'
export const ONBOARDING_RESEARCH_ANSWERED_EVENT = 'onboarding_research_answered'

/** The three answers on the research summary, by the label the person taps. */
export const RESEARCH_ANSWER_BY_LABEL = {
	'looks right': 'looks_right',
	'needs correction': 'needs_correction',
	'wrong entirely': 'wrong',
} as const

export type OnboardingResearchAnswer =
	(typeof RESEARCH_ANSWER_BY_LABEL)[keyof typeof RESEARCH_ANSWER_BY_LABEL]

/**
 * Records onboarding_second_message once per sign-up: when the person's second message
 * lands in their sign-up chat. The chat is told by the delivery marker on its hidden
 * briefing; the briefing itself is not a message the person wrote and is not counted.
 * Ids only, never message text. Best-effort: never throws, so callers fire it without awaiting.
 */
export async function maybeTrackOnboardingSecondMessage(
	db: Database,
	p: { workspaceId: string; conversationId: string; actorId: string },
): Promise<void> {
	try {
		const [briefing] = await db
			.select({ id: messages.id })
			.from(messages)
			.where(
				and(
					eq(messages.conversationId, p.conversationId),
					sql`${messages.metadata}->'delivery'->>'kind' = ${SIGNUP_ONBOARDING_DELIVERY_KIND}`,
				),
			)
			.limit(1)
		if (!briefing) return

		const [written] = await db
			.select({ value: count() })
			.from(messages)
			.where(
				and(
					eq(messages.conversationId, p.conversationId),
					eq(messages.actorId, p.actorId),
					eq(messages.kind, 'message'),
					sql`${messages.metadata}->>'hidden_from_chat' IS DISTINCT FROM 'true'`,
				),
			)
		if (written?.value !== 2) return

		await capturePosthogEvent(ONBOARDING_SECOND_MESSAGE_EVENT, p.actorId, {
			workspace_id: p.workspaceId,
			conversation_id: p.conversationId,
		})
	} catch (err) {
		logger.warn('Failed to emit onboarding_second_message', {
			conversationId: p.conversationId,
			error: String(err),
		})
	}
}

/**
 * Records onboarding_research_answered when the person taps one of the three answers on
 * the research summary: a reply to a decision card on the sign-up knowledge object whose
 * text is one of that card's option labels. One property, answer. Never message text.
 * Best-effort: never throws, so callers fire it without awaiting.
 */
export async function maybeTrackOnboardingResearchAnswered(
	db: Database,
	p: {
		workspaceId: string
		actorId: string
		objectId: string
		parentEventId: number
		content: string
	},
): Promise<void> {
	try {
		const answer = (RESEARCH_ANSWER_BY_LABEL as Record<string, OnboardingResearchAnswer>)[
			p.content.trim().toLowerCase()
		]
		if (!answer) return

		const [card] = await db
			.select({ data: events.data })
			.from(events)
			.where(
				and(
					eq(events.id, p.parentEventId),
					eq(events.workspaceId, p.workspaceId),
					eq(events.entityId, p.objectId),
					eq(events.action, 'commented'),
				),
			)
			.limit(1)
		const options = (card?.data as { decision?: { options?: Array<{ label?: unknown }> } } | null)
			?.decision?.options
		const isTap = options?.some(
			(o) =>
				typeof o.label === 'string' &&
				o.label.trim().toLowerCase() === p.content.trim().toLowerCase(),
		)
		if (!isTap) return

		const [object] = await db
			.select({ metadata: objects.metadata })
			.from(objects)
			.where(and(eq(objects.id, p.objectId), eq(objects.workspaceId, p.workspaceId)))
			.limit(1)
		if ((object?.metadata as { source?: unknown } | null)?.source !== SIGNUP_CAPTURE_SOURCE) return

		await capturePosthogEvent(ONBOARDING_RESEARCH_ANSWERED_EVENT, p.actorId, {
			workspace_id: p.workspaceId,
			answer,
		})
	} catch (err) {
		logger.warn('Failed to emit onboarding_research_answered', {
			objectId: p.objectId,
			error: String(err),
		})
	}
}
