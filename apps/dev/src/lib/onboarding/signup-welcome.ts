import type { Database } from '@maskin/db'
import { actors, workspaceMembers } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import type { SessionManager } from '../../services/session-manager'
import { postComment } from '../comments'
import { logger } from '../logger'

const CHIEF_OF_STAFF_NAME = 'Chief of Staff'
const RESEARCHER_NAME = 'Researcher'

interface SignupCaptureMetadata {
	source?: string
	name?: string
	organization?: string
	role?: string
}

export interface PostSignupWelcomeCommentInput {
	db: Database
	sessionManager: SessionManager
	workspaceId: string
	knowledgeObjectId: string
	metadata: unknown
	/** The human who just signed up (the caller that created the knowledge object) — @-mentioned alongside Researcher so the comment surfaces on their For You page. */
	humanActorId: string
}

async function resolveAgentIdByName(
	db: Database,
	workspaceId: string,
	name: string,
): Promise<string | null> {
	const [row] = await db
		.select({ actorId: workspaceMembers.actorId })
		.from(workspaceMembers)
		.innerJoin(actors, eq(workspaceMembers.actorId, actors.id))
		.where(
			and(
				eq(workspaceMembers.workspaceId, workspaceId),
				eq(actors.name, name),
				eq(actors.type, 'agent'),
			),
		)
		.limit(1)
	return row?.actorId ?? null
}

/**
 * Fires right after a `signup_capture` knowledge object is created (see the
 * `POST /api/objects` handler in `routes/objects.ts`). Deterministically —
 * not by handing it to an agent's judgment — posts a Chief-of-Staff-authored
 * welcome comment on the object that @mentions Researcher, which auto-spawns
 * a Researcher session via the existing mention-session-spawn path
 * (`lib/comments.ts` + the mention loop in `routes/events.ts`).
 *
 * This must fire every time a user signs up, so it deliberately bypasses the
 * "let the agent decide to do this" pattern that turned out to be
 * unreliable for the original welcome-session kickoff (see the hardcoded
 * kickoff + comment in `services/workspace-bootstrap.ts`).
 */
export async function postSignupWelcomeComment(
	input: PostSignupWelcomeCommentInput,
): Promise<void> {
	const { db, sessionManager, workspaceId, knowledgeObjectId, humanActorId } = input
	const metadata = (input.metadata ?? {}) as SignupCaptureMetadata
	const name = metadata.name?.trim()
	const organization = metadata.organization?.trim()
	const role = metadata.role?.trim()

	const [chiefOfStaffId, researcherId, human] = await Promise.all([
		resolveAgentIdByName(db, workspaceId, CHIEF_OF_STAFF_NAME),
		resolveAgentIdByName(db, workspaceId, RESEARCHER_NAME),
		db
			.select({ email: actors.email })
			.from(actors)
			.where(eq(actors.id, humanActorId))
			.limit(1)
			.then((rows) => rows[0]),
	])

	if (!chiefOfStaffId || !researcherId) {
		logger.warn('Skipping signup welcome comment — Chief of Staff or Researcher not seeded', {
			workspaceId,
			knowledgeObjectId,
			hasChiefOfStaff: Boolean(chiefOfStaffId),
			hasResearcher: Boolean(researcherId),
		})
		return
	}

	// @-mention both Researcher (kicks off its session, below) and the human
	// who just signed up. The human mention is what makes this comment surface
	// on their For You page — `GET /api/subscriptions/unread` matches on
	// `events.data.mentions` containing the viewer's actor id, and postComment
	// auto-subscribes every mentioned actor regardless of type.
	const displayName = name || 'there'
	const content = `Hi ${displayName} 👋 Welcome to Maskin — I'm Chief of Staff, I make sure the right agent picks up your work. @Researcher — please put together a first-pass brief on ${displayName}${organization ? ` and ${organization}` : ''} so the workspace has real context from day one. @${displayName} — if anything here looks off or you'd like to add more before Researcher gets started, just reply and I'll make sure it gets folded in.`

	const { comment, agentMentions } = await postComment(db, {
		workspaceId,
		actorId: chiefOfStaffId,
		entityId: knowledgeObjectId,
		content,
		mentions: [researcherId, humanActorId],
		attention: 3,
	})

	const researcherMention = agentMentions.find((m) => m.agentId === researcherId)
	if (!researcherMention) {
		logger.warn('Signup welcome comment posted but Researcher mention was not recorded', {
			workspaceId,
			knowledgeObjectId,
			commentEventId: comment.id,
		})
		return
	}

	await sessionManager
		.createSession(workspaceId, {
			actorId: researcherId,
			actionPrompt: buildSignupResearchPrompt({
				knowledgeObjectId,
				name,
				email: human?.email ?? undefined,
				organization,
				role,
				humanActorId,
				notificationId: researcherMention.notificationId,
			}),
			config: {
				mention: {
					object_id: knowledgeObjectId,
					commenter_actor_id: chiefOfStaffId,
					notification_id: researcherMention.notificationId,
					comment_event_id: comment.id,
				},
			},
			createdBy: chiefOfStaffId,
		})
		.catch((err) =>
			logger.error('Failed to create Researcher session for signup welcome', {
				workspaceId,
				knowledgeObjectId,
				error: String(err),
			}),
		)
}

function buildSignupResearchPrompt(ctx: {
	knowledgeObjectId: string
	name?: string
	email?: string
	organization?: string
	role?: string
	humanActorId: string
	notificationId: string
}): string {
	const who = [ctx.name, ctx.role, ctx.organization ? `at ${ctx.organization}` : undefined]
		.filter(Boolean)
		.join(', ')
	return [
		`Chief of Staff @mentioned you on this workspace's signup-context knowledge object (id: ${ctx.knowledgeObjectId}) to run a first-pass research brief on the new user${who ? ` (${who})` : ''}.`,
		'',
		`Signup info on record — name: ${ctx.name ?? 'unknown'}, email: ${ctx.email ?? 'unknown'}, organization: ${ctx.organization ?? 'unknown'}, role: ${ctx.role ?? 'unknown'}. Use all four as your research inputs — the email domain is often the fastest way to the company's own site.`,
		`User's actor ID (use this in \`mentions\` on step 5): ${ctx.humanActorId}`,
		'',
		'Do a fast-mode pass (public sources only — company site, professional profile pages, published talks/posts):',
		`1. Read knowledge object ${ctx.knowledgeObjectId} (get_objects) to confirm the signup info above.`,
		'2. Research the person and their organization using their name, email, organization, and role.',
		`3. Update that SAME knowledge object (update_objects on ${ctx.knowledgeObjectId}) with what you find — it is the workspace's single source of truth for the owner, so enrich it in place rather than filing a second one for this pass.`,
		'4. File one atomic `insight` object per key finding (create_objects), same as any other brief, linked back with an `informs` relationship (insight → knowledge).',
		`5. Post a NEW reply comment on ${ctx.knowledgeObjectId} presenting what you found — a short TL;DR is enough, the detail lives on the object you just updated. @-mention the user (include their actor ID above in \`mentions\`) and ask whether they'd like to add files or have you research anything further.`,
		`6. Mark notification ${ctx.notificationId} as resolved once done.`,
	].join('\n')
}
