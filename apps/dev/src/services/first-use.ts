import type { Database } from '@maskin/db'
import { events, actors, marketplaceLoops, objects, workspaceMembers } from '@maskin/db/schema'
import {
	FIRST_USE_MAX_SUGGESTIONS,
	FIRST_USE_SESSION_TITLE,
	FIRST_USE_SOURCE,
	FIRST_USE_SUGGESTIONS_TITLE,
	type FirstUseComment,
	type FirstUseSuggestion,
	firstUseIntroComments,
	firstUseSuggestionComments,
} from '@maskin/shared'
import { and, asc, eq } from 'drizzle-orm'
import { logger } from '../lib/logger'
import { autoSubscribe } from './subscriptions'

/**
 * First use — what a brand-new workspace opens on.
 *
 * The two cards seeded here (the Chief of Staff's introduction, and the
 * marketplace suggestions) are the parts that are the same for everyone, so
 * they are written synchronously at workspace creation: the queue is never
 * empty while a container boots, and it never depends on Claude credentials
 * being configured.
 *
 * The other two cards — the researched Knowledge about this company, and the
 * first Bet argued from it — are genuinely about *this* workspace, so they are
 * written by the live agent session this module kicks off. They arrive in the
 * queue behind the seeded pair as the agents finish.
 */

/** Object type for the first-use conversation card. */
export const FIRST_USE_SESSION_TYPE = 'onboarding_session'
export const FIRST_USE_SESSION_STATUS = 'active'

export interface FirstUseAgentIds {
	chiefOfStaff: string
	researchAgent: string
	strategist: string
}

/**
 * Agent names as `seedDefaultAgentActors` / `bootstrapDefaultAgents` write
 * them. Resolving by name keeps this working from both workspace-creation
 * paths — one seeds every agent inside its transaction and has the ids to
 * hand, the other seeds them post-commit and does not.
 */
const FIRST_USE_AGENT_NAMES = {
	chiefOfStaff: 'Chief of Staff',
	researchAgent: 'Research Agent',
	strategist: 'Strategist',
} as const

/**
 * Look up the three agents first use needs. Returns null when any of them is
 * missing — a workspace mid-bootstrap, or one whose agents failed to seed —
 * because a first-use queue attributed to the wrong actor is worse than none.
 */
export async function resolveFirstUseAgents(
	db: Pick<Database, 'select'>,
	workspaceId: string,
): Promise<FirstUseAgentIds | null> {
	const rows = await db
		.select({ id: actors.id, name: actors.name })
		.from(workspaceMembers)
		.innerJoin(actors, eq(workspaceMembers.actorId, actors.id))
		.where(eq(workspaceMembers.workspaceId, workspaceId))

	const byName = new Map(rows.map((row) => [row.name, row.id]))
	const chiefOfStaff = byName.get(FIRST_USE_AGENT_NAMES.chiefOfStaff)
	const researchAgent = byName.get(FIRST_USE_AGENT_NAMES.researchAgent)
	const strategist = byName.get(FIRST_USE_AGENT_NAMES.strategist)
	if (!chiefOfStaff || !researchAgent || !strategist) return null
	return { chiefOfStaff, researchAgent, strategist }
}

export interface SeedFirstUseArgs {
	workspaceId: string
	workspaceName: string
	/** The human this workspace was created for — the reader of every card. */
	ownerActorId: string
	ownerName: string
	agents: FirstUseAgentIds
	/** False when no agent session will follow, so the copy doesn't promise one. */
	agentsWorking: boolean
}

export interface SeededFirstUse {
	sessionObjectId: string
	suggestionsObjectId: string
	suggestions: FirstUseSuggestion[]
}

/**
 * Post one seeded comment, authored by the given agent, on the given object.
 *
 * Writes the same `data` shape `POST /api/events` writes so the card renders
 * through exactly one path — there is no seeded-comment variant in the UI.
 */
