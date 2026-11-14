import type { Database } from '@maskin/db'
import { actors, conversations, jobGoAheads, objects } from '@maskin/db/schema'
import { TERMINAL_STATUSES_BY_TYPE, buildWebAppHref, stripTrailingSlash } from '@maskin/shared'
import { and, desc, eq, inArray, isNull, notInArray, or } from 'drizzle-orm'

const MAX_JOBS = 3
const TITLE_MAX = 80

export interface GoAheadBlockSession {
	workspaceId: string
	actorId: string
	/** The object an unattended run was started for. */
	initiatedFromObjectId: string | null
	/** Set for a chat session. */
	conversationId: string | null
}

interface LiveGoAhead {
	objectId: string
	title: string | null
	type: string
	grantedByName: string
	grantedAt: Date
	via: string
}

function oneLine(text: string, max: number): string {
	const flat = text.replace(/\s+/g, ' ').trim()
	return flat.length <= max ? flat : `${flat.slice(0, max).trimEnd()}…`
}

function formatDate(at: Date): string {
	return at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
}

/**
 * Which jobs this session is shown a go-ahead for: the object an unattended run was started for,
 * the object a chat is about, and (for a chat) the open jobs this agent drives. A go-ahead only
 * counts while it is live (not taken back) and the job is not closed. Closed is read from the
 * object's status, so a closed job needs no clean-up.
 */
async function liveGoAheads(db: Database, session: GoAheadBlockSession): Promise<LiveGoAhead[]> {
	const ids = new Set<string>()
	if (session.initiatedFromObjectId) ids.add(session.initiatedFromObjectId)
	if (session.conversationId) {
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
		if (convo?.subjectType === 'object' && convo.subjectId) ids.add(convo.subjectId)
	}

	const scope = [
		ids.size ? inArray(jobGoAheads.objectId, [...ids]) : undefined,
		session.conversationId ? eq(objects.driver, session.actorId) : undefined,
	].filter((c) => c !== undefined)
	if (scope.length === 0) return []

	const open = or(
		...Object.entries(TERMINAL_STATUSES_BY_TYPE).map(([type, statuses]) =>
			and(eq(objects.type, type), notInArray(objects.status, statuses)),
		),
		// Types with no terminal list (loops, events, contacts) never count as closed here.
		notInArray(objects.type, Object.keys(TERMINAL_STATUSES_BY_TYPE)),
	)
	const rows = await db
		.select({
			objectId: objects.id,
			title: objects.title,
			type: objects.type,
			grantedByName: actors.name,
			grantedAt: jobGoAheads.grantedAt,
			via: jobGoAheads.via,
		})
		.from(jobGoAheads)
		.innerJoin(objects, eq(objects.id, jobGoAheads.objectId))
		.innerJoin(actors, eq(actors.id, jobGoAheads.grantedBy))
		.where(
			and(
				eq(jobGoAheads.workspaceId, session.workspaceId),
				isNull(jobGoAheads.takenBackAt),
				open,
				or(...scope),
			),
		)
		.orderBy(desc(jobGoAheads.grantedAt))
		.limit(50)

	// The jobs this session is about lead, then the open jobs the agent drives (chat only).
	return rows
		.sort((a, b) => Number(ids.has(b.objectId)) - Number(ids.has(a.objectId)))
		.slice(0, MAX_JOBS)
}

/**
 * The "Go-ahead on the job" block shown at session start, next to the goal of the run or the jobs
 * a chat drives. Empty when no job in reach has a live go-ahead, so a session with none is built
 * exactly as before. It is built on every launch and never saved: a go-ahead taken back between
 * two launches must not be shown again from a saved copy.
 *
 * The text says what the go-ahead covers (safe steps) and what it never does: sending in a
 * person's name, spending and deleting keep their own approval.
 */
export async function buildGoAheadBlock(
	db: Database,
	session: GoAheadBlockSession,
	frontendUrl: string,
): Promise<string> {
	const found = await liveGoAheads(db, session)
	if (found.length === 0) return ''
	const base = stripTrailingSlash(frontendUrl)
	const lines = found.map((g) => {
		const title = oneLine(g.title ?? '', TITLE_MAX).replace(/[[\]]/g, '') || 'Untitled'
		const link = `[${title}](${buildWebAppHref(base, session.workspaceId, { kind: 'object', id: g.objectId })})`
		return `- ${link} (${g.type}): go-ahead from ${g.grantedByName}, ${formatDate(g.grantedAt)}`
	})
	return [
		'## Go-ahead on the job',
		'A person told you to keep going on these jobs without asking for each step:',
		...lines,
		'Carry on with steps that send nothing in a person’s name, spend nothing and delete nothing, and do not stop to ask permission for them. This go-ahead never covers sending in a person’s name, spending money or deleting: those still need a decision card. It ends when the job closes or a person takes it back (take_back_go_ahead).',
		'---',
		'',
	].join('\n\n')
}
