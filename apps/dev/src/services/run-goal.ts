import type { Database } from '@maskin/db'
import { objects, relationships } from '@maskin/db/schema'
import { buildWebAppHref, stripTrailingSlash } from '@maskin/shared'
import { and, eq, sql } from 'drizzle-orm'

const FINISH_LINE_MAX = 1200
const MAX_SERVED_LOOPS = 2

// Headings and lines that mark a finish line in an object body. A body is
// free text, so this is a small list of names agents already use, not a field.
const FINISH_LINE_NAMES = [
	'done when',
	'done =',
	'acceptance criteria',
	'acceptance',
	'success criteria',
	'how we know it worked',
]

const HEADING_RE = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/
const BOLD_ONLY_RE = /^\s*\*\*([^*]+)\*\*:?\s*$/

function startsWithFinishLineName(text: string): boolean {
	const normalised = text.replace(/[*_`]/g, '').trim().toLowerCase()
	return FINISH_LINE_NAMES.some((name) => normalised.startsWith(name))
}

function capText(text: string): string {
	const trimmed = text.trim()
	if (trimmed.length <= FINISH_LINE_MAX) return trimmed
	return `${trimmed.slice(0, FINISH_LINE_MAX).trimEnd()} … (the rest is on the object)`
}

/**
 * Reads the finish line an object already carries, or null when none is
 * written. Never invents one. A loop's close condition is a real field; every
 * other type is read from its body: a heading (h1 to h6) or bold-only line
 * named like "Done when" or "Acceptance criteria" takes the text up to the next
 * heading, and a plain line that starts with one of those names takes just
 * that paragraph.
 */
export function extractFinishLine(
	type: string,
	content: string | null,
	metadata: unknown,
): string | null {
	if (type === 'loop') {
		const cond = (metadata as Record<string, unknown> | null)?.close_condition
		return typeof cond === 'string' && cond.trim() ? capText(cond) : null
	}
	if (!content) return null

	const lines = content.split('\n')
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? ''
		const heading = HEADING_RE.exec(line)
		const bold = heading ? null : BOLD_ONLY_RE.exec(line)
		const label = heading?.[1] ?? bold?.[1]

		if (label !== undefined) {
			if (!startsWithFinishLineName(label)) continue
			const body: string[] = []
			for (let j = i + 1; j < lines.length; j++) {
				if (HEADING_RE.test(lines[j] ?? '')) break
				if (bold && BOLD_ONLY_RE.test(lines[j] ?? '')) break
				body.push(lines[j] ?? '')
			}
			const text = body.join('\n').trim()
			// A heading with nothing under it is not a finish line.
			if (text) return capText(text)
			continue
		}

		if (startsWithFinishLineName(line)) {
			const paragraph: string[] = []
			for (let j = i; j < lines.length && (lines[j] ?? '').trim() !== ''; j++)
				paragraph.push(lines[j] ?? '')
			return capText(paragraph.join('\n'))
		}
	}
	return null
}

interface LoopRef {
	id: string
	title: string | null
}

export interface RunGoalSession {
	workspaceId: string
	triggerId: string | null
	initiatedFromObjectId: string | null
}

/**
 * The "Your goal this run" block shown at the top of an unattended session,
 * built from whatever woke the agent. The most specific source leads and the
 * rest is background:
 *   - woken by an object: that object's own finish line, or a plain note that
 *     none is written;
 *   - woken by a trigger with no object: the trigger prompt, which follows this
 *     block unchanged, is the goal;
 *   - connected to a loop: one "What this serves" line, linked, not copied.
 * A suggestion to the agent, never a check. Chat sessions are interactive and
 * never get this block: the person's message is the goal.
 */
export async function buildRunGoalBlock(
	db: Database,
	session: RunGoalSession,
	frontendUrl: string,
): Promise<string> {
	const link = (id: string, title: string | null) =>
		`[${title?.trim() || 'Untitled'}](${buildWebAppHref(stripTrailingSlash(frontendUrl), session.workspaceId, { kind: 'object', id })})`

	const woken = session.initiatedFromObjectId
		? ((
				await db
					.select({
						id: objects.id,
						type: objects.type,
						title: objects.title,
						content: objects.content,
						metadata: objects.metadata,
					})
					.from(objects)
					.where(
						and(
							eq(objects.id, session.initiatedFromObjectId),
							eq(objects.workspaceId, session.workspaceId),
						),
					)
					.limit(1)
			)[0] ?? null)
		: null

	const goal = woken
		? describeObjectGoal(link(woken.id, woken.title), woken.type, woken)
		: 'The instruction that follows this block is your goal, as written.'

	// Loops this run belongs to: through its trigger first (a loop lists its
	// trigger ids, triggers carry no loop id), then through the woken object's
	// in_loop edge. Many cron triggers name their loop only in prose and are in
	// neither list; they get no line, and the prompt is not parsed for one.
	const loops: LoopRef[] = []
	if (session.triggerId) {
		loops.push(
			...(await db
				.select({ id: objects.id, title: objects.title })
				.from(objects)
				.where(
					and(
						eq(objects.workspaceId, session.workspaceId),
						eq(objects.type, 'loop'),
						sql`${objects.metadata}->'trigger_ids' ? ${session.triggerId}`,
					),
				)
				.limit(MAX_SERVED_LOOPS)),
		)
	}
	if (woken && woken.type !== 'loop' && loops.length < MAX_SERVED_LOOPS) {
		loops.push(
			...(await db
				.select({ id: objects.id, title: objects.title })
				.from(relationships)
				.innerJoin(objects, eq(objects.id, relationships.sourceId))
				.where(
					and(
						eq(relationships.targetId, woken.id),
						eq(relationships.type, 'in_loop'),
						eq(objects.workspaceId, session.workspaceId),
						eq(objects.type, 'loop'),
					),
				)
				.limit(MAX_SERVED_LOOPS)),
		)
	}
	const served = [...new Map(loops.map((l) => [l.id, l])).values()]
		.filter((l) => l.id !== woken?.id)
		.slice(0, MAX_SERVED_LOOPS)

	return [
		'## Your goal this run',
		goal,
		...(served.length
			? [`What this serves: ${served.map((l) => link(l.id, l.title)).join(', ')}`]
			: []),
		'Start your first message with one line: Goal: <your goal>. If you cannot find a goal, say so and ask the agent that owns the object, instead of making one up.',
		'---',
		'',
	].join('\n\n')
}

function describeObjectGoal(
	objectLink: string,
	type: string,
	object: { content: string | null; metadata: unknown },
): string {
	const finishLine = extractFinishLine(type, object.content, object.metadata)
	if (finishLine) {
		const label = type === 'loop' ? 'its close condition' : 'its finish line'
		return `This run was started for ${objectLink} (${type}). Here is ${label}, as written there:\n\n${finishLine
			.split('\n')
			.map((l) => `> ${l}`)
			.join('\n')}`
	}
	return `This run was started for ${objectLink} (${type}). No finish line is written on it, so decide from the request below what done looks like. One reading, if it fits: move the object to its next status.`
}