async function postSeededComment(
	db: Pick<Database, 'insert'>,
	args: {
		workspaceId: string
		objectId: string
		actorId: string
		comment: FirstUseComment
	},
): Promise<void> {
	const { comment } = args
	await db.insert(events).values({
		workspaceId: args.workspaceId,
		actorId: args.actorId,
		action: 'commented',
		entityType: 'object',
		entityId: args.objectId,
		data: {
			content: comment.content,
			refs: comment.refs,
			metadata: comment.chips ? { chips: comment.chips } : undefined,
			// Drives the For You ordering, so the introduction leads the queue
			// without anything having to hardcode a sequence.
			attention: comment.attention,
		},
	})
}

/**
 * Pick the loops the suggestions card offers. Ordered by name so a workspace
 * created twice against the same catalog gets the same card, and capped so the
 * card stays a shortlist rather than a directory listing.
 */
export async function pickFirstUseSuggestions(
	db: Pick<Database, 'select'>,
): Promise<FirstUseSuggestion[]> {
	const rows = await db
		.select({
			id: marketplaceLoops.id,
			name: marketplaceLoops.name,
			description: marketplaceLoops.description,
		})
		.from(marketplaceLoops)
		.orderBy(asc(marketplaceLoops.name))
		.limit(FIRST_USE_MAX_SUGGESTIONS)
	return rows
}

/**
 * Write the seeded half of first use: the introduction card and the
 * suggestions card, both subscribed to the workspace owner so they land in For
 * You as unread.
 *
 * Idempotent on the introduction card — a workspace that already has a
 * first-use session is left alone and the existing ids are returned.
 */
export async function seedFirstUse(
	db: Database,
	args: SeedFirstUseArgs,
): Promise<SeededFirstUse | null> {
	// Re-seeding would post the introduction twice into a queue the owner may
	// already have read, so an existing pair short-circuits.
	const existing = await db
		.select({ id: objects.id, title: objects.title })
		.from(objects)
		.where(and(eq(objects.workspaceId, args.workspaceId), eq(objects.type, FIRST_USE_SESSION_TYPE)))
	const existingSession = existing.find((row) => row.title === FIRST_USE_SESSION_TITLE)
	const existingSuggestions = existing.find((row) => row.title === FIRST_USE_SUGGESTIONS_TITLE)
	if (existingSession && existingSuggestions) {
		return {
			sessionObjectId: existingSession.id,
			suggestionsObjectId: existingSuggestions.id,
			suggestions: [],
		}
	}

	const suggestions = await pickFirstUseSuggestions(db)

	const [session] = await db
		.insert(objects)
		.values({
			workspaceId: args.workspaceId,
			type: FIRST_USE_SESSION_TYPE,
			title: FIRST_USE_SESSION_TITLE,
			status: FIRST_USE_SESSION_STATUS,
			content:
				'What this workspace is, and how the queue you are reading works. Everything else arrives behind this card.',
			metadata: { source: FIRST_USE_SOURCE, first_use_card: 'intro' },
			createdBy: args.agents.chiefOfStaff,
		})
		.returning({ id: objects.id })

	const [suggestionsCard] = await db
		.insert(objects)
		.values({
			workspaceId: args.workspaceId,
			type: FIRST_USE_SESSION_TYPE,
			title: FIRST_USE_SUGGESTIONS_TITLE,
			status: FIRST_USE_SESSION_STATUS,
			content: 'Loops from the marketplace that would earn their place in your first week.',
			metadata: { source: FIRST_USE_SOURCE, first_use_card: 'suggestions' },
			createdBy: args.agents.chiefOfStaff,
		})
		.returning({ id: objects.id })

	if (!session || !suggestionsCard) {
		throw new Error('first use: failed to create the seeded cards')
	}

	for (const comment of firstUseIntroComments({
		ownerName: args.ownerName,
		agentsWorking: args.agentsWorking,
	})) {
		await postSeededComment(db, {
			workspaceId: args.workspaceId,
			objectId: session.id,
			actorId: args.agents.chiefOfStaff,
			comment,
		})
	}

	for (const comment of firstUseSuggestionComments({ suggestions })) {
		await postSeededComment(db, {
			workspaceId: args.workspaceId,
			objectId: suggestionsCard.id,
			actorId: args.agents.chiefOfStaff,
			comment,
		})
	}

	for (const objectId of [session.id, suggestionsCard.id]) {
		await autoSubscribe(db, {
			workspaceId: args.workspaceId,
			actorId: args.ownerActorId,
			entityType: 'object',
			entityId: objectId,
			source: 'manual',
		})
	}

	return {
		sessionObjectId: session.id,
		suggestionsObjectId: suggestionsCard.id,
		suggestions,
	}
}

