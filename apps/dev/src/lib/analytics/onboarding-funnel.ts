import type { Database } from '@maskin/db'
import { sessions } from '@maskin/db/schema'
import { actors, messages } from '@maskin/db/schema'
import type { FlowErrorCategory, FlowStepDetail, FlowStepName } from '@maskin/shared'
import { and, asc, eq, isNotNull, lt, ne } from 'drizzle-orm'
import { logger } from '../logger'
import { startedByPerson } from '../session-access'
import { trackFlowError, trackFlowStep } from './flow-events'

// The server steps of the sign-up to first result flow (tracking plan, row 3). The web sends
// the first sign-up and the result-opened steps. Every step is sent on the person's own id,
// and the person's id is also the flow_id, so web and server steps land on one person and
// one flow without passing state between them.
const FLOW = 'signup_to_first_result' as const
type OnboardingStep = FlowStepName<typeof FLOW>

/** One step of the flow for one person. Best-effort: never throws. */
export function trackOnboardingStep(p: {
	workspaceId: string
	humanId: string
	step: OnboardingStep
	detail?: FlowStepDetail
}): Promise<void> {
	return trackFlowStep({
		workspaceId: p.workspaceId,
		actorId: p.humanId,
		flow: FLOW,
		step: p.step,
		flowId: p.humanId,
		detail: p.detail,
	})
}

/**
 * `intro_clicked`, once, for the first message a person writes in the chat that opens with an
 * agent's intro. `via` says whether the message came from tapping a send step (the web marks it
 * with from_suggested_step) or was typed, and `step_index` which step was tapped. A fill step only
 * fills the message box, so it reads as typed once the person sends. Best-effort: never throws.
 */
export async function trackIntroReply(
	db: Database,
	p: {
		workspaceId: string
		conversationId: string
		humanId: string
		messageId: number
		tappedStepIndex: number | null
	},
): Promise<void> {
	try {
		const [firstHuman] = await db
			.select({ id: messages.id })
			.from(messages)
			.innerJoin(actors, eq(actors.id, messages.actorId))
			.where(and(eq(messages.conversationId, p.conversationId), eq(actors.type, 'human')))
			.orderBy(asc(messages.id))
			.limit(1)
		if (firstHuman?.id !== p.messageId) return
		const [opening] = await db
			.select({ metadata: messages.metadata })
			.from(messages)
			.where(eq(messages.conversationId, p.conversationId))
			.orderBy(asc(messages.id))
			.limit(1)
		const kind = (opening?.metadata as { delivery?: { kind?: string } } | null)?.delivery?.kind
		if (kind !== 'agent_intro') return
		await trackOnboardingStep({
			workspaceId: p.workspaceId,
			humanId: p.humanId,
			step: 'intro_clicked',
			detail:
				p.tappedStepIndex === null
					? { via: 'typed' }
					: { via: 'button', step_index: p.tappedStepIndex },
		})
	} catch (err) {
		logger.warn('Failed to emit intro_clicked', {
			conversationId: p.conversationId,
			error: String(err),
		})
	}
}

type SessionFacts = Pick<
	typeof sessions.$inferSelect,
	'id' | 'workspaceId' | 'createdBy' | 'triggerId' | 'conversationId' | 'createdAt'
>

/**
 * The person whose first chat run this session is, or null. A run counts when a person started
 * it (no trigger, a human creator) in a chat, which leaves out the welcome session the platform
 * starts at sign-up and every trigger run. First means no earlier chat run by the same person in
 * the same workspace.
 */
async function humanOfFirstChatRun(db: Database, session: SessionFacts): Promise<string | null> {
	if (!session.conversationId || !session.createdAt) return null
	if (!(await startedByPerson(db, session))) return null
	const [earlier] = await db
		.select({ id: sessions.id })
		.from(sessions)
		.where(
			and(
				eq(sessions.workspaceId, session.workspaceId),
				eq(sessions.createdBy, session.createdBy),
				isNotNull(sessions.conversationId),
				ne(sessions.id, session.id),
				lt(sessions.createdAt, session.createdAt),
			),
		)
		.limit(1)
	return earlier ? null : session.createdBy
}

/** `first_run_started`, once, when a person's first chat run is created. Best-effort: never throws. */
export async function trackFirstRunStarted(db: Database, session: SessionFacts): Promise<void> {
	try {
		const humanId = await humanOfFirstChatRun(db, session)
		if (humanId)
			await trackOnboardingStep({
				workspaceId: session.workspaceId,
				humanId,
				step: 'first_run_started',
			})
	} catch (err) {
		logger.warn('Failed to emit first_run_started', { sessionId: session.id, error: String(err) })
	}
}

/** Why a first run failed, as a category from the fixed list. Never the failure text. */
export function firstRunErrorCategory(p: {
	reasonCode: string | undefined
	outcome: 'failed' | 'timeout'
}): FlowErrorCategory {
	if (p.reasonCode === 'not_logged_in') return 'missing_model_key'
	return p.outcome === 'timeout' ? 'timeout' : 'unknown'
}

/**
 * The end of a person's first chat run: `first_run_completed` when it completed, `flow_error`
 * on that step when it failed or timed out. A stop or pause sends nothing. Best-effort: never throws.
 */
export async function trackFirstRunSettled(
	db: Database,
	sessionId: string,
	outcome: 'completed' | 'failed' | 'timeout' | 'user_stopped' | 'paused',
	reasonCode: string | undefined,
): Promise<void> {
	if (outcome === 'user_stopped' || outcome === 'paused') return
	try {
		const [session] = await db
			.select({
				id: sessions.id,
				workspaceId: sessions.workspaceId,
				createdBy: sessions.createdBy,
				triggerId: sessions.triggerId,
				conversationId: sessions.conversationId,
				createdAt: sessions.createdAt,
			})
			.from(sessions)
			.where(eq(sessions.id, sessionId))
			.limit(1)
		if (!session) return
		const humanId = await humanOfFirstChatRun(db, session)
		if (!humanId) return
		if (outcome === 'completed') {
			await trackOnboardingStep({
				workspaceId: session.workspaceId,
				humanId,
				step: 'first_run_completed',
			})
			return
		}
		await trackFlowError({
			workspaceId: session.workspaceId,
			actorId: humanId,
			flow: FLOW,
			step: 'first_run_completed',
			flowId: humanId,
			errorCategory: firstRunErrorCategory({ reasonCode, outcome }),
		})
	} catch (err) {
		logger.warn('Failed to emit first run result', { sessionId, error: String(err) })
	}
}
