import type { Database } from '@maskin/db'
import { conversations, objects, sessions } from '@maskin/db/schema'
import {
	TERMINAL_STATUSES_BY_TYPE,
	buildWebAppHref,
	loopTargetSchema,
	stripTrailingSlash,
} from '@maskin/shared'
import { and, desc, eq, inArray, notInArray, or, sql } from 'drizzle-orm'

/** Hard cap on the block, in characters. It rides in every chat, so it stays small. */
export const CHAT_DRIVES_MAX = 2000

const MORE_MARKER = '\n(more on the objects you drive)'
const MAX_LOOPS = 3
const MAX_TARGETS_PER_LOOP = 4
const MAX_OPEN_OBJECTS = 5
const CLOSE_CONDITION_MAX = 200
const TITLE_MAX = 80

// A loop that is drafted or paused is not running, so it is not something the
// agent is driving right now.
const LIVE_LOOP_STATUSES = ['learning', 'supervised', 'fully_autonomous']
const OPEN_OBJECT_TYPES = ['bet', 'task', 'insight'] as const

export interface ChatDrivesSession {
	workspaceId: string
	actorId: string
	conversationId: string
}

interface Subject {
	id: string
	type: string
	title: string | null
	status: string
	metadata: unknown
}

function oneLine(text: string, max: number): string {
	const flat = text.replace(/\s+/g, ' ').trim()
	return flat.length <= max ? flat : `${flat.slice(0, max).trimEnd()}…`
}

function describeTargets(metadata: unknown): string {
	const raw = (metadata as Record<string, unknown> | null)?.targets
	if (!Array.isArray(raw)) return ''
	return raw
		.flatMap((row) => {
			const parsed = loopTargetSchema.safeParse(row)
			return parsed.success
				? [`${parsed.data.label}: ${parsed.data.actual} of ${parsed.data.target}`]
				: []
		})
		.slice(0, MAX_TARGETS_PER_LOOP)
		.join('; ')
}

function describeCloseCondition(metadata: unknown): string {
	const cond = (metadata as Record<string, unknown> | null)?.close_condition
	return typeof cond === 'string' && cond.trim() ? oneLine(cond, CLOSE_CONDITION_MAX) : ''
}

/**
 * The "What you drive" block for a chat session: the live loops and open
 * objects the agent is the driver of, each loop's targets (actual of target)
 * and close condition, and one line saying the agent owns these outcomes and
 * the person in the chat supports. When the chat is about an object or loop,
 * that one leads. Returns '' when the agent drives nothing. Capped at
 * CHAT_DRIVES_MAX characters: lines are dropped from the end, never cut in half.
 */
export async function buildChatDrivesBlock(
	db: Database,
	session: ChatDrivesSession,
	frontendUrl: string,
): Promise<string> {
	const base = stripTrailingSlash(frontendUrl)
	const link = (id: string, title: string | null) =>
		`[${oneLine(title ?? '', TITLE_MAX).replace(/[[\]]/g, '') || 'Untitled'}](${buildWebAppHref(base, session.workspaceId, { kind: 'object', id })})`

	const select = {
		id: objects.id,
		type: objects.type,
		title: objects.title,
		status: objects.status,
		metadata: objects.metadata,
	}
	const drivenLoops: Subject[] = await db
		.select(select)
		.from(objects)
		.where(
			and(
				eq(objects.workspaceId, session.workspaceId),
				eq(objects.driver, session.actorId),
				eq(objects.type, 'loop'),
				inArray(objects.status, LIVE_LOOP_STATUSES),
			),
		)
		.orderBy(desc(objects.updatedAt))
		.limit(MAX_LOOPS)
	const drivenOpen: Subject[] = await db
		.select(select)
		.from(objects)
		.where(
			and(
				eq(objects.workspaceId, session.workspaceId),
				eq(objects.driver, session.actorId),
				or(
					...OPEN_OBJECT_TYPES.map((type) =>
						and(
							eq(objects.type, type),
							notInArray(objects.status, TERMINAL_STATUSES_BY_TYPE[type] ?? []),
						),
					),
				),
			),
		)
		.orderBy(desc(objects.updatedAt))
		.limit(MAX_OPEN_OBJECTS + 1)
	if (drivenLoops.length === 0 && drivenOpen.length === 0) return ''

	let subject: Subject | null = null
	const [convo] = await db
		.select({ subjectType: conversations.subjectType, subjectId: conversations.subjectId })
		.from(conversations)
		.where(
			and(
				eq(conversations.id, session.conversationId),
				eq(conversations.workspaceId, session.workspaceId),
			),
		)
		.limit(1)
	if (convo?.subjectId) {
		subject =
			[...drivenLoops, ...drivenOpen].find((o) => o.id === convo.subjectId) ??
			(
				await db
					.select(select)
					.from(objects)
					.where(and(eq(objects.id, convo.subjectId), eq(objects.workspaceId, session.workspaceId)))
					.limit(1)
			)[0] ??
			null
	}

	// The subject leads: its own line, and first among the loops if it is one.
	const loops = (
		subject?.type === 'loop'
			? [subject, ...drivenLoops.filter((l) => l.id !== subject?.id)]
			: drivenLoops
	).slice(0, MAX_LOOPS)
	const open = drivenOpen.filter((o) => o.id !== subject?.id).slice(0, MAX_OPEN_OBJECTS)
	const loopLines = loops.map((l) => {
		const targets = describeTargets(l.metadata)
		const closes = describeCloseCondition(l.metadata)
		return `- ${link(l.id, l.title)} (${l.status})${targets ? `. Targets: ${targets}` : ''}${closes ? `. Closes when: ${closes}` : ''}`
	})
	const openLines = open.map((o) => `- ${link(o.id, o.title)} (${o.type}, ${o.status})`)

	const lines = [
		'## What you drive',
		'You own these outcomes. The person in this chat supports you.',
		...(subject
			? [
					`This chat is about ${link(subject.id, subject.title)} (${subject.type}, ${subject.status}).`,
				]
			: []),
		...(loopLines.length ? ['Flows, with targets as actual of target:', ...loopLines] : []),
		...(openLines.length ? ['Open items:', ...openLines] : []),
	]

	// Keep whole lines only, leaving room for the marker; the objects themselves
	// carry the rest.
	let out = ''
	for (const line of lines) {
		const next = out ? `${out}\n${line}` : line
		if (next.length > CHAT_DRIVES_MAX - MORE_MARKER.length) {
			out = `${out}${MORE_MARKER}`
			break
		}
		out = next
	}
	return `${out}\n\n`
}

/**
 * Saves the block on `sessions.config.chat_drives` as a jsonb merge, so other
 * keys are untouched, like `run_goal` for unattended runs. First write wins:
 * launch runs again on resume and must not overwrite what the agent was first
 * shown.
 */
export async function saveChatDrives(
	db: Database,
	sessionId: string,
	block: string,
): Promise<void> {
	await db
		.update(sessions)
		.set({
			config: sql`coalesce(${sessions.config}, '{}'::jsonb) || ${JSON.stringify({ chat_drives: block })}::jsonb`,
		})
		.where(
			and(
				eq(sessions.id, sessionId),
				sql`NOT (coalesce(${sessions.config}, '{}'::jsonb) ? 'chat_drives')`,
			),
		)
}