/**
 * The action prompt handed to the Research agent's session. It owns the whole
 * live half of first use: research this company, write it as Knowledge, ask
 * the owner to confirm it, then hand to the Strategist for the first bet.
 */
export function firstUseResearchPrompt(args: {
	workspaceName: string
	ownerName: string
	ownerActorId: string
	strategistActorId: string
	sessionObjectId: string
}): string {
	return [
		'A workspace has just been created and its owner is reading their first cards right now. Run the `workspace-first-use` skill — it is the authority on what to write and in what order.',
		'',
		`Workspace: ${args.workspaceName}`,
		`Owner: ${args.ownerName} (actor id ${args.ownerActorId})`,
		`Strategist actor id (hand off to this one at the end): ${args.strategistActorId}`,
		`Introduction card already posted by the Chief of Staff: object ${args.sessionObjectId} — do not duplicate it.`,
		'',
		'Before you start: if this workspace already has a knowledge object with metadata.source = "workspace_first_use", first use has already run. Exit silently.',
	].join('\n')
}

/**
 * Seed the static cards and start the live half — the whole of first use, from
 * the one call site a workspace-creation path needs.
 *
 * Never throws: a workspace that fails to seed its first-use cards is still a
 * usable workspace, and failing the create request over an onboarding card
 * would be a worse outcome than an empty queue.
 */
export async function runFirstUse(
	db: Database,
	deps: StartFirstUseResearchDeps | null,
	args: SeedFirstUseArgs,
): Promise<SeededFirstUse | null> {
	try {
		const seeded = await seedFirstUse(db, args)
		if (!seeded) return null
		if (deps && args.agentsWorking) {
			await startFirstUseResearch(deps, { ...args, sessionObjectId: seeded.sessionObjectId })
		}
		return seeded
	} catch (err) {
		logger.error('first use: seeding failed', { workspaceId: args.workspaceId, err })
		return null
	}
}

export interface StartFirstUseResearchDeps {
	createSession: (
		workspaceId: string,
		params: { actorId: string; actionPrompt: string; createdBy: string },
	) => Promise<unknown>
}

/**
 * Kick off the live half. Non-fatal by construction: a workspace whose research
 * session cannot start still has its two seeded cards, and the owner still has
 * somewhere to land.
 */
export async function startFirstUseResearch(
	deps: StartFirstUseResearchDeps,
	args: SeedFirstUseArgs & { sessionObjectId: string },
): Promise<void> {
	try {
		await deps.createSession(args.workspaceId, {
			actorId: args.agents.researchAgent,
			actionPrompt: firstUseResearchPrompt({
				workspaceName: args.workspaceName,
				ownerName: args.ownerName,
				ownerActorId: args.ownerActorId,
				strategistActorId: args.agents.strategist,
				sessionObjectId: args.sessionObjectId,
			}),
			createdBy: args.ownerActorId,
		})
	} catch (err) {
		logger.error('first use: failed to start the research session', {
			workspaceId: args.workspaceId,
			err,
		})
	}
}
