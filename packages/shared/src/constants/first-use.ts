import type { CommentRef } from '../schemas/events'

/**
 * First use — the sequence of cards a brand-new workspace opens on.
 *
 * Two of the cards are seeded (this file): the Chief of Staff's introduction,
 * and the suggestions card built from whatever the marketplace actually holds.
 * The other two — the researched Knowledge and the first Bet — are written by
 * live agent sessions, because their content is genuinely about this company
 * and cannot be authored ahead of time. See
 * `.agents/skills/workspace-first-use/SKILL.md`.
 *
 * Copy lives here rather than in the seeding service so the wording is
 * reviewable in one place and the service stays about ordering and writes.
 */

export const FIRST_USE_SESSION_TITLE = 'Onboarding'
export const FIRST_USE_SUGGESTIONS_TITLE = 'Suggested loops and agents'

/** `metadata.source` stamped on every object first use creates. */
export const FIRST_USE_SOURCE = 'workspace_first_use'

/** How many marketplace loops the suggestions card offers at most. */
export const FIRST_USE_MAX_SUGGESTIONS = 4

export interface FirstUsePage {
	key: string
	label: string
	/** Workspace-relative route, matching `apps/web/src/routes/_authed/$workspaceId`. */
	path: string
	/** Shown inline when the reader expands the chip. */
	detail: string
}

/**
 * The four product surfaces the introduction card offers to explain. Each one
 * is a `page` ref chip: expanding it reveals `detail`, opening it navigates.
 */
export const FIRST_USE_PAGES: readonly FirstUsePage[] = [
	{
		key: 'chats',
		label: 'Chats',
		path: 'chats',
		detail:
			'Where you talk to an agent directly — ask it something, hand it a job, argue with its reasoning. Whatever gets decided lands on the objects it touches, so the thread is the record rather than a side conversation.',
	},
	{
		key: 'loops',
		label: 'Loops',
		path: 'loops',
		detail:
			'Work that runs without anyone starting it. Each loop is a trigger (what it listens for), the agents that act when it fires, and the points where it stops for a human. You will spend most of your time changing where they stop.',
	},
	{
		key: 'objects',
		label: 'Objects',
		path: 'objects',
		detail:
			'The shared record: insights (a signal worth acting on), bets (a scoped hypothesis with a goal and a timeline), tasks (the work that follows), and knowledge (what this workspace has learned and keeps). Agents read and write the same objects you do.',
	},
	{
		key: 'marketplace',
		label: 'Marketplace',
		path: 'marketplace',
		detail:
			'Loops and agents other teams have published. Install one and it arrives wired to its triggers, so you are turning something on rather than starting from an empty canvas.',
	},
] as const

const MARKETPLACE_PAGE_DETAIL =
	FIRST_USE_PAGES.find((page) => page.key === 'marketplace')?.detail ?? ''

export interface FirstUseComment {
	content: string
	refs?: CommentRef[]
	/** Quick-reply chips (`metadata.chips`) offered under the comment. */
	chips?: string[]
	/** 1–5, the same scale agents score their own comments on. */
	attention: number
}

/**
 * Attention scores decide the order of the For You queue, so these are what put
 * the introduction in front of everything else on day one — not a hardcoded
 * sequence. They are ordinary scores on the ordinary scale: the introduction is
 * the one card that has to be read before any other card means anything, and
 * the suggestions are genuinely a "when convenient" read.
 *
 * The two cards the agents write score themselves (both carry a decision, so
 * both land at 4) — see the first-use skills.
 */
const INTRO_ATTENTION = 4
const SUGGESTIONS_ATTENTION = 3

function firstName(fullName: string): string {
	const trimmed = fullName.trim()
	return trimmed.split(/\s+/)[0] || trimmed
}

/**
 * The introduction card — what this workspace is, and how the For You queue
 * behaves. Static apart from the reader's name and whether agents are still
 * working on the cards behind it.
 */
export function firstUseIntroComments(args: {
	ownerName: string
	/** True while the research + first-bet sessions are still running. */
	agentsWorking: boolean
}): FirstUseComment[] {
	const name = firstName(args.ownerName)
	const behind = args.agentsWorking
		? ' Two agents are working on the rest of your queue right now: the context we can find on your company, and the first bet worth opening.'
		: ''
	return [
		{
			attention: INTRO_ATTENTION,
			content: `Welcome, ${name}. I am your Chief of Staff — the agent you talk to first. I know what every agent here is working on, and I hand things to whoever should be doing them.\n\nTwo words worth having straight before anything else:\n\n- **Loops** — work that keeps cycling on its own.\n- **Bets** — a scoped hypothesis, worked until it is settled.`,
		},
		{
			attention: INTRO_ATTENTION,
			content: `**For you is a queue, not an inbox.** One card at a time. Mark it read and it leaves; keep it unread and it comes back. Nothing clears itself.\n\nExpand any of these and I will tell you what it is for.${behind}`,
			refs: FIRST_USE_PAGES.map((page) => ({
				kind: 'page' as const,
				tag: 'PAGE',
				label: page.label,
				path: page.path,
				detail: page.detail,
			})),
			chips: ['What do you do?', 'Can I skip this?'],
		},
	]
}

export interface FirstUseSuggestion {
	/** Marketplace loop id — the chip opens its detail page. */
	id: string
	name: string
	description: string
}

/**
 * The suggestions card. Structure and framing are fixed; the loops themselves
 * come from the marketplace table at seed time, so this never advertises
 * something the workspace cannot actually install.
 */
export function firstUseSuggestionComments(args: {
	suggestions: readonly FirstUseSuggestion[]
}): FirstUseComment[] {
	const { suggestions } = args
	if (suggestions.length === 0) {
		return [
			{
				attention: SUGGESTIONS_ATTENTION,
				content:
					'Nothing is running in this workspace yet. The marketplace is where loops and agents other teams have published — installing one is the fastest way to have something working by the end of the week.',
				refs: [
					{
						kind: 'page',
						tag: 'PAGE',
						label: 'Marketplace',
						path: 'marketplace',
						detail: MARKETPLACE_PAGE_DETAIL,
					},
				],
			},
		]
	}

	const count = suggestions.length === 1 ? 'This one is' : `These ${suggestions.length} are`
	return [
		{
			attention: SUGGESTIONS_ATTENTION,
			content: `Nothing in this workspace is running yet. ${count} already wired to their triggers, so turning one on is not the same as starting from an empty canvas — you are turning something on and then arguing with where it stops.\n\nNothing installs until you say so, and anything you install comes out again in one click.`,
			refs: suggestions.map((loop) => ({
				kind: 'page' as const,
				tag: 'LOOP',
				label: loop.name,
				path: `marketplace/${loop.id}`,
				detail: loop.description,
			})),
		},
		{
			attention: SUGGESTIONS_ATTENTION,
			content:
				'Picking for you would be guessing, and I would rather not. **What are you hoping to get out of this?** One sentence is enough — I read it against what the workspace already knows and come back with one thing to start.',
			chips: ['Fewer things dropped', 'Watch competitors', 'Understand customers'],
		},
	]
}
